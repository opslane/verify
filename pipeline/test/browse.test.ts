// pipeline/test/browse.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveBrowseBin, startGroupDaemon, stopGroupDaemon, stopAllGroupDaemons } from "../src/lib/browse.js";

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

const TEST_RUN_DIR = "/tmp/verify-browse-test-" + process.pid;

describe("group daemon helpers", () => {
  beforeEach(() => {
    mkdirSync(TEST_RUN_DIR, { recursive: true });
  });

  afterEach(() => {
    try { stopAllGroupDaemons(TEST_RUN_DIR); } catch { /* ignore */ }
    try { rmSync(TEST_RUN_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  describe("startGroupDaemon", () => {
    it("creates state dir and returns env with BROWSE_STATE_FILE", () => {
      const result = startGroupDaemon("g1", TEST_RUN_DIR);
      expect(result.env.BROWSE_STATE_FILE).toBe(join(TEST_RUN_DIR, ".browse-g1", "browse.json"));
      expect(existsSync(join(TEST_RUN_DIR, ".browse-g1"))).toBe(true);
    });
  });

  describe("stopGroupDaemon", () => {
    it("handles missing state file gracefully", () => {
      const stateDir = join(TEST_RUN_DIR, ".browse-missing");
      mkdirSync(stateDir, { recursive: true });
      expect(() => stopGroupDaemon(stateDir)).not.toThrow();
    });

    it("handles dead PID gracefully", () => {
      const stateDir = join(TEST_RUN_DIR, ".browse-dead");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "browse.json"), JSON.stringify({ pid: 999999999, port: 12345, token: "test" }));
      expect(() => stopGroupDaemon(stateDir)).not.toThrow();
    });
  });

  describe("stopAllGroupDaemons", () => {
    it("is a no-op when no group dirs exist", () => {
      expect(() => stopAllGroupDaemons(TEST_RUN_DIR)).not.toThrow();
    });

    it("finds and processes all .browse-* dirs", () => {
      for (const g of ["g1", "g2", "g3"]) {
        const dir = join(TEST_RUN_DIR, `.browse-${g}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "browse.json"), JSON.stringify({ pid: 999999999, port: 12345, token: "test" }));
      }
      expect(() => stopAllGroupDaemons(TEST_RUN_DIR)).not.toThrow();
    });
  });
});
