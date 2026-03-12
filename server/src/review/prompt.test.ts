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
