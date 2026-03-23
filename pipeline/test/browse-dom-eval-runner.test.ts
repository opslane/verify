import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { BrowseEvalArtifactPaths, BrowseEvalResult } from "../src/evals/browse-eval-score.js";
import {
  canonicalizePath,
  createTraceWrapper,
  defaultStageExecutor,
  discoverCaseDirs,
  isLiveSmokeEnabled,
  runDomEvalCli,
  runBrowseDomEvalCase,
  runBrowseDomEvals,
  selectCaseDirs,
} from "../src/evals/run-browse-dom-evals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const caseRoot = join(__dirname, "..", "evals", "browse-dom-harness", "cases");

describe("browse dom eval runner", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "verify-browse-dom-runner-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeCase(root: string, name: string): string {
    const caseDir = join(root, name);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "plan.json"), JSON.stringify({
      criteria: [{ id: "ac1", group: "group-a", description: "x", url: "/trial", steps: [], screenshot_at: [], timeout_seconds: 90 }],
    }));
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
    return caseDir;
  }

  function readCaseJson<T>(caseId: string, fileName: "plan.json" | "expected.json"): T {
    return JSON.parse(readFileSync(join(caseRoot, caseId, fileName), "utf8")) as T;
  }

  it("exposes eval:browse:dom in package.json scripts", () => {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["eval:browse:dom"]).toBe("tsx src/evals/run-browse-dom-evals.ts");
  });

  it("discovers DOM case directories in sorted order and filters by case id", () => {
    const discovered = discoverCaseDirs(caseRoot);

    expect(discovered).toEqual([
      join(caseRoot, "auth-redirect"),
      join(caseRoot, "dialog-css-required"),
      join(caseRoot, "keyboard-nav"),
      join(caseRoot, "tooltip-hover-success"),
      join(caseRoot, "tooltip-hover-timeout"),
      join(caseRoot, "wait-for-data"),
    ]);
    expect(selectCaseDirs(discovered, "tooltip-hover-success")).toEqual([join(caseRoot, "tooltip-hover-success")]);
  });

  it("requires keyboard-nav to prove the selected tab changed", () => {
    const plan = readCaseJson<{ criteria: Array<{ steps: string[] }> }>("keyboard-nav", "plan.json");
    const expected = readCaseJson<{
      required_evidence_substrings: string[];
      required_observed_substrings: string[];
    }>("keyboard-nav", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Press ArrowRight");
    expect(expected.required_evidence_substrings).toContain("Selected section: Security");
    expect(expected.required_observed_substrings).toContain("selected");
  });

  it("requires tooltip-hover-timeout to target a real blocked trigger", () => {
    const plan = readCaseJson<{ criteria: Array<{ steps: string[] }> }>("tooltip-hover-timeout", "plan.json");
    const expected = readCaseJson<{ required_commands: string[] }>("tooltip-hover-timeout", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Hover #trial-blocked-badge");
    expect(expected.required_commands).toContain("hover #trial-blocked-badge");
  });

  it("blocks common shell and file-read detours in phase 2 DOM cases", () => {
    const requiredForbiddenPatterns = ["rg ", "grep ", "find ", "git ", "ls ", "cat ", "sed ", "awk ", "head ", "tail "];

    for (const caseId of ["keyboard-nav", "wait-for-data", "auth-redirect", "tooltip-hover-timeout"]) {
      const expected = readCaseJson<{ forbidden_shell_patterns: string[] }>(caseId, "expected.json");
      expect(expected.forbidden_shell_patterns).toEqual(expect.arrayContaining(requiredForbiddenPatterns));
    }
  });

  it("requires wait-for-data to wait for a real DOM condition instead of a millisecond sleep", () => {
    const plan = readCaseJson<{ criteria: Array<{ steps: string[] }> }>("wait-for-data", "plan.json");
    const expected = readCaseJson<{
      required_commands: string[];
      max_duration_ms: number;
    }>("wait-for-data", "expected.json");

    expect(plan.criteria[0]?.steps).toContain("Wait for #reports-results to become visible");
    expect(expected.required_commands).toContain("wait #reports-results");
    expect(expected.max_duration_ms).toBeGreaterThanOrEqual(20000);
  });

  it("gives realistic live-browser duration budgets to the slower keyboard and timeout cases", () => {
    const keyboardExpected = readCaseJson<{ max_duration_ms: number }>("keyboard-nav", "expected.json");
    const tooltipExpected = readCaseJson<{ max_duration_ms: number }>("tooltip-hover-timeout", "expected.json");

    expect(keyboardExpected.max_duration_ms).toBeGreaterThanOrEqual(15000);
    expect(tooltipExpected.max_duration_ms).toBeGreaterThanOrEqual(20000);
  });

  it("creates a trace wrapper that forwards to the trace shim", () => {
    const wrapperPath = createTraceWrapper(tmpRoot);
    const content = readFileSync(wrapperPath, "utf8");

    expect(content).toContain("browse-trace-shim.ts");
  });

  it("canonicalizes symlinked temp paths so browse sees the real filesystem path", () => {
    const realRoot = join(tmpRoot, "real-root");
    const aliasRoot = join(tmpRoot, "alias-root");

    mkdirSync(realRoot, { recursive: true });
    symlinkSync(realRoot, aliasRoot);

    expect(canonicalizePath(aliasRoot)).toBe(realpathSync.native(realRoot));
  });

  it("runs a DOM case with config, trace env, and finally cleanup", async () => {
    const caseDir = writeCase(tmpRoot, "tooltip-hover-success");
    const captured: {
      config?: { baseUrl: string };
      env?: Record<string, string>;
      runDir?: string;
      scorePaths?: BrowseEvalArtifactPaths;
      verifyDir?: string;
      wrapper?: string;
    } = {};

    const result = await runBrowseDomEvalCase(caseDir, {
      baseUrl: "http://127.0.0.1:4123",
      realBrowseBin: "/real/browse",
      scoreArtifacts: (paths) => {
        captured.scorePaths = paths;
        return {
          caseId: "tooltip-hover-success",
          passed: true,
          failures: [],
          durationMs: 25,
          commandCount: 1,
        };
      },
      stageExecutor: (input) => {
        captured.verifyDir = input.verifyDir;
        captured.runDir = input.runDir;
        captured.env = input.env;
        captured.config = JSON.parse(readFileSync(join(input.verifyDir, "config.json"), "utf8")) as { baseUrl: string };
        captured.wrapper = readFileSync(input.env.BROWSE_BIN, "utf8");
        throw new Error("intentional test failure");
      },
    });

    expect(result.passed).toBe(true);
    expect(captured.config).toEqual({ baseUrl: "http://127.0.0.1:4123" });
    expect(captured.env?.BROWSE_TRACE_REAL_BIN).toBe("/real/browse");
    expect(captured.env?.BROWSE_EVAL_TRACE).toContain("trace.jsonl");
    expect(captured.wrapper).toContain("browse-trace-shim.ts");
    expect(captured.scorePaths?.tracePath).toBe(captured.env?.BROWSE_EVAL_TRACE);
    expect(existsSync(captured.verifyDir ?? "")).toBe(false);
    expect(existsSync(captured.runDir ?? "")).toBe(false);
  });

  it("awaits async stage execution before scoring artifacts", async () => {
    const caseDir = writeCase(tmpRoot, "async-stage");
    let stageFinished = false;

    const result = await runBrowseDomEvalCase(caseDir, {
      baseUrl: "http://127.0.0.1:4123",
      realBrowseBin: "/real/browse",
      scoreArtifacts: () => ({
        caseId: "async-stage",
        passed: stageFinished,
        failures: stageFinished ? [] : ["stage was not awaited"],
        durationMs: 25,
        commandCount: 1,
      }),
      stageExecutor: async () => {
        await Promise.resolve();
        stageFinished = true;
      },
    });

    expect(result.passed).toBe(true);
  });

  it("default stage executor shells to the production browse-agent CLI path", async () => {
    const execFileMock = vi.fn((file, args, options, callback) => {
      callback(null, "", "");
    });

    await defaultStageExecutor({
      acId: "ac1",
      env: { TEST_ENV: "1" },
      pipelineDir: "/pipeline",
      runDir: "/pipeline/run",
      verifyDir: "/pipeline/.verify",
    }, execFileMock);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith("npx", [
      "tsx",
      "src/cli.ts",
      "run-stage",
      "browse-agent",
      "--verify-dir",
      "/pipeline/.verify",
      "--run-dir",
      "/pipeline/run",
      "--ac",
      "ac1",
    ], expect.objectContaining({
      cwd: "/pipeline",
      env: { TEST_ENV: "1" },
      encoding: "utf-8",
      timeout: 120000,
    }), expect.any(Function));
  });

  it("detects when single-case live smoke is enabled", () => {
    expect(isLiveSmokeEnabled({})).toBe(false);
    expect(isLiveSmokeEnabled({ BROWSE_DOM_LIVE_SMOKE: "0" })).toBe(false);
    expect(isLiveSmokeEnabled({ BROWSE_DOM_LIVE_SMOKE: "1" })).toBe(true);
  });

  it("skips single-case live smoke unless the opt-in env var is set", async () => {
    const runner = vi.fn().mockResolvedValue([]);
    const logger = { log: vi.fn() };

    await runDomEvalCli(["--case", "tooltip-hover-success"], {}, runner, logger);

    expect(runner).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("BROWSE_DOM_LIVE_SMOKE=1"));

    await runDomEvalCli(["--case", "tooltip-hover-success"], { BROWSE_DOM_LIVE_SMOKE: "1" }, runner, logger);

    expect(runner).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      caseFilter: "tooltip-hover-success",
    }));
  });

  it("stops the daemon before the suite, between cases, and at shutdown without prestarting it", async () => {
    const firstCase = writeCase(tmpRoot, "a-case");
    const secondCase = writeCase(tmpRoot, "b-case");
    const events: string[] = [];
    const results: BrowseEvalResult[] = await runBrowseDomEvals([firstCase, secondCase], {
      caseFilter: "b-case",
      resolveBrowseBinHook: () => "/real/browse",
      scoreArtifacts: ({ caseId }) => ({
        caseId,
        passed: true,
        failures: [],
        durationMs: 10,
        commandCount: 1,
      }),
      stageExecutor: ({ runDir }) => {
        events.push("runCase");
        mkdirSync(join(runDir, "logs"), { recursive: true });
        writeFileSync(join(runDir, "logs", "browse-agent-ac1-stream.jsonl"), "");
      },
      startServer: async () => {
        events.push("startServer");
        return { server: {} as never, port: 4567 };
      },
      stopDaemonHook: () => {
        events.push("stopDaemon");
      },
      stopServer: async () => {
        events.push("stopServer");
      },
    });

    expect(results.map((result) => result.caseId)).toEqual(["b-case"]);
    expect(events).toEqual([
      "startServer",
      "stopDaemon",
      "stopDaemon",
      "runCase",
      "stopDaemon",
      "stopDaemon",
      "stopServer",
    ]);
  });
});
