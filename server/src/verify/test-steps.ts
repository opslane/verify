/**
 * Step-by-step pipeline test — isolates each stage so we can find what breaks.
 * Run: node --env-file=.env --import tsx/esm src/verify/test-steps.ts
 */

import { GitHubAppService } from '../github/app-service.js';
import { fetchPullRequest, fetchPrChangedFiles } from '../github/pr.js';
import { E2BSandboxProvider } from '../sandbox/e2b-provider.js';
import { discoverSpec } from './spec-discovery.js';
import { buildHealthCheckCommand } from './sandbox-setup.js';

const OWNER = 'abhishekray07';
const REPO = 'sentry-v2-e2e-test';
const PR = 52;
const PORT = 5173;

const provider = new E2BSandboxProvider();
let sandboxId: string;
let token: string;

function elapsed(start: number) {
  return ((Date.now() - start) / 1000).toFixed(1) + 's';
}

async function drain(stream: AsyncIterable<string>) {
  for await (const _ of stream) {}
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) lines.push(line);
  return lines;
}

async function step(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  process.stdout.write(`\n--- ${name} ---\n`);
  try {
    await fn();
    console.log(`\x1b[32mPASS\x1b[0m (${elapsed(start)})`);
  } catch (err) {
    console.log(`\x1b[31mFAIL\x1b[0m (${elapsed(start)})`);
    console.log(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && 'ptyOutput' in err) {
      console.log(`  PTY output: ${(err as any).ptyOutput?.slice(0, 300)}`);
    }
    throw err; // stop pipeline
  }
}

async function main() {
  console.log('=== Step-by-Step Pipeline Test ===\n');

  // Step 1: Get GitHub token
  await step('1. GitHub token', async () => {
    const app = new GitHubAppService(
      process.env.GITHUB_APP_ID!,
      process.env.GITHUB_APP_PRIVATE_KEY!,
    );
    const result = await app.getTokenForRepo(OWNER, REPO);
    token = result.token;
    console.log(`  Token acquired`);
  });

  // Step 2: Fetch PR metadata
  let headBranch: string;
  let cloneUrl: string;
  await step('2. Fetch PR metadata', async () => {
    const pr = await fetchPullRequest(OWNER, REPO, PR, token);
    headBranch = pr.headBranch;
    cloneUrl = pr.cloneUrl;
    console.log(`  Branch: ${headBranch}`);
    console.log(`  Clone URL: ${cloneUrl}`);
  });

  // Step 3: Fetch changed files + spec discovery
  await step('3. Spec discovery', async () => {
    const files = await fetchPrChangedFiles(OWNER, REPO, PR, token);
    console.log(`  Changed files: ${files.length}`);
    const pr = await fetchPullRequest(OWNER, REPO, PR, token);
    const spec = discoverSpec({ changedFiles: files, prBody: pr.body ?? '' });
    console.log(`  Spec type: ${spec.type}`);
    if (spec.type === 'pr-body') console.log(`  Spec length: ${spec.specContent.length} chars`);
  });

  // Step 4: Create sandbox
  await step('4. Create sandbox', async () => {
    const sandbox = await provider.create({
      template: 'base',
      timeoutMs: 600_000,
      envVars: { GIT_TERMINAL_PROMPT: '0' },
      metadata: { sessionId: 'step-test', userId: 'test' },
    });
    sandboxId = sandbox.id;
    console.log(`  Sandbox: ${sandboxId.slice(0, 12)}...`);
  });

  // Step 5: Clone repo
  await step('5. Clone repo', async () => {
    const authUrl = cloneUrl!.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`,
    );
    await drain(provider.runCommand(
      sandboxId,
      `git clone --depth=1 --branch '${headBranch!}' '${authUrl}' /home/user/repo`,
      { rawOutput: true },
    ));
    // Verify clone worked
    const files = await collect(provider.runCommand(sandboxId, 'ls /home/user/repo', { rawOutput: true }));
    console.log(`  Cloned files: ${files.join(', ')}`);
  });

  // Step 6: npm install
  await step('6. npm install', async () => {
    await drain(provider.runCommand(
      sandboxId,
      'npm install',
      { cwd: '/home/user/repo', rawOutput: true, timeoutMs: 120_000 },
    ));
    console.log(`  Install completed`);
  });

  // Step 7: Start the app
  await step('7. Start app', async () => {
    try {
      await drain(provider.runCommand(
        sandboxId,
        `nohup npx vite --host 0.0.0.0 --port ${PORT} > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid && sleep 2`,
        { cwd: '/home/user/repo', rawOutput: true, timeoutMs: 15_000 },
      ));
    } catch (err) {
      if (err instanceof Error && 'ptyOutput' in err) {
        console.log(`  PTY exited (expected for background cmd)`);
      } else {
        throw err;
      }
    }
    // Check if process is running
    const pid = await collect(provider.runCommand(sandboxId, 'cat /tmp/server.pid', { rawOutput: true }));
    console.log(`  Server PID: ${pid.join('').trim()}`);
  });

  // Step 8: Health check
  await step('8. Health check', async () => {
    const healthCmd = buildHealthCheckCommand(PORT, '/');
    let healthy = false;

    for (let i = 0; i < 15; i++) {
      try {
        const output = await collect(provider.runCommand(sandboxId, healthCmd, { rawOutput: true }));
        console.log(`  Attempt ${i + 1}: output = ${JSON.stringify(output)}`);
        const statusLine = output.find(l => l.includes('HEALTH_STATUS:'));
        if (statusLine) {
          const code = parseInt(statusLine.split('HEALTH_STATUS:')[1], 10);
          console.log(`  HTTP status: ${code}`);
          if (code >= 200 && code < 400) {
            healthy = true;
            break;
          }
        }
      } catch {
        console.log(`  Attempt ${i + 1}: curl failed (app not ready)`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    if (!healthy) {
      // Show server log
      const log = await collect(provider.runCommand(sandboxId, 'cat /tmp/server.log', { rawOutput: true }));
      console.log(`  Server log:\n${log.join('\n')}`);
      throw new Error('Health check failed after 30s');
    }
    console.log(`  App is healthy!`);
  });

  // Step 9: Install Playwright + test browser agent
  await step('9. Playwright browser test', async () => {
    // Install Playwright globally (same as sandbox-setup does)
    console.log('  Installing Playwright...');
    await drain(provider.runCommand(sandboxId, 'npm install -g playwright@latest', { rawOutput: true, timeoutMs: 120_000 }));
    await drain(provider.runCommand(sandboxId, 'npx playwright install --with-deps chromium', { rawOutput: true, timeoutMs: 180_000 }));
    console.log('  Playwright installed');

    // Test the file-upload approach used by browser-agent
    const script = `
const { execSync } = require('child_process');
const path = require('path');
const globalRoot = execSync('npm root -g', { encoding: 'utf-8' }).trim();
const { chromium } = require(path.join(globalRoot, 'playwright'));

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('http://localhost:${PORT}', { waitUntil: 'networkidle', timeout: 10000 });
    const title = await page.title();
    const bodyText = (await page.innerText('body')).slice(0, 500);
    console.log(JSON.stringify({ ok: true, result: { title, url: page.url(), bodyText } }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  } finally {
    await browser.close();
  }
})();
`;
    await provider.uploadFiles(sandboxId, [{ path: '/tmp/test-pw.js', content: script }]);
    const output = await collect(provider.runCommand(sandboxId, 'node /tmp/test-pw.js', { rawOutput: true, timeoutMs: 30_000 }));
    console.log(`  Output: ${output.join(' ')}`);

    // Parse JSON result
    for (const line of output) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.ok) {
          console.log(`  Page title: ${parsed.result.title}`);
          console.log(`  Body preview: ${parsed.result.bodyText.slice(0, 100)}`);
        } else {
          throw new Error(`Browser test failed: ${parsed.error}`);
        }
        break;
      } catch (e) {
        if (e instanceof SyntaxError) continue; // not JSON, skip
        throw e;
      }
    }
  });

  // Step 10: Parse acceptance criteria
  await step('10. Parse ACs (Anthropic)', async () => {
    const { parseAcceptanceCriteria } = await import('./pipeline.js');
    const pr = await fetchPullRequest(OWNER, REPO, PR, token);
    const criteria = await parseAcceptanceCriteria(pr.body ?? '', pr.diff ?? '');
    console.log(`  Found ${criteria.length} ACs:`);
    for (const ac of criteria) {
      console.log(`    ${ac.id}: ${ac.description} (testable: ${ac.testable})`);
    }
  });

  console.log('\n=== All steps passed! ===');

  // Cleanup
  console.log('\nDestroying sandbox...');
  await provider.destroy(sandboxId);
  console.log('Done.');
}

main().catch(async (err) => {
  if (sandboxId) {
    console.log('\nCleaning up sandbox...');
    await provider.destroy(sandboxId).catch(() => {});
  }
  process.exit(1);
});
