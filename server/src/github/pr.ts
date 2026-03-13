import { validateOwnerRepo, validatePrNumber } from "./validation.js";
import type { ReviewComment } from "../review/parser.js";

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

/**
 * Fetch the list of files changed by a pull request.
 */
export async function fetchPrChangedFiles(
  owner: string, repo: string, prNumber: number, token: string
): Promise<Array<{ filename: string; status: string }>> {
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const files = await res.json() as Array<{ filename: string; status: string }>;
  return files.map((f) => ({ filename: f.filename, status: f.status }));
}

/**
 * Post a new issue comment or update an existing one matching the marker.
 * Returns the comment URL.
 */
export async function postOrUpdateComment(
  owner: string, repo: string, prNumber: number,
  body: string, marker: string, token: string,
): Promise<string> {
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);
  const headers = githubHeaders(token);

  // Check for existing comment with marker
  const listRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers },
  );
  if (!listRes.ok) throw new Error(`GitHub API error: ${listRes.status}`);
  const comments = await listRes.json() as Array<{ id: number; body: string }>;
  const existing = comments.find((c) => c.body.includes(marker));

  if (existing) {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) },
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const data = await res.json() as { html_url: string };
    return data.html_url;
  }

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const data = await res.json() as { html_url: string };
  return data.html_url;
}

/** Post a pull request review with inline comments. Returns the review URL. */
export async function createPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  summary: string,
  comments: ReviewComment[],
  token: string
): Promise<string> {
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commit_id: commitSha,
        body: summary,
        event: "COMMENT",
        comments,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to create PR review: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { html_url: string };
  return data.html_url;
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
}

/** Fetch all comments on a PR (issue comments API). Filters out ghost/deleted users. Returns empty array on 404. */
export async function fetchPrComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<PrComment[]> {
  validateOwnerRepo(owner, repo);
  validatePrNumber(prNumber);

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers: githubHeaders(token) }
  );

  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`Failed to fetch PR comments: ${res.status}`);
  }

  const comments = await res.json() as Array<{
    user: { login: string } | null;
    body: string;
    created_at: string;
  }>;

  return comments
    .filter((c) => c.user !== null)
    .map((c) => ({
      author: c.user!.login,
      body: c.body,
      createdAt: c.created_at,
    }));
}

/** Post a comment to a PR via the issues API. Returns the comment URL. */
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
    const errBody = await res.text();
    console.error(`[postPrComment] GitHub API error: ${res.status}`, errBody);
    throw new Error(`Failed to post PR comment: ${res.status}`);
  }
  const data = await res.json() as { html_url: string };
  return data.html_url;
}
