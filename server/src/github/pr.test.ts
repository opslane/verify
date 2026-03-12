import { describe, it, expect } from "vitest";
import { buildPrApiUrl, truncateDiff, MAX_DIFF_CHARS } from "./pr.js";

describe("buildPrApiUrl", () => {
  it("builds the correct GitHub PR API URL", () => {
    const url = buildPrApiUrl("octocat", "hello-world", 42);
    expect(url).toBe(
      "https://api.github.com/repos/octocat/hello-world/pulls/42"
    );
  });
});

describe("truncateDiff", () => {
  it("returns diff unchanged when under limit", () => {
    const diff = "small diff";
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("truncates and appends notice when over MAX_DIFF_CHARS", () => {
    const big = "x".repeat(MAX_DIFF_CHARS + 1);
    const result = truncateDiff(big);
    expect(result.length).toBeLessThanOrEqual(MAX_DIFF_CHARS + 200);
    expect(result).toContain("[diff truncated]");
  });
});
