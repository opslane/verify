import type { SandboxProvider } from '../sandbox/types.js';
import type { RepoConfig } from '../db.js';
import { decrypt } from '../crypto.js';
import { buildInstallCommands, buildReadinessProbe, hasServiceDef } from './infra-services.js';
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

  // 2. Install runtime infra services
  const infraServices = config.detected_infra ?? [];
  if (infraServices.length > 0) {
    const commands = buildInstallCommands(infraServices);
    for (const cmd of commands) {
      log('infra', `Running: ${cmd.slice(0, 80)}...`);
      await drain(provider.runCommand(sandboxId, cmd, { rawOutput: true }));
    }

    // Wait for readiness
    for (const svc of infraServices) {
      if (!hasServiceDef(svc)) continue;
      const probe = buildReadinessProbe(svc);
      log('infra', `Waiting for ${svc} on port ${probe.port}`);
      let ready = false;
      for (let attempt = 0; attempt < probe.maxRetries; attempt++) {
        try {
          await drain(provider.runCommand(sandboxId, `${probe.command} && echo READY`, { rawOutput: true }));
          log('infra', `${svc} is ready`);
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, probe.intervalMs));
        }
      }
      if (!ready) {
        return { success: false, error: `${svc} failed readiness check after ${probe.maxRetries} attempts` };
      }
    }
  }

  // 3. Install dependencies
  const installCmd = config.install_command ?? 'npm install';
  log('install', `Running: ${installCmd}`);
  await drain(provider.runCommand(sandboxId, installCmd, { cwd: workDir, timeoutMs: 480_000, rawOutput: true }));

  // Playwright + Chromium are pre-installed in the opslane-verify-v2 E2B template

  // 4. Run pre-start script
  if (config.pre_start_script) {
    log('pre-start', 'Running pre-start script');
    await provider.uploadFiles(sandboxId, [{
      path: '/tmp/verify-prestart.sh',
      content: config.pre_start_script,
    }]);
    await drain(provider.runCommand(sandboxId, 'chmod +x /tmp/verify-prestart.sh && /tmp/verify-prestart.sh', { cwd: workDir, rawOutput: true }));
  }

  // 5. Start the app (fire-and-forget — health check validates it started)
  log('start', `Starting app: ${config.startup_command}`);
  // Write a wrapper script to avoid nohup/env-var/quoting issues
  const startScript = `#!/bin/bash\ncd ${workDir}\n${config.startup_command} > /tmp/server.log 2>&1 &\necho $! > /tmp/server.pid\n`;
  await provider.uploadFiles(sandboxId, [{ path: '/tmp/start-app.sh', content: startScript }]);
  try {
    await drain(provider.runCommand(
      sandboxId,
      'chmod +x /tmp/start-app.sh && /tmp/start-app.sh && sleep 1',
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

  // 6. Health check — poll until 2xx or timeout
  const healthCmd = buildHealthCheckCommand(config.port, config.health_path);
  const maxWaitMs = 120_000;
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
