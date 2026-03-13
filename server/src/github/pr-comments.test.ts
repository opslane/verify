import { describe, it, expect, vi, afterEach } from "vitest";

describe("fetchPrComments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns comments with author, body, and createdAt", async () => {
    const mockComments = [
      { user: { login: "alice" }, body: "Looks good", created_at: "2026-03-12T10:00:00Z" },
      { user: { login: "bob" }, body: "One nit", created_at: "2026-03-12T11:00:00Z" },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockComments), { status: 200 })
    );

    const { fetchPrComments } = await import("./pr.js");
    const result = await fetchPrComments("owner", "repo", 1, "fake-token");

    expect(result).toEqual([
      { author: "alice", body: "Looks good", createdAt: "2026-03-12T10:00:00Z" },
      { author: "bob", body: "One nit", createdAt: "2026-03-12T11:00:00Z" },
    ]);
  });

  it("filters out comments with null user (deleted/ghost accounts)", async () => {
    const mockComments = [
      { user: { login: "alice" }, body: "Looks good", created_at: "2026-03-12T10:00:00Z" },
      { user: null, body: "Ghost comment", created_at: "2026-03-12T10:30:00Z" },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockComments), { status: 200 })
    );

    const { fetchPrComments } = await import("./pr.js");
    const result = await fetchPrComments("owner", "repo", 1, "fake-token");

    expect(result).toEqual([
      { author: "alice", body: "Looks good", createdAt: "2026-03-12T10:00:00Z" },
    ]);
  });

  it("returns empty array on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 404 })
    );

    const { fetchPrComments } = await import("./pr.js");
    const result = await fetchPrComments("owner", "repo", 1, "fake-token");

    expect(result).toEqual([]);
  });

  it("throws on non-404 error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Server Error", { status: 500 })
    );

    const { fetchPrComments } = await import("./pr.js");
    await expect(fetchPrComments("owner", "repo", 1, "fake-token")).rejects.toThrow(
      "Failed to fetch PR comments: 500"
    );
  });
});

describe("postPrComment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a comment and returns the html_url", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ html_url: "https://github.com/o/r/pull/1#issuecomment-42" }), {
        status: 201,
      })
    );

    const { postPrComment } = await import("./pr.js");
    const url = await postPrComment("owner", "repo", 1, "Hello", "fake-token");

    expect(url).toBe("https://github.com/o/r/pull/1#issuecomment-42");
  });

  it("throws on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 })
    );

    const { postPrComment } = await import("./pr.js");
    await expect(postPrComment("owner", "repo", 1, "Hello", "fake-token")).rejects.toThrow(
      "Failed to post PR comment: 403"
    );
  });
});
