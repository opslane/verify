import { spawn } from "node:child_process";
import { writeFileSync, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunClaudeOptions, RunClaudeResult } from "./lib/types.js";
import { appendTimelineEvent } from "./lib/timeline.js";

/**
 * Run `claude -p` with the given prompt.
 *
 * Uses `--output-format stream-json --verbose` so JSONL events stream in
 * real time (tool calls, assistant chunks, system events). This means:
 *  - Raw JSONL → {stage}-stream.jsonl (real-time debug log)
 *  - Extracted final text → {stage}-output.txt (backward compat with parsers)
 *  - Progress callbacks fire on each tool_use event
 */
export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const { prompt, model, timeoutMs, stage, runDir, cwd, dangerouslySkipPermissions, allowedTools, tools, effort, settingSources, onProgress } = opts;
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  // Write prompt to disk before calling claude
  writeFileSync(join(logsDir, `${stage}-prompt.txt`), prompt);

  // Build args — stream-json gives us real-time JSONL events
  const args = ["-p", "--model", model, "--output-format", "stream-json", "--verbose"];
  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (tools !== undefined) {
    // --tools replaces the entire tool set. Empty array = no tools.
    args.push("--tools", tools.length > 0 ? tools.join(",") : "");
  } else if (allowedTools) {
    // Legacy: --allowedTools adds to the default set (doesn't restrict)
    for (const tool of allowedTools) {
      args.push("--allowedTools", tool);
    }
  }
  if (effort) {
    args.push("--effort", effort);
  }
  // Default to empty string — pipeline subprocesses should not load user hooks/skills
  args.push("--setting-sources", settingSources ?? "");

  appendTimelineEvent(runDir, { stage, event: "start" });
  const startMs = Date.now();

  return new Promise<RunClaudeResult>((resolve) => {
    const claudeBin = process.env.CLAUDE_BIN ?? "claude";
    const child = spawn(claudeBin, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });

    const pid = child.pid;

    // Collect stdout and stderr via streams, streaming to disk incrementally
    // so partial output is preserved even on timeout/kill
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutPath = join(logsDir, `${stage}-output.txt`);
    const streamPath = join(logsDir, `${stage}-stream.jsonl`);
    const stderrPath = join(logsDir, `${stage}-stderr.txt`);
    const diagPath = join(logsDir, `${stage}-diag.txt`);
    const streamFile = createWriteStream(streamPath);
    const stderrStream = createWriteStream(stderrPath);
    const diagLines: string[] = [];

    const diag = (msg: string) => {
      const ts = new Date().toISOString();
      diagLines.push(`[${ts}] ${msg}`);
    };

    diag(`spawn: ${claudeBin} ${args.join(" ")}`);
    diag(`pid: ${pid ?? "undefined"}`);
    diag(`cwd: ${cwd ?? process.cwd()}`);
    diag(`timeout: ${timeoutMs}ms`);

    // Track stream events for diagnostics
    let eventCount = 0;
    let lastEventType = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      streamFile.write(chunk);  // raw JSONL to {stage}-stream.jsonl

      // Parse events for progress reporting
      const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line) as {
            type?: string;
            message?: { content?: Array<{ type: string; name?: string }> };
          };
          eventCount++;
          lastEventType = evt.type ?? "";

          // Report tool use activity with input content
          if (onProgress && evt.type === "assistant" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "tool_use" && block.name) {
                // Extract tool input for supervisor visibility
                const input = (block as Record<string, unknown>).input as Record<string, unknown> | undefined;
                const toolInput = input?.command as string ?? input?.description as string ?? undefined;
                onProgress({ stage, event: "tool_call", detail: block.name, toolInput });
              }
            }
          }
        } catch {
          // partial line or non-JSON — ignore
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrStream.write(chunk);
    });

    // Handle spawn errors (e.g., binary not found, permission denied)
    let spawnError: Error | null = null;
    child.on("error", (err: Error) => {
      spawnError = err;
      diag(`error event: ${err.message}`);
    });

    // Write prompt to stdin
    child.stdin.on("error", (err: Error) => {
      diag(`stdin error: ${err.message}`);
    });
    child.stdin.write(prompt);
    child.stdin.end();

    // Timeout handling
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      diag(`timeout fired at ${timeoutMs}ms — sending SIGTERM`);
      child.kill("SIGTERM");
      // Give the process 5s to flush and exit, then SIGKILL
      setTimeout(() => {
        if (!child.killed || child.exitCode === null) {
          diag("SIGTERM grace period expired — sending SIGKILL");
          child.kill("SIGKILL");
        }
      }, 5_000);
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      // If child was killed but we didn't set timedOut, it was killed externally
      if (!timedOut && child.killed) timedOut = true;

      const rawStream = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderrStr = Buffer.concat(stderrChunks).toString("utf-8");
      const exitCode = timedOut ? 124 : (code ?? 1);

      // Extract final result text from stream-json events.
      // Claude CLI v2.1.83+ returns result:"" when tool calls are involved,
      // so we fall back to the last assistant text block.
      let finalText = "";
      let lastAssistantText = "";
      let parseFailures = 0;

      for (const line of rawStream.split("\n")) {
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          if (evt.type === "result" && typeof evt.result === "string" && evt.result) {
            finalText = evt.result;
          }
          if (evt.type === "assistant") {
            const msg = evt.message as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (msg?.content) {
              for (const block of msg.content) {
                if (block.type === "text" && block.text) {
                  lastAssistantText = block.text;
                }
              }
            }
          }
        } catch {
          parseFailures++;
        }
      }
      if (!finalText && lastAssistantText) {
        finalText = lastAssistantText;
      }

      diag(`close: code=${code} signal=${signal} killed=${child.killed} timedOut=${timedOut}`);
      diag(`duration: ${durationMs}ms`);
      diag(`stream events: ${eventCount}, last type: ${lastEventType}`);
      diag(`raw stream: ${rawStream.length} bytes`);
      diag(`extracted text: ${finalText.length} bytes (fallback=${!finalText && lastAssistantText ? "yes" : "no"}, parseFailures=${parseFailures})`);
      diag(`stderr: ${stderrStr.length} bytes`);
      if (spawnError) diag(`spawnError: ${spawnError.message}`);
      if (exitCode !== 0 && !timedOut) {
        diag(`NON-ZERO EXIT: ${exitCode}`);
        if (stderrStr.length > 0) {
          diag(`stderr preview: ${stderrStr.slice(0, 500)}`);
        }
        if (finalText.length === 0) {
          diag("WARNING: zero extracted text — claude may have crashed or failed to start");
        }
      }

      // Close incremental streams, then write final files synchronously
      streamFile.end();
      stderrStream.end();
      writeFileSync(stdoutPath, finalText);           // {stage}-output.txt = extracted final answer
      writeFileSync(streamPath, rawStream);            // {stage}-stream.jsonl = full event stream
      writeFileSync(stderrPath, stderrStr);
      writeFileSync(diagPath, diagLines.join("\n") + "\n");

      const event = timedOut ? "timeout" : (exitCode === 0 ? "end" : "error");
      appendTimelineEvent(runDir, {
        stage,
        event,
        durationMs,
        detail: timedOut
          ? `Timed out after ${timeoutMs}ms`
          : exitCode !== 0
            ? `Exit code ${exitCode}${signal ? ` (signal: ${signal})` : ""}${spawnError ? ` spawn error: ${spawnError.message}` : ""}`
            : undefined,
      });

      resolve({ stdout: finalText, stderr: stderrStr, exitCode, durationMs, timedOut });
    });
  });
}
