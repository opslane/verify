/**
 * E2E spike: proves sandbox v2 pipeline works against a real formbricks PR.
 * Run: cd server && node --env-file=.env --import tsx/esm src/verify/test-e2e-formbricks.ts
 *
 * Requires: E2B_API_KEY, ANTHROPIC_API_KEY, ENCRYPTION_KEY
 */
import { randomBytes } from 'node:crypto';
import { E2BSandboxProvider } from '../src/sandbox/e2b-provider.js';
import { setupSandbox } from '../src/verify/sandbox-setup.js';
import { ensureBrowserRunning, loginAndInjectAuth, runBrowserAgent } from '../src/verify/browser-agent.js';
import { encrypt } from '../src/crypto.js';
import { drain, collect } from '../src/sandbox/stream.js';
import type { RepoConfig } from '../src/db.js';

// ── Config: update these for your test PR ──
const FORK_OWNER = 'abhishekray07';
const FORK_REPO = 'formbricks';
const PR_BRANCH = 'test/verify-spike';
const COMPOSE_FILE = 'docker-compose.dev.yml';
const EXPECTED_CHANGE = "Navigate to /auth/login and verify the heading says 'Sign in to your account' instead of 'Login to your account'";

// Seed credentials — verify against packages/database/seed.ts
const TEST_EMAIL = 'test@test.com';
const TEST_PASSWORD = 'testtest1234';

const provider = new E2BSandboxProvider();

function elapsed(start: number): string {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

function buildFormbricksEnv(): Record<string, string> {
  const secret = () => randomBytes(32).toString('hex');

  const plaintext: Record<string, string> = {
    WEBAPP_URL: 'http://localhost:3000',
    NEXTAUTH_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/formbricks?schema=public',
    NEXTAUTH_SECRET: secret(),
    ENCRYPTION_KEY: secret(),
    CRON_SECRET: secret(),
    REDIS_URL: 'redis://localhost:6379',
    EMAIL_VERIFICATION_DISABLED: '1',
    PASSWORD_RESET_DISABLED: '1',
    MAIL_FROM: 'noreply@example.com',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    SMTP_SECURE_ENABLED: '0',
  };

  const encrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(plaintext)) {
    encrypted[key] = encrypt(value);
  }
  return encrypted;
}

const LOGIN_SCRIPT = [
  "await page.getByRole('button', { name: 'Login with Email' }).click();",
  "await page.getByPlaceholder('work@email.com').fill(EMAIL);",
  "await page.getByPlaceholder('*******').fill(PASSWORD);",
  "await page.getByRole('button', { name: 'Login with Email' }).nth(1).click();",
].join('\n');

async function main() {
  const t0 = Date.now();
  console.log(`\n=== Formbricks E2E Spike ===`);
  console.log(`Fork: ${FORK_OWNER}/${FORK_REPO} branch: ${PR_BRANCH}\n`);

  // 1. Create sandbox
  console.log(`[${elapsed(t0)}] Creating sandbox (opslane-verify-v2, 8GB/4CPU)...`);
  const sandbox = await provider.create({
    template: 'opslane-verify-v2',
    timeoutMs: 900_000,
    envVars: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    metadata: { sessionId: 'formbricks-e2e-spike', userId: 'test' },
  });
  const id = sandbox.id;
  console.log(`[${elapsed(t0)}] Sandbox created: ${id}`);

  try {
    // 2. Wait for Docker daemon
    console.log(`[${elapsed(t0)}] Waiting for Docker daemon...`);
    for (let i = 0; i < 30; i++) {
      try {
        const info = await collect(provider.runCommand(id, 'docker info 2>&1', { rawOutput: true }));
        if (info.some(l => l.includes('Server Version'))) break;
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, 2_000));
    }
    console.log(`[${elapsed(t0)}] Docker daemon ready`);

    // 3. Clone fork
    const cloneUrl = `https://github.com/${FORK_OWNER}/${FORK_REPO}.git`;
    console.log(`[${elapsed(t0)}] Cloning ${cloneUrl} branch ${PR_BRANCH}...`);
    await drain(provider.runCommand(
      id,
      `git clone --depth=1 --branch '${PR_BRANCH}' '${cloneUrl}' /home/user/repo`,
      { rawOutput: true, timeoutMs: 120_000 },
    ));
    console.log(`[${elapsed(t0)}] Clone complete`);

    // 4. Build RepoConfig with encrypted env vars
    const envVars = buildFormbricksEnv();
    console.log(`[${elapsed(t0)}] Encrypted ${Object.keys(envVars).length} env vars`);

    const config: RepoConfig = {
      id: 'spike-formbricks',
      installation_id: null,
      owner: FORK_OWNER,
      repo: FORK_REPO,
      dev_command: 'pnpm --filter @formbricks/web dev',
      port: 3000,
      install_command: 'pnpm install',
      health_path: '/auth/login',
      test_email: encrypt(TEST_EMAIL),
      test_password: encrypt(TEST_PASSWORD),
      env_vars: envVars,
      compose_file: COMPOSE_FILE,
      schema_command: 'npx prisma db push --schema=packages/database/schema.prisma --accept-data-loss',
      seed_command: 'ALLOW_SEED=true pnpm --filter @formbricks/database db:seed',
      login_script: LOGIN_SCRIPT,
      sandbox_template: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // 5. setupSandbox (compose, install, schema, seed, dev server, health check)
    console.log(`\n[${elapsed(t0)}] ── setupSandbox() ──`);
    const setupStart = Date.now();
    const result = await setupSandbox(provider, id, config, (step, msg) => {
      console.log(`[${elapsed(t0)}] [${step}] ${msg}`);
    });

    console.log(`[${elapsed(t0)}] setupSandbox result: ${JSON.stringify(result)}`);
    console.log(`[${elapsed(t0)}] Setup duration: ${elapsed(setupStart)}`);

    if (!result.success) {
      console.error(`\n❌ setupSandbox FAILED: ${result.error}`);
      if (result.serverLog) console.error('Server log:\n' + result.serverLog);
      process.exit(1);
    }
    console.log(`\n✅ setupSandbox succeeded in ${elapsed(setupStart)}`);

    // 6. Launch persistent browser
    console.log(`\n[${elapsed(t0)}] ── Browser Agent ──`);
    await ensureBrowserRunning(provider, id, (msg) => {
      console.log(`[${elapsed(t0)}] [browser] ${msg}`);
    });

    // 7. Login and inject auth cookies
    const loginSuccess = await loginAndInjectAuth(
      provider, id, 'http://localhost:3000', LOGIN_SCRIPT,
      TEST_EMAIL, TEST_PASSWORD,
      (msg) => console.log(`[${elapsed(t0)}] [auth] ${msg}`),
    );

    if (!loginSuccess) {
      console.error(`\n❌ Login failed — browser agent cannot authenticate`);
      try {
        const serverLog = await collect(provider.runCommand(
          id, 'tail -30 /tmp/server.log 2>/dev/null', { rawOutput: true },
        ));
        console.error('Server log:\n' + serverLog.join('\n'));
      } catch { /* ignore */ }
      process.exit(1);
    }
    console.log(`[${elapsed(t0)}] ✅ Login succeeded`);

    // 8. Run browser agent with one hardcoded AC
    console.log(`\n[${elapsed(t0)}] Running browser agent...`);
    console.log(`AC: ${EXPECTED_CHANGE}`);

    const verdict = await runBrowserAgent(
      provider, id,
      { goal: EXPECTED_CHANGE, baseUrl: 'http://localhost:3000', testEmail: TEST_EMAIL, testPassword: TEST_PASSWORD },
      (msg) => console.log(`[${elapsed(t0)}] [agent] ${msg}`),
    );

    console.log(`\n[${elapsed(t0)}] ── Result ──`);
    console.log(`Verdict: ${verdict.result}`);
    if (verdict.expected) console.log(`Expected: ${verdict.expected}`);
    if (verdict.observed) console.log(`Observed: ${verdict.observed}`);
    if (verdict.error) console.log(`Error: ${verdict.error}`);

    if (verdict.result === 'pass') {
      console.log(`\n✅ E2E SPIKE PASSED in ${elapsed(t0)}`);
    } else {
      console.log(`\n❌ E2E SPIKE FAILED (${verdict.result}) in ${elapsed(t0)}`);
      process.exit(1);
    }

  } finally {
    console.log(`\n[${elapsed(t0)}] Destroying sandbox...`);
    await provider.destroy(id);
    console.log(`[${elapsed(t0)}] Done.`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
