# Real DOM Browse Harness Plan

## Goal

Add a second browse eval layer that uses a real local browser against real DOM pages, while keeping the existing deterministic fake-browse suite for fast iteration.

This harness should answer:

- Does the browse agent behave correctly against actual DOM state, focus, hover, timing, and CSS selectors?
- Do browse-agent hardening changes improve real interaction reliability without regressing fail-fast behavior?

## Recommendation

Build a tiny local harness app inside the repo using plain HTML, CSS, and JavaScript served by a minimal Node HTTP server.

Do not use React, Vite, or a full app framework for v1.

Why:

- the repo does not already include a frontend harness framework under `pipeline/`
- static pages plus small scripted behavior are enough to exercise hover, dialog, keyboard, delayed content, and auth redirect
- fewer dependencies means lower startup cost and less flake
- the existing `browse-agent` stage can run unchanged against a real local URL

## Scope

### Keep

- existing fake-browse deterministic suite under `pipeline/evals/browse-agent/`
- existing scorer and browse-only runner as the first gate

### Add

- `pipeline/evals/browse-dom-harness/`
- a local server script
- real HTML pages for the key interaction cases
- a second runner command such as `npm run eval:browse:dom`

## Harness Architecture

### Files

- `pipeline/evals/browse-dom-harness/server.ts`
  - minimal Node HTTP server
  - serves static files from `public/`
  - supports deterministic routes only

- `pipeline/evals/browse-dom-harness/public/`
  - one HTML page per case
  - shared CSS and small shared JS helper if needed

- `pipeline/evals/browse-dom-harness/cases/`
  - one case directory per eval
  - `plan.json`
  - `expected.json`
  - optional `case-config.json` only if a page needs route-specific config

- `pipeline/src/evals/run-browse-dom-evals.ts`
  - starts the local server once
  - runs all DOM cases sequentially
  - points `baseUrl` at the harness server
  - invokes the real `browse-agent` stage
  - reuses the current scorer where possible

## Case Set

### v1 cases

- `tooltip-hover-success`
  - real hover target
  - tooltip only appears on hover

- `tooltip-hover-timeout-or-missing`
  - no valid tooltip target or blocked target
  - verifies fail-fast and no selector invention

- `dialog-css-required`
  - open action menu
  - dialog contains target button
  - `@e` refs may be unstable, CSS selector works

- `keyboard-nav`
  - focusable tablist
  - `ArrowDown` or `ArrowRight` moves focus/selection

- `wait-for-data`
  - page initially renders loading state
  - rows appear after deterministic delay

- `auth-redirect`
  - initial page redirects to `/login`
  - browse agent must report auth redirect and stop

### optional v1.1 case

- `non-replannable-interaction-failure`
  - hover or press fails on the correct page state
  - validates that pipeline does not enter replan

## Page Design

Each page should be intentionally simple and deterministic.

### Tooltip page

- button labeled `Trial`
- hidden tooltip content
- tooltip shown only via `mouseenter` or `focus`

### Dialog page

- `More` button
- opens menu/dialog
- `Duplicate` button rendered in dialog
- final dialog heading `Duplicate event type`

### Keyboard page

- real tablist with `tabindex`, `aria-selected`, and keyboard handlers
- visible selected state in text and attributes

### Loading page

- render `Loading reports...`
- swap to rows after fixed timeout like `1500ms`
- no randomness

### Auth page

- route immediately changes to `/login`
- login page includes `Sign in` heading and `Please sign in to continue`

## Runner Design

### New command

- `npm run eval:browse:dom`

### Behavior

1. Start harness server on an ephemeral local port.
2. For each case:
   - create temp `.verify` and run dir
   - write `config.json` with harness `baseUrl`
   - copy `plan.json`
   - run `browse-agent` through the existing CLI path
   - score result using trace, result, and stream logs
3. Stop server.
4. Print pass/fail summary and median duration.

### Important detail

Do not reuse the fake browse shim here.

This runner must use the real browse binary path resolution so we are testing:

- the prompt
- the model
- the real browse command behavior
- the DOM

## Scoring

Reuse the strengthened browse scorer, with DOM-case expectations requiring:

- expected command sequence
- expected observed substrings
- required evidence substrings
- no forbidden shell wandering
- no unexpected file reads
- max command count
- max duration

For DOM cases, evidence should come from:

- snapshots
- command stdout/stderr
- nav failure snapshot/error when present

## Testing the Harness Itself

### Unit tests

- server starts and serves each route
- deterministic delayed page transitions complete as expected
- route redirects behave correctly

### Integration tests

- `run-browse-dom-evals.ts` can boot server, run one case, and tear down
- one smoke test per page using raw HTTP fetch or lightweight assertions

### Full browse verification

- run `npm run eval:browse`
- run `npm run eval:browse:dom`
- run full `npm test`

## Acceptance Criteria

### v1 done means

- DOM harness runs locally with one command
- six real DOM cases exist
- server startup and teardown are reliable
- eval output is recorded separately from the fake-browse baseline
- at least one intentionally failing interaction case verifies fail-fast behavior

### quality bar

- repeated runs on the same machine produce stable results
- no flaky timing dependence beyond controlled page delays
- browse-agent regressions show up in DOM evals even when fake-browse evals still pass

## Sequencing

### Phase 1

- add minimal HTTP server
- add two pages: tooltip and dialog
- add one smoke DOM runner

### Phase 2

- add keyboard, loading, and auth pages
- add all v1 case definitions
- add command `eval:browse:dom`

### Phase 3

- strengthen scorer and artifact output for DOM runs
- record first DOM baseline
- document how fake and DOM suites complement each other

## Risks

- real browse binary may introduce more flake than the pages themselves
- CSS/selectors from snapshots can differ across environments
- time-based waits can become flaky if delays are too tight

## Mitigations

- use generous but bounded delays on harness pages
- keep DOM structure minimal and stable
- avoid animation-heavy behavior
- prefer explicit text and ARIA state for scoring

## Success Metric

We should end up with two layers:

- `eval:browse`
  - fast, deterministic, prompt and control-flow guardrail

- `eval:browse:dom`
  - real-browser, real-DOM interaction guardrail

If both stay green, browse-agent changes are much more trustworthy.
