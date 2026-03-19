// pipeline/src/init.ts — Preflight checks (run before any LLM call)
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
 * Login to the app using credentials from config.json.
 * This is the reliable auth method — fresh login every pipeline run.
 */
/**
 * Login with credentials. CRITICAL: must run with cwd=projectRoot so the browse
 * daemon uses the same browser profile as the browse agents (which also run with
 * cwd=projectRoot). Different cwd = different cookie jar = auth doesn't persist.
 */
export function loginWithCredentials(config: VerifyConfig, projectRoot?: string): CheckResult {
  if (!config.auth || config.auth.method !== "credentials" || !config.auth.email || !config.auth.password) {
    return { ok: false, error: "No credentials in config.json — run /verify-setup to configure auth" };
  }

  const bin = resolveBrowseBin();
  const loginUrl = `${config.baseUrl}${config.auth.loginUrl ?? "/auth/login"}`;
  // All browse commands must use the same cwd as browse agents
  const opts = projectRoot ? { cwd: projectRoot } : {};

  try {
    execFileSync(bin, ["goto", loginUrl], { timeout: 10_000, stdio: "ignore", ...opts });
    execFileSync("sleep", ["1"], { timeout: 5_000, stdio: "ignore" });

    let snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });

    // If there's a "Login with Email" button, click it first (Formbricks pattern)
    if (snapshot.includes("Login with Email")) {
      const emailBtnMatch = snapshot.match(/@(e\d+)\s+\[button\]\s+"Login with Email"/);
      if (emailBtnMatch) {
        execFileSync(bin, ["click", `@${emailBtnMatch[1]}`], { timeout: 5_000, stdio: "ignore", ...opts });
        execFileSync("sleep", ["1"], { timeout: 5_000, stdio: "ignore" });
        snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });
      }
    }

    const emailRef = snapshot.match(/@(e\d+)\s+\[textbox\].*(?:email|work@)/i);
    const passRef = snapshot.match(/@(e\d+)\s+\[textbox\].*password/i);

    if (!emailRef || !passRef) {
      return verifyAuthState(config.baseUrl, bin, opts);
    }

    execFileSync(bin, ["fill", `@${emailRef[1]}`, config.auth.email], { timeout: 5_000, stdio: "ignore", ...opts });
    execFileSync(bin, ["fill", `@${passRef[1]}`, config.auth.password], { timeout: 5_000, stdio: "ignore", ...opts });

    snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });
    const submitMatch = snapshot.match(/@(e\d+)\s+\[button\]\s+"Login with Email"/);
    if (submitMatch) {
      execFileSync(bin, ["click", `@${submitMatch[1]}`], { timeout: 5_000, stdio: "ignore", ...opts });
    }

    execFileSync("sleep", ["3"], { timeout: 10_000, stdio: "ignore" });

    return verifyAuthState(config.baseUrl, bin, opts);
  } catch (err: unknown) {
    return { ok: false, error: `Login failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function verifyAuthState(baseUrl: string, bin: string, opts: { cwd?: string } = {}): CheckResult {
  try {
    execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", ...opts });
    execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });
    const snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });
    const loginPatterns = /Login to your account|Login with Email|Sign in|log.in.*form/i;
    if (loginPatterns.test(snapshot) && !snapshot.includes("Surveys") && !snapshot.includes("Dashboard")) {
      return { ok: false, error: "Auth failed — still on login page after login attempt" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to verify auth state" };
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
