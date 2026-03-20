// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { healthCheck, resolveBrowseBin, startDaemon } from "./lib/browse.js";
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
 * No LLM, no regex — pure mechanical replay of steps discovered during /verify-setup.
 */
export function loginWithCredentials(config: VerifyConfig, projectRoot?: string): CheckResult {
  if (!config.auth || !config.auth.email || !config.auth.password || !config.auth.loginSteps?.length) {
    return { ok: false, error: "No auth config — run /verify-setup to configure login" };
  }

  const bin = resolveBrowseBin();
  const opts = projectRoot ? { cwd: projectRoot } : {};
  const { email, password, loginSteps } = config.auth;

  try {
    // Restart daemon — clean slate, no stale cookies from prior sessions
    execFileSync(bin, ["restart"], { timeout: 10_000, stdio: "ignore", ...opts });

    for (const step of loginSteps) {
      switch (step.action) {
        case "goto": {
          const url = step.url.startsWith("http://") || step.url.startsWith("https://")
            ? step.url
            : `${config.baseUrl}${step.url}`;
          execFileSync(bin, ["goto", url], { timeout: 10_000, stdio: "ignore", ...opts });
          break;
        }
        case "fill": {
          const value = step.value
            .replaceAll("{{email}}", email)
            .replaceAll("{{password}}", password);
          execFileSync(bin, ["fill", step.selector, value], { timeout: 5_000, stdio: "ignore", ...opts });
          break;
        }
        case "click":
          execFileSync(bin, ["click", step.selector], { timeout: 5_000, stdio: "ignore", ...opts });
          break;
        case "sleep": {
          const seconds = Math.min(Math.ceil(step.ms / 1000), 30); // cap at 30s to prevent hangs
          execFileSync("sleep", [String(seconds)], { timeout: seconds * 1000 + 2_000, stdio: "ignore" });
          break;
        }
      }
    }

    return verifyAuthState(config.baseUrl, bin, opts);
  } catch (err: unknown) {
    return { ok: false, error: `Login replay failed: ${err instanceof Error ? err.message : String(err)}. Re-run /verify-setup.` };
  }
}

/**
 * Verify we're NOT on a login page by checking for password input fields.
 * A password field in the snapshot = still on login form.
 */
function verifyAuthState(baseUrl: string, bin: string, opts: { cwd?: string } = {}): CheckResult {
  try {
    execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", ...opts });
    execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });
    const snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });

    // Generic detection: if snapshot has a password-type input, we're on a login page
    const hasPasswordField = /\[textbox\].*password|\[text\].*password/i.test(snapshot);
    if (hasPasswordField) {
      return { ok: false, error: "Login steps did not authenticate — still on login page. Re-run /verify-setup." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to verify auth state after login" };
  }
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
