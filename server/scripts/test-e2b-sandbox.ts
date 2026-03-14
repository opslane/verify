/**
 * End-to-end test: create an E2B sandbox from the formbricks template,
 * run the exact same setup flow as sandbox-setup.ts, and verify the app starts.
 *
 * Usage: cd server && node --env-file=.env --import tsx/esm scripts/test-e2b-sandbox.ts
 */

import { E2BSandboxProvider } from '../src/sandbox/e2b-provider.js';
import { setupSandbox } from '../src/verify/sandbox-setup.js';
import { findRepoConfig } from '../src/db.js';
import { drain, collect } from '../src/sandbox/stream.js';

async function main() {
  const config = await findRepoConfig('abhishekray07', 'formbricks');
  if (!config) {
    console.error('No repo config found for abhishekray07/formbricks');
    process.exit(1);
  }

  console.log('Config:', {
    startup_command: config.startup_command,
    install_command: config.install_command,
    port: config.port,
    health_path: config.health_path,
    sandbox_template: config.sandbox_template,
  });

  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: config.sandbox_template ?? 'opslane-verify-v2',
    timeoutMs: 900_000,
    envVars: {
      GIT_TERMINAL_PROMPT: '0',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    },
    metadata: { sessionId: 'test-e2b-sandbox', userId: 'test' },
  });

  console.log('Sandbox created:', sandbox.id);

  try {
    // Step 1: Check basic services
    console.log('\n--- Checking services ---');
    const pgOut = await collect(provider.runCommand(sandbox.id, 'pg_isready', { rawOutput: true }));
    console.log('Postgres:', pgOut.join(' '));

    const redisOut = await collect(provider.runCommand(sandbox.id, 'redis-cli ping', { rawOutput: true }));
    console.log('Redis:', redisOut.join(' '));

    const repoOut = await collect(provider.runCommand(sandbox.id, 'ls /home/user/repo/package.json', { rawOutput: true }));
    console.log('Repo:', repoOut.join(' '));

    // Step 2: Run setupSandbox (the exact same function the pipeline uses)
    console.log('\n--- Running setupSandbox ---');
    const log = (step: string, msg: string) => console.log(`[${step}] ${msg}`);
    const result = await setupSandbox(provider, sandbox.id, config, log);

    console.log('\n--- Result ---');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
      // Double-check with a curl
      console.log('\n--- Verifying with curl ---');
      const curlOut = await collect(provider.runCommand(
        sandbox.id,
        `curl -s -o /dev/null -w "%{http_code}" http://localhost:${config.port}${config.health_path}`,
        { rawOutput: true },
      ));
      console.log('HTTP status:', curlOut.join(' '));
    } else {
      console.log('Server log:', result.serverLog);
    }
  } finally {
    console.log('\n--- Cleaning up ---');
    await provider.destroy(sandbox.id);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
