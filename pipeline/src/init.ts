// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync } from "node:fs";
import { healthCheck } from "./lib/browse.js";

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

export async function runPreflight(baseUrl: string, specPath: string): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  const spec = checkSpecFile(specPath);
  if (!spec.ok) errors.push(spec.error!);

  const server = await checkDevServer(baseUrl);
  if (!server.ok) errors.push(server.error!);

  // Browse daemon check is best-effort — daemon may start lazily
  const daemon = checkBrowseDaemon();
  if (!daemon.ok) errors.push(daemon.error!);

  return { ok: errors.length === 0, errors };
}
