import { Sandbox as E2BSandbox } from "e2b";
import type { SandboxProvider, SandboxConfig, Sandbox, FileUpload, RunOptions } from "./types.js";

const MAX_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

// Strip ANSI escape codes from PTY output before JSON parsing
function stripAnsi(str: string): string {
  return str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g,
    ""
  );
}

// Shell-escape a string by wrapping in single quotes and escaping internal single quotes
function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

export class E2BSandboxProvider implements SandboxProvider {
  private sandboxes = new Map<string, E2BSandbox>();
  private sandboxEnvs = new Map<string, Record<string, string>>();

  async create(config: SandboxConfig): Promise<Sandbox> {
    if (!config.template) {
      throw new Error("Sandbox template is required");
    }
    if (
      config.timeoutMs !== undefined &&
      (config.timeoutMs < 0 || config.timeoutMs > MAX_SANDBOX_TIMEOUT_MS)
    ) {
      throw new Error(`timeoutMs must be between 0 and ${MAX_SANDBOX_TIMEOUT_MS}`);
    }

    const startTime = Date.now();
    try {
      const e2bSandbox = await E2BSandbox.create(config.template, {
        timeoutMs: config.timeoutMs,
        envs: config.envVars,
        metadata: config.metadata,
      });

      this.sandboxes.set(e2bSandbox.sandboxId, e2bSandbox);
      this.sandboxEnvs.set(e2bSandbox.sandboxId, config.envVars ?? {});

      console.log("Sandbox created", {
        sandboxId: e2bSandbox.sandboxId,
        durationMs: Date.now() - startTime,
        sessionId: config.metadata.sessionId,
      });

      return {
        id: e2bSandbox.sandboxId,
        status: "running",
        createdAt: new Date(),
      };
    } catch (err) {
      console.error("Sandbox creation failed", { error: (err as Error).message, durationMs: Date.now() - startTime });
      throw err;
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox) {
      await sandbox.kill();
      this.sandboxes.delete(sandboxId);
      this.sandboxEnvs.delete(sandboxId);
      console.log("Sandbox destroyed", { sandboxId });
    }
  }

  /**
   * Run a shell command inside the sandbox via PTY.
   *
   * SECURITY: `command` is passed to a shell as-is. Callers MUST ensure `command`
   * does not contain unsanitized external input (user-controlled strings from webhooks,
   * PR titles, branch names, etc.). Validate all inputs before interpolating into command.
   */
  async *runCommand(sandboxId: string, command: string, opts?: RunOptions): AsyncIterable<string> {
    const rawOutput = opts?.rawOutput ?? false;
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);

    // IMPORTANT: E2B's commands.run() onStdout does NOT fire in real-time.
    // Must use PTY (pseudo-terminal) for true streaming.
    // Validated in spike: spike/src/01-streaming.ts (2026-02-13)

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const lineQueue: string[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    // Keep recent non-JSON output for diagnostics when the command fails
    const recentNonJsonLines: string[] = [];
    const MAX_DIAGNOSTIC_LINES = 20;

    const ptyHandle = await sandbox.pty.create({
      cols: 32000,  // Very wide to prevent terminal line wrapping of JSON
      rows: 50,
      timeoutMs: opts?.timeoutMs ?? 300_000,
      envs: this.sandboxEnvs.get(sandboxId) ?? {},
      onData: (data: Uint8Array) => {
        const text = decoder.decode(data, { stream: true });
        buffer += text;

        // Process any complete lines in the buffer.
        // PTY uses \r\n line endings. Also handle plain \n.
        // Keep the last (possibly incomplete) segment in the buffer.
        const segments = buffer.split(/\r?\n/);
        buffer = segments.pop() ?? "";

        for (const segment of segments) {
          const cleaned = stripAnsi(segment).trim();
          if (!cleaned) continue;

          // Find JSON object in the segment (may have leading prompt/ANSI artifacts)
          const jsonIdx = cleaned.indexOf("{");
          if (jsonIdx !== -1) {
            const candidate = cleaned.slice(jsonIdx);
            try {
              JSON.parse(candidate);
              lineQueue.push(candidate);
              if (resolve) {
                resolve();
                resolve = null;
              }
              continue;
            } catch {
              // Not valid JSON line, fall through to debug log
            }
          }

          // In raw mode, yield all output lines (not just JSON)
          if (rawOutput) {
            // Filter shell noise: prompt echoes, login banners, exit markers
            const isPromptEcho = /^(.*@.*[:~].*\$|.*\$)\s/.test(cleaned) && cleaned.includes('; exit');
            const isLoginNoise = cleaned.startsWith('To run a command as administrator') ||
              cleaned.startsWith('See "man sudo_root"') ||
              cleaned === 'logout';
            if (!isPromptEcho && !isLoginNoise) {
              lineQueue.push(cleaned);
              if (resolve) {
                resolve();
                resolve = null;
              }
            }
          }

          // Capture non-JSON output for diagnostics on failure
          recentNonJsonLines.push(cleaned);
          if (recentNonJsonLines.length > MAX_DIAGNOSTIC_LINES) {
            recentNonJsonLines.shift();
          }
          console.debug("PTY non-JSON output", { line: cleaned.slice(0, 200) });
        }
      },
    });

    // Send command to PTY shell
    const cwd = opts?.cwd ?? "/home/user";
    if (!cwd.startsWith("/")) {
      throw new Error(`cwd must be an absolute path, got: ${cwd}`);
    }
    await sandbox.pty.sendInput(
      ptyHandle.pid,
      encoder.encode(`cd ${shellEscape(cwd)} && ${command}; exit\n`)
    );

    // Yield lines as they arrive via async iteration
    let ptyError: Error | null = null;

    const waitResult = ptyHandle.wait().then(() => {
      // Flush remaining buffer
      if (buffer.trim()) {
        const cleaned = stripAnsi(buffer).trim();
        const jsonIdx = cleaned.indexOf("{");
        if (jsonIdx !== -1) {
          const candidate = cleaned.slice(jsonIdx);
          try {
            JSON.parse(candidate);
            lineQueue.push(candidate);
          } catch {
            if (rawOutput) {
              lineQueue.push(cleaned);
            }
            recentNonJsonLines.push(cleaned);
            if (recentNonJsonLines.length > MAX_DIAGNOSTIC_LINES) {
              recentNonJsonLines.shift();
            }
            console.debug("PTY final buffer (non-JSON)", { line: cleaned.slice(0, 200) });
          }
        }
        buffer = "";
      }
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }).catch((err) => {
      ptyError = err instanceof Error ? err : new Error(String(err));
      done = true;
      if (resolve) { resolve(); resolve = null; }
    });

    while (!done || lineQueue.length > 0) {
      if (lineQueue.length > 0) {
        yield lineQueue.shift()! + "\n";
      } else if (!done) {
        await new Promise<void>(r => { resolve = r; });
      }
    }

    await waitResult;

    // Surface PTY errors to the caller with diagnostic context
    if (ptyError) {
      if (recentNonJsonLines.length > 0) {
        const diagnostics = recentNonJsonLines.join("\n");
        console.error("PTY command failed — last non-JSON output", { ptyOutput: diagnostics, sandboxId });
        // Attach diagnostic output to the error for upstream consumers
        (ptyError as Error & { ptyOutput?: string }).ptyOutput = diagnostics;
      }
      throw ptyError;
    }
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    if (!path.startsWith('/') || path.includes('..')) {
      throw new Error(`readFile path must be absolute without traversal: ${path}`);
    }
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);
    return sandbox.files.read(path);
  }

  async uploadFiles(sandboxId: string, files: FileUpload[]): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox ${sandboxId} not found`);

    for (const file of files) {
      const content = typeof file.content === "string" ? file.content : file.content.toString("utf-8");
      await sandbox.files.write(file.path, content);
    }
  }
}
