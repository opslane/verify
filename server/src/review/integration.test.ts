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
