import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunClaudeOptions, RunClaudeResult } from "./lib/types.js";
import { appendTimelineEvent } from "./lib/timeline.js";

/**
 * Run `claude -p` with the given prompt.
 *
 * Uses `spawn` (not `execFile`) because:
 * 1. Correct stdin piping — prompt is written to stdin, not passed as argument
 * 2. Stream-based stdout/stderr collection — handles arbitrarily large output
 *    (the Planner stage can produce megabytes of tool call transcripts)
 * 3. Proper timeout handling via setTimeout + child.kill()
 */
export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const { prompt, model, timeoutMs, stage, runDir, dangerouslySkipPermissions, allowedTools } = opts;
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  // Write prompt to disk before calling claude
  writeFileSync(join(logsDir, `${stage}-prompt.txt`), prompt);

  // Build args
  const args = ["-p", "--model", model];
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (allowedTools) {
    for (const tool of allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  appendTimelineEvent(runDir, { stage, event: "start" });
  const startMs = Date.now();

  return new Promise<RunClaudeResult>((resolve) => {
    const claudeBin = process.env.CLAUDE_BIN ?? "claude";
    const child = spawn(claudeBin, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Collect stdout and stderr via streams
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // Write prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();

    // Timeout handling
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.on("close", (code, _signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      // If child was killed but we didn't set timedOut, it was killed externally
      if (!timedOut && child.killed) timedOut = true;

      const stdoutStr = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderrStr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = timedOut ? 124 : (code ?? 1);

      // Always write output files
      writeFileSync(join(logsDir, `${stage}-output.txt`), stdoutStr);
      writeFileSync(join(logsDir, `${stage}-stderr.txt`), stderrStr);

      appendTimelineEvent(runDir, {
        stage,
        event: timedOut ? "timeout" : (exitCode === 0 ? "end" : "error"),
        durationMs,
        detail: timedOut ? `Timed out after ${timeoutMs}ms` : undefined,
      });

      resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode, durationMs, timedOut });
    });
  });
}
