/**
 * Unified pipeline: runs code review + acceptance criteria verification,
 * posts inline comments (review) + a single combined summary comment.
 */
import { runReviewPipeline } from '../review/pipeline.js';
import { runVerifyPipeline, type VerifyResult } from '../verify/pipeline.js';
import { postOrUpdateComment } from '../github/pr.js';
import { GitHubAppService } from '../github/app-service.js';
import { findRepoConfig } from '../db.js';
import { requireEnv } from '../env.js';
import { ICON, LABEL, type AcResult } from '../verify/comment.js';

const UNIFIED_MARKER = '<!-- opslane-report -->';

export interface UnifiedPipelineInput {
  owner: string;
  repo: string;
  prNumber: number;
}

interface UnifiedCallbacks {
  log: (step: string, message: string, data?: unknown) => void;
}

export interface UnifiedResult {
  reviewSummary: string | null;
  reviewUrl: string | null;
  verifyResult: VerifyResult | null;
  commentUrl: string;
}

/**
 * Run both review and verify pipelines, then post a single combined PR comment.
 *
 * - Code review: inline comments go via GitHub Reviews API (on specific diff lines)
 * - Combined summary: one issue comment with review summary + AC verification table
 */
export async function runUnifiedPipeline(
  input: UnifiedPipelineInput,
  callbacks: UnifiedCallbacks,
): Promise<UnifiedResult> {
  const { owner, repo, prNumber } = input;
  const { log } = callbacks;

  // Determine if verify should run (needs repo config)
  const repoConfig = await findRepoConfig(owner, repo);
  const shouldVerify = !!repoConfig;

  log('unified', `Starting unified pipeline (review=yes, verify=${shouldVerify ? 'yes' : 'skip — no repo config'})`);

  // Run review pipeline — posts inline comments, returns summary
  log('unified', 'Starting code review...');
  let reviewResult: { reviewText: string; reviewUrl: string | null; summary?: string; inlineCommentCount?: number };
  let reviewError: string | null = null;
  try {
    reviewResult = await runReviewPipeline(
      { owner, repo, prNumber },
      {
        log: (step, msg, data) => log(`review/${step}`, msg, data),
        skipPost: false, // Still post inline comments via GitHub Reviews API
      },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('unified', `Review pipeline failed: ${errMsg}`);
    reviewError = errMsg;
    reviewResult = { reviewText: '', reviewUrl: null, summary: undefined, inlineCommentCount: 0 };
  }

  // Run verify pipeline (if config exists) — skip its own comment posting
  let verifyResult: VerifyResult | null = null;
  if (shouldVerify) {
    log('unified', 'Starting acceptance criteria verification...');
    try {
      verifyResult = await runVerifyPipeline(
        { owner, repo, prNumber },
        {
          log: (step, msg, data) => log(`verify/${step}`, msg, data),
          skipComment: true,
        },
      );
    } catch (err) {
      log('unified', `Verify pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Build combined comment
  const combinedComment = formatUnifiedComment({
    reviewSummary: reviewResult.summary ?? null,
    reviewError,
    inlineCommentCount: reviewResult.inlineCommentCount ?? 0,
    verifyResult,
  });

  // Post single combined comment (idempotent — updates if exists)
  log('unified', 'Posting combined report comment');
  const githubApp = new GitHubAppService(
    requireEnv('GITHUB_APP_ID'),
    requireEnv('GITHUB_APP_PRIVATE_KEY'),
  );
  const { token } = await githubApp.getTokenForRepo(owner, repo);

  const commentUrl = await postOrUpdateComment(
    owner, repo, prNumber, combinedComment, UNIFIED_MARKER, token,
  );

  log('unified', 'Combined report posted', { commentUrl });

  return {
    reviewSummary: reviewResult.summary ?? null,
    reviewUrl: reviewResult.reviewUrl,
    verifyResult,
    commentUrl,
  };
}

interface UnifiedCommentInput {
  reviewSummary: string | null;
  reviewError: string | null;
  inlineCommentCount: number;
  verifyResult: VerifyResult | null;
}

function formatUnifiedComment(input: UnifiedCommentInput): string {
  const sections: string[] = [UNIFIED_MARKER];

  sections.push('## Opslane Report\n');

  // --- Code Review section ---
  sections.push('### Code Review\n');
  if (input.reviewError) {
    sections.push(`> **Code review encountered an error.** Please re-run or check logs.\n`);
  } else if (input.reviewSummary) {
    if (input.inlineCommentCount > 0) {
      sections.push(`*${input.inlineCommentCount} inline comment${input.inlineCommentCount === 1 ? '' : 's'} posted on the diff.*\n`);
    }
    sections.push(input.reviewSummary);
  } else {
    sections.push('*Code review did not produce output.*');
  }

  // --- Verify section ---
  sections.push('\n---\n');
  sections.push('### Acceptance Criteria Verification\n');

  if (!input.verifyResult) {
    sections.push('*Verify skipped — no repo config found. Configure your repo in the Opslane dashboard to enable AC verification.*');
  } else if (input.verifyResult.mode === 'no-config') {
    sections.push('*Verify skipped — no repo config found.*');
  } else if (input.verifyResult.mode === 'no-spec') {
    sections.push('*No spec found for this PR. Add a plan file to `docs/plans/` or include acceptance criteria in the PR description.*');
  } else if (input.verifyResult.mode === 'startup-failed') {
    sections.push('*App failed to start in the sandbox. Check your startup command and env vars in the Opslane dashboard.*');
  } else if (input.verifyResult.mode === 'verified') {
    const { results, passed, total } = input.verifyResult;
    sections.push(formatAcTable(results));
    sections.push(`\n*${passed} of ${total} criteria passed*`);
  }

  sections.push('\n---');
  sections.push('*Powered by [Opslane](https://opslane.com)*');

  return sections.join('\n');
}

function formatAcTable(results: AcResult[]): string {
  const rows = results
    .map((r) => {
      const suffix = r.result === 'skipped' && r.reason ? ` (${r.reason})` : '';
      return `| ${ICON[r.result]} | ${r.id}: ${r.description} | ${LABEL[r.result]}${suffix} |`;
    })
    .join('\n');

  const details = results
    .filter((r) => r.result !== 'skipped')
    .map((r) => {
      const icon = ICON[r.result];
      const label = LABEL[r.result];
      const parts: string[] = [];
      parts.push(`<details${r.result === 'fail' ? ' open' : ''}>`);
      parts.push(`<summary>${icon} <strong>${r.id}: ${r.description}</strong> — ${label}${r.judgeOverride ? ' (judge override)' : ''}</summary>\n`);

      if (r.expected) parts.push(`> **Expected:** ${r.expected}`);
      if (r.observed) parts.push(`> **Observed:** ${r.observed}`);
      if (r.reason) parts.push(`> **Reason:** ${r.reason}`);
      if (r.judgeReasoning) parts.push(`> **Judge:** ${r.judgeReasoning}`);
      if (r.screenshotUrl) parts.push(`\n![${r.id} screenshot](${r.screenshotUrl})`);

      parts.push('\n</details>');
      return parts.join('\n');
    })
    .join('\n\n');

  let table = `| | AC | Result |
|---|---|---|
${rows}`;

  if (details) {
    table += `\n\n#### Evidence\n\n${details}`;
  }

  return table;
}
