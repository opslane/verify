import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

const { execFileSyncMock, scoreBrowseEvalArtifactsMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  scoreBrowseEvalArtifactsMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock("../src/evals/browse-eval-score.js", () => ({
  scoreBrowseEvalArtifacts: scoreBrowseEvalArtifactsMock,
}));

import { discoverCaseDirs, formatBrowseEvalSummary, runBrowseEvalCase } from "../src/evals/run-browse-evals.js";

describe("browse eval runner", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "verify-browse-runner-"));
    execFileSyncMock.mockReset();
    scoreBrowseEvalArtifactsMock.mockReset();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function readFakeCaseJson<T>(caseId: string, fileName: "plan.json" | "expected.json"): T {
    return JSON.parse(readFileSync(join(__dirname, "..", "evals", "browse-agent", "cases", caseId, fileName), "utf8")) as T;
  }

  it("exposes eval:browse in package.json scripts", () => {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["eval:browse"]).toBe("tsx src/evals/run-browse-evals.ts");
  });

  it("discovers case directories in sorted order", () => {
    mkdirSync(join(tmpRoot, "b-case"), { recursive: true });
    mkdirSync(join(tmpRoot, "a-case"), { recursive: true });

    expect(discoverCaseDirs(tmpRoot)).toEqual([
      join(tmpRoot, "a-case"),
      join(tmpRoot, "b-case"),
    ]);
  });

  it("runs the browse-agent stage with eval env vars wired in", () => {
    const caseDir = join(tmpRoot, "tooltip-hover-success");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "plan.json"), JSON.stringify({
      criteria: [{ id: "ac1", group: "group-a", description: "x", url: "/x", steps: [], screenshot_at: [], timeout_seconds: 90 }],
    }));
    writeFileSync(join(caseDir, "browse-script.json"), JSON.stringify({ steps: [] }));
    writeFileSync(join(caseDir, "expected.json"), JSON.stringify({
      ac_id: "ac1",
      expect_parseable_result: true,
      expect_result_kind: "normal",
      required_commands: [],
      forbidden_shell_patterns: [],
      required_observed_substrings: [],
      forbidden_observed_substrings: [],
      max_command_count: 5,
      max_duration_ms: 1000,
    }));

    scoreBrowseEvalArtifactsMock.mockReturnValue({
      caseId: "tooltip-hover-success",
      passed: true,
      failures: [],
      durationMs: 1000,
      commandCount: 3,
    });

    const result = runBrowseEvalCase(caseDir);

    expect(result.passed).toBe(true);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = execFileSyncMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(bin).toBe("npx");
    expect(args).toContain("run-stage");
    expect(args).toContain("browse-agent");
    expect(options.env.BROWSE_BIN).toBeTruthy();
    expect(options.env.BROWSE_EVAL_SCRIPT).toBe(join(caseDir, "browse-script.json"));
    expect(options.env.BROWSE_EVAL_TRACE).toContain("trace.jsonl");
    expect(scoreBrowseEvalArtifactsMock).toHaveBeenCalledTimes(1);
  });

  it("formats summary counts and median duration", () => {
    const summary = formatBrowseEvalSummary([
      { caseId: "a", passed: true, failures: [], durationMs: 1000, commandCount: 2 },
      { caseId: "b", passed: false, failures: ["duration 6000ms exceeded max 5000ms"], durationMs: 6000, commandCount: 3 },
      { caseId: "c", passed: true, failures: [], durationMs: 3000, commandCount: 4 },
    ]);

    expect(summary).toContain("Summary: 2/3 passed");
    expect(summary).toContain("Median duration: 3.0s");
    expect(summary).toContain("Timeout-like failures: 1");
  });

  it("requires the fake dialog case to use explicit selectors and a realistic budget", () => {
    const plan = readFakeCaseJson<{ criteria: Array<{ steps: string[] }> }>("dialog-css-required", "plan.json");
    const expected = readFakeCaseJson<{ required_commands: string[]; max_duration_ms: number }>("dialog-css-required", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Click @e70");
    expect(plan.criteria[0]?.steps).toContain("Click [role='dialog'] button:nth-child(2)");
    expect(expected.required_commands).toContain("click [role='dialog'] button:nth-child(2)");
    expect(expected.max_duration_ms).toBeGreaterThanOrEqual(25000);
  });

  it("requires the fake tooltip-timeout case to target the known hover ref and allow realistic failure latency", () => {
    const plan = readFakeCaseJson<{ criteria: Array<{ steps: string[] }> }>("tooltip-hover-timeout", "plan.json");
    const expected = readFakeCaseJson<{ required_commands: string[]; max_duration_ms: number }>("tooltip-hover-timeout", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Hover @e1");
    expect(expected.required_commands).toContain("hover @e1");
    expect(expected.max_duration_ms).toBeGreaterThanOrEqual(20000);
  });

  it("requires the fake tooltip-success case to target the known hover ref and allow realistic success latency", () => {
    const plan = readFakeCaseJson<{ criteria: Array<{ steps: string[] }> }>("tooltip-hover-success", "plan.json");
    const expected = readFakeCaseJson<{ required_commands: string[]; max_duration_ms: number }>("tooltip-hover-success", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Hover @e1");
    expect(expected.required_commands).toContain("hover @e1");
    expect(expected.required_commands).toContain("snapshot");
    expect(expected.max_duration_ms).toBeGreaterThanOrEqual(25000);
  });

  it("requires the fake wait-for-data case to take a post-wait snapshot and score the loaded state", () => {
    const plan = readFakeCaseJson<{ criteria: Array<{ steps: string[] }> }>("wait-for-data", "plan.json");
    const expected = readFakeCaseJson<{
      required_commands: string[];
      required_observed_substrings: string[];
      forbidden_observed_substrings: string[];
    }>("wait-for-data", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Take a snapshot after the page loads");
    expect(plan.criteria[0]?.steps).toContain("Take a snapshot after the rows appear");
    expect(expected.required_commands).toEqual(expect.arrayContaining(["wait", "snapshot"]));
    expect(expected.required_observed_substrings).toEqual(expect.arrayContaining(["Reports loaded", "Monthly revenue"]));
    expect(expected.forbidden_observed_substrings).toEqual(expect.not.arrayContaining(["Loading reports"]));
  });
});
