import { validateOwnerRepo, validatePrNumber } from "./validation.js";

const GITHUB_API = "https://api.github.com";
export const MAX_DIFF_CHARS = 50_000;

export function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  const truncated = diff.slice(0, MAX_DIFF_CHARS);
  return truncated + "\n\n[diff truncated] — too large for automated review";
}

export interface PullRequestMeta {
  title: string;
  body: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  /** Unauthenticated clone URL — add token at point of use: https://x-access-token:<token>@github.com/... */
  cloneUrl: string;
  diff: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
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
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);

  const headers = githubHeaders(token);
  const prUrl = `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`;

  // Fetch PR metadata
  const prRes = await fetch(prUrl, { headers });
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

  // Fetch unified diff (same URL, different Accept header)
  const diffRes = await fetch(prUrl, {
    headers: {
      ...headers,
      Accept: "application/vnd.github.v3.diff",
    },
  });
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
    // Token NOT embedded — consumer constructs authenticated URL at point of use
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
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
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
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
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers: githubHeaders(token) }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to list PR comments: ${res.status}`);
  }
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
  validateOwnerRepo(owner, repo);

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "PATCH",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to update PR comment: ${res.status} ${await res.text()}`);
  }
}
