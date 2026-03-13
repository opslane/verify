import { describe, it, expect } from "vitest";

describe("runMentionPipeline", () => {
  it("exports runMentionPipeline function", async () => {
    const mod = await import("./mention-pipeline.js");
    expect(typeof mod.runMentionPipeline).toBe("function");
  });
});
