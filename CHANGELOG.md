# Changelog

All notable changes to opslane/verify are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.9.0] - 2026-09-03

### Added
- **Every criterion cites the spec and says why it exists.** A plan source now
  carries `quote`, the verbatim spec text the criterion was read from, next to its
  `ref`; every criterion carries `why`, the bug it would catch. Both are required:
  the engine rejects a criterion missing either, rejects a `why` that is the title
  restated, and now also rejects a malformed `source`, which was never validated.
  The approval table gains `Cited` and `Why` columns, and each report card shows
  the citation and reason under the claim.
- **Quotes are looked up in the spec.** The `criteria` verb takes `--spec`; any
  quote the spec does not contain is listed under the table as `NOT IN THE SPEC`,
  as loud as a free pass. The skill records the chosen plan in `.verify/.spec_path`
  at run creation, which also restores the spec to the second-opinion reviewer:
  `scripts/review.sh` had read that file since 2.5 but nothing wrote it, so the
  reviewer always saw `(no spec file)`. The reviewer prompt now asks it to check
  quotes against the spec and `why` against the title.

### Changed
- **README rebuilt as a landing page.** It opens on the problem (agents write more code
  than anyone can read, and the agent grading its own work has one likely answer), then
  the mechanism as five bullets and a mermaid diagram showing that criteria come from
  the plan and the base commit and never from the diff. The body is three principles:
  we test the intent not the code, we run your whole stack for every change, and we
  give you the receipts, with a screenshot of a real report.
- **Depth moved into `docs/`.** `example-run.md` walks a real run, including what the
  second model flagged and what the report found unasked. `what-it-can-test.md` covers
  the surfaces and what each needs from you. `how-it-runs-your-stack.md` covers the
  setup contract, boot modes, seeding, probes, teardown, and login capture.
- Dropped the Requirements section. Node.js is named in Install, and the rest is
  covered where it matters.

### Fixed
- Criteria approved before this release still report. The citation and reason are
  required where they are authored (the `criteria` verb) and optional where an
  approved snapshot is merely read (`drive`, `report`, `html`), which is the rule
  `plain` already followed. A run that predates them renders `(not recorded)` in
  the table and says so on the report card, rather than failing to render or
  quietly showing a blank.
- A newline, tab or indentation inside a table cell (most likely in a quote copied
  from a wrapped spec) no longer ends the row early; it folds to one space. Bidi
  overrides and control characters in the claim, citation and reason are shown as
  escapes in both the table and the report, so what the reader compares to the
  spec is what was written.
- The install command pointed at `opslane/opslane`; the marketplace lives at
  `opslane/verify`.

## [2.8.0] - 2026-09-01

### Added
- **Recipe-form contracts.** `base_url` and `health_url` may carry a restricted
  placeholder grammar — `${VAR}` and `${VAR:-default}` only — expanded
  identically by one shared bash helper (`scripts/expand.sh`, env-file aware)
  and the TS engine, so a single committed `setup.json` serves every checkout
  and worktree. `/verify-setup` now writes this form by rule: the repo's own
  documented port variables, probes keyed to compose services instead of
  run-stamped container names, and a self-check that rejects resolved ports.

### Fixed
- Every consumer of `base_url` expands it: precheck, boot, the drive engine,
  the seed invocations (candidate and compare-base), and the auth-capture
  snippets — previously a placeholder URL would have reached curl literally.

## [2.7.0] - 2026-09-01

### Fixed (pre-release review)
- results.json is schema-validated: a typo'd outcome fails loudly instead of
  rendering a wrong card while the headline disagrees.
- Headline segments partition the total (verdict buckets only); demoted
  criteria no longer count twice.
- Proof comes atomically from the newest finalized attempt; a driven PASS
  substantiates only via an attempt with a completed step (error trails still
  substantiate fails).
- The classification pipeline lives once (`classify-run.ts`), consumed by both
  the text and HTML verbs; a missing result renders a visible card instead of
  disappearing.
- Run-dir mode refuses --results/--precheck from outside the run; report.md
  honors the clean-repo-violation flag.
- The recorder command sets its environment before `timeout` (it never started
  as documented); markers and report lines strip C1/bidi control characters;
  legacy evidence names carry no links.

### Added
- **Evidence-backed report cards.** Results name run-relative evidence files; the renderer
  verifies and displays images, video, and capped text excerpts, while missing, rejected,
  and multiply-cited files remain visible.
- **One terminal verdict.** Evidence resolution and taint feed a single `displayVerdict`
  classifier consumed by headlines, counts, text, and HTML, so outputs cannot disagree.
- **Receipt transcripts.** Driven cards show approved steps and engine-recorded invocation,
  output, diagnostics, timing, and terminal state without a PTY recorder.
- **Reader-approved claims.** Criteria may carry a plain-language `plain` claim approved in
  half one and used as the report-card headline.
- **Signed drive plans.** Criteria reachable by generic hands carry verbatim plans in the approval artifact before they can execute.
- **Four receipted verbs.** `http`, read-only `db`, budgeted `wait`, and shell-free `run` execute approved steps and persist neutral receipts.
- **Mechanical proof.** Driven marker criteria resolve to present, absent, or inconclusive from one designated eligible receipt before taint makes the final override.
- **Proof provenance.** Text and HTML reports label each criterion's proof as `receipted` or `judged`.
- **Run manifests.** Normal drive runs record the repository commit and `.verify/setup.json` contract used.
- **API auth contract.** Setup records only an HTTP header name and the environment variable containing its complete value; secret values are never written.
- **Report, don't rescue.** The workflow drives each approved plan once and sends any needed plan change back through approval instead of improvising retries.
- **Worktree shared store.** Fresh git worktrees inherit the committed setup
  contract but not the gitignored login state or local env file. `/verify-setup`
  now pushes both to `~/.verify/<repo-slug>/`; `/verify` pulls the login state
  on start, and the environment scripts fall back to the store's `local.env`
  when the contract's env file is missing locally. Deleting the store folder stops
  new worktrees inheriting the login (already-pulled copies stay until their
  `.verify/` is deleted).

### Changed
- A hand-driven pass or fail requires at least one valid named evidence file. A driven pass
  or fail requires a qualifying finalized attempt; named files are optional extras and
  never substitute for receipts.
- Live asciinema is optional garnish for hand-driven flows only. Start-check, recording,
  and GIF rendering each have process-group wall-clock limits and cannot hold a run.

## [2.6.0] - 2026-08-31

### Added
- **Setup contract.** `/verify-setup` sniffs how the repo boots, seeds, and reports
  health (compose files, npm scripts, seed scripts, env files), confirms the choices
  with pre-filled questions, and writes `.verify/setup.json`. Verify never asks for or
  stores credentials; the ceiling is naming one of the repo's own local `.env` files.
- **Throwaway environment per run.** `scripts/env.sh` boots a fresh stack under a
  unique compose project (or a process group with a required health URL), seeds as a
  separate verb so a seed failure cannot leak the stack, and tears down with volumes.
  Runs rotate: the newest 5 are kept.
- **Pipeline checks with mechanical taint.** Every criterion declares `dependsOn`
  (api, db, worker, browser, sink, storage). `scripts/precheck.sh` probes each named
  part once before judging — a marker round-trip for the database, any HTTP response
  for the API — and a down part marks only its dependent criteria could-not-run. The
  override is enforced in the engine (`report --precheck`), not in prose.
- **Proof-of-run.** Every criterion declares `proof`: the artifact that shows the
  check actually ran (marker in created data, marked rejection, or a live read).
  Results carry `proofSeen`; a pass without its proof renders "not proven" and never
  counts. The report gains a headline where PASS appears only when every criterion is
  proven, and checks that did not run never disappear from the count.
- **Reviewed seed script.** Volume preconditions become a literal `seed.sh` shown at
  approval and executed with the run marker; no model runs at seed time.
- **Second opinion.** `scripts/review.sh` has a reviewer that did not write the
  criteria attack them (Codex when installed, else a fresh claude call seeing only the
  spec and the criteria), with validated output and a loud "unavailable" fallback.
- **Compare against base.** `scripts/compare.sh up <ref>` boots the base commit in
  its own separately seeded worktree stack (setup contract, auth state, and seed
  script carried over; external mode refused) so a disputed fail can be settled by
  observation instead of argument.
- **Visual report.** The `html` engine verb renders `report.html` per run — escaped
  throughout, relative evidence that plays in place, plain-English labels, a
  Not-checked section that always renders — and the skill serves it on
  127.0.0.1 with a liveness check before printing the URL.
- **Clean-repo check.** The run snapshots tracked diffs and untracked hashes before
  and after; any non-`.verify/` change poisons the headline ("CANNOT TRUST THIS
  RUN") and the exit status.
- **Codify.** After the report, criteria the reviewer marked worth keeping are
  offered as permanent tests in the repo's own conventions — written uncommitted,
  only on explicit per-test consent, after checking the existing suite for overlap.

### Changed
- Criteria validation rejects entries missing `dependsOn` or a usable `proof`.
- The text report opens with the headline and a "Proven" axis.


## [2.5.0] - 2026-08-06

### Added
- Every criterion declares `intent` (`changes` or `preserves`), `baseline` (what the base
  commit does with it), and `witness` (`success` or `refusal`). `intent` and `baseline` are
  separate fields on purpose: defining `changes` as "fails on base" is wrong for real
  criteria. A rolling-upgrade check needs both versions running at once, and a
  "with the new flag off, behaviour is unchanged" check cannot run on a base binary that
  refuses to start with an unknown flag. Both get `baseline: not-applicable`.
- The engine rejects a criterion missing any of the three, and names the free passes: an
  `intent: changes` criterion with `baseline: pass` passed before the change existed, so it
  proved nothing. On a real run, four of six criteria were free passes and the report came
  back green.
- The approval artifact prints an intent-by-witness grid. A set where every criterion checks
  that something is refused is satisfied by an implementation that refuses everything, which
  is what happened: six criteria, not one of which exercised a working credential.
- `baseline: unknown` is a first-class answer and prints as something to confirm before
  approving. An honest unknown is a smaller failure than a confident claim that turns out to
  be a free pass.

### Changed
- **Reverses part of 2.4.0.** That release turned each unexplained change in the diff into
  an inferred criterion. It now becomes a question in the approval artifact instead. An
  expectation comes from the plan, from the behaviour that existed before the change, or
  from an assumption labelled `invented`. Never from the implementation being verified,
  because such a criterion agrees with whatever the code does and cannot fail. A run pinned
  a timeout at 30 seconds purely because `DEFAULT_TIMEOUT = (5, 30)` was in the diff.
- The diff is still read once for what the plan does not explain, and now for removals and
  narrowings as well as additions. The previous wording said "addition", so a deleted
  production route in the same hunk as a new one was invisible.

### Fixed
- The criteria table escaped pipes in most cells but not in `id` or the source label, so a
  pipe in either shifted every column after it. The test that claimed to cover "any cell"
  counted escaped pipes as delimiters and could not have caught it.
- Four files described a four-axis report. The engine renders three, and the README's own
  sample output showed three. The claim is now what the code does.

## [2.4.0] - 2026-08-04

### Changed
- Criteria are checked against the laziest implementation that would pass them. A stub, a
  constant, or code that always does the same thing should fail; if it would pass, the
  criterion is an observation rather than a check.
- Every rule with an on and an off gets both criteria. "A stale selection is cleared"
  passes against code that clears unconditionally, which was a real bug: valid selections
  were being thrown away on every load. The preserving side is where bugs live, because
  over-eager code satisfies the clearing side by accident.
- The diff is read for what the plan does not explain, and each unexplained change becomes
  an inferred criterion or goes in the uncovered list. Two clear() calls the plan never
  asked for were on screen while criteria were drafted, and one of them was the bug.
- UI criteria arrive at state instead of planting it. At least one path per run is walked
  end to end in a single session, because bugs in what a page does on its first pass are
  invisible when every check starts from a page loaded cold with values set by hand.


## [2.3.1] - 2026-08-04

### Fixed
- Two examples in the skill taught the phrasing the skill forbids. One asked "needs a
  production job to fail" while the very next line said to force the failure on the local
  stack; the other carried the same wording under a GOOD label. A model reading either
  copies the header, not the correction. Both now name the setup instead of an
  environment, and "needs a production job" appears only as a BAD example.

## [2.3.0] - 2026-08-04

### Changed
- Criteria render as a table with the source requirement in its own column, so the mapping
  from criterion to requirement can be scanned rather than read. Anything not straight from
  the plan is marked INVENTED or INFERRED in the table and explained underneath, where the
  assumption is stated in full. Pipes inside a cell are escaped so a command containing one
  cannot silently corrupt the table.


## [2.2.0] - 2026-08-04

### Changed
- Assume a criterion can be reproduced locally until something specific stops it. A job
  that fails with a key in its error text is a job you can make fail; a worker run is a
  worker you can start. Only four things count as real blockers: a credential a human must
  obtain, a third-party service that cannot be faked at the boundary that matters, an
  irreversible or publicly visible action, or something that genuinely cannot be induced
  here, with the reason named. "Needs production" is almost never one of them. Observed in
  the wild alongside the 2.1.0 fixes: two criteria skipped for needing "a production job"
  and "a live worker run", both reproducible on the stack the run had already started.


## [2.1.0] - 2026-08-04

### Changed
- Cost is the user's decision. A criterion that can be driven but needs real setup is
  presented with what it would take, while the stack is still up, rather than being moved
  to `Not checked` unilaterally. "Cheapest sufficient proof" means the least setup that
  still observes the behaviour, not permission to skip inconvenient checks.
- A `Not checked` reason must say why the criterion was not driven. If it also claims
  something else covers it, that thing must be named, with a plain statement that this run
  did not re-run it. Observed in the wild: three entries reading "covered by unit
  canaries", where the workflow had not run those tests and could not know.


## [2.0.0] - 2026-08-04

### Changed
- `/verify` works on any change surface, not only a browser. API, datastore, CLI, async,
  and UI each get a real check driven the way a user would drive it.
- The workflow is two halves with a stop between them. Half one writes acceptance criteria
  from the change's plan and waits for approval. Half two runs them and reports.
- Criteria record where they came from: a plan line, an inference from the diff, or an
  assumption the tool made and is telling you about.
- Results report on four separate axes. Whether the code is right, whether the harness
  worked, how much of the branch was covered, and whether causality was established are
  four different answers.
- `Not checked` is always printed, even when empty.

### Removed
- `/verify-setup`. The repository already declares how to run itself; a separate
  onboarding step was skipped in practice and its artifacts never survived a worktree.
- The pipeline: orchestrator, staged prompts, and the headless `claude -p` runner. That is
  a different control loop from a skill, and the skill never called it.
- Existing-test inspection. Whether a unit test exists, and whether it mocks something, is
  a question about the test suite. This plugin answers whether the change works.

### Fixed
- `changed-files` reports an unknown revision with the available refs instead of a stack
  trace, and refuses a base that git would read as an option.
- Files inside `tests/`, `__tests__/`, and `spec/` are excluded, not only files whose name
  ends in `.test.ts`.


## [1.1.0] — 2026-04-23

### Added
- Per-AC video + trace evidence on non-pass verdicts. Each failing AC's directory now contains a Playwright video and trace alongside screenshots, making it easy to diff what the agent saw vs. expected. (#12)
- Inline `/verify-setup` skill — auto-detects dev server port, indexes routes and selectors from your codebase, writes `.verify/config.json` and `.verify/app.json`. No `npm install` needed. (#11)
- Playwright MCP-based `/verify` skill — drives the browser via Playwright MCP directly from Claude Code, no CLI binary required. (#7)

### Changed
- `/verify` skill now uses Playwright MCP directly instead of an external browse binary, simplifying the install path to one `claude mcp add` command. (#7)
- Cookie-based auth replaces credential-based auth — log in once via your normal browser, `/verify-setup` reads the cookie. (#5)

### Removed
- Server directory and SaaS backend — opslane/verify is now a pure Claude Code plugin with no server dependency. Auth state lives in `.verify/auth.json` locally. (#10)
- Standalone CLI package (`@opslane/verify`) — replaced by inline Claude Code skills. (#11)
- Browse binary and v1 pipeline code — superseded by Playwright MCP. (#8)

### Fixed
- `/verify-setup` cookie import flow, `auth.json` export path, and browse-binary download fallback. (#9)

[Unreleased]: https://github.com/opslane/verify/compare/v2.7.0...HEAD
[2.7.0]: https://github.com/opslane/verify/releases/tag/v2.7.0
[2.6.0]: https://github.com/opslane/verify/releases/tag/v2.6.0
[1.1.0]: https://github.com/opslane/verify/releases/tag/v1.1.0
