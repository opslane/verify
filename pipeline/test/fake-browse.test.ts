import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "src", "evals", "fake-browse.ts");
const TSX_BIN = join(__dirname, "..", "node_modules", ".bin", "tsx");

describe("fake-browse", () => {
  let tmpDir: string;
  let scriptPath: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "verify-fake-browse-"));
    scriptPath = join(tmpDir, "browse-script.json");
    tracePath = join(tmpDir, "trace.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns scripted stdout and appends a trace entry", () => {
    writeFileSync(scriptPath, JSON.stringify({
      steps: [
        { match: "snapshot", stdout: "page snapshot", exitCode: 0 },
      ],
    }));

    const stdout = execFileSync(TSX_BIN, [CLI_PATH, "snapshot"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        BROWSE_EVAL_SCRIPT: scriptPath,
        BROWSE_EVAL_TRACE: tracePath,
      },
    });

    expect(stdout).toBe("page snapshot");

    const traceLines = readFileSync(tracePath, "utf-8").trim().split("\n");
    expect(traceLines).toHaveLength(1);
    const trace = JSON.parse(traceLines[0]) as { command: string; exitCode: number; stdout: string };
    expect(trace.command).toBe("snapshot");
    expect(trace.exitCode).toBe(0);
    expect(trace.stdout).toBe("page snapshot");
  });

  it("matches command prefixes like hover and waits when configured", () => {
    writeFileSync(scriptPath, JSON.stringify({
      steps: [
        { match: "hover", stdout: "hovered", exitCode: 0, sleepMs: 5 },
      ],
    }));

    const stdout = execFileSync(TSX_BIN, [CLI_PATH, "hover", "@e70"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        BROWSE_EVAL_SCRIPT: scriptPath,
        BROWSE_EVAL_TRACE: tracePath,
      },
    });

    expect(stdout).toBe("hovered");
    const trace = JSON.parse(readFileSync(tracePath, "utf-8").trim()) as { command: string };
    expect(trace.command).toBe("hover @e70");
  });

  it("accepts trailing-space goto matches against a full URL command", () => {
    writeFileSync(scriptPath, JSON.stringify({
      steps: [
        { match: "goto ", stdout: "navigated", exitCode: 0 },
      ],
    }));

    const stdout = execFileSync(TSX_BIN, [CLI_PATH, "goto", "http://localhost:3000/settings/billing"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        BROWSE_EVAL_SCRIPT: scriptPath,
        BROWSE_EVAL_TRACE: tracePath,
      },
    });

    expect(stdout).toBe("navigated");
    const trace = JSON.parse(readFileSync(tracePath, "utf-8").trim()) as { command: string };
    expect(trace.command).toBe("goto http://localhost:3000/settings/billing");
  });

  it("consumes scripted responses in order across separate invocations", () => {
    writeFileSync(scriptPath, JSON.stringify({
      steps: [
        { match: "snapshot", stdout: "loading", exitCode: 0 },
        { match: "snapshot", stdout: "loaded", exitCode: 0 },
      ],
    }));

    const first = execFileSync(TSX_BIN, [CLI_PATH, "snapshot"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        BROWSE_EVAL_SCRIPT: scriptPath,
        BROWSE_EVAL_TRACE: tracePath,
      },
    });
    const second = execFileSync(TSX_BIN, [CLI_PATH, "snapshot"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        BROWSE_EVAL_SCRIPT: scriptPath,
        BROWSE_EVAL_TRACE: tracePath,
      },
    });

    expect(first).toBe("loading");
    expect(second).toBe("loaded");
    const traceLines = readFileSync(tracePath, "utf-8").trim().split("\n");
    expect(traceLines).toHaveLength(2);
  });

  it("fails clearly when the next scripted step does not match the command", () => {
    writeFileSync(scriptPath, JSON.stringify({
      steps: [
        { match: "snapshot", stdout: "loading", exitCode: 0 },
      ],
    }));

    try {
      execFileSync(TSX_BIN, [CLI_PATH, "hover", "@e70"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          BROWSE_EVAL_SCRIPT: scriptPath,
          BROWSE_EVAL_TRACE: tracePath,
        },
      });
      throw new Error("expected mismatched command to fail");
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      expect(e.status).toBe(98);
      expect(String(e.stderr ?? "")).toContain("SCRIPT MISMATCH");
      expect(String(e.stderr ?? "")).toContain('expected "snapshot"');
    }
  });
});
