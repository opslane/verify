import { describe, it, expect } from "vitest";
import { truncateDiff, MAX_DIFF_CHARS } from "./pr.js";

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
