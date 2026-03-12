import { describe, it, expect } from "vitest";
import { buildDiffUrl, truncateDiff, MAX_DIFF_BYTES } from "./pr.js";

describe("buildDiffUrl", () => {
  it("builds the correct GitHub diff URL", () => {
    const url = buildDiffUrl("octocat", "hello-world", 42);
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

  it("truncates and appends notice when over MAX_DIFF_BYTES", () => {
    const big = "x".repeat(MAX_DIFF_BYTES + 1);
    const result = truncateDiff(big);
    expect(result.length).toBeLessThanOrEqual(MAX_DIFF_BYTES + 200);
    expect(result).toContain("[diff truncated]");
  });
});
