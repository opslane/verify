// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, execSync } from "node:child_process";
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
 * Login on a specific browse daemon identified by env vars (e.g., BROWSE_STATE_FILE).
 * Reusable for both the primary daemon (preflight) and per-group daemons.
 * No LLM, no regex — pure mechanical replay of steps discovered during /verify-setup.
 */
export function loginOnDaemon(config: VerifyConfig, extraEnv: Record<string, string> = {}): CheckResult {
  if (!config.auth || !config.auth.email || !config.auth.password || !config.auth.loginSteps?.length) {
    return { ok: false, error: "No auth config — run /verify-setup to configure login" };
  }

  const bin = resolveBrowseBin();
  const { email, password, loginSteps } = config.auth;
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  try {
    for (const step of loginSteps) {
      switch (step.action) {
        case "goto": {
          const url = step.url.startsWith("http://") || step.url.startsWith("https://")
            ? step.url
            : `${config.baseUrl}${step.url}`;
          execFileSync(bin, ["goto", url], { timeout: 10_000, stdio: "ignore", env: spawnEnv });
          // Wait for page load + React hydration before subsequent fill/click steps.
          // Without this, fills hit native HTML inputs before React mounts event handlers,
          // causing form submission to send stale/empty data.
          execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });
          break;
        }
        case "fill": {
          const value = step.value
            .replaceAll("{{email}}", email)
            .replaceAll("{{password}}", password);
          execFileSync(bin, ["fill", step.selector, value], { timeout: 5_000, stdio: "ignore", env: spawnEnv });
          break;
        }
        case "click":
          execFileSync(bin, ["click", step.selector], { timeout: 5_000, stdio: "ignore", env: spawnEnv });
          break;
        case "sleep": {
          const seconds = Math.min(Math.ceil(step.ms / 1000), 30); // cap at 30s to prevent hangs
          execFileSync("sleep", [String(seconds)], { timeout: seconds * 1000 + 2_000, stdio: "ignore" });
          break;
        }
      }
    }

    // Wait for the click/submit to complete auth + server-side redirect before polling.
    // Without this delay, the first poll's goto races with the auth redirect and sees the login page.
    execFileSync("sleep", ["3"], { timeout: 5_000, stdio: "ignore" });

    return waitForAuth(config.baseUrl, bin, 10_000, 500, spawnEnv);
  } catch (err: unknown) {
    return { ok: false, error: `Login replay failed: ${err instanceof Error ? err.message : String(err)}. Re-run /verify-setup.` };
  }
}

/**
 * Replay saved login steps from config.json on the primary (default) daemon.
 * Kills zombie daemons first, then delegates to loginOnDaemon.
 */
export function loginWithCredentials(config: VerifyConfig, _projectRoot?: string): CheckResult {
  // Kill zombie browse daemons that hold the port but don't respond.
  // browse stop hangs ~30s, so we use pkill. This targets only verify's browse daemons
  // (the .cache/verify path), not gstack skill daemons at other paths.
  try { execSync("pkill -f 'bun run.*/\\.cache/verify/.*browse/src/server\\.ts'", { timeout: 3_000, stdio: "ignore" }); } catch { /* none running */ }
  // Brief pause for port release after kill
  try { execFileSync("sleep", ["1"], { timeout: 3_000, stdio: "ignore" }); } catch { /* ignore */ }

  return loginOnDaemon(config);
}

/**
 * Poll until authenticated: navigate to baseUrl, take snapshot, check for password field.
 * Returns as soon as password field is gone (auth succeeded) or after maxWait ms (auth failed).
 */
function waitForAuth(
  baseUrl: string,
  bin: string,
  maxWait = 10_000,
  interval = 500,
  spawnEnv: NodeJS.ProcessEnv = process.env,
): CheckResult {
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    try {
      execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", env: spawnEnv });
      const snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: spawnEnv });

      // Detect login page: password field (by label or masked dots), or sign-in/log-in button
      const isLoginPage =
        /\[textbox\].*password|\[text\].*password/i.test(snapshot) ||
        /\[textbox\]\s*"•+"/i.test(snapshot) ||
        /\[button\]\s*"(Sign [Ii]n|Log [Ii]n)"/i.test(snapshot);
      if (!isLoginPage) {
        return { ok: true };
      }
    } catch {
      // Browse command failed — retry on next iteration
    }

    // Sleep between polls
    if (Date.now() < deadline) {
      execFileSync("sleep", [String(interval / 1000)], { timeout: 2_000, stdio: "ignore" });
    }
  }

  return { ok: false, error: "Login steps did not authenticate — still on login page after 10s. Re-run /verify-setup." };
}

/**
 * Import cookies from the user's browser into the browse daemon.
 * Extracts cookies for the given domain from Chromium's cookie store.
 */
export function importCookiesToDaemon(baseUrl: string): CheckResult {
  const bin = resolveBrowseBin();
  const url = new URL(baseUrl);
  const domain = url.hostname;

  try {
    // Start daemon first so cookie-import has a target
    startDaemon({});
    // Import cookies from the default Chromium browser
    execFileSync(bin, ["cookie-import-browser", "chromium", domain], {
      timeout: 15_000,
      stdio: "ignore",
    });
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Cookie import failed: ${err instanceof Error ? err.message : String(err)}. Make sure you're logged in to ${baseUrl} in Chrome.`,
    };
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

  // When auth is configured, skip startDaemon — its stop/goto about:blank breaks
  // cookie persistence. The first goto in login steps starts the daemon implicitly.
  if (config?.auth) {
    const auth = loginWithCredentials(config);
    if (!auth.ok) errors.push(auth.error!);
  } else {
    const daemon = checkBrowseDaemon();
    if (!daemon.ok) {
      try {
        startDaemon({});
      } catch {
        errors.push(daemon.error!);
        return { ok: errors.length === 0, errors };
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
