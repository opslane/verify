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

  // Attempt 3: find first { ... } that parses as valid JSON
  // Use greedy match to capture nested objects (like comments array)
  const objectMatch = raw.match(/\{[\s\S]*\}/);
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
    if (!c.path || typeof c.line !== "number" || !c.body) continue;

    const side: "LEFT" | "RIGHT" = c.side === "LEFT" ? "LEFT" : "RIGHT";

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
