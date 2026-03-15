import type { SandboxProvider } from '../sandbox/types.js';
import type { RepoConfig } from '../db.js';
import { decrypt } from '../crypto.js';
import { drain, collect } from '../sandbox/stream.js';

/** Escape a value for double-quoted .env format */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\n/g, '\\n');
}

export function buildEnvFileContent(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
    .join('\n') + '\n';
}

const VALID_PATH = /^\/[a-zA-Z0-9\/_.-]*$/;

export function buildHealthCheckCommand(port: number, healthPath = '/'): string {
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  if (!VALID_PATH.test(path)) {
    throw new Error(`Invalid health path: ${path}`);
  }
  // Use sentinel prefix so we can reliably extract the status code from PTY noise.
  // No -f flag: we want the status code even on HTTP errors (4xx/5xx).
  return `curl -s -o /dev/null -w "HEALTH_STATUS:%{http_code}" --max-time 10 http://localhost:${port}${path}`;
}

// Must be a relative path (no leading /) ending in .yml or .yaml
const SAFE_COMPOSE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*\.ya?ml$/;

/** Validate compose_file path is safe for shell interpolation. Exported for testing. */
export function validateComposeFile(path: string): boolean {
  return SAFE_COMPOSE.test(path) && !path.includes('..');
}

interface SetupResult {
  success: boolean;
  error?: string;
  serverLog?: string;
}

export async function setupSandbox(
  provider: SandboxProvider,
  sandboxId: string,
  config: RepoConfig,
  log: (step: string, msg: string) => void,
): Promise<SetupResult> {
  const workDir = '/home/user/repo';

  // 1. Write .env file
  if (config.env_vars && Object.keys(config.env_vars).length > 0) {
    log('env', 'Writing .env file');
    const decrypted: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env_vars)) {
      decrypted[key] = decrypt(value);
    }
    if (config.test_email) decrypted.TEST_EMAIL = decrypt(config.test_email);
    if (config.test_password) decrypted.TEST_PASSWORD = decrypt(config.test_password);
    const envContent = buildEnvFileContent(decrypted);
    await provider.uploadFiles(sandboxId, [{ path: `${workDir}/.env`, content: envContent }]);
  }

  // 2. Docker Compose (if compose_file configured)
  if (config.compose_file) {
    if (!validateComposeFile(config.compose_file)) {
      return { success: false, error: `Invalid compose_file path: ${config.compose_file}` };
    }
    log('compose', `Starting infra: docker compose -f ${config.compose_file} up -d --wait`);
    try {
      await drain(provider.runCommand(
        sandboxId,
        `docker compose -f ${config.compose_file} up -d --wait`,
        { cwd: workDir, timeoutMs: 300_000, rawOutput: true },
      ));
      log('compose', 'Docker Compose services are up');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Docker Compose failed: ${msg}` };
    }
  }

  // Steps 3-6 interpolate config commands into shell strings. These values come from
  // repo_configs written by authenticated admins — if the config surface is ever exposed
  // to less-trusted callers (e.g., self-serve UI), add command validation here.

  // 3. Install dependencies (always — idempotent, fast no-op if unchanged)
  const installCmd = config.install_command ?? 'npm install';
  log('install', `Running: ${installCmd}`);
  try {
    await drain(provider.runCommand(sandboxId, installCmd, { cwd: workDir, timeoutMs: 480_000, rawOutput: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Install command failed: ${msg}` };
  }

  // 4. Schema push (if schema_command configured — idempotent)
  if (config.schema_command) {
    log('schema', `Running: ${config.schema_command}`);
    try {
      await drain(provider.runCommand(sandboxId, config.schema_command, { cwd: workDir, timeoutMs: 120_000, rawOutput: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Schema command failed: ${msg}` };
    }
  }

  // 5. Seed DB (if seed_command configured)
  if (config.seed_command) {
    log('seed', `Running: ${config.seed_command}`);
    try {
      await drain(provider.runCommand(sandboxId, config.seed_command, { cwd: workDir, timeoutMs: 120_000, rawOutput: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Seed command failed: ${msg}` };
    }
  }

  // 6. Start dev server (fire-and-forget — health check validates it started)
  log('start', `Starting dev server: ${config.dev_command}`);
  try {
    await drain(provider.runCommand(
      sandboxId,
      `nohup ${config.dev_command} > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid && sleep 1`,
      { cwd: workDir, rawOutput: true, timeoutMs: 10_000 },
    ));
  } catch (err) {
    // Only suppress PTY exit-code errors — rethrow infrastructure failures
    if (err instanceof Error && 'ptyOutput' in err) {
      log('start', 'PTY exited (expected for background commands)');
    } else {
      throw err;
    }
  }

  // 7. Health check — poll until 2xx or timeout
  const healthCmd = buildHealthCheckCommand(config.port, config.health_path);
  const maxWaitMs = 300_000;
  const intervalMs = 2_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const output = await collect(provider.runCommand(sandboxId, healthCmd, { rawOutput: true }));
      // Find the sentinel-prefixed status code in any output line
      const statusLine = output.find(l => l.includes('HEALTH_STATUS:'));
      const code = statusLine ? parseInt(statusLine.split('HEALTH_STATUS:')[1], 10) : NaN;
      if (code >= 200 && code < 400) {
        log('health', `App healthy (HTTP ${code})`);
        return { success: true };
      }
    } catch {
      // curl failed — app not ready yet
    }

    // Check if process is still alive
    try {
      await drain(provider.runCommand(sandboxId, 'kill -0 $(cat /tmp/server.pid 2>/dev/null) 2>/dev/null', { rawOutput: true }));
    } catch {
      const logOutput = await collect(
        provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"', { rawOutput: true })
      );
      return {
        success: false,
        error: 'App process exited unexpectedly',
        serverLog: logOutput.join('\n'),
      };
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Timed out
  const logOutput = await collect(
    provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"', { rawOutput: true })
  );
  return {
    success: false,
    error: `App did not respond on port ${config.port} within ${maxWaitMs / 1000} seconds`,
    serverLog: logOutput.join('\n'),
  };
}
