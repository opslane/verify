import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

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
    expect(result.stderr).toContain("browse-agent");
  });

  it("errors when unknown stage given", () => {
    const result = runCli(["run-stage", "bogus", "--run-dir", "/tmp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown stage");
  });

  it("browse-agent stage honors per-AC timeout_seconds", () => {
    const rootDir = join(tmpdir(), `verify-cli-${Date.now()}`);
    const verifyDir = join(rootDir, ".verify");
    const runDir = join(rootDir, "run");
    const claudeStubPath = join(rootDir, "claude-stub.js");

    mkdirSync(join(runDir, "logs"), { recursive: true });
    mkdirSync(verifyDir, { recursive: true });
    writeFileSync(join(verifyDir, "config.json"), JSON.stringify({ baseUrl: "http://localhost:3000" }));
    writeFileSync(join(runDir, "plan.json"), JSON.stringify({
      criteria: [{
        id: "ac1",
        group: "group-a",
        description: "Check timeout wiring",
        url: "/settings",
        steps: ["Go to /settings"],
        screenshot_at: [],
        timeout_seconds: 7,
      }],
    }));
    writeFileSync(claudeStubPath, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ type: 'result', result: process.env.CLAUDE_STUB_RESULT ?? '' }) + '\\n');",
      "});",
    ].join("\n"));
    chmodSync(claudeStubPath, 0o755);

    const result = runCli([
      "run-stage",
      "browse-agent",
      "--verify-dir",
      verifyDir,
      "--run-dir",
      runDir,
      "--ac",
      "ac1",
    ], {
      CLAUDE_BIN: claudeStubPath,
      CLAUDE_STUB_RESULT: JSON.stringify({ ac_id: "ac1", observed: "ok", screenshots: [], commands_run: [] }),
      BROWSE_BIN: "/tmp/fake-browse",
    });

    expect(result.exitCode).toBe(0);
    const diag = readFileSync(join(runDir, "logs", "browse-agent-ac1-diag.txt"), "utf-8");
    expect(diag).toContain("timeout: 7000ms");

    rmSync(rootDir, { recursive: true, force: true });
  });
});
