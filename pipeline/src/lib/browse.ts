// pipeline/src/lib/browse.ts — Browse daemon lifecycle management
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveBrowseBin(): string {
  if (process.env.BROWSE_BIN) return process.env.BROWSE_BIN;
  const cached = join(homedir(), ".cache", "verify", "browse");
  if (existsSync(cached)) return cached;
  throw new Error("Browse binary not found. Run /verify-setup or set BROWSE_BIN env var.");
}

// These functions use execFileSync (blocking) intentionally — the browse daemon
// is a local process and callers wait for each operation to complete before proceeding.

export function startDaemon(opts: { videoDir?: string }): void {
  const bin = resolveBrowseBin();
  const env = { ...process.env };
  if (opts.videoDir) env.BROWSE_VIDEO_DIR = opts.videoDir;

  // NOTE: browse status/stop/goto about:blank all break cookie persistence for subsequent
  // navigations. Only call startDaemon for non-auth flows (browse agents, QA).
  // For login flows, skip startDaemon — the first goto in login steps starts the daemon.
  try { execFileSync(bin, ["stop"], { env, timeout: 5000, stdio: "ignore" }); } catch { /* wasn't running */ }
  execFileSync(bin, ["goto", "about:blank"], { env, timeout: 10_000, stdio: "ignore" });
}

export function healthCheck(): boolean {
  try {
    execFileSync(resolveBrowseBin(), ["status"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function stopDaemon(): void {
  try { execFileSync(resolveBrowseBin(), ["stop"], { timeout: 5000, stdio: "ignore" }); } catch { /* already stopped */ }
}

export function resetPage(): void {
  // Intentionally a no-op. Navigating to about:blank between ACs breaks cookie persistence
  // in gstack/browse, causing login cookies to be lost for subsequent browse agents.
  // The browse agent's first goto step handles navigation to the correct page.
}

// ── Per-group daemon isolation ─────────────────────────────────────────────

export interface GroupDaemonEnv {
  env: Record<string, string>;
  stateDir: string;
}

/**
 * Create an isolated state directory for a group's browse daemon.
 * The daemon auto-starts on the first `browse goto` command that uses this env.
 */
export function startGroupDaemon(groupId: string, runDir: string): GroupDaemonEnv {
  const stateDir = join(runDir, `.browse-${groupId}`);
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "browse.json");
  return {
    env: { BROWSE_STATE_FILE: stateFile },
    stateDir,
  };
}

/**
 * Kill a group daemon by reading its PID from the state file.
 * Uses process.kill directly — avoids `browse stop` which can hang.
 */
export function stopGroupDaemon(stateDir: string): void {
  const stateFile = join(stateDir, "browse.json");
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    if (typeof state.pid === "number") {
      try { process.kill(state.pid, "SIGTERM"); } catch { /* already dead */ }
    }
  } catch {
    // State file missing or unparseable — daemon was never started or already cleaned up
  }
}

/**
 * Kill all group daemons under a run directory. Safety net for cleanup.
 */
export function stopAllGroupDaemons(runDir: string): void {
  try {
    const entries = readdirSync(runDir);
    for (const entry of entries) {
      if (entry.startsWith(".browse-")) {
        stopGroupDaemon(join(runDir, entry));
      }
    }
  } catch {
    // runDir doesn't exist or can't be read — nothing to clean up
  }
}

