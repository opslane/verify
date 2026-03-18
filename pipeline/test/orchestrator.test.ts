// pipeline/test/orchestrator.test.ts — Orchestrator integration tests with mocked stages
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  loadCookies: vi.fn(),
}));

// ── Mock video helper ───────────────────────────────────────────────────────
vi.mock("../src/lib/video.js", () => ({
  findAndRenameVideo: vi.fn(() => null),
}));

// ── Mock setup-writer execution ─────────────────────────────────────────────
vi.mock("../src/stages/setup-writer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/stages/setup-writer.js")>();
  return {
    ...original,
    executeSetupCommands: vi.fn(() => ({ success: true })),
    executeTeardownCommands: vi.fn(() => []),
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
    it("marks group ACs as setup_failed when setup commands fail", async () => {
      const specPath = join(verifyDir, "spec.md");
      writeFileSync(specPath, "# Test spec");

      const acsWithSetup: ACGeneratorOutput = {
        groups: [{ id: "group-a", condition: "trial user exists", acs: [{ id: "ac1", description: "Check" }] }],
        skipped: [],
      };
      const planWithSetup: PlannerOutput = {
        criteria: [{ id: "ac1", group: "group-a", description: "Check", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 }],
      };

      mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(acsWithSetup) });
      mockRunClaudeResult("planner", { stdout: JSON.stringify(planWithSetup) });
      mockRunClaudeResult("setup-group-a", { stdout: JSON.stringify({ group_id: "group-a", condition: "trial user exists", setup_commands: ["psql -c 'INSERT...'"], teardown_commands: [] }) });
      mockRunClaudeResult("learner", { stdout: "" });

      // Make executeSetupCommands fail
      const { executeSetupCommands } = await import("../src/stages/setup-writer.js");
      vi.mocked(executeSetupCommands).mockReturnValueOnce({ success: false, error: "psql: connection refused" });

      const { callbacks } = makeCallbacks();
      const { runPipeline } = await import("../src/orchestrator.js");
      const result = await runPipeline(specPath, verifyDir, callbacks);

      const setupFailed = result.verdicts!.verdicts.filter(v => v.verdict === "setup_failed");
      expect(setupFailed.length).toBe(1);
      expect(setupFailed[0].ac_id).toBe("ac1");
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
});
