# Verify Pipeline: Compute Browse Agent Timeout from Step Count

## Problem

The browse agent timeout is hardcoded with a 120s floor (`Math.max(ac.timeout_seconds, 120)`). The planner LLM always outputs `timeout_seconds: 120` because it has no calibration data for how long browse commands take. Multi-step UI flows routinely need 18-20 browse commands × ~7s each ≈ 126-140s, causing agents to time out on the final screenshot step. This is a recurring issue — bumping the floor just plays whack-a-mole.

## Solution

Remove `timeout_seconds` from the planner output contract entirely. Compute timeout deterministically in the orchestrator based on step count.

### Timeout Formula

```ts
const SECONDS_PER_STEP = 20; // ~3 browse commands per step × ~7s each (including LLM thinking)
const MIN_TIMEOUT_S = 90;
const MAX_TIMEOUT_S = 300;

export function computeTimeoutMs(steps: string[]): number {
  const seconds = Math.min(Math.max(steps.length * SECONDS_PER_STEP, MIN_TIMEOUT_S), MAX_TIMEOUT_S);
  return seconds * 1000;
}
```

Use the enriched steps (after nav hint splicing) as input, since that's what the agent actually executes.

## Files to Change

### Source (5 files)

1. **`pipeline/src/orchestrator.ts`**
   - Add `computeTimeoutMs(steps: string[])` helper (exported for CLI use)
   - Line 286: replace `Math.max(ac.timeout_seconds, 120) * 1000` → `computeTimeoutMs(enrichedAc.steps)`
   - Line 338: replace `Math.max(ac.timeout_seconds, 120) * 1000` → `computeTimeoutMs(retryAc.steps)`
   - Line 294: update reasoning string from `ac.timeout_seconds` to computed value
   - Line 345: same

2. **`pipeline/src/lib/types.ts`**
   - Line 50: remove `timeout_seconds: number;` from `PlannedAC` interface

3. **`pipeline/src/stages/plan-validator.ts`**
   - Remove `MIN_TIMEOUT` and `MAX_TIMEOUT` constants (lines 5-6)
   - Remove timeout bounds check (lines 50-55)

4. **`pipeline/src/prompts/planner.txt`**
   - Line 28: remove `"timeout_seconds": 120` from the JSON example

5. **`pipeline/src/cli.ts`**
   - Line 288: remove `timeout_seconds: number` from inline type assertion
   - Line 300: replace `(ac.timeout_seconds ?? 90) * 1000` → `computeTimeoutMs(ac.steps)` (import from orchestrator)

### Tests & Fixtures (4 files)

6. **`pipeline/test/orchestrator.test.ts`**
   - Remove `timeout_seconds` from `FIXTURE_PLAN` (lines 93-94) and all inline plan objects
   - Add test: "computes timeout from step count" — verify that an AC with 10 steps gets `10 * 20 * 1000 = 200_000` ms timeout

7. **`pipeline/test/plan-validator.test.ts`**
   - Remove "catches timeout out of bounds (too low)" test (lines 44-48)
   - Remove "catches timeout out of bounds (too high)" test (lines 50-54)

8. **`pipeline/test/fixtures/plan.json`**
   - Remove `"timeout_seconds": 90` (line 10)

9. **`pipeline/test/fixtures/plan-invalid.json`**
   - Remove `"timeout_seconds": 30` (line 10) and `"timeout_seconds": 500` (line 19)

## Verification

```bash
cd ~/.claude/tools/verify/pipeline && npx vitest run
```

All existing tests should pass (minus the two removed timeout validation tests). The new test should confirm step-based timeout computation.
