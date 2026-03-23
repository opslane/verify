# Real DOM Browse Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-browser, real-DOM browse eval suite that runs locally against a tiny harness app and complements the existing deterministic fake-browse suite.

**Architecture:** Keep the harness assets and case fixtures under `pipeline/evals/browse-dom-harness/`, and keep executable TypeScript under `pipeline/src/evals/` so it stays covered by `tsc --noEmit`. The new DOM runner should start one local HTTP server, run the existing `browse-agent` stage against real pages through an executor seam that defaults to the production CLI path, and reuse the current browse scorer and temp-run artifact structure. Unit tests stay hermetic by stubbing that executor and the browse lifecycle hooks; only the `eval:browse:dom` command hits the live browse/model stack, with browse daemon state reset between cases.

**Tech Stack:** Node HTTP server, TypeScript, static HTML/CSS/JS, `tsx`, `vitest`, existing `browse-agent` CLI path.

## Implementation Notes

- Do not introduce React, Vite, Playwright, or another app framework for v1.
- Keep the fake-browse suite intact. The new DOM suite is a second gate, not a replacement.
- Reuse the strengthened scorer in `pipeline/src/evals/browse-eval-score.ts`.
- Preserve command-level scoring by wrapping the real browse binary with a trace shim that writes `trace.jsonl` entries compatible with the existing scorer.
- The harness must be deterministic: no network calls, no random delays, no generated IDs, no animation-dependent assertions.
- Prefer visible text, ARIA state, and stable IDs over brittle CSS selectors in the harness pages.
- Keep `pipeline/test/*.test.ts` hermetic. Default `vitest` must not require the real browse binary, model credentials, or network access.
- Reserve live browse/model execution for `npm run eval:browse:dom` and optional opt-in smoke commands, not normal test runs.
- Protected-route cases must use a real HTTP redirect with a `Location` header so URL change handling is actually exercised.
- Case `plan.json` files should target stable app-style routes like `/trial`, `/event-types`, `/settings`, `/reports`, and `/billing`, not raw `*.html` filenames.
- The DOM runner must stop the browse daemon before the suite, reset it between cases, and stop it again in `finally` so history/cookies/current-page state cannot leak across runs.

## Target File Layout

### New directories

- Create: `pipeline/evals/browse-dom-harness/`
- Create: `pipeline/evals/browse-dom-harness/public/`
- Create: `pipeline/evals/browse-dom-harness/cases/`
- Create: `pipeline/evals/browse-dom-harness/baselines/`

### New TypeScript entrypoints

- Create: `pipeline/src/evals/browse-dom-harness-server.ts`
- Create: `pipeline/src/evals/run-browse-dom-evals.ts`
- Create: `pipeline/src/evals/browse-trace-shim.ts`

### New tests

- Create: `pipeline/test/browse-dom-harness-server.test.ts`
- Create: `pipeline/test/browse-dom-eval-runner.test.ts`

### Existing files to modify

- Modify: `pipeline/package.json`
- Modify: `pipeline/evals/browse-agent/README.md`

## Task 1: Scaffold the DOM Harness Layout

**Files:**
- Create: `pipeline/evals/browse-dom-harness/README.md`
- Create: `pipeline/evals/browse-dom-harness/public/.gitkeep`
- Create: `pipeline/evals/browse-dom-harness/cases/.gitkeep`
- Create: `pipeline/evals/browse-dom-harness/baselines/.gitkeep`
- Modify: `pipeline/package.json`

**Step 1: Write the failing test**

- Add a runner test in `pipeline/test/browse-dom-eval-runner.test.ts` that expects a new npm script value for `eval:browse:dom` to exist in `pipeline/package.json`.

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- FAIL because `eval:browse:dom` does not exist yet.

**Step 3: Add minimal structure**

- Add `eval:browse:dom` script to `pipeline/package.json`.
- Add the empty harness directories and README.
- In the README, explain that this suite uses the real browse binary against local static pages.

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/package.json pipeline/evals/browse-dom-harness pipeline/test/browse-dom-eval-runner.test.ts
git commit -m "chore: scaffold DOM browse harness"
```

## Task 2: Build the Harness HTTP Server

**Files:**
- Create: `pipeline/src/evals/browse-dom-harness-server.ts`
- Test: `pipeline/test/browse-dom-harness-server.test.ts`

**Step 1: Write the failing test**

Add server tests for:
- starting on port `0` and returning the bound port
- serving `/healthz`
- serving static files from `pipeline/evals/browse-dom-harness/public/`
- returning `404` for unknown routes

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- FAIL because the server module does not exist.

**Step 3: Write minimal implementation**

Implement:
- `startBrowseDomHarnessServer()`
- `stopBrowseDomHarnessServer()`
- static file serving from the harness `public/` directory
- `GET /healthz` returning `200 ok`

Keep the implementation dependency-free with `node:http`, `node:fs`, and `node:path`.

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/src/evals/browse-dom-harness-server.ts pipeline/test/browse-dom-harness-server.test.ts
git commit -m "feat: add DOM browse harness server"
```

## Task 3: Add Shared Harness Assets

**Files:**
- Create: `pipeline/evals/browse-dom-harness/public/shared.css`
- Create: `pipeline/evals/browse-dom-harness/public/shared.js`

**Step 1: Write the failing test**

- Extend `pipeline/test/browse-dom-harness-server.test.ts` to request `/shared.css` and `/shared.js` and assert they are served successfully.

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- FAIL because the files do not exist.

**Step 3: Write minimal implementation**

- Add shared styles for stable layout, visible focus rings, dialog appearance, hidden/visible helpers, and small semantic class names.
- Add tiny shared JS helpers only for deterministic UI state transitions.

Do not add generic frontend tooling.

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/evals/browse-dom-harness/public/shared.css pipeline/evals/browse-dom-harness/public/shared.js pipeline/test/browse-dom-harness-server.test.ts
git commit -m "feat: add shared DOM harness assets"
```

## Task 4: Implement Tooltip and Dialog Pages

**Files:**
- Create: `pipeline/evals/browse-dom-harness/public/tooltip.html`
- Create: `pipeline/evals/browse-dom-harness/public/dialog.html`
- Modify: `pipeline/src/evals/browse-dom-harness-server.ts`
- Test: `pipeline/test/browse-dom-harness-server.test.ts`

**Step 1: Write the failing test**

Add page smoke tests that fetch:
- `/trial`
- `/event-types`

Assert initial HTML contains only the trigger state:
- tooltip page: `Trial` and a stable trigger id like `trial-badge`
- dialog page: `More` and a stable trigger id like `more-actions-button`

Assert initial HTML does **not** contain the interacted end state:
- tooltip page must not contain `14 days left in your trial`
- dialog page must not contain `Duplicate event type`

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- FAIL because the pages do not exist.

**Step 3: Write minimal implementation**

Tooltip page:
- button or badge with stable id like `trial-badge`
- tooltip text is created only on `mouseenter` and `focus`, not shipped in the initial HTML

Dialog page:
- `More` button
- first interaction creates a dialog/menu containing `Cancel` and `Duplicate`
- second interaction creates a dialog with heading `Duplicate event type`

Keep selectors and DOM structure intentional:
- include ARIA roles where applicable
- make visible state easy to capture in snapshots
- serve the pages via stable app-style aliases:
  - `/trial` -> `tooltip.html`
  - `/event-types` -> `dialog.html`

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/evals/browse-dom-harness/public/tooltip.html pipeline/evals/browse-dom-harness/public/dialog.html pipeline/test/browse-dom-harness-server.test.ts
git commit -m "feat: add tooltip and dialog harness pages"
```

## Task 5: Build the DOM Eval Runner

**Files:**
- Create: `pipeline/src/evals/browse-trace-shim.ts`
- Create: `pipeline/src/evals/run-browse-dom-evals.ts`
- Modify: `pipeline/package.json`
- Test: `pipeline/test/browse-dom-eval-runner.test.ts`

**Step 1: Write the failing test**

Add runner tests for:
- browse daemon lifecycle hooks run before the suite, between cases, and in teardown
- server starts once before cases
- server stops after cases
- each case gets a temp `.verify/config.json` using the harness base URL
- each case gets isolated temp working directories and cleanup in `finally`
- each case gets a `trace.jsonl` populated by a trace shim around the real browse binary
- runner supports an injected stage executor so tests can stay hermetic
- default executor resolves the same real `src/cli.ts run-stage browse-agent` path used by production
- optional `--case <id>` filtering works for local iteration

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- FAIL because the DOM runner module does not exist.

**Step 3: Write minimal implementation**

Implement:
- case discovery under `pipeline/evals/browse-dom-harness/cases/`
- single server lifecycle
- temp verify/run directories per case
- browse lifecycle management using the existing helpers in `pipeline/src/lib/browse.ts`
- a trace shim that logs `ts`, `command`, `exitCode`, `stdout`, and `stderr` for every real browse command
- a temporary wrapper script that points `BROWSE_BIN` at the trace shim while forwarding to the resolved real browse binary
- scoring via `scoreBrowseEvalArtifacts`
- summary output consistent with `run-browse-evals.ts`
- `runBrowseDomEvalCase()` accepts an injected executor interface for tests
- the default executor shells to the same real `browse-agent` CLI path as production
- resolve the browse binary once, then pass isolated per-case env where needed
- stop the browse daemon before the suite, after each case, and in `finally` after errors
- clean temp `.verify` and run directories in `finally`, even on executor failure or scoring errors
- optional case filtering keeps local smoke runs fast

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/src/evals/browse-trace-shim.ts pipeline/src/evals/run-browse-dom-evals.ts pipeline/package.json pipeline/test/browse-dom-eval-runner.test.ts
git commit -m "feat: add DOM browse eval runner"
```

## Task 6: Add Phase 1 DOM Cases

**Files:**
- Create: `pipeline/evals/browse-dom-harness/cases/tooltip-hover-success/plan.json`
- Create: `pipeline/evals/browse-dom-harness/cases/tooltip-hover-success/expected.json`
- Create: `pipeline/evals/browse-dom-harness/cases/dialog-css-required/plan.json`
- Create: `pipeline/evals/browse-dom-harness/cases/dialog-css-required/expected.json`
- Test: `pipeline/test/browse-dom-eval-runner.test.ts`

**Step 1: Write the failing test**

Add a runner test that discovers exactly the two Phase 1 case directories in sorted order.

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- FAIL because the case directories do not exist yet.

**Step 3: Write minimal implementation**

Create the two case directories with:
- `plan.json`
- `expected.json`

Use stable route targets in the plans:
- `tooltip-hover-success` -> `/trial`
- `dialog-css-required` -> `/event-types`

Make expectations require:
- required commands
- required observed substrings
- required evidence substrings
- no forbidden shell wandering
- no unexpected file reads outside `instructions.json`

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/evals/browse-dom-harness/cases pipeline/test/browse-dom-eval-runner.test.ts
git commit -m "feat: add Phase 1 DOM browse cases"
```

## Task 7: Add Opt-In Live Smoke Coverage

**Files:**
- Modify: `pipeline/src/evals/run-browse-dom-evals.ts`
- Modify: `pipeline/test/browse-dom-eval-runner.test.ts`
- Modify: `pipeline/evals/browse-dom-harness/README.md`

**Step 1: Write the failing test**

Add hermetic tests for:
- a helper that decides whether live smoke is enabled via an env var like `BROWSE_DOM_LIVE_SMOKE=1`
- a guard that skips live smoke behavior unless the opt-in env var is set
- one-case filtering so manual smoke runs can stay bounded

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- FAIL until the live-smoke guard and one-case filter are wired correctly.

**Step 3: Write minimal implementation**

- implement the live-smoke guard without making normal `vitest` hit the real browse/model stack
- document the manual smoke command in the new harness README:
  `cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case tooltip-hover-success`

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- PASS.

**Step 5: Run manual live smoke for Phase 1**

Run:

```bash
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case tooltip-hover-success
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case dialog-css-required
```

Expected:
- both cases complete with real DOM evidence and no leaked daemon state between runs.

**Step 6: Commit**

```bash
git add pipeline/test/browse-dom-eval-runner.test.ts pipeline/evals/browse-dom-harness/README.md
git commit -m "test: add DOM browse smoke coverage"
```

## Task 8: Implement Keyboard, Loading, and Auth Pages

**Files:**
- Create: `pipeline/evals/browse-dom-harness/public/keyboard.html`
- Create: `pipeline/evals/browse-dom-harness/public/loading.html`
- Create: `pipeline/evals/browse-dom-harness/public/login.html`
- Modify: `pipeline/src/evals/browse-dom-harness-server.ts`
- Test: `pipeline/test/browse-dom-harness-server.test.ts`

**Step 1: Write the failing test**

Add smoke tests for:
- `/keyboard.html`
- `/loading.html`
- `/billing` returning an HTTP redirect to login

Add assertions for:
- keyboard page contains `Profile`, `Security`, `Notifications`
- loading page initially contains `Loading reports...`
- `/billing` responds with a `302`, `303`, or `307`
- `/billing` includes a `Location` header pointing to `/login.html?next=%2Fbilling`
- `/login.html` contains `Sign in`

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- FAIL because these pages and route rules are not implemented.

**Step 3: Write minimal implementation**

Keyboard page:
- implement deterministic keyboard selection state with ARIA

Loading page:
- initial loading text
- fixed delayed transition to rows like `Monthly revenue` and `Active users`

Auth behavior:
- `/billing` must issue a real redirect to `/login.html?next=%2Fbilling` without external auth machinery
- the login page should render the `next` target so URL/evidence assertions are possible

Serve stable app-style aliases:
- `/settings` -> `keyboard.html`
- `/reports` -> `loading.html`
- `/login` -> `login.html`

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
```

Expected:
- PASS.

**Step 5: Commit**

```bash
git add pipeline/evals/browse-dom-harness/public/keyboard.html pipeline/evals/browse-dom-harness/public/loading.html pipeline/evals/browse-dom-harness/public/login.html pipeline/src/evals/browse-dom-harness-server.ts pipeline/test/browse-dom-harness-server.test.ts
git commit -m "feat: add keyboard loading and auth harness pages"
```

## Task 9: Add Phase 2 DOM Cases

**Files:**
- Create: `pipeline/evals/browse-dom-harness/cases/keyboard-nav/plan.json`
- Create: `pipeline/evals/browse-dom-harness/cases/keyboard-nav/expected.json`
- Create: `pipeline/evals/browse-dom-harness/cases/wait-for-data/plan.json`
- Create: `pipeline/evals/browse-dom-harness/cases/wait-for-data/expected.json`
- Create: `pipeline/evals/browse-dom-harness/cases/auth-redirect/plan.json`
- Create: `pipeline/evals/browse-dom-harness/cases/auth-redirect/expected.json`
- Create: `pipeline/evals/browse-dom-harness/cases/tooltip-hover-timeout/plan.json`
- Create: `pipeline/evals/browse-dom-harness/cases/tooltip-hover-timeout/expected.json`

**Step 1: Write the failing test**

Extend `pipeline/test/browse-dom-eval-runner.test.ts` to assert discovery of all Phase 2 case directories.

**Step 2: Run test to verify it fails**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- FAIL because the new cases do not exist yet.

**Step 3: Write minimal implementation**

Create the remaining case definitions and make expectations match real page evidence.

Use stable route targets in the plans:
- `keyboard-nav` -> `/settings`
- `wait-for-data` -> `/reports`
- `auth-redirect` -> `/billing`
- `tooltip-hover-timeout` -> `/trial`

Make `tooltip-hover-timeout` the explicit fail-fast negative case:
- require `failure.kind` to be `interaction`
- require no replan artifact or retry summary
- require short failure duration relative to suite budget

**Step 4: Run test to verify it passes**

Run:

```bash
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

Expected:
- PASS.

**Step 5: Run manual live smoke for Phase 2**

Run:

```bash
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case keyboard-nav
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case wait-for-data
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case auth-redirect
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case tooltip-hover-timeout
```

Expected:
- each case completes with real DOM evidence before the final baseline run
- the negative case fails fast without replan

**Step 6: Commit**

```bash
git add pipeline/evals/browse-dom-harness/cases pipeline/test/browse-dom-eval-runner.test.ts
git commit -m "feat: add Phase 2 DOM browse cases"
```

## Task 10: Record the First DOM Baseline

**Files:**
- Create: `pipeline/evals/browse-dom-harness/baselines/README.md`
- Create: `pipeline/evals/browse-dom-harness/baselines/YYYY-MM-DD-initial.json`
- Modify: `pipeline/evals/browse-dom-harness/README.md`
- Modify: `pipeline/evals/browse-agent/README.md`

**Step 1: Run the full verification stack**

Run:

```bash
cd pipeline && npm run typecheck
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts test/browse-dom-eval-runner.test.ts
cd pipeline && npm run eval:browse
cd pipeline && npm run eval:browse:dom
cd pipeline && npm run eval:browse:dom
cd pipeline && npm run eval:browse:dom
cd pipeline && npm test
```

Expected:
- all relevant tests pass
- both browse suites complete
- all three DOM eval runs produce the same pass/fail outcome

**Step 2: Write the baseline artifacts**

Record:
- timestamp
- repeat count
- case count
- pass count
- true median duration
- min/max duration across repeated runs
- timeout-like failures
- flake count across repeated runs
- per-case results

Keep fake and DOM baselines separate.
Do not freeze the first DOM baseline unless repeated runs stay within a zero-flake budget for v1.

**Step 3: Update docs**

Document:
- when to run fake suite
- when to run DOM suite
- what each one proves
- expected local runtime
- that `npm test` stays hermetic and does not call the live browse/model stack by default

**Step 4: Commit**

```bash
git add pipeline/evals/browse-dom-harness/baselines pipeline/evals/browse-dom-harness/README.md pipeline/evals/browse-agent/README.md
git commit -m "docs: record initial DOM browse baseline"
```

## Required Test Commands

### Fast inner loop

```bash
cd pipeline && npx vitest run test/browse-dom-harness-server.test.ts
cd pipeline && npx vitest run test/browse-dom-eval-runner.test.ts
```

### Harness verification

```bash
cd pipeline && npm run eval:browse:dom
```

### One-case live smoke

```bash
cd pipeline && BROWSE_DOM_LIVE_SMOKE=1 npm run eval:browse:dom -- --case tooltip-hover-success
```

### Full verification

```bash
cd pipeline && npm run typecheck
cd pipeline && npm run eval:browse
cd pipeline && npm run eval:browse:dom
cd pipeline && npm test
```

## Risks to Watch During Execution

- real browse binary behavior may differ from the fake harness in selector formatting
- route redirects may be represented differently by the browse CLI than plain HTTP fetch
- DOM case timing may flake if delays are too short
- case expectations may overfit the exact wording of `observed`
- live-model behavior can drift, so hermetic `vitest` coverage must not be the only runner validation
- browse daemon state can leak across runs unless teardown is enforced on every path

## Guardrails

- use fixed delays of at least `1500ms` for delayed content pages
- require evidence-backed substrings from snapshots or command stdout, not only `observed`
- keep selectors simple and intentional
- avoid introducing framework tooling unless the plain-server approach proves inadequate
- do not make default `vitest` depend on model credentials, external network, or the real browse binary
- require the redirect case to assert both login content and final URL evidence
- require the fail-fast negative case to prove no replan on interaction failure
- require route aliases to stay stable even if backing HTML filenames change
- enforce daemon stop and temp-dir cleanup in `finally`

## Definition of Done

- `eval:browse:dom` exists and runs locally
- at least six real DOM cases exist
- DOM harness server and runner have dedicated tests
- default `vitest` remains hermetic
- the suite includes an explicit no-replan interaction-failure case
- stable app-style routes are used by all DOM cases
- the first DOM baseline is recorded
- fake and DOM suites both remain green
