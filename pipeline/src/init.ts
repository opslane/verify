// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { healthCheck, resolveBrowseBin, startDaemon } from "./lib/browse.js";

interface CheckResult {
  ok: boolean;
  error?: string;
}

export async function checkDevServer(baseUrl: string): Promise<CheckResult> {
  try {
    await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    return { ok: true };
  } catch {
    return { ok: false, error: `Dev server at ${baseUrl} is not reachable. Is it running?` };
  }
}

export function checkBrowseDaemon(): CheckResult {
  const healthy = healthCheck();
  if (healthy) return { ok: true };
  return { ok: false, error: "Browse daemon is not running. Run /verify-setup first." };
}

export function checkSpecFile(specPath: string): CheckResult {
  if (existsSync(specPath)) return { ok: true };
  return { ok: false, error: `Spec file not found: ${specPath}` };
}

/**
 * Load cookies into the browse daemon and verify auth by navigating to baseUrl.
 * Returns ok:true if the page does NOT show a login form.
 */
export function ensureBrowseAuth(verifyDir: string, baseUrl: string): CheckResult {
  const bin = resolveBrowseBin();

  // Load cookies from cookies.json if present
  const cookiesPath = join(verifyDir, "cookies.json");
  if (existsSync(cookiesPath)) {
    try {
      const cookies = JSON.parse(readFileSync(cookiesPath, "utf-8")) as Array<{ name: string; value: string }>;
      for (const cookie of cookies) {
        try {
          execFileSync(bin, ["cookie", `${cookie.name}=${cookie.value}`], { timeout: 5000, stdio: "ignore" });
        } catch { /* best effort */ }
      }
    } catch { /* malformed cookies.json */ }
  }

  // Navigate to baseUrl and check for login page
  try {
    execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore" });
    // Wait for page load
    const snapshot = execFileSync(bin, ["snapshot", "-D"], { timeout: 5_000, encoding: "utf-8" });
    const loginPatterns = /login|sign.in|password|log.in|Login to your account/i;
    if (loginPatterns.test(snapshot)) {
      return { ok: false, error: `Browse daemon shows a login page at ${baseUrl}. Run /verify-setup to re-authenticate.` };
    }
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: `Failed to verify browse auth: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runPreflight(baseUrl: string, specPath: string, verifyDir?: string): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  const spec = checkSpecFile(specPath);
  if (!spec.ok) errors.push(spec.error!);

  const server = await checkDevServer(baseUrl);
  if (!server.ok) errors.push(server.error!);

  // Ensure browse daemon is running
  const daemon = checkBrowseDaemon();
  if (!daemon.ok) {
    // Try starting it
    try {
      await startDaemon({});
    } catch {
      errors.push(daemon.error!);
      return { ok: errors.length === 0, errors };
    }
  }

  // Verify auth if verifyDir provided
  if (verifyDir) {
    const auth = ensureBrowseAuth(verifyDir, baseUrl);
    if (!auth.ok) errors.push(auth.error!);
  }

  return { ok: errors.length === 0, errors };
}
