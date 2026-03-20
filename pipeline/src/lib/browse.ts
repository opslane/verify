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

  try { execFileSync(bin, ["stop"], { env, timeout: 5000, stdio: "ignore" }); } catch { /* wasn't running */ }
  // goto about:blank implicitly starts the daemon if not running
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
  try { execFileSync(resolveBrowseBin(), ["goto", "about:blank"], { timeout: 10_000, stdio: "ignore" }); } catch { /* best effort */ }
}

