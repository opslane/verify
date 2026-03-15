/**
 * E2E test — evidence-judge pipeline against formbricks PR #2.
 *
 * Run: cd server && node --env-file=.env --import tsx/esm src/verify/test-e2e-judge.ts
 *
 * Tests: screenshot capture, R2 upload, Opus judge, comment formatting.
 * Does NOT post the comment to GitHub (skipComment: true) — prints it instead.
 */

import { upsertRepoConfig } from '../db.js';
import { encrypt } from '../crypto.js';
import { runVerifyPipeline } from './pipeline.js';

const TEST_OWNER = 'abhishekray07';
const TEST_REPO = 'formbricks';
const TEST_PR = 2;

async function main() {
  console.log(`\n=== E2E Evidence + Judge Test ===`);
  console.log(`Target: ${TEST_OWNER}/${TEST_REPO}#${TEST_PR}\n`);

  // 1. Upsert repo config for formbricks
  console.log('Upserting repo config...');
  await upsertRepoConfig({
    installationId: null,
    owner: TEST_OWNER,
    repo: TEST_REPO,
    devCommand: 'pnpm dev --filter=@formbricks/web',
    port: 3000,
    installCommand: 'pnpm install && cd packages/database && npx prisma generate && cd ../.. && pnpm build --filter=@formbricks/web...',
    healthPath: '/auth/login',
    composeFile: 'docker-compose.dev.yml',
    schemaCommand: 'set -a && . .env && set +a && cd packages/database && npx prisma db push --accept-data-loss',
    seedCommand: 'set -a && . .env && set +a && cd packages/database && npx tsx src/seed.ts',
    sandboxTemplate: null,
    testEmail: encrypt('admin@formbricks.com'),
    testPassword: encrypt('Password#123'),
    loginScript: `await page.getByRole('button', { name: 'Login with Email' }).click();
await page.getByPlaceholder('work@email.com').fill(EMAIL);
await page.getByPlaceholder('*******').fill(PASSWORD);
await page.getByRole('button', { name: 'Login with Email' }).nth(1).click();`,
    envVars: {
      DATABASE_URL: encrypt('postgresql://postgres:postgres@localhost:5432/formbricks?schema=public'),
      NEXTAUTH_SECRET: encrypt('test-secret-for-e2e-not-production'),
      NEXTAUTH_URL: encrypt('http://localhost:3000'),
      WEBAPP_URL: encrypt('http://localhost:3000'),
      ENCRYPTION_KEY: encrypt('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
      CRON_SECRET: encrypt('test-cron-secret'),
      REDIS_URL: encrypt('redis://localhost:6379'),
      EMAIL_VERIFICATION_DISABLED: encrypt('1'),
      PASSWORD_RESET_DISABLED: encrypt('1'),
    },
  });
  console.log('Repo config upserted.\n');

  // 2. Run the pipeline
  const startTime = Date.now();

  const result = await runVerifyPipeline(
    { owner: TEST_OWNER, repo: TEST_REPO, prNumber: TEST_PR },
    {
      log: (step, message, data) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  [${elapsed}s] [${step}] ${message}`);
        if (data) console.log(`           ${JSON.stringify(data).slice(0, 200)}`);
      },
      skipComment: true,
    },
  );

  // 3. Report results
  console.log(`\n=== Result ===`);
  console.log(`Mode: ${result.mode}`);

  if (result.mode === 'verified') {
    console.log(`Score: ${result.passed}/${result.total} passed`);
    console.log(`\nResults:`);
    for (const r of result.results) {
      const icon = r.result === 'pass' ? '\x1b[32m✓\x1b[0m'
        : r.result === 'fail' ? '\x1b[31m✗\x1b[0m'
        : '\x1b[33m⊘\x1b[0m';
      console.log(`  ${icon} ${r.id}: ${r.description}`);
      if (r.expected) console.log(`    Expected: ${r.expected}`);
      if (r.observed) console.log(`    Observed: ${r.observed}`);
      if (r.reason) console.log(`    Reason: ${r.reason}`);
      if (r.screenshotUrl) console.log(`    Screenshot: ${r.screenshotUrl.slice(0, 100)}...`);
      if (r.judgeReasoning) console.log(`    Judge: ${r.judgeReasoning}`);
      if (r.judgeOverride) console.log(`    \x1b[33m⚠ Judge overrode agent verdict\x1b[0m`);
    }
  }

  if (result.mode === 'no-config') {
    console.log('ERROR: No repo config found — upsert failed?');
  }

  if ('comment' in result && result.comment) {
    console.log(`\n--- PR Comment Preview ---`);
    console.log(result.comment);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
