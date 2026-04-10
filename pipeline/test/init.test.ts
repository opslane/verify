// pipeline/test/init.test.ts — Preflight check + cookie auth tests
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn() };
});

vi.mock("../src/lib/browse.js", () => ({
  resolveBrowseBin: vi.fn(() => "/mock/browse"),
  startDaemon: vi.fn(),
}));

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

describe("importCookiesToDaemon", () => {
  const mockExec = vi.mocked(execFileSync);

  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls cookie-import-browser with chromium and domain", async () => {
    const { importCookiesToDaemon } = await import("../src/init.js");
    const result = importCookiesToDaemon("http://localhost:3000");
    expect(result.ok).toBe(true);

    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls[0][1]).toEqual(["cookie-import-browser", "chromium", "localhost"]);
  });

  it("passes extraEnv to execFileSync", async () => {
    const { importCookiesToDaemon } = await import("../src/init.js");
    importCookiesToDaemon("http://localhost:3000", { BROWSE_STATE_FILE: "/tmp/test-state/browse.json" });

    const calls = (execFileSync as unknown as MockInstance).mock.calls;
    const cookieCall = calls.find((c: unknown[]) => c[1]?.[0] === "cookie-import-browser");
    expect(cookieCall).toBeDefined();
    expect(cookieCall![2]?.env?.BROWSE_STATE_FILE).toBe("/tmp/test-state/browse.json");
  });

  it("returns error when cookie-import-browser throws", async () => {
    const { importCookiesToDaemon } = await import("../src/init.js");
    mockExec.mockImplementation(() => { throw new Error("No Chromium cookies found"); });
    const result = importCookiesToDaemon("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cookie import failed");
  });

  it("extracts domain from full URL", async () => {
    const { importCookiesToDaemon } = await import("../src/init.js");
    importCookiesToDaemon("https://app.example.com:8080/dashboard");

    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls[0][1]).toEqual(["cookie-import-browser", "chromium", "app.example.com"]);
  });
});
