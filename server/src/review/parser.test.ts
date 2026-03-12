import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "./parser.js";
import type { DiffFile } from "./diff-parser.js";

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
