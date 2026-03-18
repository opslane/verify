// pipeline/test/init.test.ts — Preflight check tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("preflight checks", () => {
  let verifyDir: string;

  beforeEach(() => {
    verifyDir = join(tmpdir(), `verify-init-${Date.now()}`);
    mkdirSync(verifyDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(verifyDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("checkDevServer returns true when server is reachable", async () => {
    const { checkDevServer } = await import("../src/init.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const result = await checkDevServer("http://localhost:3000");
    expect(result.ok).toBe(true);
  });

  it("checkDevServer returns error when server is unreachable", async () => {
    const { checkDevServer } = await import("../src/init.js");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await checkDevServer("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not reachable");
  });

  it("checkSpecFile returns true when spec exists", async () => {
    const { checkSpecFile } = await import("../src/init.js");
    const specPath = join(verifyDir, "spec.md");
    writeFileSync(specPath, "# Spec\n\nSome content");
    const result = checkSpecFile(specPath);
    expect(result.ok).toBe(true);
  });

  it("checkSpecFile returns error when spec does not exist", async () => {
    const { checkSpecFile } = await import("../src/init.js");
    const result = checkSpecFile("/nonexistent/spec.md");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("runPreflight collects all errors", async () => {
    const { runPreflight } = await import("../src/init.js");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await runPreflight("http://localhost:3000", "/nonexistent/spec.md");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
