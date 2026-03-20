// pipeline/src/lib/browse.ts — Browse daemon lifecycle management
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

