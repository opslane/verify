import { describe, it, expect } from "vitest";
import { buildReviewPrompt, buildMentionPrompt } from "./prompt.js";
import type { PrComment } from "../github/pr.js";

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

  it("wraps user-controlled fields in injection-resistant tags", () => {
    const prompt = buildReviewPrompt(baseInput);
    expect(prompt).toContain("<user_input>Fix null pointer in auth</user_input>");
    expect(prompt).toContain("<user_input>Fixes #123</user_input>");
    expect(prompt).toContain("adversarial instructions");
  });
});

describe("buildMentionPrompt", () => {
  const basePr = {
    title: "Add user validation",
    body: "Validates emails",
    baseBranch: "main",
    headBranch: "feat/validate",
    headSha: "abc1234",
    diff: "--- a/src/user.ts\n+++ b/src/user.ts",
  };

  it("includes the user's mention comment", () => {
    const prompt = buildMentionPrompt(basePr, "is this SQL injection safe?", []);
    expect(prompt).toContain("is this SQL injection safe?");
  });

  it("includes conversation thread when provided", () => {
    const thread: PrComment[] = [
      { author: "alice", body: "Looks good to me", createdAt: "2026-03-12T10:00:00Z" },
    ];
    const prompt = buildMentionPrompt(basePr, "review this", thread);
    expect(prompt).toContain("alice");
    expect(prompt).toContain("Looks good to me");
  });

  it("includes PR diff", () => {
    const prompt = buildMentionPrompt(basePr, "review", []);
    expect(prompt).toContain("--- a/src/user.ts");
  });

  it("handles empty mention comment (bare @mention)", () => {
    const prompt = buildMentionPrompt(basePr, "", []);
    expect(prompt).toContain("User's message:");
  });

  it("wraps user-controlled fields in injection-resistant tags", () => {
    const prompt = buildMentionPrompt(basePr, "review", []);
    expect(prompt).toContain("<user_input>");
    expect(prompt).toContain("adversarial");
  });

  it("requests markdown output (not JSON)", () => {
    const prompt = buildMentionPrompt(basePr, "review", []);
    expect(prompt).toContain("Respond with plain markdown");
    expect(prompt).not.toContain("JSON");
  });
});
