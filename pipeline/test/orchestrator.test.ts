// pipeline/test/orchestrator.test.ts — V1.1 single-session orchestrator tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunClaudeOptions, RunClaudeResult, ACGeneratorOutput } from "../src/lib/types.js";

// ── Mock runClaude ──────────────────────────────────────────────────────────
const runClaudeCalls: RunClaudeOptions[] = [];
const runClaudeResponses = new Map<string, Partial<RunClaudeResult>>();

function mockRunClaudeResult(stage: string, overrides: Partial<RunClaudeResult> = {}): void {
  runClaudeResponses.set(stage, overrides);
}

function defaultRunClaudeResult(opts: RunClaudeOptions): RunClaudeResult {
  const override = runClaudeResponses.get(opts.stage)
    ?? [...runClaudeResponses.entries()].find(([k]) => opts.stage.startsWith(k))?.[1]
    ?? {};
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

    // For session executor: simulate writing result.json files to evidence dirs
    if (opts.stage === "executor-session" && opts.prompt) {
      const evidenceMatch = opts.prompt.match(/Evidence directory: (.+)/);
      if (evidenceMatch) {
        const evidenceBase = evidenceMatch[1].trim();
        // Write mock results for each AC mentioned in prompt
        const acMatches = opts.prompt.matchAll(/\[(\w+)\]/g);
        for (const match of acMatches) {
          const acId = match[1];
          const dir = join(evidenceBase, acId);
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "result.json"), JSON.stringify({
              ac_id: acId,
              verdict: "pass",
              confidence: "high",
              reasoning: "Verified successfully",
              observed: "Element found",
              steps_taken: ["goto http://localhost:3000"],
              screenshots: ["result.png"],
            }));
          } catch {
            // Directory may not exist in certain test scenarios
          }
        }
      }
    }

    return defaultRunClaudeResult(opts);
  }),
}));

// ── Mock browse helpers ─────────────────────────────────────────────────────
vi.mock("../src/lib/browse.js", () => ({
  resolveBrowseBin: vi.fn(() => "/mock/browse"),
  startGroupDaemon: vi.fn((_groupId: string, runDir: string) => ({
    env: { BROWSE_STATE_FILE: `${runDir}/.browse/browse.json` },
    stateDir: `${runDir}/.browse`,
  })),
  stopGroupDaemon: vi.fn(),
}));

vi.mock("../src/init.js", () => ({
  runPreflight: vi.fn(async () => ({ ok: true, errors: [] })),
  loginOnDaemon: vi.fn(() => ({ ok: true })),
}));

vi.mock("../src/lib/diff-hints.js", () => ({
  extractDiffHints: vi.fn(() => "No diff information available."),
}));

// ── Test setup ──────────────────────────────────────────────────────────────
let testDir: string;
let verifyDir: string;
let specPath: string;

const VALID_ACS: ACGeneratorOutput = {
  groups: [
    { id: "group-a", condition: null, acs: [
      { id: "ac1", description: "Tab shows Inbox" },
      { id: "ac2", description: "Tab shows Pending" },
    ]},
  ],
  skipped: [],
};

beforeEach(() => {
  testDir = join(tmpdir(), `verify-orch-${Date.now()}`);
  verifyDir = join(testDir, ".verify");
  specPath = join(verifyDir, "spec.md");
  mkdirSync(verifyDir, { recursive: true });
  writeFileSync(join(verifyDir, "config.json"), JSON.stringify({ baseUrl: "http://localhost:3000" }));
  writeFileSync(specPath, "## AC\n- Tab shows Inbox");

  runClaudeCalls.length = 0;
  runClaudeResponses.clear();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("v1.1 single-session orchestrator", () => {
  it("runs AC extractor + single session executor and produces verdicts", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });
    // executor-session mock writes result.json files via the runClaude mock above

    const logs: string[] = [];
    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: (msg) => logs.push(msg),
      onError: (msg) => logs.push(`ERROR: ${msg}`),
      onProgress: () => {},
    });

    expect(result.verdicts).not.toBeNull();
    expect(result.verdicts!.verdicts.length).toBe(2);

    // Should be ONE executor session call, not one per AC
    const sessionCalls = runClaudeCalls.filter(c => c.stage === "executor-session");
    expect(sessionCalls.length).toBe(1);

    // Both ACs should be in the single prompt
    expect(sessionCalls[0].prompt).toContain("ac1");
    expect(sessionCalls[0].prompt).toContain("ac2");
  });

  it("uses generous session timeout as safety net", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });

    await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    const sessionCall = runClaudeCalls.find(c => c.stage === "executor-session");
    expect(sessionCall).toBeDefined();
    // 10 minute safety net, not per-AC scaling
    expect(sessionCall!.timeoutMs).toBe(600_000);
  });

  it("retries AC extractor once on parse failure", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: "not json" });
    mockRunClaudeResult("ac-generator-retry", { stdout: JSON.stringify(VALID_ACS) });

    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    expect(result.verdicts).not.toBeNull();
    const acGenCalls = runClaudeCalls.filter(c => c.stage.startsWith("ac-generator"));
    expect(acGenCalls.length).toBe(2);
  });

  it("aborts when AC extractor fails after retry", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: "not json" });
    mockRunClaudeResult("ac-generator-retry", { stdout: "still not json" });

    const errors: string[] = [];
    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: (msg) => errors.push(msg),
      onProgress: () => {},
    });

    expect(result.verdicts).toBeNull();
    expect(errors.some(e => e.includes("AC Extractor failed"))).toBe(true);
  });

  it("aborts cleanly when user rejects ACs", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });

    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async () => null,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    expect(result.verdicts).toBeNull();
    expect(runClaudeCalls.filter(c => c.stage === "executor-session").length).toBe(0);
  });

  it("marks unprocessed ACs as error when session times out", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });
    // Override the mock to NOT write result files (simulating timeout before any AC processed)
    const originalMock = vi.mocked(await import("../src/run-claude.js")).runClaude;
    originalMock.mockImplementation(async (opts: RunClaudeOptions) => {
      runClaudeCalls.push(opts);
      if (opts.stage === "executor-session") {
        // Don't write any result files — simulate total timeout
        return { stdout: "", stderr: "", exitCode: 1, durationMs: 120000, timedOut: true };
      }
      return defaultRunClaudeResult(opts);
    });

    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    expect(result.verdicts).not.toBeNull();
    // Both ACs should be errors since no result files were written
    const errors = result.verdicts!.verdicts.filter(v => v.verdict === "error");
    expect(errors.length).toBe(2);
    expect(errors[0].reasoning).toContain("timed out");
  });

  it("handles partial results when session times out mid-run", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });
    // Manually mock: session times out but ac1 got a result written
    const originalMock = vi.mocked(await import("../src/run-claude.js")).runClaude;
    originalMock.mockImplementation(async (opts: RunClaudeOptions) => {
      runClaudeCalls.push(opts);
      if (opts.stage === "executor-session") {
        // Write result for ac1 only, simulating timeout before ac2
        const evidenceMatch = opts.prompt.match(/Evidence directory: (.+)/);
        if (evidenceMatch) {
          const base = evidenceMatch[1].trim();
          mkdirSync(join(base, "ac1"), { recursive: true });
          writeFileSync(join(base, "ac1", "result.json"), JSON.stringify({
            ac_id: "ac1", verdict: "pass", confidence: "high",
            reasoning: "Found it", observed: "Tab visible",
            steps_taken: [], screenshots: [],
          }));
        }
        return { stdout: "", stderr: "", exitCode: 1, durationMs: 120000, timedOut: true };
      }
      return defaultRunClaudeResult(opts);
    });

    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    expect(result.verdicts).not.toBeNull();
    const verdicts = result.verdicts!.verdicts;
    expect(verdicts.length).toBe(2);
    // ac1 should have a real verdict (pass)
    expect(verdicts.find(v => v.ac_id === "ac1")?.verdict).toBe("pass");
    // ac2 should be error (no result file)
    expect(verdicts.find(v => v.ac_id === "ac2")?.verdict).toBe("error");
  });

  it("detects auth failure in results", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });
    const originalMock = vi.mocked(await import("../src/run-claude.js")).runClaude;
    originalMock.mockImplementation(async (opts: RunClaudeOptions) => {
      runClaudeCalls.push(opts);
      if (opts.stage === "executor-session") {
        const evidenceMatch = opts.prompt.match(/Evidence directory: (.+)/);
        if (evidenceMatch) {
          const base = evidenceMatch[1].trim();
          mkdirSync(join(base, "ac1"), { recursive: true });
          writeFileSync(join(base, "ac1", "result.json"), JSON.stringify({
            ac_id: "ac1", verdict: "blocked", confidence: "high",
            reasoning: "Auth redirect to /signin", observed: "Auth redirect: redirected to /signin",
            steps_taken: [], screenshots: [],
          }));
          mkdirSync(join(base, "ac2"), { recursive: true });
          writeFileSync(join(base, "ac2", "result.json"), JSON.stringify({
            ac_id: "ac2", verdict: "pass", confidence: "high",
            reasoning: "Tab visible", observed: "Pending tab found",
            steps_taken: [], screenshots: [],
          }));
        }
        return { stdout: "SESSION_COMPLETE: 2", stderr: "", exitCode: 0, durationMs: 5000, timedOut: false };
      }
      return defaultRunClaudeResult(opts);
    });

    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    expect(result.verdicts).not.toBeNull();
    // ac1 should be auth_expired
    expect(result.verdicts!.verdicts.find(v => v.ac_id === "ac1")?.verdict).toBe("auth_expired");
    // ac2 should be pass (auth might work on other pages)
    expect(result.verdicts!.verdicts.find(v => v.ac_id === "ac2")?.verdict).toBe("pass");
  });

  it("writes verdicts.json and report.json to run dir", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });

    const result = await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    expect(existsSync(join(result.runDir, "verdicts.json"))).toBe(true);
    expect(existsSync(join(result.runDir, "report.json"))).toBe(true);
  });

  it("passes cwd to every runClaude call", async () => {
    const { runPipeline } = await import("../src/orchestrator.js");

    mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(VALID_ACS) });

    await runPipeline(specPath, verifyDir, {
      onACCheckpoint: async (acs) => acs,
      onLog: () => {},
      onError: () => {},
      onProgress: () => {},
    });

    for (const call of runClaudeCalls) {
      expect(call.cwd).toBeDefined();
      expect(call.cwd).toBe(testDir);
    }
  });
});
