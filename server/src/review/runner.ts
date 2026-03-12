import { task, logger } from "@trigger.dev/sdk/v3";
import { GitHubAppService } from "../github/app-service.js";
import { fetchPullRequest, postPrComment, findBotComment, updatePrComment } from "../github/pr.js";
import { E2BSandboxProvider } from "../sandbox/e2b-provider.js";
import { buildReviewPrompt } from "./prompt.js";
import { REVIEW_COMMENT_MARKER } from "../webhook/verify.js";

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE ?? "base";
const REVIEW_TIMEOUT_MS = 180_000; // 3 minutes hard limit

// Validate branch name to prevent command injection
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export interface ReviewPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
}

export const reviewPrTask = task({
  id: "review-pr",
  maxDuration: 300, // Trigger.dev max seconds

  run: async (payload: ReviewPayload) => {
    const { owner, repo, prNumber } = payload;
    logger.info("Starting PR review", { owner, repo, prNumber });

    // 1. Get GitHub installation token
    const githubApp = new GitHubAppService(
      process.env.GITHUB_APP_ID!,
      process.env.GITHUB_APP_PRIVATE_KEY!
    );
    const { token } = await githubApp.getTokenForRepo(owner, repo);

    // 2. Fetch PR metadata + diff
    const pr = await fetchPullRequest(owner, repo, prNumber, token);
    logger.info("Fetched PR", { title: pr.title, headSha: pr.headSha });

    // 3. Validate branch name before shell use (prevents command injection)
    if (!SAFE_BRANCH_RE.test(pr.headBranch)) {
      throw new Error(`Unsafe branch name: ${pr.headBranch}`);
    }

    // 4. Build authenticated clone URL — token added here, not stored in PullRequestMeta
    const authenticatedCloneUrl = pr.cloneUrl.replace(
      "https://github.com/",
      `https://x-access-token:${token}@github.com/`
    );

    // 5. Build prompt
    const prompt = buildReviewPrompt(pr);

    // 6. Spin up E2B sandbox (try/finally guarantees teardown)
    const provider = new E2BSandboxProvider();
    const sandbox = await provider.create({
      template: SANDBOX_TEMPLATE,
      timeoutMs: REVIEW_TIMEOUT_MS + 30_000,
      envVars: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
        GIT_TERMINAL_PROMPT: "0",
      },
      metadata: { sessionId: `pr-${owner}-${repo}-${prNumber}`, userId: "code-reviewer" },
    });

    let reviewText = "";

    try {
      // 7. Clone repo inside sandbox
      // SECURITY: authenticatedCloneUrl validated above (contains only validated owner/repo/token)
      // SECURITY: pr.headBranch validated against SAFE_BRANCH_RE above
      const cloneCmd = `git clone --depth=1 --branch ${pr.headBranch} ${authenticatedCloneUrl} /workspace/repo`;
      logger.info("Cloning repo", { branch: pr.headBranch });
      for await (const _ of provider.runCommand(sandbox.id, cloneCmd, { cwd: "/", timeoutMs: 60_000 })) {
        // drain output
      }

      // 8. Write prompt to file in sandbox (avoids shell ARG_MAX limits on large diffs)
      await provider.uploadFiles(sandbox.id, [
        { path: "/tmp/review-prompt.txt", content: prompt },
      ]);

      // 9. Run claude -p via stdin from file
      // IMPORTANT: --output-format stream-json --verbose is required:
      //   - stream-json produces NDJSON that the E2B PTY provider can yield line-by-line
      //   - --verbose is required or stream-json mode fails silently
      //   - plain --output-format text output is dropped by the PTY provider (it only yields valid JSON lines)
      // Proven in opslane-v2 spike: docs/plans/2026-02-12-spike-results.md
      logger.info("Running claude -p review");
      const claudeCmd = `cat /tmp/review-prompt.txt | claude -p --output-format stream-json --verbose --dangerouslySkipPermissions`;

      const outputLines: string[] = [];
      for await (const line of provider.runCommand(sandbox.id, claudeCmd, {
        cwd: "/workspace/repo",
        timeoutMs: REVIEW_TIMEOUT_MS,
      })) {
        outputLines.push(line);
      }

      // Extract final result from stream-json NDJSON output
      // stream-json emits many event lines; the last "result" type line has the full text
      for (const line of outputLines) {
        try {
          const parsed = JSON.parse(line) as { type?: string; result?: string };
          if (parsed.type === "result" && parsed.result) {
            reviewText = parsed.result;
          }
        } catch {
          // skip non-JSON lines
        }
      }

      logger.info("Review complete", { length: reviewText.length });
    } finally {
      // Always tear down sandbox — even on failure
      await provider.destroy(sandbox.id).catch((err) => {
        logger.error("Sandbox teardown failed", { error: String(err) });
      });
    }

    if (!reviewText) {
      logger.warn("Empty review output — skipping comment");
      return { skipped: true };
    }

    // 10. Post or update PR comment (edit in-place on synchronize to avoid stacking)
    const commentBody = `${REVIEW_COMMENT_MARKER}\n## Code Review\n\n${reviewText}`;
    const existingCommentId = await findBotComment(owner, repo, prNumber, REVIEW_COMMENT_MARKER, token);

    let commentUrl: string;
    if (existingCommentId) {
      await updatePrComment(owner, repo, existingCommentId, commentBody, token);
      commentUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${existingCommentId}`;
      logger.info("Updated existing review comment", { commentUrl });
    } else {
      commentUrl = await postPrComment(owner, repo, prNumber, commentBody, token);
      logger.info("Posted new review comment", { commentUrl });
    }

    return { commentUrl };
  },
});
