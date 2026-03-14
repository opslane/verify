/**
 * Debug script: test prisma db push + seed in formbricks sandbox
 * Usage: node --env-file=.env --import tsx/esm scripts/test-seed.ts
 */
import { E2BSandboxProvider } from '../src/sandbox/e2b-provider.js';
import { collect, drain } from '../src/sandbox/stream.js';
import { findRepoConfig } from '../src/db.js';
import { decrypt } from '../src/crypto.js';
import { GitHubAppService } from '../src/github/app-service.js';
import { requireEnv } from '../src/env.js';
import { fetchPullRequest } from '../src/github/pr.js';
import { buildEnvFileContent } from '../src/verify/sandbox-setup.js';

async function run(provider: E2BSandboxProvider, sandboxId: string, cmd: string, label: string, timeoutMs = 120_000): Promise<string[]> {
  console.log(`\n--- ${label} ---`);
  const output = await collect(provider.runCommand(sandboxId, cmd, { rawOutput: true, timeoutMs }));
  // Filter out PTY noise
  const clean = output.filter(l => !l.includes('\x1B') && !l.includes('sudo') && !l.includes('npm notice'));
  if (clean.length > 0) console.log(clean.join('\n'));
  return output;
}

async function main() {
  const owner = 'abhishekray07';
  const repo = 'formbricks';
  const prNumber = 1;

  const config = await findRepoConfig(owner, repo);
  if (!config) throw new Error('No repo config');

  const appService = new GitHubAppService(requireEnv('GITHUB_APP_ID'), requireEnv('GITHUB_APP_PRIVATE_KEY'));
  const { token } = await appService.getTokenForRepo(owner, repo);
  const prMeta = await fetchPullRequest(owner, repo, prNumber, token);
  console.log(`PR: ${prMeta.headBranch}`);

  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: config.sandbox_template ?? 'opslane-verify-v2',
    timeoutMs: 600_000,
    envVars: { GIT_TERMINAL_PROMPT: '0', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
    metadata: { sessionId: 'debug-seed-2', userId: 'system' },
  });
  console.log(`Sandbox: ${sandbox.id}`);

  try {
    // Fetch PR branch
    const authCloneUrl = prMeta.cloneUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
    await run(provider, sandbox.id,
      `cd /home/user/repo && git remote set-url origin '${authCloneUrl}' && git fetch --depth=1 origin '${prMeta.headBranch}' && git checkout FETCH_HEAD`,
      'Fetch PR branch'
    );

    // Write .env
    if (config.env_vars && Object.keys(config.env_vars).length > 0) {
      const decrypted: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.env_vars)) {
        decrypted[key] = decrypt(value);
      }
      const envContent = buildEnvFileContent(decrypted);
      await provider.uploadFiles(sandbox.id, [{ path: '/home/user/repo/.env', content: envContent }]);
      console.log('.env written');
    }

    // Run prisma db push
    await run(provider, sandbox.id,
      'cd /home/user/repo && npx prisma db push --schema=packages/database/schema.prisma --accept-data-loss 2>&1',
      'Prisma DB Push'
    );

    // Run seed with correct command
    await run(provider, sandbox.id,
      'cd /home/user/repo && ALLOW_SEED=true pnpm --filter @formbricks/database db:seed 2>&1',
      'Prisma DB Seed'
    );

    // Check users with simple psql
    await run(provider, sandbox.id,
      'psql -h localhost -U postgres -d formbricks -c "SELECT email FROM \\"User\\" LIMIT 5;" 2>&1',
      'Check Users in DB'
    );

  } finally {
    console.log('\nDestroying sandbox...');
    await provider.destroy(sandbox.id);
  }
}

main().catch(console.error);
