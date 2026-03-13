import type { SandboxProvider } from '../sandbox/types.js';
import type { RepoConfig } from '../db.js';
import { decrypt } from '../crypto.js';
import { buildInstallCommands, buildReadinessProbe, getServiceDefs } from './infra-services.js';

/** Escape a value for double-quoted .env format */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

export function buildEnvFileContent(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([key, value]) => `${key}="${escapeEnvValue(value)}"`)
    .join('\n') + '\n';
}

export function buildHealthCheckCommand(port: number, healthPath = '/'): string {
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  return `curl -sf -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:${port}${path}`;
}

interface SetupResult {
  success: boolean;
  error?: string;
  serverLog?: string;
}

/** Drain an async iterable (consume all output, discard it) */
async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

/** Drain and collect output lines */
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) { lines.push(line); }
  return lines;
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
      await drain(provider.runCommand(sandboxId, cmd));
    }

    // Wait for readiness
    const serviceDefs = getServiceDefs();
    for (const svc of infraServices) {
      if (!serviceDefs[svc]) continue;
      const probe = buildReadinessProbe(svc);
      log('infra', `Waiting for ${svc} on port ${probe.port}`);
      for (let attempt = 0; attempt < probe.maxRetries; attempt++) {
        try {
          await drain(provider.runCommand(sandboxId, `${probe.command} && echo READY`));
          log('infra', `${svc} is ready`);
          break;
        } catch {
          if (attempt === probe.maxRetries - 1) {
            log('infra', `${svc} failed readiness check after ${probe.maxRetries} attempts`);
          }
          await new Promise((r) => setTimeout(r, probe.intervalMs));
        }
      }
    }
  }

  // 3. Install dependencies
  const installCmd = config.install_command ?? 'npm install';
  log('install', `Running: ${installCmd}`);
  await drain(provider.runCommand(sandboxId, installCmd, { cwd: workDir, timeoutMs: 480_000 }));

  // 4. Run pre-start script
  if (config.pre_start_script) {
    log('pre-start', 'Running pre-start script');
    await provider.uploadFiles(sandboxId, [{
      path: '/tmp/verify-prestart.sh',
      content: config.pre_start_script,
    }]);
    await drain(provider.runCommand(sandboxId, 'chmod +x /tmp/verify-prestart.sh && /tmp/verify-prestart.sh', { cwd: workDir }));
  }

  // 5. Start the app
  log('start', `Starting app: ${config.startup_command}`);
  await drain(provider.runCommand(
    sandboxId,
    `nohup ${config.startup_command} > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid`,
    { cwd: workDir },
  ));

  // 6. Health check — poll until 2xx or timeout
  const healthCmd = buildHealthCheckCommand(config.port, config.health_path);
  const maxWaitMs = 60_000;
  const intervalMs = 2_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const output = await collect(provider.runCommand(sandboxId, healthCmd));
      const lastLine = output[output.length - 1] ?? '';
      const code = parseInt(lastLine.replace(/[^0-9]/g, ''), 10);
      if (code >= 200 && code < 400) {
        log('health', `App healthy (HTTP ${code})`);
        return { success: true };
      }
    } catch {
      // curl failed — app not ready yet
    }

    // Check if process is still alive
    try {
      await drain(provider.runCommand(sandboxId, 'kill -0 $(cat /tmp/server.pid 2>/dev/null) 2>/dev/null'));
    } catch {
      const logOutput = await collect(
        provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"')
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
    provider.runCommand(sandboxId, 'tail -30 /tmp/server.log 2>/dev/null || echo "No server log found"')
  );
  return {
    success: false,
    error: `App did not respond on port ${config.port} within ${maxWaitMs / 1000} seconds`,
    serverLog: logOutput.join('\n'),
  };
}
