import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { BrowseEvalArtifactPaths, BrowseEvalResult } from "../src/evals/browse-eval-score.js";
import {
  createTraceWrapper,
  defaultStageExecutor,
  discoverCaseDirs,
  runBrowseDomEvalCase,
  runBrowseDomEvals,
  selectCaseDirs,
} from "../src/evals/run-browse-dom-evals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  it("exposes eval:browse:dom in package.json scripts", () => {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["eval:browse:dom"]).toBe("tsx src/evals/run-browse-dom-evals.ts");
  });

  it("discovers DOM case directories in sorted order and filters by case id", () => {
    writeCase(tmpRoot, "b-case");
    writeCase(tmpRoot, "a-case");

    const discovered = discoverCaseDirs(tmpRoot);

    expect(discovered).toEqual([
      join(tmpRoot, "a-case"),
      join(tmpRoot, "b-case"),
    ]);
    expect(selectCaseDirs(discovered, "b-case")).toEqual([join(tmpRoot, "b-case")]);
  });

  it("creates a trace wrapper that forwards to the trace shim", () => {
    const wrapperPath = createTraceWrapper(tmpRoot);
    const content = readFileSync(wrapperPath, "utf8");

    expect(content).toContain("browse-trace-shim.ts");
  });

  it("runs a DOM case with config, trace env, and finally cleanup", () => {
    const caseDir = writeCase(tmpRoot, "tooltip-hover-success");
    const captured: {
      config?: { baseUrl: string };
      env?: Record<string, string>;
      runDir?: string;
      scorePaths?: BrowseEvalArtifactPaths;
      verifyDir?: string;
      wrapper?: string;
    } = {};

    const result = runBrowseDomEvalCase(caseDir, {
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

  it("default stage executor shells to the production browse-agent CLI path", () => {
    const execFileSyncMock = vi.fn();

    defaultStageExecutor({
      acId: "ac1",
      env: { TEST_ENV: "1" },
      pipelineDir: "/pipeline",
      runDir: "/pipeline/run",
      verifyDir: "/pipeline/.verify",
    }, execFileSyncMock);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith("npx", [
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
      stdio: "pipe",
    }));
  });

  it("runs the server once and browse lifecycle hooks around filtered cases", async () => {
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
      startDaemonHook: () => {
        events.push("startDaemon");
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
      "startDaemon",
      "runCase",
      "stopDaemon",
      "stopDaemon",
      "stopServer",
    ]);
  });
});
