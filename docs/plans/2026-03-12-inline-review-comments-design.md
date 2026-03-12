# Inline Review Comments — Design

**Date:** 2026-03-12
**Status:** Design finalized, ready for implementation
**Depends on:** `docs/plans/2026-03-12-code-reviewer-design.md` (base code reviewer)

## Overview

Extend the code reviewer to post line-by-line inline comments on PRs using
GitHub's Pull Request Reviews API, instead of a single issue comment. Each
finding maps to a specific file and line in the diff. A top-level summary
accompanies the inline comments.

## Current state

The base code reviewer (parallel implementation) posts a single issue comment
via `POST /repos/{owner}/{repo}/issues/{prNumber}/comments`. Claude outputs
free-form markdown. All findings land in one blob — not anchored to code.

## Target state

The reviewer posts a **GitHub Pull Request Review** via:

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

Each review contains:
- **`body`** — top-level summary of the PR and what needs to change
- **`event`** — always `COMMENT` (never `APPROVE` or `REQUEST_CHANGES`)
- **`commit_id`** — the head SHA, anchoring comments to the exact commit
- **`comments[]`** — inline annotations, each with `path`, `line`, `side`, `body`

## Request flow (changes from base design)

The webhook + Trigger.dev dispatch is unchanged. Only the review runner changes:

```
Trigger.dev task starts
  → fetch PR metadata + diff (unchanged)
    → parse diff to extract commentable line ranges (NEW)
      → build structured prompt with line map (CHANGED)
        → run claude -p in E2B sandbox (unchanged)
          → parse structured JSON output (NEW)
            → validate comments against diff line ranges (NEW)
              → POST pull request review with inline comments (CHANGED)
```

## Structured prompt

The prompt changes from "output markdown" to "output JSON". Claude receives:

1. PR metadata (title, description, branches)
2. The unified diff
3. A line map showing which files and line ranges are commentable
4. Instructions to output structured JSON

### Prompt output format

```json
{
  "summary": "This PR adds auth middleware but has a SQL injection vulnerability in the query builder and missing error handling on the token refresh path.",
  "comments": [
    {
      "path": "src/auth/middleware.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**Blocker:** SQL injection — `userId` is interpolated directly into the query string. Use a parameterized query instead."
    },
    {
      "path": "src/auth/middleware.ts",
      "line": 78,
      "side": "RIGHT",
      "body": "**Should fix:** If `refreshToken()` throws, this catch block swallows the error silently. At minimum, log it."
    }
  ]
}
```

Field definitions:
- **`path`** — file path relative to repo root (must exist in the diff)
- **`line`** — file line number (not diff position). GitHub's newer API accepts this directly with the `line` + `side` parameters. The older API uses a `position` parameter (line offset within the diff hunk). Implementation should validate that `line`/`side` works with the Create Review endpoint; if not, fall back to computing `position` from the diff hunk offsets (which changes the diff parser requirements).
- **`side`** — `RIGHT` for new/added lines (most common), `LEFT` for deleted lines
- **`body`** — the comment text. Should be concise and actionable. Claude embeds severity directly in the body (e.g., "**Blocker:**", "**Should fix:**", "**Consider:**") rather than as a separate structured field — this keeps the JSON schema simple and matches how Claude naturally writes.

### Line map

The prompt includes a machine-readable list of commentable ranges so Claude knows
exactly which lines it can reference:

```
Commentable lines:
- src/auth/middleware.ts: 38-52, 70-85
- src/auth/token.ts: 1-24
```

This is extracted from the unified diff hunks and prevents Claude from
referencing lines outside the diff (which GitHub's API would reject with a
422 Unprocessable Entity).

## Diff parser

New module that extracts commentable line metadata from a unified diff.

Input: raw unified diff string. **Important:** the base design truncates diffs at
50KB. The diff parser must run *before* truncation, or truncation must happen at
hunk boundaries (not mid-hunk). If the parser receives a truncated diff with an
incomplete final hunk, it must discard that hunk gracefully rather than crash.

Output:
```typescript
interface DiffFile {
  path: string;
  hunks: Array<{
    newStart: number;
    newCount: number;
    oldStart: number;
    oldCount: number;
  }>;
}
```

Used for:
1. Building the line map section of the prompt
2. Validating Claude's output — rejecting comments that reference invalid lines

Standard unified diff parsing — no external library needed. The format is:

```
diff --git a/path b/path
--- a/path
+++ b/path
@@ -oldStart,oldCount +newStart,newCount @@
```

### Edge cases the parser must handle

- **Renamed files** — diffs show `rename from`/`rename to` headers. Use the
  `+++ b/path` line (not the `diff --git` line) to determine the file path for
  RIGHT-side comments.
- **Binary files** — `Binary files differ` with no hunk headers. Skip gracefully;
  these files cannot receive inline comments.
- **File deletions** — `+++ /dev/null` produces no new-side lines. Exclude from
  the line map (no RIGHT-side lines to comment on).
- **New files** — `--- /dev/null` where `oldStart=0`. All lines are RIGHT-side.
  Straightforward but confirm the parser handles the zero-start case.
- **`\ No newline at end of file`** — this marker is not a real line and must not
  increment the line counter.

## Output parser

New module that parses Claude's JSON output into validated review comments.

Responsibilities:
1. Parse JSON from Claude's output (handle markdown wrapping like ` ```json `,
   varying fence styles, and preamble text before the JSON block — extract the
   first valid JSON object via regex fallback if fence-stripping fails)
2. Validate each comment's `path` exists in the diff
3. Validate each comment's `line` falls within a commentable range for that file
4. **Orphan handling** — comments that fail validation get appended to the summary body as bullet points rather than dropped silently

## GitHub PR review function

New function in `github/pr.ts`:

```typescript
interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

async function createPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  summary: string,
  comments: ReviewComment[],
  token: string
): Promise<string>
```

- Always posts with `event: "COMMENT"`
- `commit_id` is set to `commitSha` (the head SHA at fetch time)
- Returns the review URL

### On new pushes (synchronize)

No special handling. Post a new review each time. This matches the behavior of
existing review bots (CodeRabbit, Copilot, PR-Agent).

**Nuance on GitHub's "outdated" behavior:** GitHub marks inline comments as
"outdated" only when the *specific lines they reference* are modified in a
subsequent commit. If the commented lines are untouched by the new push, the
old comments persist as active. This means old review comments can accumulate
across review cycles on active PRs. This is acceptable for v1 — the comments
remain relevant if the lines haven't changed. If accumulation becomes noisy in
practice, a future version can dismiss previous reviews programmatically via
`PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals`.

### `commit_id` staleness

Between fetching PR metadata and posting the review, a new commit could be
pushed (especially on active PRs). If `commit_id` no longer matches HEAD, the
API still accepts it, but all comments will immediately appear as outdated.
This is an accepted risk — the review content would be stale anyway, and the
next `synchronize` webhook will trigger a fresh review.

The `findBotComment` / `updatePrComment` pattern from the base design is not
used for inline reviews.

## Runner changes

The Trigger.dev task (`review/runner.ts`) changes from:

```
claude output (text) → post issue comment
```

To:

```
claude output (JSON) → parse → validate against diff → post PR review
```

Specifically:
1. Parse the unified diff into `DiffFile[]`
2. Build the structured prompt (with line map)
3. Run `claude -p` in sandbox
4. Parse JSON output into `{ summary, comments[] }`
5. Validate comments against diff metadata
6. Move invalid comments to summary as bullet points
7. Call `createPrReview` with validated comments + enriched summary

## Fallback behavior

If Claude returns unparseable output (not valid JSON, wrong shape):
- Fall back to posting a **review with `event: "COMMENT"`, populated `body`, and
  empty `comments[]` array** — this keeps the output consistently in the Reviews
  section of the PR UI rather than switching to issue comments
- Log a warning for debugging

This ensures a review always gets posted even if the structured output fails.

## GitHub App permissions

No changes needed. `pull_requests: write` already covers the Reviews API.

## New and changed files

| File | Status | Purpose |
|------|--------|---------|
| `server/src/review/prompt.ts` | Modify | Structured JSON output instructions + line map |
| `server/src/review/diff-parser.ts` | New | Parse unified diff into commentable line ranges |
| `server/src/review/parser.ts` | New | Parse + validate Claude's JSON output |
| `server/src/github/pr.ts` | Modify | Add `createPrReview` function |
| `server/src/review/runner.ts` | Modify | Wire up diff parsing, output parsing, review posting |
| `server/src/review/diff-parser.test.ts` | New | Tests for diff parser |
| `server/src/review/parser.test.ts` | New | Tests for output parser |
| `server/src/github/pr.test.ts` | Modify | Tests for `createPrReview` |

## Key decisions

- **Always `COMMENT`** — the bot never approves or requests changes. Humans own that.
- **No review dismissal** — new pushes get new reviews; old comments on modified lines are marked outdated by GitHub. Comments on unmodified lines persist (acceptable — they're still relevant). Revisit if accumulation becomes noisy.
- **Orphaned comments go to summary** — never silently drop a finding. If a comment can't be placed inline, it appears in the top-level summary.
- **JSON output with review fallback** — if structured parsing fails, post a review with empty `comments[]` and the raw text as `body`. Keeps output consistently in the Reviews UI section.
- **Line map in prompt** — tells Claude exactly which lines are commentable, reducing invalid references.
- **No multi-line comments** — single-line annotations only for v1. GitHub supports `start_line` + `line` but it's fragile and adds complexity.
- **Severity in body text** — Claude embeds severity tags ("**Blocker:**", etc.) directly in the comment body rather than as a structured field. Keeps the JSON schema simple; add a structured field in v2 if programmatic filtering is needed.
- **`line`/`side` with `position` fallback** — use GitHub's newer `line`/`side` parameters; if they don't work with the Create Review endpoint, fall back to computing `position` from diff hunk offsets.
