import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process.spawn
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  const { Readable, Writable } = require("node:stream");
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
      proc.kill = vi.fn();
      return proc;
    }),
  };
});

import { runClaude } from "../src/run-claude.js";
import { spawn } from "node:child_process";

function emitSuccess(mockSpawn: ReturnType<typeof vi.fn>, stdout = "", stderr = "") {
  // Use nextTick so stream data listeners are attached before push
  process.nextTick(() => {
    const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1].value;
    if (stdout) proc.stdout.push(stdout);
    proc.stdout.push(null);
    if (stderr) proc.stderr.push(stderr);
    proc.stderr.push(null);
    proc.emit("close", 0);
  });
}

function emitTimeout(mockSpawn: ReturnType<typeof vi.fn>) {
  process.nextTick(() => {
    const proc = mockSpawn.mock.results[mockSpawn.mock.results.length - 1].value;
    proc.stdout.push(null);
    proc.stderr.push(null);
    // Simulate timeout — kill is called, then close with signal
    proc.killed = true;
    proc.emit("close", null, "SIGTERM");
  });
}

describe("runClaude", () => {
  let runDir: string;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    runDir = join(tmpdir(), `verify-run-${Date.now()}`);
    mkdirSync(join(runDir, "logs"), { recursive: true });
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("writes prompt to log file before calling claude", async () => {
    const promise = runClaude({
      prompt: "test prompt",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "test-stage",
      runDir,
    });
    emitSuccess(mockSpawn);
    await promise;

    const promptPath = join(runDir, "logs", "test-stage-prompt.txt");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf-8")).toBe("test prompt");
  });

  it("saves stdout and stderr to log files", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "opus",
      timeoutMs: 5000,
      stage: "my-stage",
      runDir,
    });
    emitSuccess(mockSpawn, "the output", "some warnings");
    const result = await promise;

    expect(result.stdout).toBe("the output");
    expect(result.stderr).toBe("some warnings");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    expect(readFileSync(join(runDir, "logs", "my-stage-output.txt"), "utf-8")).toBe("the output");
    expect(readFileSync(join(runDir, "logs", "my-stage-stderr.txt"), "utf-8")).toBe("some warnings");
  });

  it("passes --model flag to claude", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "opus",
      timeoutMs: 5000,
      stage: "s",
      runDir,
    });
    emitSuccess(mockSpawn);
    await promise;

    const callArgs = mockSpawn.mock.calls[0];
    const args = callArgs[1] as string[];
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });

  it("passes --dangerouslySkipPermissions when set", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "s",
      runDir,
      dangerouslySkipPermissions: true,
    });
    emitSuccess(mockSpawn);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("passes --allowedTools when set", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "s",
      runDir,
      allowedTools: ["Read", "Grep"],
    });
    emitSuccess(mockSpawn);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read");
  });

  it("returns timedOut=true when timeout fires", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 100,
      stage: "s",
      runDir,
    });
    emitTimeout(mockSpawn);
    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it("records duration in milliseconds", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "s",
      runDir,
    });
    emitSuccess(mockSpawn);
    const result = await promise;

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("appends timeline events for start and end", async () => {
    const promise = runClaude({
      prompt: "test",
      model: "sonnet",
      timeoutMs: 5000,
      stage: "planner",
      runDir,
    });
    emitSuccess(mockSpawn);
    await promise;

    const timelinePath = join(runDir, "logs", "timeline.jsonl");
    expect(existsSync(timelinePath)).toBe(true);
    const lines = readFileSync(timelinePath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[0]).event).toBe("start");
    expect(JSON.parse(lines[1]).event).toBe("end");
  });
});
