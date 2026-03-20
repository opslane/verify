# Setup Writer Retry Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When setup SQL fails (bad syntax, missing columns, wrong table names), retry by feeding the psql error back to the setup-writer LLM instead of immediately marking the group as `setup_failed`.

**Architecture:** Mirror the existing planner retry pattern. The orchestrator wraps setup execution in a loop (max 3 attempts). On failure, `buildSetupWriterRetryPrompt` appends the failed SQL + error to the original prompt. DB snapshot is restored between retries for clean state. Two failure types get distinct retry prompts: parse errors ("your output was not valid JSON") and execution errors (failed SQL + psql error message).

**Tech Stack:** TypeScript, Node 22 ESM, vitest

---

### Task 1: Add `SetupRetryContext` type and `buildSetupWriterRetryPrompt` to setup-writer.ts

**Files:**
- Modify: `pipeline/src/stages/setup-writer.ts:29-35`
- Test: `pipeline/test/setup-writer.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/setup-writer.test.ts`. First, update the import at line 3:

```typescript
import { buildSetupWriterPrompt, buildSetupWriterRetryPrompt, parseSetupWriterOutput, detectORM, executeSetupCommands, executeTeardownCommands, validateTeardownCommands } from "../src/stages/setup-writer.js";
```

Then add a new `describe` block after the existing `buildSetupWriterPrompt` tests:

```typescript
describe("buildSetupWriterRetryPrompt", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), `verify-setup-retry-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
  });
  afterEach(() => { rmSync(projectDir, { recursive: true, force: true }); });

  it("includes psql error and failed commands for exec_error", () => {
    const prompt = buildSetupWriterRetryPrompt("group-a", "trialing state", projectDir, {
      type: "exec_error",
      failedCommands: ["psql -c 'UPDATE \"User\" SET LIMIT 1'"],
      error: "ERROR: syntax error at or near \"LIMIT\"",
    });
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("trialing state");
    expect(prompt).toContain("YOUR PREVIOUS SQL FAILED");
    expect(prompt).toContain("LIMIT");
    expect(prompt).toContain("syntax error");
    // Error block should appear BEFORE the "Output ONLY" marker
    const errorIdx = prompt.indexOf("YOUR PREVIOUS SQL FAILED");
    const outputIdx = prompt.indexOf("Output ONLY the JSON");
    expect(errorIdx).toBeLessThan(outputIdx);
  });

  it("includes parse error message for parse_error", () => {
    const prompt = buildSetupWriterRetryPrompt("group-b", "org with members", projectDir, {
      type: "parse_error",
    });
    expect(prompt).toContain("group-b");
    expect(prompt).toContain("YOUR PREVIOUS OUTPUT WAS NOT VALID JSON");
    expect(prompt).toContain("Output ONLY the JSON");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/setup-writer.test.ts`
Expected: FAIL — `buildSetupWriterRetryPrompt` is not exported

**Step 3: Write the implementation**

Add to `pipeline/src/stages/setup-writer.ts` between `buildSetupWriterPrompt` (line 29) and `parseSetupWriterOutput` (line 31). Also add the type:

```typescript
export type SetupRetryContext =
  | { type: "parse_error" }
  | { type: "exec_error"; failedCommands: string[]; error: string };

/**
 * Build a retry prompt that includes the original prompt + error context.
 * For exec_error: appends the failed SQL commands and psql error message.
 * For parse_error: tells the LLM its output was not valid JSON.
 */
export function buildSetupWriterRetryPrompt(
  groupId: string, condition: string, projectRoot: string,
  retryContext: SetupRetryContext,
): string {
  const base = buildSetupWriterPrompt(groupId, condition, projectRoot);

  let retryBlock: string;
  if (retryContext.type === "exec_error") {
    const failedBlock = retryContext.failedCommands
      .map((c, i) => `  Command ${i + 1}: ${c}`)
      .join("\n");
    retryBlock = [
      "",
      "YOUR PREVIOUS SQL FAILED. Fix the error and try again.",
      "",
      "Failed commands:",
      failedBlock,
      "",
      `Error: ${retryContext.error}`,
      "",
      "Analyze the error, fix the SQL, and output corrected JSON.",
      "Common fixes: use Postgres syntax (not MySQL), provide explicit IDs for columns",
      "without defaults, use correct column names from app.json, ensure JSONB values are valid.",
    ].join("\n");
  } else {
    retryBlock = [
      "",
      "YOUR PREVIOUS OUTPUT WAS NOT VALID JSON.",
      "You must output ONLY a JSON object with group_id, condition, setup_commands, and teardown_commands.",
      "No markdown fences, no explanation, no extra text.",
    ].join("\n");
  }

  // Insert before the "Output ONLY" marker so the JSON-only instruction stays last
  const marker = "Output ONLY the JSON.";
  const markerIdx = base.indexOf(marker);
  if (markerIdx === -1) {
    return `${base}\n${retryBlock}`;
  }
  const before = base.slice(0, markerIdx);
  const after = base.slice(markerIdx);
  return `${before}${retryBlock}\n\n${after}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/setup-writer.test.ts`
Expected: PASS — all tests including the 2 new ones

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add pipeline/src/stages/setup-writer.ts pipeline/test/setup-writer.test.ts
git commit -m "feat(pipeline): add buildSetupWriterRetryPrompt with parse_error and exec_error paths"
```

---

### Task 2: Add retry loop to orchestrator's `executeGroup`

**Files:**
- Modify: `pipeline/src/orchestrator.ts:17` (import)
- Modify: `pipeline/src/orchestrator.ts:187-222` (setup block in `executeGroup`)

**Step 1: Update import**

At `pipeline/src/orchestrator.ts:17`, add `buildSetupWriterRetryPrompt` and `SetupRetryContext` to the import:

Change line 20:
```typescript
import { buildSetupWriterPrompt, parseSetupWriterOutput, executeSetupCommands, executeTeardownCommands, loadProjectEnv } from "./stages/setup-writer.js";
```
To:
```typescript
import { buildSetupWriterPrompt, buildSetupWriterRetryPrompt, parseSetupWriterOutput, executeSetupCommands, executeTeardownCommands, loadProjectEnv } from "./stages/setup-writer.js";
import type { SetupRetryContext } from "./stages/setup-writer.js";
```

**Step 2: Replace the setup block in `executeGroup`**

Replace lines 187-222 (the `if (condition) { ... }` block) with the retry loop. The full replacement:

```typescript
    if (condition) {
      const MAX_SETUP_ATTEMPTS = 3;
      let setupSuccess = false;
      let lastRetryContext: SetupRetryContext | null = null;

      for (let attempt = 1; attempt <= MAX_SETUP_ATTEMPTS; attempt++) {
        // Build prompt — original on first attempt, retry with error context after
        const setupPrompt = attempt === 1
          ? buildSetupWriterPrompt(groupId, condition, projectRoot)
          : buildSetupWriterRetryPrompt(groupId, condition, projectRoot, lastRetryContext!);
        const stageName = attempt === 1
          ? `setup-${groupId}`
          : `setup-${groupId}-retry${attempt - 1}`;
        const timeoutMs = attempt === 1 ? 90_000 : 60_000;

        const setupResult = await runClaude({
          prompt: setupPrompt, model: "sonnet", timeoutMs,
          stage: stageName, runDir, ...perms("setup-writer"),
        });
        const commands = parseSetupWriterOutput(setupResult.stdout);
        if (!commands) {
          lastRetryContext = { type: "parse_error" };
          callbacks.onLog(`  Setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS} for ${groupId}: parse error, ${attempt < MAX_SETUP_ATTEMPTS ? "retrying..." : "giving up"}`);
          continue;
        }

        // Restore snapshot if this is a retry (clean slate before re-executing)
        if (attempt > 1 && snapshotPath) {
          const restoreResult = restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
          if (!restoreResult.success) {
            callbacks.onLog(`  Snapshot restore failed for ${groupId} — aborting retries: ${restoreResult.error}`);
            break;  // DB in unknown state, don't retry
          }
        }

        // Snapshot affected tables (first attempt or re-snapshot on retry)
        snapshotTableList = extractTableNames(commands.setup_commands);
        const snapshotDir = join(runDir, "setup", groupId);
        mkdirSync(snapshotDir, { recursive: true });
        snapshotPath = snapshotTables(snapshotTableList, snapshotDir, projectEnv);
        if (attempt === 1 && snapshotPath) {
          callbacks.onLog(`  Snapshotted ${snapshotTableList.length} tables for ${groupId}`);
        }

        // Execute setup SQL
        const setupExec = executeSetupCommands(commands.setup_commands, projectEnv, projectRoot, seedIds);
        if (setupExec.success) {
          setupSuccess = true;
          writeFileSync(join(runDir, "setup", groupId, "commands.json"), JSON.stringify(commands, null, 2));
          break;
        }

        lastRetryContext = {
          type: "exec_error",
          failedCommands: commands.setup_commands,
          error: setupExec.error ?? "Unknown error",
        };
        callbacks.onLog(`  Setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS} for ${groupId}: ${setupExec.error}${attempt < MAX_SETUP_ATTEMPTS ? " — retrying..." : ""}`);
      }

      if (!setupSuccess) {
        // Restore snapshot after all attempts failed
        if (snapshotPath) restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
        const reason = lastRetryContext?.type === "exec_error"
          ? `Setup failed after ${MAX_SETUP_ATTEMPTS} attempts: ${lastRetryContext.error}`
          : `Setup failed after ${MAX_SETUP_ATTEMPTS} attempts: could not produce valid output`;
        for (const ac of groupAcs) {
          allVerdicts.push({ ac_id: ac.id, verdict: "setup_failed", confidence: "high", reasoning: reason });
          progress.update(ac.id, "error", "setup_failed");
        }
        return;
      }
    }
```

**Step 3: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 4: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: 1 test failure — the existing "marks group ACs as setup_failed when setup commands fail" test at `orchestrator.test.ts:305` now triggers retries but only has 1 mock failure. This is expected and we fix it in Task 3.

**Step 5: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(pipeline): setup-writer retry loop — max 3 attempts with error feedback"
```

---

### Task 3: Update existing orchestrator test and add retry tests

**Files:**
- Modify: `pipeline/test/orchestrator.test.ts:304-333` (update existing test)
- Modify: `pipeline/test/orchestrator.test.ts` (add new tests in same describe block)

**Step 1: Update the existing `setup_failed` test**

The existing test at line 305 mocks `executeSetupCommands` to fail once. With the retry loop, the orchestrator now calls `runClaude` up to 3 times for the setup stage, so we need to mock the retry stage results too, and mock `executeSetupCommands` to fail on all attempts.

Replace lines 305-333:

```typescript
    it("marks group ACs as setup_failed after all retry attempts fail", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const acsWithSetup: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: "trial user exists", acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const planWithSetup: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };
      const setupOutput = JSON.stringify({ group_id: "group-a", condition: "trial user exists", setup_commands: ["psql -c 'INSERT...'"], teardown_commands: [] });

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(acsWithSetup) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(planWithSetup) });
      mockRunClaudeResult("setup-group-a", { stdout: setupOutput });
      mockRunClaudeResult("setup-group-a-retry1", { stdout: setupOutput });
      mockRunClaudeResult("setup-group-a-retry2", { stdout: setupOutput });
      mockRunClaudeResult("learner", { stdout: "" });

      // Make executeSetupCommands fail on ALL attempts
      const { executeSetupCommands } = await import("../src/stages/setup-writer.js");
      vi.mocked(executeSetupCommands)
        .mockReturnValueOnce({ success: false, error: "psql: LIMIT not valid" })
        .mockReturnValueOnce({ success: false, error: "psql: LIMIT not valid" })
        .mockReturnValueOnce({ success: false, error: "psql: LIMIT not valid" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      const setupFailed = result.verdicts!.verdicts.filter(v => v.verdict === "setup_failed");
      expect(setupFailed.length).toBe(1);
      expect(setupFailed[0].ac_id).toBe("ac1");
      expect(setupFailed[0].reasoning).toContain("3 attempts");
    });
```

**Step 2: Add test for retry-then-succeed**

Add a new test right after the one above, inside the same `describe("setup failure handling", ...)` block:

```typescript
    it("retries setup and succeeds on second attempt after SQL error", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const acsWithSetup: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: "trial user exists", acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const planWithSetup: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };
      const setupOutput = JSON.stringify({ group_id: "group-a", condition: "trial user exists", setup_commands: ["psql -c 'UPDATE ...'"], teardown_commands: [] });
      const browseOutput = JSON.stringify({ ac_id: "ac1", observed: "Banner visible", screenshots: [], commands_run: [] });

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(acsWithSetup) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(planWithSetup) });
      mockRunClaudeResult("setup-group-a", { stdout: setupOutput });
      mockRunClaudeResult("setup-group-a-retry1", { stdout: setupOutput });
      mockRunClaudeResult("browse-agent-ac1", { stdout: browseOutput });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "Banner visible" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      // Fail first attempt, succeed on retry
      const { executeSetupCommands } = await import("../src/stages/setup-writer.js");
      vi.mocked(executeSetupCommands)
        .mockReturnValueOnce({ success: false, error: "psql: syntax error at LIMIT" })
        .mockReturnValueOnce({ success: true });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      // Should NOT have setup_failed — retry succeeded
      const setupFailed = result.verdicts!.verdicts.filter(v => v.verdict === "setup_failed");
      expect(setupFailed.length).toBe(0);

      // Should see retry log message
      expect(logs.some(l => l.includes("retrying"))).toBe(true);

      // The retry stage should have been called
      const retryCalls = runClaudeCalls.filter(c => c.stage === "setup-group-a-retry1");
      expect(retryCalls.length).toBe(1);
    });
```

**Step 3: Add test for parse failure retry**

Add another test in the same block:

```typescript
    it("retries setup on parse failure with distinct prompt", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const acsWithSetup: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: "trial user exists", acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const planWithSetup: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };
      const goodSetupOutput = JSON.stringify({ group_id: "group-a", condition: "trial user exists", setup_commands: ["psql -c 'UPDATE ...'"], teardown_commands: [] });
      const browseOutput = JSON.stringify({ ac_id: "ac1", observed: "Banner visible", screenshots: [], commands_run: [] });

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(acsWithSetup) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(planWithSetup) });
      // First attempt: LLM returns garbage, not parseable JSON
      mockRunClaudeResult("setup-group-a", { stdout: "Here is the setup SQL: ..." });
      // Retry: returns valid JSON
      mockRunClaudeResult("setup-group-a-retry1", { stdout: goodSetupOutput });
      mockRunClaudeResult("browse-agent-ac1", { stdout: browseOutput });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { executeSetupCommands } = await import("../src/stages/setup-writer.js");
      vi.mocked(executeSetupCommands).mockReturnValueOnce({ success: true });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      // Should NOT have setup_failed — retry succeeded
      const setupFailed = result.verdicts!.verdicts.filter(v => v.verdict === "setup_failed");
      expect(setupFailed.length).toBe(0);

      // Parse error retry log
      expect(logs.some(l => l.includes("parse error"))).toBe(true);
    });
```

**Step 4: Run tests to verify all pass**

Run: `cd pipeline && npx vitest run`
Expected: PASS — all 203 existing + 3 new orchestrator tests + 2 new setup-writer tests = 208 total

**Step 5: Commit**

```bash
git add pipeline/test/orchestrator.test.ts
git commit -m "test(pipeline): setup-writer retry — exhaustion, success-on-retry, parse-error-retry"
```

---

### Task 4: Reduce setup-writer timeout in cli.ts

**Files:**
- Modify: `pipeline/src/cli.ts:259`

The `run-stage setup-writer` CLI path uses `240_000` as the default timeout. Since the setup-writer no longer explores source code (it only reads app.json + schema.sql + learnings.md), reduce this to 90s to match the orchestrator.

**Step 1: Update timeout**

Change line 259:
```typescript
      const result = await runClaude({ prompt, model: "sonnet", timeoutMs: timeoutOverrideMs ?? 240_000, stage: "setup-writer", runDir, ...permissions });
```
To:
```typescript
      const result = await runClaude({ prompt, model: "sonnet", timeoutMs: timeoutOverrideMs ?? 90_000, stage: "setup-writer", runDir, ...permissions });
```

**Step 2: Typecheck + run tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS — no behavior change, just a timeout value

**Step 3: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "perf(pipeline): reduce setup-writer timeout from 240s to 90s — no longer explores codebase"
```

---

## Summary

| Task | Files | What |
|------|-------|------|
| 1 | `setup-writer.ts`, `setup-writer.test.ts` | `SetupRetryContext` type + `buildSetupWriterRetryPrompt` + 2 unit tests |
| 2 | `orchestrator.ts` | Retry loop in `executeGroup` — max 3 attempts, re-snapshot, abort on restore failure |
| 3 | `orchestrator.test.ts` | Update existing test + 2 new integration tests (retry-succeed, parse-error-retry) |
| 4 | `cli.ts` | Reduce setup-writer default timeout from 240s to 90s |

**Total: 4 files modified, 0 new files, 5 new tests.**

## Verification (run in this order before final commit)

1. `cd pipeline && npx tsc --noEmit` — no type errors
2. `cd pipeline && npx vitest run` — all tests pass (208 expected)
