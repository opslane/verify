// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { healthCheck, startDaemon } from "./lib/browse.js";
import type { VerifyConfig } from "./lib/types.js";

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
  return { ok: false, error: "Browse daemon is not running." };
}

export function checkSpecFile(specPath: string): CheckResult {
  if (existsSync(specPath)) return { ok: true };
  return { ok: false, error: `Spec file not found: ${specPath}` };
}

/**
 * Replay saved login steps from config.json.
 * Restarts the browse daemon first to guarantee a clean cookie jar.
 */
export function loginWithCredentials(config: VerifyConfig, projectRoot?: string): CheckResult {
  if (!config.auth || !config.auth.email || !config.auth.password || !config.auth.loginSteps?.length) {
    return { ok: false, error: "No auth config — run /verify-setup to configure login" };
  }

  // TODO: Task 2 replaces this with step replay
  return { ok: true };
}

export async function runPreflight(
  baseUrl: string,
  specPath: string,
  verifyDir?: string,
  config?: VerifyConfig
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const spec = checkSpecFile(specPath);
  if (!spec.ok) errors.push(spec.error!);

  const server = await checkDevServer(baseUrl);
  if (!server.ok) errors.push(server.error!);

  // Ensure browse daemon is running
  const daemon = checkBrowseDaemon();
  if (!daemon.ok) {
    try {
      await startDaemon({});
    } catch {
      errors.push(daemon.error!);
      return { ok: errors.length === 0, errors };
    }
  }

  // Login with credentials — must use same cwd as browse agents (projectRoot)
  const projectRoot = verifyDir ? resolve(verifyDir, "..") : undefined;
  if (config?.auth) {
    const auth = loginWithCredentials(config, projectRoot);
    if (!auth.ok) errors.push(auth.error!);
  }

  return { ok: errors.length === 0, errors };
}
