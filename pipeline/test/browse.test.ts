// pipeline/test/browse.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveBrowseBin } from "../src/lib/browse.js";

describe("resolveBrowseBin", () => {
  afterEach(() => { delete process.env.BROWSE_BIN; });

  it("uses BROWSE_BIN env var when set", () => {
    process.env.BROWSE_BIN = "/custom/browse";
    expect(resolveBrowseBin()).toBe("/custom/browse");
  });

  it("throws when browse binary is not found and BROWSE_BIN is unset", () => {
    delete process.env.BROWSE_BIN;
    const cached = join(homedir(), ".cache", "verify", "browse");
    if (existsSync(cached)) {
      // Browse is actually installed — verify it returns the cached path
      expect(resolveBrowseBin()).toBe(cached);
    } else {
      // Browse is not installed — verify it throws
      expect(() => resolveBrowseBin()).toThrow("Browse binary not found");
    }
  });
});
