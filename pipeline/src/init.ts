// pipeline/src/init.ts — Preflight checks + cookie auth (run before any LLM call)
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveBrowseBin } from "./lib/browse.js";

export interface CheckResult {
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

export interface CookieImportOptions {
  /** Show picker URL to user (for interactive init). Default: false */
  interactive?: boolean;
  /** Verify cookies landed after import (browse cookies check). Default: true */
  verify?: boolean;
}

/**
 * Import cookies from the user's Chromium browser into a browse daemon.
 * Uses gstack's browse binary: `browse cookie-import-browser chromium <domain>`
 *
 * When interactive=true, the picker URL is shown to the user (stdio: inherit)
 * and the timeout is extended to 60s for human interaction.
 * When verify=true (default), runs `browse cookies` after import to confirm
 * cookies actually landed — catches silent failures from the picker.
 */
export function importCookiesToDaemon(
  baseUrl: string,
  extraEnv: Record<string, string> = {},
  options: CookieImportOptions = {},
): CheckResult {
  const { interactive = false, verify = true } = options;
  const bin = resolveBrowseBin();
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  try {
    const domain = new URL(baseUrl).hostname;
    execFileSync(bin, ["cookie-import-browser", "chromium", domain], {
      timeout: interactive ? 60_000 : 15_000,
      stdio: interactive ? "inherit" : "ignore",
      env: spawnEnv,
    });

    if (verify) {
      const output = execFileSync(bin, ["cookies"], {
        timeout: 10_000,
        encoding: "utf-8",
        env: spawnEnv,
      });
      const cookies: unknown[] = JSON.parse(output as string);
      if (!Array.isArray(cookies) || cookies.length === 0) {
        return {
          ok: false,
          error: "Cookie import completed but no cookies were found. Make sure you selected cookies in the picker.",
        };
      }
    }

    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Cookie import failed: ${err instanceof Error ? err.message : String(err)}. Make sure you're logged in to ${baseUrl} in Chrome.`,
    };
  }
}

/**
 * Export cookies from the browse daemon to Playwright's storage-state format.
 * Writes { cookies: [...], origins: [] } to the given path.
 */
export function exportAuthState(
  authJsonPath: string,
  extraEnv: Record<string, string> = {},
): CheckResult {
  const bin = resolveBrowseBin();
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  try {
    const output = execFileSync(bin, ["cookies"], {
      timeout: 10_000,
      encoding: "utf-8",
      env: spawnEnv,
    });

    const parsed: unknown = JSON.parse(output as string);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: "Expected array from browse cookies, got: " + typeof parsed };
    }
    const cookies = parsed as Array<Record<string, unknown>>;
    const storageState = {
      cookies: cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? false,
        sameSite: c.sameSite ?? "Lax",
      })),
      origins: [],
    };

    writeFileSync(authJsonPath, JSON.stringify(storageState, null, 2));
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Failed to export auth state: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Validate that imported cookies actually authenticate the user.
 * Navigates to baseUrl via the browse daemon and checks for auth redirects.
 * Returns a warning (not a hard failure) — the app may be public.
 */
export function validateCookieAuth(
  baseUrl: string,
  extraEnv: Record<string, string> = {},
): CheckResult {
  const bin = resolveBrowseBin();
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };

  try {
    execFileSync(bin, ["goto", baseUrl], {
      timeout: 15_000,
      stdio: "ignore",
      env: spawnEnv,
    });

    const url = (execFileSync(bin, ["url"], {
      timeout: 5_000,
      encoding: "utf-8",
      env: spawnEnv,
    }) as string).trim();

    const isAuthRedirect = /\/(login|signin|signup|auth)(\/|$|\?)/i.test(url);
    if (isAuthRedirect) {
      return {
        ok: false,
        error: `Cookies imported but app redirected to ${url}. Your session may be expired. Log in at ${baseUrl} in Chrome and re-run init.`,
      };
    }

    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Cookie validation failed: ${err instanceof Error ? err.message : String(err)}`,
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
