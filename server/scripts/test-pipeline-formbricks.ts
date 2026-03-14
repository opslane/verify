/**
 * E2E: full verify pipeline against abhishekray07/formbricks PR #1
 * Run: node --env-file=.env --import tsx/esm scripts/test-pipeline-formbricks.ts
 */
import { runVerifyPipeline } from '../src/verify/pipeline.js';

async function main() {
  console.log(`\n=== E2E Verify Pipeline: formbricks PR #1 ===\n`);
  const startTime = Date.now();

  const result = await runVerifyPipeline(
    { owner: 'abhishekray07', repo: 'formbricks', prNumber: 1 },
    {
      log: (step, message, data) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  [${elapsed}s] [${step}] ${message}`);
        if (data) console.log(`           ${JSON.stringify(data).slice(0, 200)}`);
      },
      skipComment: true, // don't post to PR during testing
    },
  );

  console.log(`\n=== Result ===`);
  console.log(`Mode: ${result.mode}`);

  if (result.mode === 'verified') {
    console.log(`Score: ${result.passed}/${result.total} passed`);
    for (const r of result.results) {
      const icon = r.result === 'pass' ? '✓' : r.result === 'fail' ? '✗' : '⊘';
      console.log(`  ${icon} ${r.id}: ${r.description}`);
      if (r.expected) console.log(`    Expected: ${r.expected}`);
      if (r.observed) console.log(`    Observed: ${r.observed}`);
      if (r.reason) console.log(`    Reason: ${r.reason}`);
    }
  }

  if ('comment' in result && result.comment) {
    console.log(`\n--- PR Comment Preview ---`);
    console.log(result.comment.slice(0, 1000));
  }

  console.log(`\nTotal time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
