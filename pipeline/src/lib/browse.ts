// pipeline/src/lib/browse.ts — Browse daemon lifecycle management
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";

// ── Browse binary auto-download ─────────────────────────────────────────────

export const BROWSE_TAG = "v0.1.0";

const BROWSE_CHECKSUMS: Record<string, string> = {
  "darwin-arm64": "PLACEHOLDER_CHECKSUM_DARWIN_ARM64",
  "darwin-x64": "PLACEHOLDER_CHECKSUM_DARWIN_X64",
  "linux-x64": "PLACEHOLDER_CHECKSUM_LINUX_X64",
};

export function detectPlatform(): string {
  const os = platform();
  const cpu = arch();
  const key = `${os}-${cpu}`;
  if (!(key in BROWSE_CHECKSUMS)) {
    throw new Error(`Unsupported platform: ${key}. Supported: ${Object.keys(BROWSE_CHECKSUMS).join(", ")}. Set BROWSE_BIN env var to use a custom binary.`);
  }
  return key;
}

/**
 * Download the browse binary from GitHub releases, verify SHA256, and install atomically.
 * Uses Node 22 built-in fetch.
 */
export async function ensureBrowseBin(): Promise<string> {
  if (process.env.BROWSE_BIN) return process.env.BROWSE_BIN;

  const cacheDir = join(homedir(), ".cache", "verify");
  const finalPath = join(cacheDir, "browse");
  if (existsSync(finalPath)) return finalPath;

  const plat = detectPlatform();
  const baseUrl = process.env.BROWSE_RELEASE_URL
    ?? `https://github.com/AshDevFr/gstack/releases/download/${BROWSE_TAG}`;
  const url = `${baseUrl}/browse-${plat}`;

  mkdirSync(cacheDir, { recursive: true });
  const tmpPath = join(cacheDir, `browse.tmp.${process.pid}`);

  try {
    console.log(`Downloading browse binary for ${plat}...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText} from ${url}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(tmpPath, buffer);

    // Verify SHA256 checksum (skip if placeholder — real checksums filled before GA)
    const expected = BROWSE_CHECKSUMS[plat];
    if (expected.startsWith("PLACEHOLDER_")) {
      console.warn(`Warning: checksum verification skipped for browse-${plat} (no checksum configured)`);
    } else {
      const hash = createHash("sha256").update(buffer).digest("hex");
      if (hash !== expected) {
        throw new Error(
          `Checksum mismatch for browse-${plat}:\n  expected: ${expected}\n  got:      ${hash}\nThe binary may be corrupted or tampered with.`,
        );
      }
    }

    // Atomic install: rename + chmod
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o755);
    console.log(`Browse binary installed: ${finalPath}`);
    return finalPath;
  } catch (err) {
    // Clean up temp file on any failure
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
    throw err;
  }
}

export function resolveBrowseBin(): string {
  if (process.env.BROWSE_BIN) return process.env.BROWSE_BIN;
  const cached = join(homedir(), ".cache", "verify", "browse");
  if (existsSync(cached)) return cached;
  throw new Error("Browse binary not found. Run `npx @opslane/verify init` or set BROWSE_BIN env var.");
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

