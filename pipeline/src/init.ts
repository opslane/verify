// pipeline/src/init.ts — Preflight checks + cookie auth (run before any LLM call)
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveBrowseBin, startDaemon } from "./lib/browse.js";

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

export function checkSpecFile(specPath: string): CheckResult {
  if (existsSync(specPath)) return { ok: true };
  return { ok: false, error: `Spec file not found: ${specPath}` };
}

/**
 * Import cookies from the user's Chromium browser into a browse daemon.
 * Replaces the old loginOnDaemon — no credentials or login steps needed.
 * Uses gstack's browse binary: `browse cookie-import-browser chromium <domain>`
 */
export function importCookiesToDaemon(
  baseUrl: string,
  extraEnv: Record<string, string> = {},
): CheckResult {
  const bin = resolveBrowseBin();
  const domain = new URL(baseUrl).hostname;
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  try {
    execFileSync(bin, ["cookie-import-browser", "chromium", domain], {
      timeout: 15_000,
      stdio: "ignore",
      env: spawnEnv,
    });
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Cookie import failed: ${err instanceof Error ? err.message : String(err)}. Make sure you're logged in to ${baseUrl} in Chrome.`,
    };
  }
}

/**
 * Preflight checks: spec exists + dev server reachable.
 * Does NOT import cookies — the orchestrator handles per-group cookie import.
 */
export async function runPreflight(
  baseUrl: string,
  specPath: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const spec = checkSpecFile(specPath);
  if (!spec.ok) errors.push(spec.error!);

  const server = await checkDevServer(baseUrl);
  if (!server.ok) errors.push(server.error!);

  return { ok: errors.length === 0, errors };
}
