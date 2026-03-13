import { GitHubAppService } from "../github/app-service.js";
import { fetchPullRequest, fetchPrComments, postPrComment } from "../github/pr.js";
import { E2BSandboxProvider } from "../sandbox/e2b-provider.js";
import { buildMentionPrompt } from "./prompt.js";
import { requireEnv } from "../env.js";

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE ?? "base";
const MENTION_TIMEOUT_MS = 180_000;

/** Validate branch name to prevent command injection */
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._\-/]+$/;

export interface MentionPipelineInput {
  owner: string;
  repo: string;
  prNumber: number;
  mentionComment: string;
}

export interface MentionPipelineCallbacks {
  log: (step: string, message: string, data?: unknown) => void;
  onOutputLine?: (line: string) => void;
}

export interface MentionPipelineResult {
  responseText: string;
  commentUrl: string | null;
}

/**
 * Run the mention-triggered pipeline: fetch PR + thread, run Claude in E2B, post comment.
 */
export async function runMentionPipeline(
  input: MentionPipelineInput,
  callbacks: MentionPipelineCallbacks
): Promise<MentionPipelineResult> {
  const { owner, repo, prNumber, mentionComment } = input;
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

  // 3. Fetch conversation thread
  log("github", "Fetching PR conversation thread...");
  const thread = await fetchPrComments(owner, repo, prNumber, token);
  log("github", `Fetched ${thread.length} comments`);

  // 4. Validate branch name before shell use
  if (!SAFE_BRANCH_RE.test(pr.headBranch)) {
    throw new Error(`Unsafe branch name: ${pr.headBranch}`);
  }

  // 5. Build authenticated clone URL
  const authenticatedCloneUrl = pr.cloneUrl.replace(
    "https://github.com/",
    `https://x-access-token:${token}@github.com/`
  );

  // 6. Build prompt
  const prompt = buildMentionPrompt(pr, mentionComment, thread);
  log("prompt", `Built mention prompt (${prompt.length} chars)`);

  // 7. Create E2B sandbox
  log("e2b", `Creating sandbox (template: ${SANDBOX_TEMPLATE})...`);
  const provider = new E2BSandboxProvider();
  const sandbox = await provider.create({
    template: SANDBOX_TEMPLATE,
    timeoutMs: MENTION_TIMEOUT_MS + 60_000,
    envVars: {
      ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
      GIT_TERMINAL_PROMPT: "0",
    },
    metadata: { sessionId: `mention-${owner}-${repo}-${prNumber}`, userId: "code-reviewer" },
  });
  log("e2b", "Sandbox created", { sandboxId: sandbox.id });

  let responseText = "";

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

    // 10. Upload prompt file
    await provider.uploadFiles(sandbox.id, [
      { path: "/tmp/mention-prompt.txt", content: prompt },
    ]);

    // 11. Run claude -p
    log("e2b", "Running claude -p mention response...");
    const claudeCmd = `cat /tmp/mention-prompt.txt | claude -p --output-format stream-json --verbose --dangerously-skip-permissions`;
    const outputLines: string[] = [];
    for await (const line of provider.runCommand(sandbox.id, claudeCmd, {
      cwd: "/home/user/repo",
      timeoutMs: MENTION_TIMEOUT_MS,
    })) {
      outputLines.push(line);
      onOutputLine?.(line);
    }

    // Extract final result from stream-json NDJSON output
    for (const line of outputLines) {
      try {
        const parsed = JSON.parse(line) as { type?: string; result?: string };
        if (parsed.type === "result" && parsed.result) {
          responseText = parsed.result;
        }
      } catch {
        // skip non-JSON lines
      }
    }

    log("e2b", `Response extracted (${responseText.length} chars)`);
  } finally {
    log("e2b", "Destroying sandbox...");
    await provider.destroy(sandbox.id).catch((err) => {
      log("e2b", "Sandbox teardown failed", { error: String(err) });
    });
  }

  if (!responseText) {
    return { responseText: "", commentUrl: null };
  }

  // 12. Post as a new PR comment (not a review — conversational response)
  log("github", "Posting mention response comment...");
  const commentUrl = await postPrComment(owner, repo, prNumber, responseText, token);
  log("github", "Posted comment", { commentUrl });

  return { responseText, commentUrl };
}
