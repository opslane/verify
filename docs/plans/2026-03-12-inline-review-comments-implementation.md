# Inline Review Comments — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the code reviewer to post line-by-line inline comments on PRs using GitHub's Pull Request Reviews API, with a top-level summary and validated line references.

**Architecture:** The diff parser extracts commentable line ranges from the unified diff. The prompt builder includes a line map so Claude outputs structured JSON with file/line references. The output parser validates Claude's JSON against the diff metadata and moves invalid comments to the summary. The runner posts a GitHub Pull Request Review with inline comments instead of a single issue comment.

**Tech Stack:** TypeScript, vitest (tests). All new code lives under the existing `server/` package — no new dependencies.

**Design doc:** `docs/plans/2026-03-12-inline-review-comments-design.md`

**Depends on:** `docs/plans/2026-03-12-code-reviewer-implementation.md` (base code reviewer must be implemented first). This plan assumes all base code reviewer files exist: `server/src/review/prompt.ts`, `server/src/review/runner.ts`, `server/src/github/pr.ts`, etc.

---

## Before You Start

Read these files from the base implementation — you will modify them:
- `server/src/review/prompt.ts` — current free-form markdown prompt
- `server/src/review/runner.ts` — current runner that posts issue comments
- `server/src/github/pr.ts` — current PR functions (fetch, postPrComment, findBotComment, updatePrComment)

Read the design doc for full context on decisions:
- `docs/plans/2026-03-12-inline-review-comments-design.md`

---

## Task 1: Diff parser

**Files:**
- Create: `server/src/review/diff-parser.ts`
- Create: `server/src/review/diff-parser.test.ts`

**Step 1: Write the failing tests**

Create `server/src/review/diff-parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseDiff, buildLineMap } from "./diff-parser.js";
import type { DiffFile } from "./diff-parser.js";

describe("parseDiff", () => {
  it("parses a simple single-file diff", () => {
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,4 +10,6 @@ function login() {
   existing line
+  added line 1
+  added line 2
   another existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/auth.ts");
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 10,
      oldCount: 4,
      newStart: 10,
      newCount: 6,
    });
  });

  it("parses multiple files", () => {
    const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
+new line
 existing
diff --git a/bar.ts b/bar.ts
--- a/bar.ts
+++ b/bar.ts
@@ -5,2 +5,3 @@
+another new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("foo.ts");
    expect(files[1].path).toBe("bar.ts");
  });

  it("parses multiple hunks in one file", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+first addition
 existing
@@ -20,3 +21,4 @@
+second addition
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0].newStart).toBe(1);
    expect(files[0].hunks[1].newStart).toBe(21);
  });

  it("handles renamed files using +++ line", () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,4 @@
+new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new-name.ts");
  });

  it("skips binary files", () => {
    const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });

  it("skips deleted files (+++ /dev/null)", () => {
    const diff = `diff --git a/deleted.ts b/deleted.ts
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line 1
-line 2
-line 3
diff --git a/kept.ts b/kept.ts
--- a/kept.ts
+++ b/kept.ts
@@ -1,3 +1,4 @@
+new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("kept.ts");
  });

  it("handles new files (--- /dev/null)", () => {
    const diff = `diff --git a/new-file.ts b/new-file.ts
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,5 @@
+line 1
+line 2
+line 3
+line 4
+line 5
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new-file.ts");
    expect(files[0].hunks[0]).toEqual({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 5,
    });
  });

  it("ignores 'No newline at end of file' marker", () => {
    // The parser reads hunk headers, not individual lines, so this marker
    // has no effect — but this test documents that property explicitly.
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+new line
 existing
-old line
\\ No newline at end of file
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
    });
  });

  it("returns empty array for empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("discards incomplete final hunk gracefully", () => {
    // Simulates a diff truncated mid-hunk (50KB cap)
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+complete hunk
 existing
@@ -50,3 +51,4 @@
+this hunk is trun`;
    // Should not throw — just parse what it can
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    // At least the first hunk should be present
    expect(files[0].hunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildLineMap", () => {
  it("builds a line map string from parsed diff files", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        hunks: [
          { oldStart: 10, oldCount: 4, newStart: 10, newCount: 6 },
          { oldStart: 30, oldCount: 3, newStart: 32, newCount: 5 },
        ],
      },
      {
        path: "src/token.ts",
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 24 }],
      },
    ];
    const lineMap = buildLineMap(files);
    expect(lineMap).toContain("src/auth.ts: 10-15, 32-36");
    expect(lineMap).toContain("src/token.ts: 1-24");
  });

  it("returns empty string for empty file list", () => {
    expect(buildLineMap([])).toBe("");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd server && npm test -- diff-parser.test
```
Expected: FAIL — module not found

**Step 3: Create `server/src/review/diff-parser.ts`**

```typescript
export interface DiffFile {
  path: string;
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }>;
}

const DIFF_HEADER_RE = /^diff --git /;
const PLUS_FILE_RE = /^\+\+\+ b\/(.+)$/;
const DEV_NULL_RE = /^\+\+\+ \/dev\/null$/;
const HUNK_RE = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/;
const BINARY_RE = /^Binary files /;

/**
 * Parse a unified diff string into structured file/hunk metadata.
 * Handles renamed files, binary files, deletions, new files, and
 * truncated diffs gracefully.
 */
export function parseDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];

  const files: DiffFile[] = [];
  const lines = diff.split("\n");

  let currentFile: DiffFile | null = null;
  let isDeleted = false;
  let isBinary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file section starts
    if (DIFF_HEADER_RE.test(line)) {
      // Save previous file if valid
      if (currentFile && currentFile.hunks.length > 0) {
        files.push(currentFile);
      }
      currentFile = null;
      isDeleted = false;
      isBinary = false;
      continue;
    }

    // Binary file — skip entire section
    if (BINARY_RE.test(line)) {
      isBinary = true;
      currentFile = null;
      continue;
    }
    if (isBinary) continue;

    // Deleted file — skip (no RIGHT-side lines to comment on)
    if (DEV_NULL_RE.test(line)) {
      isDeleted = true;
      currentFile = null;
      continue;
    }
    if (isDeleted) continue;

    // Extract file path from +++ line (handles renames correctly)
    const plusMatch = line.match(PLUS_FILE_RE);
    if (plusMatch) {
      currentFile = { path: plusMatch[1], hunks: [] };
      continue;
    }

    // Parse hunk header
    if (currentFile) {
      const hunkMatch = line.match(HUNK_RE);
      if (hunkMatch) {
        currentFile.hunks.push({
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: hunkMatch[2] !== "" ? parseInt(hunkMatch[2], 10) : 1,
          newStart: parseInt(hunkMatch[3], 10),
          newCount: hunkMatch[4] !== "" ? parseInt(hunkMatch[4], 10) : 1,
        });
      }
    }
  }

  // Don't forget the last file
  if (currentFile && currentFile.hunks.length > 0) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Build a human-readable line map string from parsed diff files.
 * Used in the Claude prompt so it knows which lines are commentable.
 *
 * Output format:
 *   Commentable lines:
 *   - src/auth.ts: 10-15, 32-36
 *   - src/token.ts: 1-24
 */
export function buildLineMap(files: DiffFile[]): string {
  if (files.length === 0) return "";

  const lines = files.map((file) => {
    const ranges = file.hunks.map((hunk) => {
      const end = hunk.newStart + hunk.newCount - 1;
      if (hunk.newStart === end) return `${hunk.newStart}`;
      return `${hunk.newStart}-${end}`;
    });
    return `- ${file.path}: ${ranges.join(", ")}`;
  });

  return `Commentable lines:\n${lines.join("\n")}`;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npm test -- diff-parser.test
```
Expected: PASS (11 tests)

**Step 5: Commit**

```bash
git add server/src/review/diff-parser.ts server/src/review/diff-parser.test.ts
git commit -m "feat(server): add unified diff parser with line map builder"
```

---

## Task 2: Output parser

**Files:**
- Create: `server/src/review/parser.ts`
- Create: `server/src/review/parser.test.ts`

**Step 1: Write the failing tests**

Create `server/src/review/parser.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "./parser.js";
import type { DiffFile } from "./diff-parser.js";
import type { ParsedReview } from "./parser.js";

const DIFF_FILES: DiffFile[] = [
  {
    path: "src/auth.ts",
    hunks: [{ oldStart: 10, oldCount: 4, newStart: 10, newCount: 6 }],
  },
  {
    path: "src/token.ts",
    hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 24 }],
  },
];

describe("parseReviewOutput", () => {
  it("parses valid JSON output", () => {
    const input = JSON.stringify({
      summary: "Looks good overall.",
      comments: [
        {
          path: "src/auth.ts",
          line: 12,
          side: "RIGHT",
          body: "**Blocker:** Missing null check.",
        },
      ],
    });

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.summary).toBe("Looks good overall.");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].path).toBe("src/auth.ts");
    expect(result.comments[0].line).toBe(12);
    expect(result.fallback).toBe(false);
  });

  it("parses JSON wrapped in markdown fences", () => {
    const input = `Here is my review:

\`\`\`json
{
  "summary": "Summary text.",
  "comments": []
}
\`\`\`

Hope that helps!`;

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.summary).toBe("Summary text.");
    expect(result.comments).toHaveLength(0);
    expect(result.fallback).toBe(false);
  });

  it("extracts JSON via regex when fence stripping fails", () => {
    const input = `Some preamble text that is not JSON.
{"summary": "Found issues.", "comments": [{"path": "src/auth.ts", "line": 14, "side": "RIGHT", "body": "Fix this."}]}
Some trailing text.`;

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.summary).toBe("Found issues.");
    expect(result.comments).toHaveLength(1);
    expect(result.fallback).toBe(false);
  });

  it("orphans comments with invalid path to summary", () => {
    const input = JSON.stringify({
      summary: "Review done.",
      comments: [
        { path: "src/auth.ts", line: 12, side: "RIGHT", body: "Valid comment." },
        { path: "src/nonexistent.ts", line: 5, side: "RIGHT", body: "Orphaned comment." },
      ],
    });

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].path).toBe("src/auth.ts");
    expect(result.summary).toContain("Orphaned comment.");
    expect(result.summary).toContain("src/nonexistent.ts:5");
  });

  it("orphans comments with line outside hunk range", () => {
    const input = JSON.stringify({
      summary: "Review done.",
      comments: [
        { path: "src/auth.ts", line: 12, side: "RIGHT", body: "Valid — line 12 is in range 10-15." },
        { path: "src/auth.ts", line: 99, side: "RIGHT", body: "Invalid — line 99 is outside range." },
      ],
    });

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].line).toBe(12);
    expect(result.summary).toContain("Invalid — line 99 is outside range.");
  });

  it("returns fallback for completely unparseable output", () => {
    const input = "This is just plain text, not JSON at all.";

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.fallback).toBe(true);
    expect(result.rawText).toBe(input);
    expect(result.comments).toHaveLength(0);
  });

  it("returns fallback for JSON with wrong shape", () => {
    const input = JSON.stringify({ foo: "bar" });

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.fallback).toBe(true);
  });

  it("defaults side to RIGHT when missing", () => {
    const input = JSON.stringify({
      summary: "Review.",
      comments: [
        { path: "src/auth.ts", line: 12, body: "Missing side field." },
      ],
    });

    const result = parseReviewOutput(input, DIFF_FILES);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].side).toBe("RIGHT");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd server && npm test -- parser.test
```
Expected: FAIL — module not found

**Step 3: Create `server/src/review/parser.ts`**

```typescript
import type { DiffFile } from "./diff-parser.js";

export interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export interface ParsedReview {
  summary: string;
  comments: ReviewComment[];
  fallback: boolean;
  rawText?: string;
}

interface RawReviewOutput {
  summary?: string;
  comments?: Array<{
    path?: string;
    line?: number;
    side?: string;
    body?: string;
  }>;
}

/**
 * Try to extract a JSON object from Claude's output.
 * Handles: bare JSON, markdown-fenced JSON, JSON embedded in prose.
 */
function extractJson(raw: string): RawReviewOutput | null {
  // Attempt 1: parse the entire string as JSON
  try {
    return JSON.parse(raw) as RawReviewOutput;
  } catch {
    // not bare JSON
  }

  // Attempt 2: strip markdown fences
  const fenceMatch = raw.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as RawReviewOutput;
    } catch {
      // fence content is not valid JSON
    }
  }

  // Attempt 3: extract first JSON object via lazy regex
  // Lazy quantifier to avoid matching from first { to last } across unrelated blocks
  const objectMatch = raw.match(/\{[\s\S]*?\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as RawReviewOutput;
    } catch {
      // matched braces but not valid JSON
    }
  }

  return null;
}

/**
 * Check if a line falls within any hunk range of a file in the diff.
 */
function isLineInDiff(path: string, line: number, side: string, diffFiles: DiffFile[]): boolean {
  const file = diffFiles.find((f) => f.path === path);
  if (!file) return false;

  for (const hunk of file.hunks) {
    if (side === "LEFT") {
      if (line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
        return true;
      }
    } else {
      if (line >= hunk.newStart && line < hunk.newStart + hunk.newCount) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parse Claude's review output into validated comments.
 * Invalid comments (wrong path, line out of range) are moved to the summary.
 * Returns fallback=true with rawText if JSON parsing fails entirely.
 */
export function parseReviewOutput(raw: string, diffFiles: DiffFile[]): ParsedReview {
  const parsed = extractJson(raw);

  // Fallback: not JSON or wrong shape
  if (!parsed || typeof parsed.summary !== "string" || !Array.isArray(parsed.comments)) {
    return {
      summary: "",
      comments: [],
      fallback: true,
      rawText: raw,
    };
  }

  const validComments: ReviewComment[] = [];
  const orphans: string[] = [];

  for (const c of parsed.comments) {
    if (!c.path || !c.line || !c.body) continue;

    const side = c.side === "LEFT" ? "LEFT" as const : "RIGHT" as const;

    if (isLineInDiff(c.path, c.line, side, diffFiles)) {
      validComments.push({
        path: c.path,
        line: c.line,
        side,
        body: c.body,
      });
    } else {
      orphans.push(`- \`${c.path}:${c.line}\`: ${c.body}`);
    }
  }

  let summary = parsed.summary;
  if (orphans.length > 0) {
    summary += "\n\n**Additional findings** (could not be placed inline):\n" + orphans.join("\n");
  }

  return {
    summary,
    comments: validComments,
    fallback: false,
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npm test -- parser.test
```
Expected: PASS (8 tests)

**Step 5: Commit**

```bash
git add server/src/review/parser.ts server/src/review/parser.test.ts
git commit -m "feat(server): add review output parser with orphan handling"
```

---

## Task 3: GitHub PR review function

**Files:**
- Modify: `server/src/github/pr.ts`
- Modify: `server/src/github/pr.test.ts`

**Step 1: Add `createPrReview` to `server/src/github/pr.ts`**

Add the following at the end of the existing `server/src/github/pr.ts`:

```typescript
import type { ReviewComment } from "../review/parser.js";

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
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commit_id: commitSha,
        body: summary,
        event: "COMMENT" as const,
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
```

No separate `buildReviewPayload` function — the payload construction is inlined
since it's a trivial 4-property object literal with a single caller.

**Step 2: Verify TypeScript compiles**

```bash
cd server && npm run typecheck
```
Expected: No errors

**Step 3: Run existing tests still pass**

```bash
cd server && npm test -- pr.test
```
Expected: PASS (existing tests unchanged)

**Step 4: Commit**

```bash
git add server/src/github/pr.ts
git commit -m "feat(server): add createPrReview for inline comments"
```

---

## Task 4: Structured review prompt

**Files:**
- Modify: `server/src/review/prompt.ts`
- Modify: `server/src/review/prompt.test.ts`

**Step 1: Write the failing tests**

Replace the existing tests in `server/src/review/prompt.test.ts` (the prompt output format has changed entirely):

```typescript
import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "./prompt.js";

describe("buildReviewPrompt", () => {
  const baseInput = {
    title: "Fix null pointer in auth",
    body: "Fixes #123",
    baseBranch: "main",
    headBranch: "fix/null-ptr",
    headSha: "abc1234",
    diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-null\n+undefined",
    lineMap: "Commentable lines:\n- src/auth.ts: 1-1",
  };

  it("includes PR title", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain("Fix null pointer in auth");
  });

  it("includes the diff", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain("--- a/src/auth.ts");
  });

  it("includes the line map", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain("Commentable lines:");
    expect(prompt).toContain("src/auth.ts: 1-1");
  });

  it("includes all review dimensions", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain("Correctness");
    expect(prompt).toContain("Security");
    expect(prompt).toContain("Simplicity");
  });

  it("requests JSON output format", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"comments"');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain('"line"');
    expect(prompt).toContain('"side"');
    expect(prompt).toContain('"body"');
  });

  it("instructs to embed severity in body", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain("**Blocker:**");
    expect(prompt).toContain("**Should fix:**");
    expect(prompt).toContain("**Consider:**");
  });

  it("handles null body", () => {
    const prompt = buildReviewPrompt({ ...baseInput, body: null });
    // Should not render the literal string "null" as the description
    expect(prompt).not.toContain("**Description:** null");
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd server && npm test -- prompt.test
```
Expected: FAIL — `lineMap` is not part of the current `PromptInput` type, and the prompt doesn't include JSON format instructions

**Step 3: Rewrite `server/src/review/prompt.ts`**

Replace the entire file:

```typescript
interface PromptInput {
  title: string;
  body: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diff: string;
  lineMap: string;
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

## ${pr.lineMap}

## Instructions

Review this PR across these dimensions:
- **Correctness** — logic bugs, missing error handling, broken edge cases
- **Security** — injection, leaked secrets, missing auth/validation
- **Architecture** — does it fit the existing codebase patterns?
- **Simplicity** — over-engineering, unnecessary abstractions, dead code
- **Testing** — missing tests for new behavior or edge cases
- **Maintainability** — readability, naming, comments where needed

## Output format

You MUST respond with a single JSON object. No markdown fences, no preamble, no text outside the JSON.

The JSON object must have this exact shape:

{
  "summary": "One paragraph summarizing the PR and what needs to change before merging.",
  "comments": [
    {
      "path": "relative/file/path.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**Blocker:** Description of the issue and how to fix it."
    }
  ]
}

### Field rules

- **path** — file path relative to repo root. MUST be a file listed in the Commentable lines section above.
- **line** — file line number (not diff position). MUST fall within a commentable range listed above.
- **side** — "RIGHT" for new/added lines (use this almost always). "LEFT" only for commenting on deleted lines.
- **body** — start each comment with a severity tag:
  - "**Blocker:**" — will cause production failures if merged
  - "**Should fix:**" — important gaps, convention violations, missing error handling
  - "**Consider:**" — optional improvements, style, minor simplifications

### Important

- Only reference files and lines listed in the Commentable lines section.
- If you have a finding that doesn't map to a specific line, put it in the summary instead.
- If there are no findings, return an empty comments array and say so in the summary.
- Do not repeat the diff back to me.
- Be concise.`;
}
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npm test -- prompt.test
```
Expected: PASS (7 tests)

**Step 5: Commit**

```bash
git add server/src/review/prompt.ts server/src/review/prompt.test.ts
git commit -m "feat(server): rewrite prompt for structured JSON output with line map"
```

---

## Task 5: Wire up runner

**Files:**
- Modify: `server/src/review/runner.ts`

This task modifies the existing Trigger.dev runner to use the diff parser, structured prompt, output parser, and PR review API.

**Step 1: Read the current `server/src/review/runner.ts`**

Familiarize yourself with the existing runner from the base implementation. The full code is in `docs/plans/2026-03-12-code-reviewer-implementation.md`, Task 7.

**Step 2: Modify `server/src/review/runner.ts`**

Replace the import section and the body of the `run` function. Keep the task definition structure, sandbox lifecycle, and `claude -p` invocation identical. Changes are:

1. Add imports for new modules
2. Add diff parsing + line map building between PR fetch and prompt construction
3. Pass `lineMap` to the prompt builder
4. Replace the text-extraction logic with the output parser
5. Replace `postPrComment` / `findBotComment` / `updatePrComment` with `createPrReview`

Here is the full updated file:

```typescript
import { task, logger } from "@trigger.dev/sdk/v3";
import { GitHubAppService } from "../github/app-service.js";
import { fetchPullRequest, createPrReview } from "../github/pr.js";
import { E2BSandboxProvider } from "../sandbox/e2b-provider.js";
import { buildReviewPrompt } from "./prompt.js";
import { parseDiff, buildLineMap } from "./diff-parser.js";
import { parseReviewOutput } from "./parser.js";

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

    // 4. Parse diff to extract commentable line ranges
    const diffFiles = parseDiff(pr.diff);
    const lineMap = buildLineMap(diffFiles);
    logger.info("Parsed diff", {
      fileCount: diffFiles.length,
      totalHunks: diffFiles.reduce((n, f) => n + f.hunks.length, 0),
    });

    // 5. Build structured prompt with line map
    const prompt = buildReviewPrompt({
      title: pr.title,
      body: pr.body,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      diff: pr.diff,
      lineMap,
    });

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

    let rawOutput = "";

    try {
      // 7. Clone repo inside sandbox
      const cloneCmd = `git clone --depth=1 --branch ${pr.headBranch} ${pr.cloneUrl} /workspace/repo`;
      logger.info("Cloning repo", { branch: pr.headBranch });
      for await (const _ of provider.runCommand(sandbox.id, cloneCmd, { cwd: "/", timeoutMs: 60_000 })) {
        // drain output
      }

      // 8. Write prompt to file in sandbox (avoids shell ARG_MAX limits)
      await provider.uploadFiles(sandbox.id, [
        { path: "/tmp/review-prompt.txt", content: prompt },
      ]);

      // 9. Run claude -p
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
      for (const line of outputLines) {
        try {
          const parsed = JSON.parse(line) as { type?: string; result?: string };
          if (parsed.type === "result" && parsed.result) {
            rawOutput = parsed.result;
          }
        } catch {
          // skip non-JSON lines
        }
      }

      logger.info("Review complete", { length: rawOutput.length });
    } finally {
      await provider.destroy(sandbox.id).catch((err) => {
        logger.error("Sandbox teardown failed", { error: String(err) });
      });
    }

    if (!rawOutput) {
      logger.warn("Empty review output — skipping comment");
      return { skipped: true };
    }

    // 10. Parse + validate Claude's output
    const review = parseReviewOutput(rawOutput, diffFiles);

    let reviewUrl: string;

    if (review.fallback) {
      // Fallback: post review with raw text as body, no inline comments
      logger.warn("Structured parsing failed — falling back to summary-only review");
      reviewUrl = await createPrReview(
        owner, repo, prNumber, pr.headSha,
        review.rawText ?? rawOutput,
        [],
        token
      );
    } else {
      // Normal: post review with inline comments
      logger.info("Posting review", {
        inlineComments: review.comments.length,
      });
      reviewUrl = await createPrReview(
        owner, repo, prNumber, pr.headSha,
        review.summary,
        review.comments,
        token
      );
    }

    logger.info("Review posted", { reviewUrl });
    return { reviewUrl };
  },
});
```

**Step 3: Verify TypeScript compiles**

```bash
cd server && npm run typecheck
```
Expected: No errors

**Step 4: Run full test suite**

```bash
cd server && npm test
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add server/src/review/runner.ts
git commit -m "feat(server): wire runner to use diff parser, output parser, and PR review API"
```

---

## Task 6: Integration smoke test

**Files:**
- Create: `server/src/review/integration.test.ts`

This test wires the diff parser → prompt → output parser pipeline together end-to-end with a realistic diff, without hitting any external APIs.

**Step 1: Write the test**

Create `server/src/review/integration.test.ts`:

These tests focus on **cross-module seams** — verifying that the diff parser,
prompt builder, and output parser agree on line ranges and data flow. Unit-level
assertions (individual module behavior) are already covered in Tasks 1-2.

```typescript
import { describe, it, expect } from "vitest";
import { parseDiff, buildLineMap } from "./diff-parser.js";
import { buildReviewPrompt } from "./prompt.js";
import { parseReviewOutput } from "./parser.js";

describe("review pipeline integration", () => {
  const REALISTIC_DIFF = `diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts
--- a/src/auth/middleware.ts
+++ b/src/auth/middleware.ts
@@ -10,6 +10,12 @@ export function authMiddleware(req: Request) {
   const token = req.headers.get("Authorization");
+  if (!token) {
+    return new Response("Unauthorized", { status: 401 });
+  }
+  const userId = parseToken(token);
+  const user = db.query(\`SELECT * FROM users WHERE id = \${userId}\`);
+  req.user = user;
   return next(req);
 }
diff --git a/src/auth/token.ts b/src/auth/token.ts
--- /dev/null
+++ b/src/auth/token.ts
@@ -0,0 +1,8 @@
+export function parseToken(raw: string): string {
+  const parts = raw.split(" ");
+  return parts[1];
+}
+
+export function validateToken(token: string): boolean {
+  return token.length > 0;
+}
`;

  it("line map from diff parser is included in prompt", () => {
    // Tests the seam: parseDiff → buildLineMap → buildReviewPrompt
    const files = parseDiff(REALISTIC_DIFF);
    const lineMap = buildLineMap(files);

    const prompt = buildReviewPrompt({
      title: "Add auth middleware",
      body: null,
      baseBranch: "main",
      headBranch: "feat/auth",
      headSha: "abc123",
      diff: REALISTIC_DIFF,
      lineMap,
    });
    expect(prompt).toContain("Commentable lines:");
    expect(prompt).toContain("src/auth/middleware.ts");
    expect(prompt).toContain("src/auth/token.ts");
  });

  it("output parser validates comments against diff parser line ranges", () => {
    // Tests the seam: parseDiff hunk ranges agree with parseReviewOutput validation
    // Catches off-by-one bugs between buildLineMap display and isLineInDiff check
    const files = parseDiff(REALISTIC_DIFF);
    const claudeOutput = JSON.stringify({
      summary: "SQL injection in middleware, missing token validation.",
      comments: [
        {
          path: "src/auth/middleware.ts",
          line: 15,
          side: "RIGHT",
          body: "**Blocker:** SQL injection — use parameterized query.",
        },
        {
          path: "src/auth/token.ts",
          line: 6,
          side: "RIGHT",
          body: "**Should fix:** validateToken always returns true for any non-empty string.",
        },
        {
          path: "src/auth/middleware.ts",
          line: 999,
          side: "RIGHT",
          body: "**Consider:** This line doesn't exist in the diff.",
        },
      ],
    });

    const review = parseReviewOutput(claudeOutput, files);
    expect(review.fallback).toBe(false);
    // 2 valid comments (lines 15 and 6 are within hunk ranges)
    expect(review.comments).toHaveLength(2);
    // 1 orphan (line 999 is outside all ranges)
    expect(review.summary).toContain("Additional findings");
    expect(review.summary).toContain("This line doesn't exist");
  });
});
```

**Step 2: Run the test**

```bash
cd server && npm test -- integration.test
```
Expected: PASS (2 tests)

**Step 3: Run the full test suite**

```bash
cd server && npm test
```
Expected: All tests PASS

**Step 4: Run typecheck**

```bash
cd server && npm run typecheck
```
Expected: No errors

**Step 5: Commit**

```bash
git add server/src/review/integration.test.ts
git commit -m "test(server): add integration smoke test for review pipeline"
```

---

## Done — What's Next

After implementation:
1. Validate that `line`/`side` parameters work with GitHub's Create Review endpoint by posting a test review to a scratch repo. If they fail, switch to computing `position` from diff hunk offsets (requires extending the diff parser).
2. Test with a real PR that includes renamed files, binary files, and new files to verify diff parser edge cases.
3. Monitor for orphan rate — if many comments are orphaned, improve the line map format or add examples to the prompt.
4. If review accumulation on active PRs becomes noisy, add review dismissal via `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals`.
