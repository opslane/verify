// pipeline/test/orchestrator.test.ts — Orchestrator integration tests with mocked stages
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunClaudeOptions, RunClaudeResult, ACGeneratorOutput, PlannerOutput, JudgeOutput } from "../src/lib/types.js";

// ── Mock runClaude ──────────────────────────────────────────────────────────
// Track all runClaude calls for assertion
const runClaudeCalls: RunClaudeOptions[] = [];
const runClaudeResponses = new Map<string, Partial<RunClaudeResult>>();

function mockRunClaudeResult(stage: string, overrides: Partial<RunClaudeResult> = {}): void {
  runClaudeResponses.set(stage, overrides);
}

function defaultRunClaudeResult(opts: RunClaudeOptions): RunClaudeResult {
  const override = runClaudeResponses.get(opts.stage) ?? {};
  return {
    stdout: override.stdout ?? "{}",
    stderr: override.stderr ?? "",
    exitCode: override.exitCode ?? 0,
    durationMs: override.durationMs ?? 1000,
    timedOut: override.timedOut ?? false,
  };
}

vi.mock("../src/run-claude.js", () => ({
  runClaude: vi.fn(async (opts: RunClaudeOptions): Promise<RunClaudeResult> => {
    runClaudeCalls.push(opts);
    return defaultRunClaudeResult(opts);
  }),
}));

// ── Mock browse helpers ─────────────────────────────────────────────────────
vi.mock("../src/lib/browse.js", () => ({
  resolveBrowseBin: vi.fn(() => "/mock/browse"),
  startDaemon: vi.fn(),
  healthCheck: vi.fn(() => true),
  stopDaemon: vi.fn(),
  resetPage: vi.fn(),
}));

// ── Mock video helper ───────────────────────────────────────────────────────
vi.mock("../src/lib/video.js", () => ({
  findAndRenameVideo: vi.fn(() => null),
}));

// ── Mock init/preflight ──────────────────────────────────────────────────────
vi.mock("../src/init.js", () => ({
  runPreflight: vi.fn(async () => ({ ok: true, errors: [] })),
}));

// ── Mock setup-writer execution ─────────────────────────────────────────────
vi.mock("../src/stages/setup-writer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/stages/setup-writer.js")>();
  return {
    ...original,
    executeSetupCommands: vi.fn(() => ({ success: true })),
    executeTeardownCommands: vi.fn(() => []),
    loadProjectEnv: vi.fn(() => ({ ...process.env })),
  };
});

// ── Test helpers ────────────────────────────────────────────────────────────
function makeCallbacks() {
  const logs: string[] = [];
  const errors: string[] = [];
  const progressEvents: Array<{ acId: string; status: string }> = [];
  return {
    callbacks: {
      onACCheckpoint: vi.fn(async (acs: ACGeneratorOutput) => acs),
      onLog: (msg: string) => logs.push(msg),
      onError: (msg: string) => errors.push(msg),
      onProgress: (evt: { acId: string; status: string }) => progressEvents.push(evt),
    },
    logs,
    errors,
    progressEvents,
  };
}

const FIXTURE_ACS: ACGeneratorOutput = {
  groups: [
    { id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check banner" }] },
    { id: "group-b", condition: "user with trial", acs: [{ id: "ac2", description: "Check trial UI" }] },
  ],
  skipped: [],
};

const FIXTURE_PLAN: PlannerOutput = {
  criteria: [
    { id: "ac1", group: "group-a", description: "Check banner", url: "/dashboard", steps: ["Go to page", "Check banner"], screenshot_at: ["after step 2"], timeout_seconds: 90 },
    { id: "ac2", group: "group-b", description: "Check trial UI", url: "/settings", steps: ["Navigate", "Verify"], screenshot_at: ["after step 2"], timeout_seconds: 120 },
  ],
};

const FIXTURE_BROWSE_RESULT = {
  ac_id: "ac1",
  observed: "Banner is visible with correct text",
  screenshots: ["screenshot1.png"],
  commands_run: ["goto /dashboard", "snapshot"],
};

const FIXTURE_VERDICTS: JudgeOutput = {
  verdicts: [
    { ac_id: "ac1", verdict: "pass" as const, confidence: "high" as const, reasoning: "Banner visible" },
    { ac_id: "ac2", verdict: "fail" as const, confidence: "medium" as const, reasoning: "Trial UI missing" },
  ],
};

describe("orchestrator", () => {
  let verifyDir: string;

  beforeEach(() => {
    runClaudeCalls.length = 0;
    runClaudeResponses.clear();
    vi.clearAllMocks();

    verifyDir = join(tmpdir(), `verify-orch-${Date.now()}`);
    mkdirSync(verifyDir, { recursive: true });
    // Write minimal config
    writeFileSync(join(verifyDir, "config.json"), JSON.stringify({ baseUrl: "http://localhost:3000" }));
  });

  afterEach(() => {
    rmSync(verifyDir, { recursive: true, force: true });
  });

  describe("cwd propagation", () => {
    it("passes cwd: projectRoot to every runClaude call", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      // Setup mock responses for a minimal happy path
      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(FIXTURE_ACS) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(FIXTURE_PLAN) });
      mockRunClaudeResult("setup-writer", { stdout: JSON.stringify({ group_id: "group-b", condition: "user with trial", setup_commands: [], teardown_commands: [] }) });
      mockRunClaudeResult(`setup-group-b`, { stdout: JSON.stringify({ group_id: "group-b", condition: "user with trial", setup_commands: [], teardown_commands: [] }) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(FIXTURE_BROWSE_RESULT) });
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ...FIXTURE_BROWSE_RESULT, ac_id: "ac2", observed: "Trial UI present" }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify(FIXTURE_VERDICTS) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Every runClaude call must have cwd set to projectRoot (verifyDir/..)
      const expectedCwd = join(verifyDir, "..");
      for (const call of runClaudeCalls) {
        expect(call.cwd).toBe(expectedCwd);
      }
    });
  });

  describe("stage timeouts", () => {
    it("uses 240s timeout for planner (tool-using stage)", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(FIXTURE_ACS) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(FIXTURE_PLAN) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(FIXTURE_BROWSE_RESULT) });
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ...FIXTURE_BROWSE_RESULT, ac_id: "ac2", observed: "ok" }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify(FIXTURE_VERDICTS) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      const plannerCall = runClaudeCalls.find(c => c.stage === "planner");
      expect(plannerCall).toBeDefined();
      expect(plannerCall!.timeoutMs).toBe(240_000);
    });
  });

  describe("circuit breaker", () => {
    it("trips when browse agent returns auth failure", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      // Two groups, each with one AC. First AC triggers auth failure.
      const acsWithTwoGroups: ACGeneratorOutput = {
        groups: [
          { id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check A" }] },
          { id: "group-b", condition: null, acs: [{ id: "ac2", description: "Check B" }] },
        ],
        skipped: [],
      };
      const planWithTwoGroups: PlannerOutput = {
        criteria: [
          { id: "ac1", group: "group-a", description: "Check A", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 },
          { id: "ac2", group: "group-b", description: "Check B", url: "/b", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 },
        ],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(acsWithTwoGroups) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(planWithTwoGroups) });
      // ac1 triggers auth failure
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify({ ac_id: "ac1", observed: "Auth redirect to /login detected", screenshots: [], commands_run: [] }) });
      // ac2 should ideally not run, but if groups execute in parallel it might
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ac_id: "ac2", observed: "ok", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, errors } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      // Should have auth_expired verdicts
      expect(errors.some(e => e.includes("Auth session expired"))).toBe(true);
      const authVerdicts = result.verdicts!.verdicts.filter(v => v.verdict === "auth_expired");
      expect(authVerdicts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("stage failure handling", () => {
    it("aborts when AC Generator returns unparseable output", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      mockRunClaudeResult("ac-generator", { stdout: "not json" });

      const { callbacks, errors } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      expect(result.verdicts).toBeNull();
      expect(errors.some(e => e.includes("AC Generator failed"))).toBe(true);
    });

    it("aborts when Planner returns unparseable output", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(FIXTURE_ACS) });
      mockRunClaudeResult("planner", { stdout: "garbage" });

      const { callbacks, errors } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      expect(result.verdicts).toBeNull();
      expect(errors.some(e => e.includes("Planner failed"))).toBe(true);
    });

    it("marks AC as timeout when browse agent times out", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check A" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check A", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: "", timedOut: true });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      const timeoutVerdicts = result.verdicts!.verdicts.filter(v => v.verdict === "timeout");
      expect(timeoutVerdicts.length).toBe(1);
      expect(timeoutVerdicts[0].ac_id).toBe("ac1");
    });

    it("skips Judge when zero evidence files exist", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check A" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check A", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      // Browse agent returns unparseable output — no evidence written
      mockRunClaudeResult("browse-agent-ac1", { stdout: "not json" });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Judge should NOT have been called
      const judgeCalls = runClaudeCalls.filter(c => c.stage === "judge");
      expect(judgeCalls.length).toBe(0);
      expect(logs.some(l => l.includes("No evidence collected"))).toBe(true);
    });
  });

  describe("setup failure handling", () => {
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
  });

  describe("planner retry", () => {
    it("retries planner once on validation failure", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check A" }] }],
        skipped: [],
      };
      // First plan has template variable — will fail validation
      const badPlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check A", url: "/{userId}", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };
      const goodPlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check A", url: "/dashboard", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(badPlan) });
      mockRunClaudeResult("planner-retry", { stdout: JSON.stringify(goodPlan) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify({ ac_id: "ac1", observed: "OK", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Should have called planner-retry
      const retryCalls = runClaudeCalls.filter(c => c.stage === "planner-retry");
      expect(retryCalls.length).toBe(1);
    });
  });

  describe("learner safety", () => {
    it("runs learner even when pipeline aborts early via circuit breaker", async () => {
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
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify({ ac_id: "ac1", observed: "Auth redirect detected", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Learner must have been called
      const learnerCalls = runClaudeCalls.filter(c => c.stage === "learner");
      expect(learnerCalls.length).toBe(1);
    });
  });

  describe("user abort", () => {
    it("aborts cleanly when onACCheckpoint returns null", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(FIXTURE_ACS) });

      const { callbacks, logs } = makeCallbacks();
      callbacks.onACCheckpoint = vi.fn(async () => null);
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      expect(result.verdicts).toBeNull();
      expect(logs.some(l => l.includes("User aborted"))).toBe(true);
    });
  });

  describe("group execution ordering", () => {
    it("logs setup vs pure-UI group split", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      // 2 setup groups + 1 pure-UI group
      const threeGroupAcs: ACGeneratorOutput = {
        groups: [
          { id: "group-a", condition: "billing state A", acs: [{ id: "ac1", description: "Check A" }] },
          { id: "group-b", condition: "billing state B", acs: [{ id: "ac2", description: "Check B" }] },
          { id: "group-c", condition: null, acs: [{ id: "ac3", description: "Check C" }] },
        ],
        skipped: [],
      };
      const threeGroupPlan: PlannerOutput = {
        criteria: [
          { id: "ac1", group: "group-a", description: "Check A", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 },
          { id: "ac2", group: "group-b", description: "Check B", url: "/b", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 },
          { id: "ac3", group: "group-c", description: "Check C", url: "/c", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 },
        ],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(threeGroupAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(threeGroupPlan) });
      mockRunClaudeResult("setup-group-a", { stdout: JSON.stringify({ group_id: "group-a", condition: "billing state A", setup_commands: [], teardown_commands: [] }) });
      mockRunClaudeResult("setup-group-b", { stdout: JSON.stringify({ group_id: "group-b", condition: "billing state B", setup_commands: [], teardown_commands: [] }) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify({ ac_id: "ac1", observed: "OK", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ac_id: "ac2", observed: "OK", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("browse-agent-ac3", { stdout: JSON.stringify({ ac_id: "ac3", observed: "OK", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [
        { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
        { ac_id: "ac2", verdict: "pass", confidence: "high", reasoning: "OK" },
        { ac_id: "ac3", verdict: "pass", confidence: "high", reasoning: "OK" },
      ] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Should log the setup vs pure-UI split
      expect(logs.some(l => l.includes("2 setup (serial)") && l.includes("1 pure-UI (parallel)"))).toBe(true);
    });
  });

  describe("output artifacts", () => {
    it("writes verdicts.json and report.json to run dir", async () => {
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
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify({ ac_id: "ac1", observed: "OK", screenshots: [], commands_run: [] }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      expect(existsSync(join(result.runDir, "verdicts.json"))).toBe(true);
      expect(existsSync(join(result.runDir, "report.json"))).toBe(true);

      const verdicts = JSON.parse(readFileSync(join(result.runDir, "verdicts.json"), "utf-8"));
      expect(verdicts.verdicts.length).toBeGreaterThan(0);
    });
  });

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
    const INTERACTION_FAILURE_BROWSE_RESULT = {
      ac_id: "ac1",
      nav_failure: {
        kind: "interaction",
        failed_step: "hover @e1",
        error: "Operation timed out: hover: Timeout 5000ms exceeded.",
        page_snapshot: "@e1 [button] \"Trial\"\n@e2 [text] \"14 days left in your trial\"",
      },
      screenshots: ["nav-failure.png"],
      commands_run: ["goto http://localhost:3000/settings/billing", "snapshot", "hover @e1", "snapshot", "screenshot nav-failure.png"],
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
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify({ ac_id: "ac1", observed: "Duplicate dialog visible", screenshots: ["success.png"], commands_run: ["goto ..."] }) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      const replanCalls = runClaudeCalls.filter(c => c.stage === "replan-ac1");
      expect(replanCalls.length).toBe(1);
      expect(replanCalls[0].timeoutMs).toBe(45_000);
      expect(replanCalls[0].effort).toBe("low");

      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(retryCalls.length).toBe(1);

      expect(logs.some(l => l.includes("nav_failure") && l.includes("replanning"))).toBe(true);

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
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify({ revised_steps: null }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(retryCalls.length).toBe(0);
    });

    it("does not replan on interaction failures", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const singleAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [{ id: "ac1", description: "Hover check" }] }],
        skipped: [],
      };
      const singlePlan: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Hover check", url: "/settings/billing", steps: ["Navigate", "Hover trial badge"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(singleAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(singlePlan) });
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(INTERACTION_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: "Hover timed out" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      const replanCalls = runClaudeCalls.filter(c => c.stage === "replan-ac1");
      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(replanCalls.length).toBe(0);
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
      mockRunClaudeResult("replan-ac1", { stdout: "", timedOut: true });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      const retryCalls = runClaudeCalls.filter(c => c.stage === "browse-agent-ac1-retry");
      expect(retryCalls.length).toBe(0);
    });

    it("passes nav hints from ac1 replan to ac2 (same URL, no replan needed)", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      // Two ACs in same group, same URL
      const twoAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [
          { id: "ac1", description: "Check event type A" },
          { id: "ac2", description: "Check event type B" },
        ] }],
        skipped: [],
      };
      const twoPlan: PlannerOutput = {
        criteria: [
          { id: "ac1", group: "group-a", description: "Check event type A", url: "/event-types", steps: ["Navigate to /event-types", "Wait for page load", "Click [data-testid=event-type-options-1159]"], screenshot_at: [], timeout_seconds: 90 },
          { id: "ac2", group: "group-a", description: "Check event type B", url: "/event-types", steps: ["Navigate to /event-types", "Wait for page load", "Click [data-testid=event-type-options-1160]"], screenshot_at: [], timeout_seconds: 90 },
        ],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(twoAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(twoPlan) });

      // ac1: nav_failure → replan → retry succeeds
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify({ ac_id: "ac1", observed: "Event type A visible", screenshots: ["s.png"], commands_run: ["goto ..."] }) });

      // ac2: should succeed WITHOUT replan (got nav hints from ac1)
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ac_id: "ac2", observed: "Event type B visible", screenshots: ["s.png"], commands_run: ["goto ..."] }) });

      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [
        { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
        { ac_id: "ac2", verdict: "pass", confidence: "high", reasoning: "OK" },
      ] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      // ac1 should have triggered a replan
      const replanCalls = runClaudeCalls.filter(c => c.stage === "replan-ac1");
      expect(replanCalls.length).toBe(1);

      // ac2 should NOT have triggered a replan
      const replanAc2 = runClaudeCalls.filter(c => c.stage === "replan-ac2");
      expect(replanAc2.length).toBe(0);

      // Verify ac2's instructions.json contains the nav hint step from ac1's replan
      const ac2EvidenceDir = runClaudeCalls.find(c => c.stage === "browse-agent-ac2");
      expect(ac2EvidenceDir).toBeDefined();
      // The instructions.json is written by buildBrowseAgentPrompt into evidenceDir
      // Find ac2's evidence dir from the run dir
      const runsDir = join(verifyDir, "runs");
      const runDirs = readdirSync(runsDir);
      const runDir = join(runsDir, runDirs[0]);
      const ac2Instructions = JSON.parse(readFileSync(join(runDir, "evidence", "ac2", "instructions.json"), "utf-8"));
      // The enriched steps should include the nav hint "Click the 'Seeded Team' tab"
      expect(ac2Instructions.steps.some((s: string) => s.includes("Seeded Team"))).toBe(true);

      // Should log that hints were saved
      expect(logs.some(l => l.includes("nav hint"))).toBe(true);
    });

    it("does not apply hints across different URLs", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      // Two ACs in same group, DIFFERENT URLs
      const twoAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [
          { id: "ac1", description: "Check event types" },
          { id: "ac2", description: "Check settings" },
        ] }],
        skipped: [],
      };
      const twoPlan: PlannerOutput = {
        criteria: [
          { id: "ac1", group: "group-a", description: "Check event types", url: "/event-types", steps: ["Navigate to /event-types", "Wait for page load", "Click [data-testid=event-type-options-1159]"], screenshot_at: [], timeout_seconds: 90 },
          { id: "ac2", group: "group-a", description: "Check settings", url: "/settings", steps: ["Navigate to /settings", "Wait for page load", "Click [data-testid=billing-tab]"], screenshot_at: [], timeout_seconds: 90 },
        ],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(twoAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(twoPlan) });

      // ac1: nav_failure → replan → retry succeeds (saves hint for /event-types)
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify({ ac_id: "ac1", observed: "OK", screenshots: ["s.png"], commands_run: ["goto ..."] }) });

      // ac2: different URL — should NOT get /event-types hints
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ac_id: "ac2", observed: "Settings visible", screenshots: ["s.png"], commands_run: ["goto ..."] }) });

      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [
        { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
        { ac_id: "ac2", verdict: "pass", confidence: "high", reasoning: "OK" },
      ] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // Both should pass — no cross-contamination
      // Verify ac2's instructions.json does NOT contain Seeded Team hint
      const runsDir = join(verifyDir, "runs");
      const runDirs = readdirSync(runsDir);
      const runDir = join(runsDir, runDirs[0]);
      const ac2Instructions = JSON.parse(readFileSync(join(runDir, "evidence", "ac2", "instructions.json"), "utf-8"));
      expect(ac2Instructions.steps.some((s: string) => s.includes("Seeded Team"))).toBe(false);

      // ac2 should not have been replanned
      const replanAc2 = runClaudeCalls.filter(c => c.stage === "replan-ac2");
      expect(replanAc2.length).toBe(0);
    });

    it("does not save hints when retry also has nav_failure", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      // Two ACs — ac1's retry also fails with nav_failure, ac2 should get no hints
      const twoAcs: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: null, acs: [
          { id: "ac1", description: "Check A" },
          { id: "ac2", description: "Check B" },
        ] }],
        skipped: [],
      };
      const twoPlan: PlannerOutput = {
        criteria: [
          { id: "ac1", group: "group-a", description: "Check A", url: "/event-types", steps: ["Navigate to /event-types", "Wait for page load", "Click [data-testid=event-type-options-1159]"], screenshot_at: [], timeout_seconds: 90 },
          { id: "ac2", group: "group-a", description: "Check B", url: "/event-types", steps: ["Navigate to /event-types", "Wait for page load", "Click [data-testid=event-type-options-1160]"], screenshot_at: [], timeout_seconds: 90 },
        ],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(twoAcs) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(twoPlan) });

      // ac1: nav_failure → replan → retry ALSO fails with nav_failure
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });

      // ac2: should NOT receive any hints (ac1's retry failed)
      mockRunClaudeResult("browse-agent-ac2", { stdout: JSON.stringify({ ac_id: "ac2", observed: "OK", screenshots: ["s.png"], commands_run: ["goto ..."] }) });

      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [
        { ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: "Still broken" },
        { ac_id: "ac2", verdict: "pass", confidence: "high", reasoning: "OK" },
      ] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks, logs } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      // No hints should have been saved (retry failed)
      expect(logs.some(l => l.includes("nav hint"))).toBe(false);

      // ac2's instructions.json should NOT contain Seeded Team hint
      const runsDir = join(verifyDir, "runs");
      const runDirs = readdirSync(runsDir);
      const runDir = join(runsDir, runDirs[0]);
      const ac2Instructions = JSON.parse(readFileSync(join(runDir, "evidence", "ac2", "instructions.json"), "utf-8"));
      expect(ac2Instructions.steps.some((s: string) => s.includes("Seeded Team"))).toBe(false);
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
      mockRunClaudeResult("browse-agent-ac1", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("replan-ac1", { stdout: JSON.stringify(REPLAN_OUTPUT) });
      mockRunClaudeResult("browse-agent-ac1-retry", { stdout: JSON.stringify(NAV_FAILURE_BROWSE_RESULT) });
      mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: "Element still not found after replan" }] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      await runPipeline(specPath, verifyDir, callbacks);

      const replanCalls = runClaudeCalls.filter(c => c.stage.startsWith("replan-"));
      expect(replanCalls.length).toBe(1);
    });
  });
});
