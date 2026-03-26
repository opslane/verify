# Browse Agent Evals V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a fast, browse-only eval suite that measures browse-agent reliability before any hardening work lands.

**Architecture:** Reuse the existing `run-stage browse-agent` entrypoint and swap in a deterministic fake browse CLI via `BROWSE_BIN`. Each eval case provides a frozen `plan.json`, scripted browse-command responses, and assertion rules. The runner executes the real browse-agent prompt/model path, captures logs/results, and scores output without involving the judge or learner.

**Tech Stack:** TypeScript, tsx, vitest, existing pipeline CLI, JSON fixtures

---

### Task 1: Define the browse-eval fixture format

**Files:**
- Create: `pipeline/evals/browse-agent/README.md`
- Create: `pipeline/evals/browse-agent/cases/tooltip-hover-success/plan.json`
- Create: `pipeline/evals/browse-agent/cases/tooltip-hover-success/browse-script.json`
- Create: `pipeline/evals/browse-agent/cases/tooltip-hover-success/expected.json`
- Create: `pipeline/evals/browse-agent/cases/tooltip-hover-timeout/plan.json`
- Create: `pipeline/evals/browse-agent/cases/tooltip-hover-timeout/browse-script.json`
- Create: `pipeline/evals/browse-agent/cases/tooltip-hover-timeout/expected.json`
- Create: `pipeline/evals/browse-agent/cases/dialog-css-required/plan.json`
- Create: `pipeline/evals/browse-agent/cases/dialog-css-required/browse-script.json`
- Create: `pipeline/evals/browse-agent/cases/dialog-css-required/expected.json`
- Create: `pipeline/evals/browse-agent/cases/keyboard-nav/plan.json`
- Create: `pipeline/evals/browse-agent/cases/keyboard-nav/browse-script.json`
- Create: `pipeline/evals/browse-agent/cases/keyboard-nav/expected.json`
- Create: `pipeline/evals/browse-agent/cases/wait-for-data/plan.json`
- Create: `pipeline/evals/browse-agent/cases/wait-for-data/browse-script.json`
- Create: `pipeline/evals/browse-agent/cases/wait-for-data/expected.json`
- Create: `pipeline/evals/browse-agent/cases/auth-redirect/plan.json`
- Create: `pipeline/evals/browse-agent/cases/auth-redirect/browse-script.json`
- Create: `pipeline/evals/browse-agent/cases/auth-redirect/expected.json`

**Step 1: Document the fixture contract**

Write `pipeline/evals/browse-agent/README.md` explaining that each case contains:

- `plan.json`: one AC in normal pipeline shape
- `browse-script.json`: deterministic command-response mapping for the fake browse CLI
- `expected.json`: assertions for scoring

Include this exact `expected.json` shape in the doc:

```json
{
  "ac_id": "ac1",
  "expect_parseable_result": true,
  "expect_result_kind": "normal",
  "required_commands": ["goto", "snapshot", "hover", "screenshot"],
  "forbidden_shell_patterns": ["rg ", "grep ", "find ", "git ", "ls "],
  "required_observed_substrings": ["tooltip", "days left"],
  "forbidden_observed_substrings": ["login", "error"],
  "max_command_count": 6,
  "max_duration_ms": 20000
}
```

**Step 2: Seed the first six cases**

Use these case intents:

- `tooltip-hover-success`: the correct path is `goto -> snapshot -> hover -> snapshot -> screenshot`
- `tooltip-hover-timeout`: `hover @e70` returns timeout; the agent should fail fast after one failure
- `dialog-css-required`: snapshot shows a dialog and an `@e` path is misleading; expected end state is a successful dialog interaction using a CSS selector
- `keyboard-nav`: expected path includes `press Tab` or `press ArrowDown`
- `wait-for-data`: the first snapshot shows loading; success requires a `wait`
- `auth-redirect`: first snapshot shows a login page; success is reporting auth redirect without trying to log in

**Step 3: Keep each case single-AC and browse-only**

Every `plan.json` should contain exactly one criterion. Do not include judge or learner artifacts. v1 is measuring browse-stage behavior only.

**Step 4: Commit**

```bash
git add pipeline/evals/browse-agent
git commit -m "test(pipeline): add browse-agent eval fixture corpus"
```

---

### Task 2: Build the fake browse CLI

**Files:**
- Create: `pipeline/src/evals/browse-eval-types.ts`
- Create: `pipeline/src/evals/fake-browse.ts`
- Test: `pipeline/test/fake-browse.test.ts`

**Step 1: Define the scripted response types**

In `pipeline/src/evals/browse-eval-types.ts`, add the fixture types:

```typescript
export interface BrowseScriptStep {
  match: string;
  stdout?: string;
  stderr?: string;
  exitCode: number;
  sleepMs?: number;
}

export interface BrowseScript {
  steps: BrowseScriptStep[];
}

export interface BrowseEvalExpectation {
  ac_id: string;
  expect_parseable_result: boolean;
  expect_result_kind: "normal" | "nav_failure";
  required_commands: string[];
  forbidden_shell_patterns: string[];
  required_observed_substrings: string[];
  forbidden_observed_substrings: string[];
  max_command_count: number;
  max_duration_ms: number;
}
```

**Step 2: Implement the fake CLI**

Write `pipeline/src/evals/fake-browse.ts` as a Node CLI. It should:

- Read `BROWSE_EVAL_SCRIPT` for the path to `browse-script.json`
- Read `BROWSE_EVAL_TRACE` for the path to append JSONL trace entries
- Join `process.argv.slice(2)` into one command string such as `hover @e70`
- Find the first scripted response whose `match` is an exact prefix of the command string
- Write one trace line with `ts`, `command`, `exitCode`, `stdout`, `stderr`
- Print `stdout`/`stderr`, sleep if requested, and exit with the scripted `exitCode`

If no scripted response matches, return exit code `99` with stderr `UNSCRIPTED COMMAND`.

**Step 3: Write the failing test**

In `pipeline/test/fake-browse.test.ts`, add a test that:

- Creates a temporary `browse-script.json`
- Invokes `node src/evals/fake-browse.ts snapshot`
- Verifies stdout matches the scripted value
- Verifies trace file contains the command
- Verifies an unscripted command exits non-zero

**Step 4: Run tests**

Run:

```bash
cd pipeline && npx vitest run test/fake-browse.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/evals/browse-eval-types.ts pipeline/src/evals/fake-browse.ts pipeline/test/fake-browse.test.ts
git commit -m "test(pipeline): add fake browse CLI for deterministic evals"
```

---

### Task 3: Build the browse-eval scorer

**Files:**
- Create: `pipeline/src/evals/browse-eval-score.ts`
- Test: `pipeline/test/browse-eval-score.test.ts`

**Step 1: Implement scorer inputs**

The scorer should read:

- `result.json` if present
- the fake browse `trace.jsonl`
- `logs/browse-agent-<ac>-stream.jsonl`
- `expected.json`

**Step 2: Implement score rules**

In `pipeline/src/evals/browse-eval-score.ts`, produce this shape:

```typescript
export interface BrowseEvalResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  commandCount: number;
}
```

Score the following:

- parseability matches expectation
- result kind is `normal` vs `nav_failure`
- required browse commands were actually run
- command count is within limit
- duration is within limit
- observed text contains required substrings and excludes forbidden substrings
- no forbidden shell usage appears in the Claude stream log

For forbidden shell usage, scan the raw stream log for substrings such as `rg `, `grep `, `find `, `git `, `ls ` from `expected.json`.

**Step 3: Write the failing tests**

In `pipeline/test/browse-eval-score.test.ts`, add:

- a passing case with parseable result and matching trace
- a failing case where `hover` is missing from the command trace
- a failing case where the stream log shows `rg src`
- a failing case where duration exceeds threshold

**Step 4: Run tests**

Run:

```bash
cd pipeline && npx vitest run test/browse-eval-score.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/evals/browse-eval-score.ts pipeline/test/browse-eval-score.test.ts
git commit -m "test(pipeline): add browse eval scorer"
```

---

### Task 4: Build the eval runner around the existing browse-agent stage

**Files:**
- Create: `pipeline/src/evals/run-browse-evals.ts`
- Modify: `pipeline/package.json`
- Test: `pipeline/test/browse-eval-runner.test.ts`

**Step 1: Reuse the existing CLI stage**

In `pipeline/src/evals/run-browse-evals.ts`, for each case directory:

- create a temporary verify dir with `config.json`
- create a temporary run dir with the case `plan.json`
- set:
  - `BROWSE_BIN="node <abs path>/src/evals/fake-browse.ts"`
  - `BROWSE_EVAL_SCRIPT=<case browse-script.json>`
  - `BROWSE_EVAL_TRACE=<runDir>/trace.jsonl`
- invoke:

```bash
npx tsx src/cli.ts run-stage browse-agent --verify-dir <tmpVerifyDir> --run-dir <tmpRunDir> --ac ac1
```

- score the resulting artifacts

Do not call the full pipeline. Do not run judge or learner.

**Step 2: Print a concise report**

Print one line per case:

```text
PASS tooltip-hover-success  6 cmds  8421ms
FAIL tooltip-hover-timeout  missing nav_failure result
```

Then print a summary block:

```text
Summary: 4/6 passed
Median duration: 9.2s
Timeout-like failures: 2
```

**Step 3: Add npm script**

Modify `pipeline/package.json`:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "eval:browse": "tsx src/evals/run-browse-evals.ts"
  }
}
```

**Step 4: Write runner tests**

In `pipeline/test/browse-eval-runner.test.ts`, mock `execFileSync` or child process execution so the test verifies:

- every case is discovered
- environment variables are set correctly
- the runner surfaces pass/fail counts

**Step 5: Run tests**

Run:

```bash
cd pipeline && npx vitest run test/browse-eval-runner.test.ts
cd pipeline && npm run typecheck
```

Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/evals/run-browse-evals.ts pipeline/package.json pipeline/test/browse-eval-runner.test.ts
git commit -m "test(pipeline): add browse-agent eval runner"
```

---

### Task 5: Establish the baseline and lock the first score

**Files:**
- Create: `pipeline/evals/browse-agent/baselines/README.md`
- Create: `pipeline/evals/browse-agent/baselines/v1-baseline.json`
- Modify: `pipeline/evals/browse-agent/README.md`

**Step 1: Run the eval suite against current main**

Run:

```bash
cd pipeline && npm run eval:browse
```

Capture:

- total pass count
- median duration
- failures by capability: hover, dialog, keyboard, wait, auth

**Step 2: Save the baseline**

Write `pipeline/evals/browse-agent/baselines/v1-baseline.json`:

```json
{
  "recorded_at": "2026-03-22T00:00:00Z",
  "cases": 6,
  "passed": 0,
  "median_duration_ms": 0,
  "notes": "Initial browse-only baseline before hardening"
}
```

Replace numbers with the actual first run.

**Step 3: Document the gate for future browse hardening**

Update `pipeline/evals/browse-agent/README.md` with the rule:

- No browse-agent hardening change is considered an improvement unless `npm run eval:browse` improves total pass count or lowers median duration without regressions.

**Step 4: Commit**

```bash
git add pipeline/evals/browse-agent/baselines pipeline/evals/browse-agent/README.md
git commit -m "test(pipeline): record browse-agent eval baseline"
```

---

### Task 6: Verification before hardening work starts

**Files:**
- No code changes

**Step 1: Run the full eval test surface**

Run:

```bash
cd pipeline && npx vitest run test/fake-browse.test.ts test/browse-eval-score.test.ts test/browse-eval-runner.test.ts
cd pipeline && npm run eval:browse
```

Expected:

- unit tests: PASS
- runner executes all six cases
- summary prints deterministic baseline numbers

**Step 2: Sanity-check scope**

Verify the suite does **not** depend on:

- a dev server
- a real browser daemon
- judge stage
- learner stage

If any of these are required, the implementation is too broad for v1 and must be reduced.

**Step 3: Record deferred v2 work in README**

List these explicitly as deferred:

- real DOM harness app
- frozen real-repo cases
- judge-in-the-loop evaluation
- cross-run trend dashboard

**Step 4: Commit**

```bash
git add pipeline/evals/browse-agent/README.md
git commit -m "docs(pipeline): scope browse-agent evals v1 to deterministic local baseline"
```

