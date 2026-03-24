// pipeline/test/browse-parallel.test.ts — Integration test for parallel browse daemon isolation
// Requires: browse binary installed, dev server running on TEST_BASE_URL
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startGroupDaemon, stopGroupDaemon, stopAllGroupDaemons, resolveBrowseBin } from "../src/lib/browse.js";

const TEST_RUN_DIR = "/tmp/verify-parallel-test-" + process.pid;
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3003";

// Skip if browse binary missing or no dev server running
const canRun = (() => {
  try {
    resolveBrowseBin();
    execFileSync("curl", ["-sf", "-o", "/dev/null", BASE_URL], { timeout: 3_000 });
    return true;
  } catch { return false; }
})();

describe.skipIf(!canRun)("parallel browse daemon isolation", () => {
  afterEach(() => {
    try { stopAllGroupDaemons(TEST_RUN_DIR); } catch { /* ignore */ }
    try { rmSync(TEST_RUN_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it("two daemons navigate to different pages without interference", () => {
    mkdirSync(TEST_RUN_DIR, { recursive: true });
    const bin = resolveBrowseBin();

    // Start two isolated daemons
    const d1 = startGroupDaemon("g1", TEST_RUN_DIR);
    const d2 = startGroupDaemon("g2", TEST_RUN_DIR);

    const env1: NodeJS.ProcessEnv = { ...process.env, ...d1.env };
    const env2: NodeJS.ProcessEnv = { ...process.env, ...d2.env };

    // Navigate both to different pages
    execFileSync(bin, ["goto", `${BASE_URL}/signin`], { timeout: 10_000, env: env1, stdio: "ignore" });
    execFileSync(bin, ["goto", `${BASE_URL}/signup`], { timeout: 10_000, env: env2, stdio: "ignore" });

    // Give pages time to load
    execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });

    // Snapshot both — they should show DIFFERENT pages
    const snap1 = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: env1 });
    const snap2 = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: env2 });

    // D1 should show sign-in content
    expect(snap1).toMatch(/Sign [Ii]n/);
    // D2 should show sign-up content
    expect(snap2).toMatch(/Sign [Uu]p|Create account/i);

    // Cleanup
    stopGroupDaemon(d1.stateDir);
    stopGroupDaemon(d2.stateDir);
  }, 30_000);
});
