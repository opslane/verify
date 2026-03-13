/**
 * End-to-end test — runs the unified pipeline (review + verify) against a real PR.
 * Run: node --env-file=.env --import tsx/esm src/unified/test-e2e.ts
 *
 * Requires: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, ANTHROPIC_API_KEY,
 *           E2B_API_KEY, ENCRYPTION_KEY, DATABASE_URL
 */

import { runUnifiedPipeline } from './pipeline.js';

const TEST_OWNER = 'abhishekray07';
const TEST_REPO = 'sentry-v2-e2e-test';
const TEST_PR = 52;

async function main() {
  console.log(`\n=== Unified Pipeline E2E Test ===`);
  console.log(`Target: ${TEST_OWNER}/${TEST_REPO}#${TEST_PR}\n`);

  const startTime = Date.now();

  const result = await runUnifiedPipeline(
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
  console.log(`Review URL: ${result.reviewUrl ?? 'none'}`);
  console.log(`Comment URL: ${result.commentUrl}`);

  if (result.reviewSummary) {
    console.log(`\n--- Review Summary (first 500 chars) ---`);
    console.log(result.reviewSummary.slice(0, 500));
  }

  if (result.verifyResult) {
    console.log(`\nVerify mode: ${result.verifyResult.mode}`);
    if (result.verifyResult.mode === 'verified') {
      console.log(`Score: ${result.verifyResult.passed}/${result.verifyResult.total} passed`);
      for (const r of result.verifyResult.results) {
        const icon = r.result === 'pass' ? '\x1b[32m✓\x1b[0m'
          : r.result === 'fail' ? '\x1b[31m✗\x1b[0m'
          : '\x1b[33m⊘\x1b[0m';
        console.log(`  ${icon} ${r.id}: ${r.description}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
