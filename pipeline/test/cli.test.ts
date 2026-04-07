import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const CLI_PATH = join(__dirname, "..", "src", "cli.ts");

function runCli(args: string[], envOverrides: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, CLAUDE_BIN: "echo", ...envOverrides }, // stub claude by default
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
    expect(result.stderr).toContain("ac-generator");
    expect(result.stderr).toContain("verify-login");
  });

  it("errors when unknown stage given", () => {
    const result = runCli(["run-stage", "bogus", "--run-dir", "/tmp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown stage");
  });

  it("verify-login stage is accepted (not unknown)", () => {
    const result = runCli(["run-stage", "verify-login",
      "--verify-dir", "/tmp/nonexistent",
    ]);
    expect(result.stderr).not.toContain("Unknown stage: verify-login");
  });

});
