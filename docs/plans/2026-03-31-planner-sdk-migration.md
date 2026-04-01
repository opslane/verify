# Planner SDK Migration: Transport-Only Change

## Context

The planner stage converts acceptance criteria into browser test plans. Today it's a 52-line wrapper around `claude -p` (Opus, 240s) that uses Read/Grep/Glob to explore the codebase and app.json. We're migrating to the Claude Agent SDK for structured error handling, tool call logging, and timeout control.

**What changed from the original plan:** Spikes (2026-03-31) proved that the planner needs tool access to grep the codebase — removing tools caused 75% of ACs to time out because the planner couldn't discover query params like `?tab=invites`. The two-agent split and Sonnet downgrade also showed no benefit. The migration is now transport-only: same prompt, same tools, same model, just swap `claude -p` for the SDK `query()`.

## Spike Findings (summary)

Full details in the "Spike Results" section at the end.

- **Two-agent split unnecessary** — single agent with `example_urls` from route-resolver handles URLs fine
- **Tools are load-bearing** — planner reads app.json as an index, then greps the codebase for query params, component structure, selectors. Removing tools → 1/4 pass rate (vs 5/6 with tools)
- **app.json is essential but insufficient** — it's the starting index; tools provide the detail lookup
- **Prompt quality > model > architecture** — the real `planner.txt` rules are what make plans executable
- **Model choice doesn't matter** — Sonnet and Opus produce equivalent downstream results with the real prompt; use Opus since cost isn't a constraint

## Baseline (established 2026-03-31)

Eval set: 42 runs, 174 ACs from documenso with known downstream verdicts.

| Metric | Current Planner |
|--------|----------------|
| Avg structural score | **0.967** |
| Validator clean | 88% |
| Route matched | 100% |
| Uses example URLs | 88% |
| Starts with navigation | 100% |
| Has screenshot | 100% |
| Has wait after nav | 100% |
| No login steps | 98% |
| Step count in [3,10] | 96% |
| Timeout valid | 100% |

Known defects: 12% of ACs have invented URL params (planner ignores `example_urls`), correlating with `error` verdicts downstream.

Eval scorer: `pipeline/src/evals/planner-eval.ts`
Eval set: `/tmp/documenso-verify/evals/planner-eval-set.json`
Baseline: `/tmp/documenso-verify/evals/planner-baseline.json`

## Architecture

```
Current (CLI):
  ACs ──▶ claude -p (Opus, Read/Grep/Glob, 240s) ──▶ plan-validator ──▶ retry ──▶ plan.json

SDK:
  ACs ──▶ query() (Opus, same tools via dangerouslySkipPermissions, 240s) ──▶ plan-validator ──▶ retry ──▶ plan.json
```

No architecture change. The SDK gives us:
- Structured tool call logging (vs parsing NDJSON from stdout)
- Proper timeout via AbortController (vs SIGTERM)
- Typed error handling (vs parsing exit codes)
- maxTurns control (vs unbounded)

## Files

### Create
1. `pipeline/src/stages/planner-sdk.ts` — SDK wrapper, follows `setup-writer-sdk.ts` pattern

### Modify
2. `pipeline/src/sdk/errors.ts` — Add `PlannerError` enum
3. `pipeline/src/orchestrator.ts` — Wire SDK path with `VERIFY_PLANNER_SDK=1` toggle
4. `pipeline/src/cli.ts` — Add `eval-planner` command

### Existing (reuse as-is)
- `pipeline/src/stages/planner.ts` — `buildPlannerPrompt()`, `parsePlannerOutput()`, `buildRetryPrompt()`, `filterPlanErrors()`
- `pipeline/src/stages/plan-validator.ts` — `validatePlan()`
- `pipeline/src/sdk/tools/run-sql.ts` — pattern reference for SDK tool creation
- `pipeline/src/evals/planner-eval.ts` — eval scorer
- `@anthropic-ai/claude-agent-sdk` — already in package.json from setup-writer migration

## Implementation

### Task 1: PlannerError enum

**sdk/errors.ts** — Add after existing `SetupError`:
```typescript
export enum PlannerError {
  EMPTY_RESPONSE = "empty_response",
  PARSE_ERROR = "parse_error",
  TIMEOUT = "timeout",
  MAX_TURNS = "max_turns",
  SPAWN_ERROR = "spawn_error",
}
```

### Task 2: planner-sdk.ts

Follow `setup-writer-sdk.ts` exactly. Key differences from setup-writer:
- No custom MCP tool — planner uses `dangerouslySkipPermissions` for Read/Grep/Glob (same as CLI path)
- Prompt comes from `buildPlannerPrompt()` (unchanged)
- Output parsed by `parsePlannerOutput()` (unchanged)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PlannerError } from "../sdk/errors.js";
import { buildPlannerPrompt, parsePlannerOutput, buildRetryPrompt } from "./planner.js";
import { validatePlan } from "./plan-validator.js";
import type { PlannerOutput, AppIndex } from "../lib/types.js";

export interface PlannerSDKResult {
  plan: PlannerOutput | null;
  error?: PlannerError;
  errorDetail?: string;
  durationMs: number;
}

export async function runPlannerSDK(opts: {
  acsPath: string;
  appIndex: AppIndex | null;
  timeoutMs: number;
  stage: string;
  runDir: string;
  cwd: string;
}): Promise<PlannerSDKResult>
```

**Flow:**
```
1. buildPlannerPrompt(acsPath)
2. query({ prompt, options: { permissionMode: "dontAsk", maxTurns: 20, abortController } })
3. Collect result text
4. parsePlannerOutput(text)
5. validatePlan(plan, appIndex)
6. If invalid → buildRetryPrompt() → query() again (same as CLI retry)
7. Write logs: prompt, output, session log
8. Return PlannerSDKResult
```

**Key details:**
- `permissionMode: "dontAsk"` — equivalent to `dangerouslySkipPermissions` in CLI
- `maxTurns: 20` — planner typically uses 10-17 tool calls; 20 gives headroom
- AbortController timeout at `timeoutMs` (default 240s)
- Log format matches CLI: `{stage}-prompt.txt`, `{stage}-output.txt`, `{stage}-session.log`
- No MCP server needed — the SDK handles Read/Grep/Glob natively when permissionMode is dontAsk

### Task 3: Orchestrator wiring

Add `VERIFY_PLANNER_SDK=1` env toggle in Stage 2. The toggle is already partially wired from the spike — clean it up:

```typescript
if (process.env.VERIFY_PLANNER_SDK === "1") {
  const { runPlannerSDK } = await import("./stages/planner-sdk.js");
  const sdkResult = await runPlannerSDK({
    acsPath: join(runDir, "acs.json"),
    appIndex,
    timeoutMs: 240_000,
    stage: "planner",
    runDir,
    cwd: projectRoot,
  });
  plan = sdkResult.plan;
  // SDK handles retry internally
} else {
  // Existing CLI path (unchanged)
}
```

Remove the `spike-planner.ts` import that was added during the spike.

### Task 4: CLI eval command

Add `eval-planner` to cli.ts:
```
npx tsx src/cli.ts eval-planner --run-dir <path>   # score a single run
npx tsx src/cli.ts eval-planner                     # score full eval set
```

This just calls `planner-eval.ts` — the scorer already exists.

## Verification

1. `cd pipeline && npx tsc --noEmit` — types clean
2. `cd pipeline && npx vitest run` — existing tests pass
3. Score SDK path against baseline:
   ```
   # Run pipeline with SDK planner on a real spec
   VERIFY_PLANNER_SDK=1 npx tsx src/cli.ts run --spec .verify/spec.md --verify-dir .verify

   # Score the run
   npx tsx src/evals/planner-eval.ts --run-dir .verify/runs/<run-id>

   # Compare against baseline (must be >= 0.967 avg structural)
   ```
4. Full pipeline A/B: run same spec with and without `VERIFY_PLANNER_SDK=1`, compare verdicts
5. Gate: no regressions in structural score or downstream pass rate

## Execution Order

### Phase 1: Foundation (parallel, no deps)
1. Task 1: PlannerError enum
2. Task 4: CLI eval command

### Phase 2: Core (sequential)
3. Task 2: planner-sdk.ts (depends on Task 1)
4. Task 3: Orchestrator wiring (depends on Task 2)

### Phase 3: Verification
5. Run eval scorer on SDK output
6. Full pipeline A/B test

## What already exists
- `setup-writer-sdk.ts` — SDK pattern to follow (query(), error handling, logging, abort)
- `sdk/errors.ts` — error enum pattern
- `planner.ts` — prompt builder, output parser, retry logic (reused as-is)
- `plan-validator.ts` — validation (reused as-is)
- `planner-eval.ts` — eval scorer with 42-case baseline
- `orchestrator.ts` — VERIFY_SPIKE_PLANNER toggle (replace with VERIFY_PLANNER_SDK)
- `@anthropic-ai/claude-agent-sdk` — already installed

## NOT in scope
- Changing the prompt (planner.txt stays as-is)
- Changing the model (stays Opus)
- Changing the tools (stays Read/Grep/Glob via dangerouslySkipPermissions)
- Two-agent split (proven unnecessary by spike)
- Removing CLI fallback (keep until SDK is proven)
- Fixing the 12% invented-URL-params defect (separate improvement, not migration)

## Failure modes

```
CODEPATH          | FAILURE MODE     | RESCUED? | TEST?    | USER SEES   | LOGGED?
──────────────────|──────────────────|──────────|──────────|─────────────|────────
query()           | SDK timeout      | Y        | Eval     | plan_error  | Y
query()           | Empty response   | Y        | Eval     | plan_error  | Y
query()           | Max turns        | Y        | Eval     | plan_error  | Y
query()           | Abort/crash      | Y        | Eval     | plan_error  | Y
parsePlannerOutput| Parse failure    | Y        | Existing | Retry       | Y
validatePlan      | Template vars    | Y        | Existing | Retry       | Y
validatePlan      | Bad params       | Y        | Existing | plan_error  | Y
```

---

## Spike Results (2026-03-31)

### Phase 1: Validator-level comparison (56 ACs, 12 real runs)

| Metric | Spike A (Single, Sonnet) | Spike B (Two-Agent, Sonnet) |
|--------|--------------------------|----------------------------|
| Validator-clean | 56/56 (100%) | 56/56 (100%) |
| URL match baseline | 48/56 (86%) | 54/56 (96%) |
| Avg steps/AC | 6.7 | 6.0 |
| Duration | 508s | 696s |
| LLM calls | 12 | ~68 |

Both 100% validator-clean, but so is the current Opus planner on all historical runs.

### Phase 2: E2E downstream execution

- Simplified prompt caused regressions for both Sonnet and Opus
- Real planner.txt prompt fixed all regressions for both models
- Prompt quality matters more than model choice

### Phase 3: Full pipeline A/B test (PR #2636)

| | Current (Opus + tools) | Spike (Opus, no tools) |
|---|---|---|
| Planner time | 74s | 20s |
| ACs planned | 6/6 | 4/6 |
| Browse passes | **5/6** | 1/4 |
| Browse timeouts | 0 | **3/4** |

Root cause: spike couldn't discover `?tab=invites` without grep access to the codebase.

### Tool call analysis (PR #2636)

The current planner reads app.json first (index), then greps the codebase for query params and component structure. Both are load-bearing.

### Spike artifacts

- `pipeline/src/evals/spike-planner-single-agent.ts`
- `pipeline/src/evals/spike-planner-two-agent.ts`
- `pipeline/src/evals/spike-planner-e2e.ts`
- `pipeline/src/stages/spike-planner.ts` (proven insufficient — remove before merge)
