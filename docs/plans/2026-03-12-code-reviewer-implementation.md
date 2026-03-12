# Code Reviewer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `server/` package to the verify repo that receives GitHub PR webhooks via Svix, runs Claude in an E2B sandbox with full repo context, and posts a code review comment back to the PR.

**Architecture:** Hono HTTP server deployed to Railway receives Svix-forwarded GitHub webhooks and immediately responds 202, triggering a Trigger.dev background task that spins up an E2B sandbox, clones the repo, runs `claude -p` with a code review prompt, and posts the result as a GitHub PR comment. The Hono server is deployed to Railway; Trigger.dev tasks are deployed to Trigger.dev cloud.

**Tech Stack:** TypeScript, Hono + `@hono/node-server`, Trigger.dev v3 (`@trigger.dev/sdk`), E2B (`e2b`), `svix` (webhook verification), `jose` + `node:crypto` (GitHub App JWT), `vitest` (tests), `tsx` (dev), `tsup` (build)

**Design doc:** `docs/plans/2026-03-12-code-reviewer-design.md`

---

## Before You Start

Read these files from opslane-v2 — you will copy them nearly verbatim:
- `../opslane-v2/apps/api/src/sandbox/e2b-provider.ts` — E2BSandboxProvider
- `../opslane-v2/apps/api/src/sandbox/types.ts` — SandboxProvider interface
- `../opslane-v2/apps/api/src/services/github-app-service.ts` — GitHubAppService
- `../opslane-v2/apps/api/src/triggers/verify.ts` — verifyGitHubSignature

GitHub App permissions required (document in README): `pull_requests: write`, `contents: read`

---

## Task 1: Project scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/trigger.config.ts`
- Create: `server/src/index.ts`
- Create: `server/.env.example`
- Create: `server/.gitignore`

**Step 1: Create `server/package.json`**

```json
{
  "name": "@verify/server",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "trigger:dev": "npx trigger.dev@latest dev",
    "trigger:deploy": "npx trigger.dev@latest deploy"
  },
  "dependencies": {
    "@hono/node-server": "^1.14.0",
    "@trigger.dev/sdk": "^3.0.0",
    "e2b": "^1.0.0",
    "hono": "^4.0.0",
    "jose": "^5.0.0",
    "svix": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node16",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "trigger.config.ts"]
}
```

**Step 3: Create `server/trigger.config.ts`**

```typescript
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_placeholder",
  dirs: ["src/review"],
});
```

**Step 4: Create `server/src/index.ts`**

```typescript
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { webhookRoutes } from "./routes/webhooks.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/webhooks", webhookRoutes);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Server listening on port ${port}`);
});
```

**Step 5: Create `server/.env.example`**

```bash
# GitHub App — https://github.com/settings/apps
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=   # base64-encoded PEM: base64 -w0 < private-key.pem

# Svix — https://app.svix.com (incoming webhooks signing secret)
SVIX_WEBHOOK_SECRET=

# E2B — https://e2b.dev/dashboard
E2B_API_KEY=

# Anthropic — https://console.anthropic.com (used inside E2B sandbox)
ANTHROPIC_API_KEY=

# Trigger.dev — https://cloud.trigger.dev
TRIGGER_SECRET_KEY=
TRIGGER_PROJECT_REF=

# Local dev only — set to "true" to skip Svix sig verification
# NEVER set in production
SVIX_SKIP_VERIFICATION=
```

**Step 6: Create `server/.gitignore`**

```
node_modules/
dist/
.env
```

**Step 7: Install dependencies**

```bash
cd server && npm install
```

**Step 8: Verify TypeScript compiles**

```bash
cd server && npm run typecheck
```
Expected: No errors (or only "cannot find module" for files not yet created)

**Step 9: Commit**

```bash
git add server/
git commit -m "feat(server): scaffold TypeScript package with Hono + Trigger.dev"
```

---

## Task 2: GitHub App service

**Files:**
- Create: `server/src/github/app-service.ts` (copied + adapted from opslane-v2)
- Create: `server/src/github/app-service.test.ts`

**Step 1: Copy `GitHubAppService` from opslane-v2**

Copy `../opslane-v2/apps/api/src/services/github-app-service.ts` to `server/src/github/app-service.ts`.

Remove the `logger` import and replace all `logger.info/warn/error` calls with `console.log/warn/error`. Remove the `@opslane/shared` or internal imports if any. Keep everything else identical.

**Step 2: Write failing test**

Create `server/src/github/app-service.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { GitHubAppService, GitHubAppNotInstalledError } from "./app-service.js";

describe("GitHubAppService", () => {
  it("throws on invalid private key", () => {
    expect(
      () => new GitHubAppService("123", "not-a-valid-key")
    ).toThrow("Invalid GitHub App private key format");
  });

  it("throws GitHubAppNotInstalledError with install URL", () => {
    const err = new GitHubAppNotInstalledError("owner", "repo", "my-app");
    expect(err.message).toContain("https://github.com/apps/my-app/installations/new");
    expect(err.owner).toBe("owner");
    expect(err.repo).toBe("repo");
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && npm test -- app-service
```
Expected: FAIL — module not found

**Step 4: Create the file (already done in Step 1), run again**

```bash
cd server && npm test -- app-service
```
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add server/src/github/
git commit -m "feat(server): add GitHubAppService (adapted from opslane-v2)"
```

---

## Task 3: GitHub PR functions

**Files:**
- Create: `server/src/github/pr.ts`
- Create: `server/src/github/pr.test.ts`

**Step 1: Write failing test**

Create `server/src/github/pr.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildDiffUrl, truncateDiff, MAX_DIFF_BYTES } from "./pr.js";

describe("buildDiffUrl", () => {
  it("builds the correct GitHub diff URL", () => {
    const url = buildDiffUrl("octocat", "hello-world", 42);
    expect(url).toBe(
      "https://api.github.com/repos/octocat/hello-world/pulls/42"
    );
  });
});

describe("truncateDiff", () => {
  it("returns diff unchanged when under limit", () => {
    const diff = "small diff";
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("truncates and appends notice when over MAX_DIFF_BYTES", () => {
    const big = "x".repeat(MAX_DIFF_BYTES + 1);
    const result = truncateDiff(big);
    expect(result.length).toBeLessThanOrEqual(MAX_DIFF_BYTES + 200);
    expect(result).toContain("[diff truncated]");
  });
});
```

**Step 2: Run to verify fails**

```bash
cd server && npm test -- pr.test
```
Expected: FAIL — module not found

**Step 3: Create `server/src/github/pr.ts`**

```typescript
const GITHUB_API = "https://api.github.com";
export const MAX_DIFF_BYTES = 50_000;

export function buildDiffUrl(owner: string, repo: string, prNumber: number): string {
  return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`;
}

export function truncateDiff(diff: string): string {
  if (Buffer.byteLength(diff, "utf8") <= MAX_DIFF_BYTES) return diff;
  const truncated = diff.slice(0, MAX_DIFF_BYTES);
  return truncated + "\n\n[diff truncated — too large for automated review]";
}

export interface PullRequestMeta {
  title: string;
  body: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  cloneUrl: string;   // authenticated clone URL with token
  diff: string;
}

/**
 * Fetch PR metadata and unified diff using a GitHub App installation token.
 */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<PullRequestMeta> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Fetch PR metadata
  const prRes = await fetch(buildDiffUrl(owner, repo, prNumber), { headers });
  if (!prRes.ok) {
    throw new Error(`GitHub PR fetch failed: ${prRes.status} ${await prRes.text()}`);
  }
  const pr = await prRes.json() as {
    title: string;
    body: string | null;
    base: { ref: string };
    head: { ref: string; sha: string };
    diff_url: string;
  };

  // Fetch unified diff
  const diffRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        ...headers,
        Accept: "application/vnd.github.v3.diff",
      },
    }
  );
  if (!diffRes.ok) {
    throw new Error(`GitHub diff fetch failed: ${diffRes.status}`);
  }
  const rawDiff = await diffRes.text();

  return {
    title: pr.title,
    body: pr.body,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
    cloneUrl: `https://x-access-token:${token}@github.com/${owner}/${repo}.git`,
    diff: truncateDiff(rawDiff),
  };
}

/** Post a comment to a PR. Returns the comment URL. */
export async function postPrComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string
): Promise<string> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to post PR comment: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { html_url: string };
  return data.html_url;
}

/** Find an existing bot comment by a marker string. Returns comment ID or null. */
export async function findBotComment(
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
  token: string
): Promise<number | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!res.ok) return null;
  const comments = await res.json() as Array<{ id: number; body: string }>;
  const found = comments.find((c) => c.body.includes(marker));
  return found?.id ?? null;
}

/** Edit an existing PR comment in-place. */
export async function updatePrComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  token: string
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to update PR comment: ${res.status} ${await res.text()}`);
  }
}
```

**Step 4: Run tests**

```bash
cd server && npm test -- pr.test
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add server/src/github/pr.ts server/src/github/pr.test.ts
git commit -m "feat(server): add GitHub PR fetch + comment functions"
```

---

## Task 4: Svix webhook verification + dedup

**Files:**
- Create: `server/src/webhook/verify.ts`
- Create: `server/src/webhook/dedup.ts`
- Create: `server/src/webhook/verify.test.ts`
- Create: `server/src/webhook/dedup.test.ts`

**Step 1: Write failing tests**

Create `server/src/webhook/verify.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldSkipVerification } from "./verify.js";

describe("shouldSkipVerification", () => {
  it("returns false by default", () => {
    expect(shouldSkipVerification("production", undefined)).toBe(false);
  });

  it("returns false in production even if env var set", () => {
    expect(shouldSkipVerification("production", "true")).toBe(false);
  });

  it("returns true only in non-production with var set", () => {
    expect(shouldSkipVerification("development", "true")).toBe(true);
  });
});
```

Create `server/src/webhook/dedup.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DeduplicationSet } from "./dedup.js";

describe("DeduplicationSet", () => {
  it("returns false for a new delivery ID", () => {
    const set = new DeduplicationSet();
    expect(set.isDuplicate("abc-123")).toBe(false);
  });

  it("returns true for a seen delivery ID", () => {
    const set = new DeduplicationSet();
    set.markSeen("abc-123");
    expect(set.isDuplicate("abc-123")).toBe(true);
  });

  it("returns false for a different delivery ID", () => {
    const set = new DeduplicationSet();
    set.markSeen("abc-123");
    expect(set.isDuplicate("def-456")).toBe(false);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd server && npm test -- verify.test dedup.test
```
Expected: FAIL — module not found

**Step 3: Create `server/src/webhook/verify.ts`**

```typescript
import { Webhook } from "svix";

export const REVIEW_COMMENT_MARKER = "<!-- opslane-code-review -->";

/**
 * Svix skip flag: only honoured outside production.
 * Guards against accidental production bypass.
 */
export function shouldSkipVerification(
  nodeEnv: string | undefined,
  skipFlag: string | undefined
): boolean {
  if (nodeEnv === "production") return false;
  return skipFlag === "true";
}

/**
 * Verify a Svix-forwarded webhook. Throws if invalid.
 */
export function verifySvixWebhook(
  payload: string,
  headers: Record<string, string>,
  secret: string
): void {
  const wh = new Webhook(secret);
  wh.verify(payload, headers);
}
```

**Step 4: Create `server/src/webhook/dedup.ts`**

```typescript
/**
 * In-memory deduplication set for webhook delivery IDs.
 * Prevents duplicate reviews when Svix retries a delivery.
 * NOTE: single-instance only — use Redis if you scale horizontally.
 * Entries expire after TTL_MS to prevent unbounded memory growth.
 */
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class DeduplicationSet {
  private seen = new Set<string>();

  isDuplicate(deliveryId: string): boolean {
    return this.seen.has(deliveryId);
  }

  markSeen(deliveryId: string): void {
    this.seen.add(deliveryId);
    setTimeout(() => this.seen.delete(deliveryId), TTL_MS);
  }
}
```

**Step 5: Run tests**

```bash
cd server && npm test -- verify.test dedup.test
```
Expected: PASS (6 tests)

**Step 6: Commit**

```bash
git add server/src/webhook/
git commit -m "feat(server): add Svix verification + dedup set"
```

---

## Task 5: E2B sandbox provider

**Files:**
- Create: `server/src/sandbox/types.ts` (copied from opslane-v2)
- Create: `server/src/sandbox/e2b-provider.ts` (copied + adapted from opslane-v2)

**Step 1: Copy `server/src/sandbox/types.ts`**

Copy verbatim from `../opslane-v2/apps/api/src/sandbox/types.ts`.

No changes needed — it has no external dependencies.

**Step 2: Copy `server/src/sandbox/e2b-provider.ts`**

Copy from `../opslane-v2/apps/api/src/sandbox/e2b-provider.ts`.

Replace the `logger` import and all `logger.info/warn/error/debug` calls with `console.log/warn/error/debug`. Keep everything else identical — the PTY streaming logic is battle-tested and should not be touched.

**Step 3: Verify TypeScript compiles**

```bash
cd server && npm run typecheck
```
Expected: No errors in `sandbox/`

**Step 4: Commit**

```bash
git add server/src/sandbox/
git commit -m "feat(server): add E2B sandbox provider (adapted from opslane-v2)"
```

---

## Task 6: Review prompt builder

**Files:**
- Create: `server/src/review/prompt.ts`
- Create: `server/src/review/prompt.test.ts`

**Step 1: Write failing test**

Create `server/src/review/prompt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "./prompt.js";

describe("buildReviewPrompt", () => {
  it("includes PR title in prompt", () => {
    const prompt = buildReviewPrompt({
      title: "Fix null pointer in auth",
      body: "Fixes #123",
      baseBranch: "main",
      headBranch: "fix/null-ptr",
      headSha: "abc1234",
      diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-null\n+undefined",
    });
    expect(prompt).toContain("Fix null pointer in auth");
  });

  it("includes diff in prompt", () => {
    const prompt = buildReviewPrompt({
      title: "My PR",
      body: null,
      baseBranch: "main",
      headBranch: "feature/x",
      headSha: "def5678",
      diff: "--- a/foo.ts",
    });
    expect(prompt).toContain("--- a/foo.ts");
  });

  it("includes all review dimensions", () => {
    const prompt = buildReviewPrompt({
      title: "PR",
      body: null,
      baseBranch: "main",
      headBranch: "x",
      headSha: "000",
      diff: "",
    });
    expect(prompt).toContain("Correctness");
    expect(prompt).toContain("Security");
    expect(prompt).toContain("Simplicity");
  });
});
```

**Step 2: Run to verify fails**

```bash
cd server && npm test -- prompt.test
```
Expected: FAIL — module not found

**Step 3: Create `server/src/review/prompt.ts`**

```typescript
interface PromptInput {
  title: string;
  body: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diff: string;
}

export function buildReviewPrompt(pr: PromptInput): string {
  return `You are a senior engineer performing a pull request code review. Be direct, specific, and actionable.

## Pull Request

**Title:** ${pr.title}
**Base:** ${pr.baseBranch} ← **Head:** ${pr.headBranch} (${pr.headSha})
${pr.body ? `**Description:** ${pr.body}` : ""}

## Diff

\`\`\`diff
${pr.diff}
\`\`\`

## Instructions

Review this PR across these dimensions:
- **Correctness** — logic bugs, missing error handling, broken edge cases
- **Security** — injection, leaked secrets, missing auth/validation
- **Architecture** — does it fit the existing codebase patterns?
- **Simplicity** — over-engineering, unnecessary abstractions, dead code
- **Testing** — missing tests for new behavior or edge cases
- **Maintainability** — readability, naming, comments where needed

## Output format

Respond with plain markdown. Use these sections:

### Blockers
Issues that will cause production failures if merged. If none, write "None."

### Should Fix
Important gaps, convention violations, or missing error handling. If none, write "None."

### Consider
Optional improvements, style, minor simplifications.

### Summary
One paragraph verdict: is this ready to merge, needs minor fixes, or needs significant work?

Be concise. Use \`file:line\` references where possible. Do not repeat the diff back to me.`;
}
```

**Step 4: Run tests**

```bash
cd server && npm test -- prompt.test
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add server/src/review/
git commit -m "feat(server): add review prompt builder"
```

---

## Task 7: Trigger.dev review task

**Files:**
- Create: `server/src/review/runner.ts`

This is the Trigger.dev task that runs the full review pipeline. It is deployed to Trigger.dev cloud (not Railway).

**Step 1: Create `server/src/review/runner.ts`**

```typescript
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
// Validate clone URL to prevent SSRF
const SAFE_CLONE_URL_RE = /^https:\/\/x-access-token:[^@]+@github\.com\/[\w.\-]+\/[\w.\-]+\.git$/;

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

    // 3. Validate branch name and clone URL before shell use
    if (!SAFE_BRANCH_RE.test(pr.headBranch)) {
      throw new Error(`Unsafe branch name: ${pr.headBranch}`);
    }
    if (!SAFE_CLONE_URL_RE.test(pr.cloneUrl)) {
      throw new Error(`Unsafe clone URL`);
    }

    // 4. Build prompt
    const prompt = buildReviewPrompt(pr);

    // 5. Spin up E2B sandbox (try/finally guarantees teardown)
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
      // 6. Clone repo inside sandbox
      const cloneCmd = `git clone --depth=1 --branch ${pr.headBranch} ${pr.cloneUrl} /workspace/repo`;
      logger.info("Cloning repo", { branch: pr.headBranch });
      for await (const _ of provider.runCommand(sandbox.id, cloneCmd, { cwd: "/", timeoutMs: 60_000 })) {
        // drain output
      }

      // 7. Write prompt to file in sandbox (avoids shell ARG_MAX limits on large diffs)
      await provider.uploadFiles(sandbox.id, [
        { path: "/tmp/review-prompt.txt", content: prompt },
      ]);

      // 8. Run claude -p via stdin from file
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

    // 9. Post or update PR comment (edit in-place on synchronize to avoid stacking)
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
```

**Step 2: Verify TypeScript compiles**

```bash
cd server && npm run typecheck
```
Expected: No errors

**Step 3: Commit**

```bash
git add server/src/review/runner.ts
git commit -m "feat(server): add Trigger.dev review task"
```

---

## Task 8: Webhook route

**Files:**
- Create: `server/src/routes/webhooks.ts`
- Create: `server/src/routes/webhooks.test.ts`

**Step 1: Write failing test**

Create `server/src/routes/webhooks.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createWebhookApp } from "./webhooks.js";

describe("GET /health", () => {
  it("returns 200", async () => {
    const app = createWebhookApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("POST /webhooks/github", () => {
  it("returns 401 when Svix verification fails", async () => {
    process.env.SVIX_WEBHOOK_SECRET = "whsec_test_secret_at_least_32_chars_long!!";
    process.env.NODE_ENV = "production";
    const app = createWebhookApp();
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 accepted:false for non-PR events when verification skipped", async () => {
    process.env.SVIX_SKIP_VERIFICATION = "true";
    process.env.NODE_ENV = "test";
    const app = createWebhookApp();
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: boolean };
    expect(body.accepted).toBe(false);
  });
});
```

**Step 2: Run to verify fails**

```bash
cd server && npm test -- webhooks.test
```
Expected: FAIL — module not found

**Step 3: Create `server/src/routes/webhooks.ts`**

```typescript
import { Hono } from "hono";
import { tasks } from "@trigger.dev/sdk/v3";
import type { reviewPrTask } from "../review/runner.js";
import { shouldSkipVerification, verifySvixWebhook } from "../webhook/verify.js";
import { DeduplicationSet } from "../webhook/dedup.js";
import type { ReviewPayload } from "../review/runner.js";

const dedup = new DeduplicationSet();

export function createWebhookApp(): Hono {
  const app = new Hono();

  // NOTE: /health lives in index.ts only. Do not add it here — would become /webhooks/health.
  app.post("/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const deliveryId = c.req.header("svix-id") ?? crypto.randomUUID();
    const eventType = c.req.header("x-github-event") ?? "";

    // Svix signature verification
    const skipVerification = shouldSkipVerification(
      process.env.NODE_ENV,
      process.env.SVIX_SKIP_VERIFICATION
    );

    if (!skipVerification) {
      const secret = process.env.SVIX_WEBHOOK_SECRET;
      if (!secret) {
        return c.json({ error: "Webhook secret not configured" }, 503);
      }
      try {
        verifySvixWebhook(rawBody, Object.fromEntries(c.req.raw.headers.entries()), secret);
      } catch {
        return c.json({ error: "Invalid signature" }, 401);
      }
    }

    // Only handle PR events
    if (eventType !== "pull_request") {
      return c.json({ accepted: false, reason: "Not a pull_request event" });
    }

    let payload: { action?: string; number?: number; repository?: { owner?: { login?: string }; name?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only handle opened + synchronize
    if (payload.action !== "opened" && payload.action !== "synchronize") {
      return c.json({ accepted: false, reason: `Ignoring action: ${payload.action}` });
    }

    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const prNumber = payload.number;

    if (!owner || !repo || !prNumber) {
      return c.json({ error: "Missing owner, repo, or PR number" }, 400);
    }

    // Deduplicate
    if (dedup.isDuplicate(deliveryId)) {
      return c.json({ accepted: false, reason: "Duplicate delivery" }, 200);
    }
    dedup.markSeen(deliveryId);

    // Trigger background task — respond 202 immediately
    const reviewPayload: ReviewPayload = { owner, repo, prNumber, deliveryId };

    // tasks.trigger is a no-op in test/dev if TRIGGER_SECRET_KEY is not set
    if (process.env.TRIGGER_SECRET_KEY) {
      await tasks.trigger<typeof reviewPrTask>("review-pr", reviewPayload);
    } else {
      console.warn("TRIGGER_SECRET_KEY not set — skipping task dispatch");
    }

    return c.json({ accepted: true, prNumber, owner, repo }, 202);
  });

  return app;
}

// Export default Hono instance for server entry point
export const webhookRoutes = createWebhookApp();
```

**Step 4: Run tests**

```bash
cd server && npm test -- webhooks.test
```
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add server/src/routes/
git commit -m "feat(server): add webhook route with Svix verification and Trigger.dev dispatch"
```

---

## Task 9: Dockerfile + Railway config

**Files:**
- Create: `server/Dockerfile`
- Create: `server/railway.json`

**Step 1: Create `server/Dockerfile`**

Multi-stage build: first stage compiles TypeScript, second stage runs production only.

```dockerfile
# --- Build stage ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

**Step 3: Create `server/railway.json`**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "server/Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

**Step 4: Run full test suite**

```bash
cd server && npm test
```
Expected: All tests PASS

**Step 5: Run typecheck**

```bash
cd server && npm run typecheck
```
Expected: No errors

**Step 6: Commit**

```bash
git add server/Dockerfile server/railway.json
git commit -m "feat(server): add Dockerfile and Railway config"
```

---

## Task 10: README

**Files:**
- Create: `server/README.md`

**Step 1: Create `server/README.md`**

```markdown
# verify/server

Cloud service that reviews GitHub PRs using Claude in an E2B sandbox.

## How it works

1. GitHub PR opened/updated → Svix (webhook buffer) → this server
2. Server responds 202, triggers a Trigger.dev background task
3. Task: fetches PR diff, spins up E2B sandbox, clones repo, runs `claude -p`
4. Posts code review as a PR comment

## Required GitHub App permissions

- `pull_requests: write` — post/edit review comments
- `contents: read` — fetch PR diff

## Setup

1. Copy `.env.example` to `.env` and fill in all values
2. Install: `npm install`
3. Dev: `npm run dev` (Hono server) + `npm run trigger:dev` (Trigger.dev worker)

## Environment variables

See `.env.example` for all required vars.

## Deployment

- **Hono server** → Railway (use `Dockerfile`, set env vars in Railway dashboard)
- **Trigger.dev tasks** → `npm run trigger:deploy`

## Local testing with ngrok

```bash
ngrok http 3000
# Set SVIX_SKIP_VERIFICATION=true in .env
# Point GitHub App webhook to: https://<ngrok-url>/webhooks/github
```
```

**Step 2: Run all tests one final time**

```bash
cd server && npm test
```
Expected: All PASS

**Step 3: Commit**

```bash
git add server/README.md
git commit -m "docs(server): add README"
```

---

## Done — What's Next

After implementation:
1. Create a Trigger.dev project, get `TRIGGER_SECRET_KEY` + `TRIGGER_PROJECT_REF`
2. Get E2B API key and note which sandbox template has `claude` CLI installed (or build a custom template)
3. Set all env vars in Railway
4. Run `npm run trigger:deploy` to deploy the task to Trigger.dev
5. Deploy server to Railway
6. Configure GitHub App webhook URL to point to Svix, which forwards to `https://<railway-url>/webhooks/github`
7. Open a test PR and watch the review appear

**Note on E2B template:** The sandbox template must have the `claude` CLI pre-installed and authenticated. Either use an existing opslane-v2 template that has it, or build a new one. The `ANTHROPIC_API_KEY` is passed as an env var at runtime.
