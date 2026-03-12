import { GitHubAppService } from "../github/app-service.js";
import { fetchPullRequest, createPrReview } from "../github/pr.js";
import { E2BSandboxProvider } from "../sandbox/e2b-provider.js";
import { buildReviewPrompt } from "./prompt.js";
import { parseDiff, buildLineMap } from "./diff-parser.js";
import { parseReviewOutput } from "./parser.js";
import { requireEnv } from "../env.js";

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE ?? "base";
const REVIEW_TIMEOUT_MS = 180_000; // 3 minutes hard limit

/** Validate branch name to prevent command injection */
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export interface ReviewPipelineInput {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ReviewPipelineCallbacks {
  log: (step: string, message: string, data?: unknown) => void;
  /** Called for each line of output during long-running commands. Useful for progress dots. */
  onOutputLine?: (line: string) => void;
}

export interface ReviewPipelineResult {
  reviewText: string;
  reviewUrl: string | null;
}

/**
 * Run the full review pipeline: fetch PR, run Claude in E2B sandbox, post inline review.
 *
 * Shared between the Trigger.dev task (runner.ts) and the local test script (test-live.ts).
 */
export async function runReviewPipeline(
  input: ReviewPipelineInput,
  callbacks: ReviewPipelineCallbacks
): Promise<ReviewPipelineResult> {
  const { owner, repo, prNumber } = input;
  const { log, onOutputLine } = callbacks;

  // 1. Get GitHub installation token
  log("github", "Fetching installation token...");
  const githubApp = new GitHubAppService(
    requireEnv("GITHUB_APP_ID"),
    requireEnv("GITHUB_APP_PRIVATE_KEY")
  );
  const { token } = await githubApp.getTokenForRepo(owner, repo);

  // 2. Fetch PR metadata + diff
  log("github", "Fetching PR metadata + diff...");
  const pr = await fetchPullRequest(owner, repo, prNumber, token);
  log("github", `PR: "${pr.title}"`, { headBranch: pr.headBranch, diffLen: pr.diff.length });

  // 3. Validate branch name before shell use
  if (!SAFE_BRANCH_RE.test(pr.headBranch)) {
    throw new Error(`Unsafe branch name: ${pr.headBranch}`);
  }

  // 4. Build authenticated clone URL
  const authenticatedCloneUrl = pr.cloneUrl.replace(
    "https://github.com/",
    `https://x-access-token:${token}@github.com/`
  );

  // 5. Parse diff to extract commentable line ranges
  const diffFiles = parseDiff(pr.diff);
  const lineMap = buildLineMap(diffFiles);
  log("diff", "Parsed diff", {
    fileCount: diffFiles.length,
    totalHunks: diffFiles.reduce((n, f) => n + f.hunks.length, 0),
  });

  // 6. Build structured prompt with line map
  const prompt = buildReviewPrompt({
    title: pr.title,
    body: pr.body,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    headSha: pr.headSha,
    diff: pr.diff,
    lineMap,
  });
  log("prompt", `Built prompt (${prompt.length} chars)`);

  // 7. Create E2B sandbox
  log("e2b", `Creating sandbox (template: ${SANDBOX_TEMPLATE})...`);
  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: SANDBOX_TEMPLATE,
    timeoutMs: REVIEW_TIMEOUT_MS + 60_000,
    envVars: {
      ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
      GIT_TERMINAL_PROMPT: "0",
    },
    metadata: { sessionId: `pr-${owner}-${repo}-${prNumber}`, userId: "code-reviewer" },
  });
  log("e2b", "Sandbox created", { sandboxId: sandbox.id });

  let reviewText = "";

  try {
    // 8. Install claude CLI if using base template
    if (SANDBOX_TEMPLATE === "base") {
      log("e2b", "Installing claude CLI...");
      for await (const line of provider.runCommand(sandbox.id, "npm install -g @anthropic-ai/claude-code", {
        cwd: "/",
        timeoutMs: 120_000,
      })) {
        onOutputLine?.(line);
      }
    }

    // 9. Clone repo
    const cloneCmd = `git clone --depth=1 --branch '${pr.headBranch}' '${authenticatedCloneUrl}' /home/user/repo`;
    log("e2b", `Cloning ${owner}/${repo}@${pr.headBranch}...`);
    for await (const _ of provider.runCommand(sandbox.id, cloneCmd, {
      cwd: "/home/user",
      timeoutMs: 60_000,
    })) { /* drain */ }
    log("e2b", "Clone complete");

    // 10. Upload prompt file (avoids shell ARG_MAX limits on large diffs)
    await provider.uploadFiles(sandbox.id, [
      { path: "/tmp/review-prompt.txt", content: prompt },
    ]);

    // 11. Run claude -p review
    // IMPORTANT: --output-format stream-json --verbose is required:
    //   - stream-json produces NDJSON that the E2B PTY provider can yield line-by-line
    //   - --verbose is required or stream-json mode fails silently
    //   - plain --output-format text output is dropped by the PTY provider (it only yields valid JSON lines)
    // Proven in opslane-v2 spike: docs/plans/2026-02-12-spike-results.md
    log("e2b", "Running claude -p review...");
    const claudeCmd = `cat /tmp/review-prompt.txt | claude -p --output-format stream-json --verbose --dangerously-skip-permissions`;
    const outputLines: string[] = [];
    for await (const line of provider.runCommand(sandbox.id, claudeCmd, {
      cwd: "/home/user/repo",
      timeoutMs: REVIEW_TIMEOUT_MS,
    })) {
      outputLines.push(line);
      onOutputLine?.(line);
    }

    // Extract final result from stream-json NDJSON output
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

    log("e2b", `Review extracted (${reviewText.length} chars)`);
  } finally {
    log("e2b", "Destroying sandbox...");
    await provider.destroy(sandbox.id).catch((err) => {
      log("e2b", "Sandbox teardown failed", { error: String(err) });
    });
  }

  if (!reviewText) {
    return { reviewText: "", reviewUrl: null };
  }

  // 12. Parse + validate Claude's output against diff metadata
  const review = parseReviewOutput(reviewText, diffFiles);

  let reviewUrl: string;

  if (review.fallback) {
    // Fallback: structured parsing failed — post raw text as summary, no inline comments
    log("github", "Structured parsing failed — falling back to summary-only review");
    reviewUrl = await createPrReview(
      owner, repo, prNumber, pr.headSha,
      review.rawText ?? reviewText,
      [],
      token
    );
  } else {
    // Normal: post review with validated inline comments
    log("github", "Posting inline review", {
      inlineComments: review.comments.length,
      orphanedToSummary: review.summary.includes("Additional findings"),
    });
    reviewUrl = await createPrReview(
      owner, repo, prNumber, pr.headSha,
      review.summary,
      review.comments,
      token
    );
  }

  log("github", "Review posted", { reviewUrl });
  return { reviewText, reviewUrl };
}
