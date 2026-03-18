import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI_PATH = join(__dirname, "..", "src", "cli.ts");

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, CLAUDE_BIN: "echo" }, // stub claude with echo
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("cli", () => {
  it("shows usage with --help", () => {
    const result = runCli(["--help"]);
    expect(result.stdout).toContain("run-stage");
    expect(result.stdout).toContain("judge");
    expect(result.stdout).toContain("learner");
  });

  it("errors when no command given", () => {
    const result = runCli([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("expected");
  });

  it("errors when unknown stage given", () => {
    const result = runCli(["run-stage", "bogus", "--run-dir", "/tmp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown stage");
  });

  it("errors when --run-dir is missing", () => {
    const result = runCli(["run-stage", "judge"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--run-dir");
  });

  it("judge with empty evidence outputs empty verdicts", () => {
    const runDir = join(tmpdir(), `verify-cli-${Date.now()}`);
    mkdirSync(join(runDir, "logs"), { recursive: true });
    const result = runCli(["run-stage", "judge", "--run-dir", runDir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"verdicts":[]');
    rmSync(runDir, { recursive: true, force: true });
  });
});
