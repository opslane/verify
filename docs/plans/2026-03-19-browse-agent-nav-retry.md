# Browse Agent Nav Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a browse agent can't find an element (wrong tab/sub-view), fail fast, replan with a page snapshot, and retry once — instead of thrashing for 5 minutes.

**Architecture:** Browse agent detects "Operation timed out" from `gstack browse click`, stops immediately, captures a DOM snapshot. Orchestrator sends snapshot + failed steps to a lightweight replan prompt. If replan succeeds, browse agent retries with corrected steps. Learner records navigation facts for future runs.

**Tech Stack:** TypeScript, vitest, `claude -p`, gstack browse CLI

---

### Task 1: Add NavFailure type, update BrowseResult, add replan permissions

**Files:**
- Modify: `pipeline/src/lib/types.ts:76-82,165-172`

**Step 1: Write the type additions**

In `pipeline/src/lib/types.ts`, add `NavFailure` interface before `BrowseResult` and add the optional field:

```typescript
export interface NavFailure {
  failed_step: string;
  error: string;
  page_snapshot: string;
}

export interface BrowseResult {
  ac_id: string;
  observed: string;
  screenshots: string[];                // filenames relative to evidence dir
  commands_run: string[];
  nav_failure?: NavFailure;             // present when element not found on current view
}
```

**Step 2: Add replan stage permissions**

In the `STAGE_PERMISSIONS` map in the same file, add an entry for the replan stage. The replan LLM only needs to read the `replan-input.json` file — it must NOT get `dangerouslySkipPermissions` because its input contains user-controlled DOM content (the page snapshot):

```typescript
export const STAGE_PERMISSIONS: Record<string, Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools">> = {
  "ac-generator":  { dangerouslySkipPermissions: true },
  "planner":       { dangerouslySkipPermissions: true },
  "setup-writer":  { allowedTools: ["Bash"] },
  "browse-agent":  { allowedTools: ["Bash", "Read"] },
  "browse-replan": { allowedTools: ["Read"] },             // reads replan-input.json only
  "judge":         { allowedTools: ["Read"] },
  "learner":       { dangerouslySkipPermissions: true },
};
```

**Step 3: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS (no code references nav_failure yet, so adding an optional field is safe)

**Step 4: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): add NavFailure type, BrowseResult field, replan permissions"
```

---

### Task 2: Update parseBrowseResult to handle nav_failure

**Files:**
- Modify: `pipeline/src/stages/browse-agent.ts:47-54`
- Test: `pipeline/test/browse-agent.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/browse-agent.test.ts` inside the existing `describe("parseBrowseResult", ...)` block:

```typescript
  it("parses nav_failure result", () => {
    const output = JSON.stringify({
      ac_id: "ac1",
      nav_failure: {
        failed_step: "click [data-testid=event-type-options-1159]",
        error: "Operation timed out: click: Timeout 5000ms exceeded.",
        page_snapshot: "Tabs: [Personal] [Seeded Team]\nEvent types: 30 min meeting",
      },
      screenshots: ["nav-failure.png"],
      commands_run: ["goto http://localhost:3000/event-types", "click [data-testid=event-type-options-1159]"],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.ac_id).toBe("ac1");
    expect(result!.nav_failure).toBeDefined();
    expect(result!.nav_failure!.failed_step).toBe("click [data-testid=event-type-options-1159]");
    expect(result!.nav_failure!.page_snapshot).toContain("Seeded Team");
    expect(result!.observed).toBe("Nav failure: could not find [data-testid=event-type-options-1159]");
  });

  it("parses normal result without nav_failure", () => {
    const output = JSON.stringify({
      ac_id: "ac1", observed: "Banner visible",
      screenshots: ["s.png"], commands_run: ["goto ..."],
    });
    const result = parseBrowseResult(output);
    expect(result).not.toBeNull();
    expect(result!.nav_failure).toBeUndefined();
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/browse-agent.test.ts`
Expected: FAIL — the nav_failure test fails because `parseBrowseResult` returns null when `observed` is missing (nav_failure results have no `observed` field)

**Step 3: Update parseBrowseResult**

In `pipeline/src/stages/browse-agent.ts`, replace the `parseBrowseResult` function:

```typescript
export function parseBrowseResult(raw: string): BrowseResult | null {
  const parsed = parseJsonOutput<BrowseResult>(raw);
  if (!parsed) return null;

  // Nav failure result: no observed, but has nav_failure
  if (parsed.nav_failure && typeof parsed.nav_failure.failed_step === "string") {
    // Synthesize an observed string for downstream consumers (judge, etc.)
    if (typeof parsed.observed !== "string" || !parsed.observed) {
      const selector = parsed.nav_failure.failed_step.replace(/^(click|fill)\s+/, "");
      parsed.observed = `Nav failure: could not find ${selector}`;
    }
  } else if (typeof parsed.observed !== "string") {
    return null;
  }

  // Ensure arrays default to empty if LLM omits them
  if (!Array.isArray(parsed.screenshots)) parsed.screenshots = [];
  if (!Array.isArray(parsed.commands_run)) parsed.commands_run = [];
  return parsed;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/browse-agent.test.ts`
Expected: PASS

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/stages/browse-agent.ts pipeline/test/browse-agent.test.ts
git commit -m "feat(pipeline): parseBrowseResult handles nav_failure output"
```

---

### Task 3: Update browse-agent.txt prompt with fail-fast protocol

**Files:**
- Modify: `pipeline/src/prompts/browse-agent.txt`

**Step 1: Add the element-not-found protocol**

In `pipeline/src/prompts/browse-agent.txt`, replace the CRITICAL RULES section (lines 24-36) with:

```
CRITICAL RULES:
1. Copy the URL from the instructions file character-for-character.
2. Take a snapshot after navigation to understand the page state.
3. If you see a login page or auth redirect, report it in "observed" — do NOT try to log in.
4. ELEMENT NOT FOUND — If any `browse click` or `browse fill` command returns
   "Operation timed out" or exits with a non-zero code:
   a. STOP IMMEDIATELY. Do not try alternative selectors, snapshot refs, or other elements.
   b. Run: {{browseBin}} snapshot — capture what IS on the page right now.
   c. Save a screenshot to {{evidenceDir}}/nav-failure.png
   d. Output a nav_failure result (see schema below) instead of the normal result.
   e. Do NOT search the codebase, try alternative URLs, or retry the same action.
5. If a step fails for any OTHER reason (element exists but wrong state, unexpected page content),
   take a screenshot and REPORT WHAT YOU SEE in the normal result format.
6. Save at least one screenshot, even if the check fails.
7. Your job is to report REALITY — what is actually on the page — not to find the answer the planner expected.

OUTPUT: Write valid JSON to stdout with this exact schema:

Normal result (element found, steps executed):
{
  "ac_id": "<id from instructions file>",
  "observed": "Describe what you actually saw on the page",
  "screenshots": ["screenshot-name.png"],
  "commands_run": ["goto http://...", "snapshot", "screenshot ..."]
}

Nav failure result (element NOT found — click/fill timed out):
{
  "ac_id": "<id from instructions file>",
  "nav_failure": {
    "failed_step": "click [data-testid=exact-selector-that-failed]",
    "error": "the exact error message from the browse command",
    "page_snapshot": "paste the FULL snapshot output here"
  },
  "screenshots": ["nav-failure.png"],
  "commands_run": ["goto http://...", "snapshot", "click ...", "snapshot", "screenshot ..."]
}

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Run existing tests to ensure no regressions**

Run: `cd pipeline && npx vitest run test/browse-agent.test.ts`
Expected: PASS (prompt changes don't affect unit tests)

**Step 3: Commit**

```bash
git add pipeline/src/prompts/browse-agent.txt
git commit -m "feat(pipeline): browse agent fail-fast protocol for missing elements"
```

---

### Task 4: Add replan prompt and replan functions to browse-agent

**Files:**
- Modify: `pipeline/src/stages/browse-agent.ts`
- Create: `pipeline/src/prompts/browse-replan.txt`
- Test: `pipeline/test/browse-agent.test.ts`

The replan logic is two small functions (prompt builder + output parser). They belong in `browse-agent.ts` alongside the existing prompt builder and result parser — no separate module needed.

**Step 1: Write the failing tests**

Add to `pipeline/test/browse-agent.test.ts`, after the existing `describe` blocks. Also update the import to include the new functions:

Update the import line at the top:
```typescript
import { buildBrowseAgentPrompt, writeInstructionsFile, parseBrowseResult, buildReplanPrompt, parseReplanOutput } from "../src/stages/browse-agent.js";
```

Add new test blocks:

```typescript
describe("buildReplanPrompt", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = join(tmpdir(), `verify-replan-${Date.now()}`); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("substitutes replan input path into template", () => {
    mkdirSync(tmpDir, { recursive: true });
    const inputPath = join(tmpDir, "replan-input.json");
    writeFileSync(inputPath, JSON.stringify({
      ac_id: "ac2",
      description: "Duplicate dialog for managed event type",
      original_steps: ["Navigate to /event-types", "Click [data-testid=event-type-options-1159]"],
      failed_step: "Click [data-testid=event-type-options-1159]",
      error: "Operation timed out: click: Timeout 5000ms exceeded.",
      page_snapshot: "Tabs: [Personal] [Seeded Team]",
    }));
    const prompt = buildReplanPrompt(inputPath);
    expect(prompt).toContain(inputPath);
    expect(prompt).not.toContain("{{");
  });
});

describe("parseReplanOutput", () => {
  it("parses revised steps", () => {
    const output = JSON.stringify({
      revised_steps: [
        "Click the 'Seeded Team' tab",
        "Wait for page load",
        "Click [data-testid=event-type-options-1159]",
      ],
    });
    const result = parseReplanOutput(output);
    expect(result).not.toBeNull();
    expect(result!.revised_steps).toHaveLength(3);
    expect(result!.revised_steps![0]).toContain("Seeded Team");
  });

  it("parses null revised_steps (element genuinely missing)", () => {
    const output = JSON.stringify({ revised_steps: null });
    const result = parseReplanOutput(output);
    expect(result).not.toBeNull();
    expect(result!.revised_steps).toBeNull();
  });

  it("treats empty revised_steps array as null", () => {
    const output = JSON.stringify({ revised_steps: [] });
    const result = parseReplanOutput(output);
    expect(result).not.toBeNull();
    expect(result!.revised_steps).toBeNull();
  });

  it("returns null for unparseable output", () => {
    expect(parseReplanOutput("garbage")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseReplanOutput("")).toBeNull();
  });
});
```

Note: the `writeFileSync` import is already available in the test file from `node:fs`.

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/browse-agent.test.ts`
Expected: FAIL — `buildReplanPrompt` and `parseReplanOutput` don't exist yet

**Step 3: Create the replan prompt**

Create `pipeline/src/prompts/browse-replan.txt`:

```
You are a navigation recovery planner. A browse agent tried to click an element
but it wasn't found on the page. You have the page snapshot showing what IS visible.

Read the replan input from: {{replanInputPath}}

The input contains:
- ac_id, description: what we're trying to verify
- original_steps: the steps that were planned
- failed_step: which specific step failed (the click/fill that timed out)
- error: the error message from the browse command
- page_snapshot: DOM snapshot of the current page state

Your job: look at the page snapshot, identify what navigation step is missing
(click a tab, expand a section, switch to a sub-view), and output revised steps.

OUTPUT: JSON with a revised_steps array:
{
  "revised_steps": [
    "Click the 'Seeded Team' tab",
    "Wait for page load",
    "Click [data-testid=event-type-options-1159]",
    "Wait for dropdown menu to appear",
    "Click [data-testid=event-type-duplicate-1159]"
  ]
}

RULES:
1. Look at the page_snapshot for tabs, navigation elements, sub-view switches, expandable sections.
2. Keep revised steps minimal — add ONLY the missing navigation step(s), then include the
   failed step and all remaining original steps after it.
3. Do NOT change the target selector — if the original plan said click X, the revised plan
   must still click X, just after navigating to the right view first.
4. If the snapshot shows no obvious tabs, navigation, or sub-views that could reveal the
   element, output: {"revised_steps": null}
5. Do NOT include steps that already succeeded (steps before the failed_step).

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 4: Add replan functions to browse-agent.ts**

Add to the bottom of `pipeline/src/stages/browse-agent.ts`:

```typescript
// ── Replan (nav failure recovery) ──────────────────────────────────────────

export interface ReplanOutput {
  revised_steps: string[] | null;
}

export function buildReplanPrompt(replanInputPath: string): string {
  const template = readFileSync(join(__dirname, "../prompts/browse-replan.txt"), "utf-8");
  return template.replaceAll("{{replanInputPath}}", replanInputPath);
}

export function parseReplanOutput(raw: string): ReplanOutput | null {
  const parsed = parseJsonOutput<ReplanOutput>(raw);
  if (!parsed) return null;
  // revised_steps must be a non-empty array of strings, or null
  if (parsed.revised_steps !== null && !Array.isArray(parsed.revised_steps)) return null;
  // Treat empty array as null — zero revised steps means nothing to retry
  if (Array.isArray(parsed.revised_steps) && parsed.revised_steps.length === 0) {
    parsed.revised_steps = null;
  }
  return parsed;
}
```

**Step 5: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/browse-agent.test.ts`
Expected: PASS

**Step 6: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add pipeline/src/stages/browse-agent.ts pipeline/src/prompts/browse-replan.txt pipeline/test/browse-agent.test.ts
git commit -m "feat(pipeline): replan prompt + parser for nav failure recovery"
```

---

### Task 5: Add nav_failure retry loop to orchestrator

**Files:**
- Modify: `pipeline/src/orchestrator.ts:2,22,278,285-306`
- Test: `pipeline/test/orchestrator.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/orchestrator.test.ts`, inside the top-level `describe("orchestrator", ...)`:

```typescript
  describe("nav_failure retry", () => {
    const NAV_FAILURE_BROWSE_RESULT = {
      ac_id: "ac1",
      nav_failure: {
        failed_step: "click [data-testid=event-type-options-1159]",
        error: "Operation timed out: click: Timeout 5000ms exceeded.",
        page_snapshot: "Tabs: [Personal] [Seeded Team]\nEvent types: 30 min meeting",
      },
      screenshots: ["nav-failure.png"],
      commands_run: ["goto http://localhost:3000/event-types", "click [data-testid=event-type-options-1159]"],
    };

    const REPLAN_OUTPUT = {
      revised_steps: [
        "Click the 'Seeded Team' tab",
        "Wait for page load",
        "Click [data-testid=event-type-options-1159]",
      ],
    };

    it("replans and retries browse agent on nav_failure", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check managed event" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check managed event", url: "/event-types", steps: ["Navigate", "Click kebab"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      // First browse attempt: nav_failure
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      // Replan succeeds
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      // Retry browse succeeds
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify({ ac_id: "ac1", observed: "Duplicate dialog visible", screenshots: ["success.png"], commands_run: ["goto ..."] }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      // Should have called replan
      const replanCalls = runClaudeCalls.filter(c => c.stage === "replan-ac1");
      expect(replanCalls.length).toBe(1);
      expect(replanCalls[0].timeoutMs).toBe(30_000);

      // Should have retried browse agent
      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(retryCalls.length).toBe(1);

      // Should log nav_failure
      expect(logs.some(l => l.includes("nav_failure") && l.includes("replanning"))).toBe(true);

      // Final verdict should be pass (from retry)
      const passVerdicts = result.verdicts!.verdicts.filter(v => v.verdict === "pass");
      expect(passVerdicts.length).toBeGreaterThanOrEqual(1);
    });

    it("records fail verdict when replan returns null revised_steps", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      // Replan says: can't fix
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify({ revised_steps: null }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      // Should NOT have retried browse agent
      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(retryCalls.length).toBe(0);
    });

    it("skips replan when replan prompt times out", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      // Replan times out
      mockRunClaudeResult("replan-ac1", { stdout: "", timedOut: true });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Should NOT have retried
      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(retryCalls.length).toBe(0);
    });

    it("does not replan a second time if retry also produces nav_failure", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      // First: nav_failure
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      // Retry: also nav_failure
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: "Element still not found after replan" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Should have called replan exactly once
      const replanCalls = runClaudeCalls.filter(c => c.stage.startsWith("replan-"));
      expect(replanCalls.length).toBe(1);
    });
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/orchestrator.test.ts`
Expected: FAIL — orchestrator doesn't import or call replan yet

**Step 3: Implement nav_failure retry in orchestrator**

In `pipeline/src/orchestrator.ts`:

**3a. Add import** (after the existing `browse-agent.js` import on line 22):

Update the existing browse-agent import to also include the replan functions:
```typescript
import { buildBrowseAgentPrompt, parseBrowseResult, buildReplanPrompt, parseReplanOutput } from "./stages/browse-agent.js";
```

**3b. Reduce timeout floor** (line 278):

Change:
```typescript
timeoutMs: Math.max(ac.timeout_seconds, 300) * 1000,
```
To:
```typescript
timeoutMs: Math.max(ac.timeout_seconds, 120) * 1000,
```

**3c. Add nav_failure handling** after the existing browse result parsing block (after `parseBrowseResult` and before the `resetPage()` call). The full per-AC block in `executeGroup` (lines ~270-309) should become:

Replace the section from `const agentPrompt =` through `resetPage();` with:

```typescript
      const agentPrompt = buildBrowseAgentPrompt(ac, {
        baseUrl: config.baseUrl, browseBin, evidenceDir,
      });
      const agentResult = await runClaude({
        prompt: agentPrompt, model: "sonnet", timeoutMs: Math.max(ac.timeout_seconds, 120) * 1000,
        stage: `browse-agent-${ac.id}`, runDir, ...perms("browse-agent"),
      });

      // Collect video evidence if present
      findAndRenameVideo(evidenceDir);

      if (agentResult.timedOut) {
        allVerdicts.push({ ac_id: ac.id, verdict: "timeout", confidence: "high", reasoning: `Timed out after ${ac.timeout_seconds}s` });
        progress.update(ac.id, "timeout");
        resetPage();
        continue;
      }

      let browseResult = parseBrowseResult(agentResult.stdout);

      // Nav failure → replan → retry (max 1 attempt)
      if (browseResult?.nav_failure && !agentResult.timedOut) {
        callbacks.onLog(`  ${ac.id}: nav_failure — replanning...`);
        progress.update(ac.id, "running", "replanning");

        // Write replan input
        const replanInputPath = join(evidenceDir, "replan-input.json");
        writeFileSync(replanInputPath, JSON.stringify({
          ac_id: ac.id,
          description: ac.description,
          original_steps: ac.steps,
          failed_step: browseResult.nav_failure.failed_step,
          error: browseResult.nav_failure.error,
          page_snapshot: browseResult.nav_failure.page_snapshot,
        }));

        // Call replan prompt (lightweight, 30s timeout, minimal permissions)
        const replanResult = await runClaude({
          prompt: buildReplanPrompt(replanInputPath),
          model: "sonnet", timeoutMs: 30_000,
          stage: `replan-${ac.id}`, runDir, ...perms("browse-replan"),
        });
        const replanOutput = parseReplanOutput(replanResult.stdout);

        if (replanOutput?.revised_steps) {
          // Retry browse agent with revised steps — reuse same evidenceDir
          // so judge sees one clean result per AC (no ghost "ac1-retry" dirs)
          callbacks.onLog(`  ${ac.id}: retrying with ${replanOutput.revised_steps.length} revised steps`);
          resetPage();
          const retryAc = { ...ac, steps: replanOutput.revised_steps };
          const retryPrompt = buildBrowseAgentPrompt(retryAc, {
            baseUrl: config.baseUrl, browseBin, evidenceDir,
          });
          const retryResult = await runClaude({
            prompt: retryPrompt, model: "sonnet",
            timeoutMs: Math.max(ac.timeout_seconds, 120) * 1000,
            stage: `browse-agent-${ac.id}-retry`, runDir, ...perms("browse-agent"),
          });

          findAndRenameVideo(evidenceDir);

          if (retryResult.timedOut) {
            allVerdicts.push({ ac_id: ac.id, verdict: "timeout", confidence: "high", reasoning: `Timed out after replan retry (${ac.timeout_seconds}s)` });
            progress.update(ac.id, "timeout");
            resetPage();
            continue;
          }

          const retryBrowse = parseBrowseResult(retryResult.stdout);
          if (retryBrowse) {
            browseResult = retryBrowse; // Use retry result — written to evidenceDir below
          }
        }
      }

      if (browseResult) {
        writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(browseResult, null, 2));

        // Circuit breaker: auth failure kills all agents
        if (isAuthFailure(browseResult.observed)) {
          callbacks.onError("Auth session expired. Run /verify-setup to re-authenticate.");
          abortController.abort();
          allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Auth redirect detected" });
          progress.update(ac.id, "error", "auth_expired");
          resetPage();
          continue;
        }
      } else {
        allVerdicts.push({ ac_id: ac.id, verdict: "error", confidence: "high", reasoning: "Browse agent produced no parseable output" });
        progress.update(ac.id, "error");
      }

      // Reset page between agents in same group
      resetPage();
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/orchestrator.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 6: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 7: Commit**

```bash
git add pipeline/src/orchestrator.ts pipeline/test/orchestrator.test.ts
git commit -m "feat(pipeline): nav_failure retry loop — replan + retry browse agent once"
```

---

### Task 6: Add Navigation section to learner

**Files:**
- Modify: `pipeline/src/stages/learner.ts:23-28`
- Modify: `pipeline/src/prompts/learner.txt`
- Test: `pipeline/test/learner-validator.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/learner-validator.test.ts` inside the existing `describe("validateLearnings", ...)`:

```typescript
  it("preserves Navigation section", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"

## Navigation
- /event-types — element [data-testid=event-type-options-1159] is under "Seeded Team" tab (?teamId=2)
`;
    const result = validateLearnings(input);
    expect(result).toContain("## Navigation");
    expect(result).toContain("event-type-options-1159");
    expect(result).toContain("Seeded Team");
  });

  it("strips banned patterns in Navigation section", () => {
    const input = `# Learnings

## Navigation
- /event-types — element is under Seeded Team tab
- Planner MUST always add tab-switching steps
- NEVER navigate without checking tabs first
`;
    const result = validateLearnings(input);
    expect(result).toContain("element is under Seeded Team tab");
    expect(result).not.toContain("Planner MUST");
    expect(result).not.toContain("NEVER navigate");
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/learner-validator.test.ts`
Expected: FAIL — "Navigation" is not in ALLOWED_SECTIONS, so the section gets stripped

**Step 3: Add Navigation to ALLOWED_SECTIONS**

In `pipeline/src/stages/learner.ts`, line 23-28, add `"Navigation"`:

```typescript
const ALLOWED_SECTIONS = new Set([
  "SQL Corrections",
  "Column Mappings",
  "Required Fields",
  "Timing",
  "Navigation",
]);
```

**Step 4: Add Navigation section to learner prompt**

In `pipeline/src/prompts/learner.txt`, add after the `## Timing` section (before `RULES:`):

```
## Navigation
Page navigation facts discovered from browse agent nav_failures.
Format: /route — element [selector] is under [tab/sub-view name] (?queryParam=value)
Only add entries from actual nav_failure evidence (replan-input.json files) in this run.
```

**Step 5: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/learner-validator.test.ts`
Expected: PASS

**Step 6: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 7: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 8: Commit**

```bash
git add pipeline/src/stages/learner.ts pipeline/src/prompts/learner.txt pipeline/test/learner-validator.test.ts
git commit -m "feat(pipeline): learner captures Navigation facts from nav_failures"
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

Run: `cd pipeline && npx vitest run`
Expected: ALL PASS

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 3: Verify no regressions in existing tests**

Look at test output — all previously passing tests should still pass. The new tests added:
- `browse-agent.test.ts`: 2 new (nav_failure parsing) + 5 new (replan prompt build, parse variants incl. empty array)
- `orchestrator.test.ts`: 4 new (replan+retry, null steps, timeout, max 1 retry)
- `learner-validator.test.ts`: 2 new (Navigation preserved, banned patterns)

Total: 13 new tests.
