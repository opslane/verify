// pipeline/test/browse.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveBrowseBin } from "../src/lib/browse.js";

describe("resolveBrowseBin", () => {
  afterEach(() => { delete process.env.BROWSE_BIN; });

  it("uses BROWSE_BIN env var when set", () => {
    process.env.BROWSE_BIN = "/custom/browse";
    expect(resolveBrowseBin()).toBe("/custom/browse");
  });

  it("falls back to default cache path", () => {
    delete process.env.BROWSE_BIN;
    // This may throw if browse is not installed — that's OK for unit test
    try {
      const bin = resolveBrowseBin();
      expect(bin).toContain(".cache/verify/browse");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("Browse binary not found");
    }
  });
});
