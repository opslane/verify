// pipeline/src/lib/browse.ts — Browse daemon lifecycle management
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function resolveBrowseBin(): string {
  if (process.env.BROWSE_BIN) return process.env.BROWSE_BIN;
  const cached = join(homedir(), ".cache", "verify", "browse");
  if (existsSync(cached)) return cached;
  throw new Error("Browse binary not found. Run /verify-setup or set BROWSE_BIN env var.");
}

export async function startDaemon(opts: { videoDir?: string }): Promise<void> {
  const bin = resolveBrowseBin();
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (opts.videoDir) env.BROWSE_VIDEO_DIR = opts.videoDir;

  try { execFileSync(bin, ["stop"], { env, timeout: 5000, stdio: "ignore" }); } catch { /* wasn't running */ }
  execFileSync(bin, ["goto", "about:blank"], { env, timeout: 10_000, stdio: "ignore" });
}

export async function healthCheck(): Promise<boolean> {
  try {
    execFileSync(resolveBrowseBin(), ["status"], { timeout: 5000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function stopDaemon(): Promise<void> {
  try { execFileSync(resolveBrowseBin(), ["stop"], { timeout: 5000, stdio: "ignore" }); } catch { /* already stopped */ }
}

export async function resetPage(): Promise<void> {
  try { execFileSync(resolveBrowseBin(), ["goto", "about:blank"], { timeout: 5000, stdio: "ignore" }); } catch { /* best effort */ }
}

export async function loadCookies(cookiesPath: string): Promise<void> {
  const cookies = JSON.parse(readFileSync(cookiesPath, "utf-8")) as Array<{ name: string; value: string }>;
  const bin = resolveBrowseBin();
  for (const cookie of cookies) {
    try { execFileSync(bin, ["cookie", `${cookie.name}=${cookie.value}`], { timeout: 5000, stdio: "ignore" }); } catch { /* best effort */ }
  }
}
