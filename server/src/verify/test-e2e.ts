/**
 * End-to-end test — runs the full verify pipeline against a real PR.
 * Run: node --env-file=.env --import tsx/esm src/verify/test-e2e.ts
 *
 * Requires: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ANTHROPIC_API_KEY,
 *           E2B_API_KEY, ENCRYPTION_KEY, DATABASE_URL
 *
 * Pre-requisite: repo_config row must exist for the test repo.
 * Run test-live.ts first to verify individual integrations.
 */

import { runVerifyPipeline } from './pipeline.js';

const TEST_OWNER = 'abhishekray07';
const TEST_REPO = 'sentry-v2-e2e-test';
const TEST_PR = 52;

async function main() {
  console.log(`\n=== E2E Verify Pipeline Test ===`);
  console.log(`Target: ${TEST_OWNER}/${TEST_REPO}#${TEST_PR}\n`);

  const startTime = Date.now();

  const result = await runVerifyPipeline(
    { owner: TEST_OWNER, repo: TEST_REPO, prNumber: TEST_PR },
    {
      log: (step, message, data) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  [${elapsed}s] [${step}] ${message}`);
        if (data) console.log(`           ${JSON.stringify(data).slice(0, 200)}`);
      },
    },
  );

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
    }
  }

  if (result.mode === 'no-config') {
    console.log('ERROR: No repo config found — did you create it?');
  }

  if ('comment' in result && result.comment) {
    console.log(`\n--- PR Comment Preview ---`);
    console.log(result.comment.slice(0, 500));
    if (result.comment.length > 500) console.log('  ...(truncated)');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
