import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
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
  it("shows usage when no command given", () => {
    const result = runCli([]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("run-stage");
    expect(result.stderr).toContain("judge");
    expect(result.stderr).toContain("learner");
  });

  it("errors when unknown stage given", () => {
    const result = runCli(["run-stage", "bogus", "--run-dir", "/tmp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown stage");
  });

  it("login-agent stage is accepted (not unknown)", () => {
    const result = runCli(["run-stage", "login-agent",
      "--verify-dir", "/tmp/nonexistent",
      "--base-url", "http://localhost:3000",
      "--email", "a@b.com",
      "--password", "x",
      "--browse-bin", "/nonexistent/browse",
    ]);
    // Should not error with "Unknown stage" — may fail for other reasons (no browse binary, etc.)
    expect(result.stderr).not.toContain("Unknown stage: login-agent");
  });

  it("verify-login stage is accepted (not unknown)", () => {
    const result = runCli(["run-stage", "verify-login",
      "--verify-dir", "/tmp/nonexistent",
    ]);
    expect(result.stderr).not.toContain("Unknown stage: verify-login");
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
