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
    expect(prompt).not.toContain("**Description:** null");
  });
});
