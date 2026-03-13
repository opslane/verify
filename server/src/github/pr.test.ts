import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
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

describe("fetchPrChangedFiles", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns list of changed files with status", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { filename: "src/index.ts", status: "modified" },
        { filename: "docs/plans/plan.md", status: "added" },
      ]))
    );

    const { fetchPrChangedFiles } = await import("./pr.js");
    const files = await fetchPrChangedFiles("org", "repo", 1, "token");
    expect(files).toHaveLength(2);
    expect(files[0].filename).toBe("src/index.ts");
    expect(files[1].status).toBe("added");
  });
});

describe("postOrUpdateComment", () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("creates new comment when no existing marker found", async () => {
    // Mock list comments (empty)
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([])));
    // Mock create comment
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      html_url: "https://github.com/org/repo/pull/1#issuecomment-123",
    })));

    const { postOrUpdateComment } = await import("./pr.js");
    const url = await postOrUpdateComment("org", "repo", 1, "<!-- marker -->body", "<!-- marker -->", "token");
    expect(url).toContain("issuecomment");
  });

  it("updates existing comment when marker found", async () => {
    // Mock list comments (has existing)
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 456, body: "<!-- marker -->\nold content" },
    ])));
    // Mock update comment
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      html_url: "https://github.com/org/repo/pull/1#issuecomment-456",
    })));

    const { postOrUpdateComment } = await import("./pr.js");
    const url = await postOrUpdateComment("org", "repo", 1, "<!-- marker -->new", "<!-- marker -->", "token");
    expect(url).toContain("issuecomment-456");
  });
});
