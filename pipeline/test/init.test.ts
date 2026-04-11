// pipeline/test/init.test.ts — Preflight check + cookie auth tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: mock execFileSync to handle both cookie-import-browser and cookies calls.
   * By default: import succeeds, cookies returns a non-empty array.
   */
  function mockCookieImportSuccess(cookies: unknown[] = [{ name: "session", value: "abc" }]) {
    mockExec.mockImplementation(((cmd: string, args: string[]) => {
      if (args[0] === "cookie-import-browser") return Buffer.from("");
      if (args[0] === "cookies") return JSON.stringify(cookies);
      return Buffer.from("");
    }) as typeof execFileSync);
  }

  it("calls cookie-import-browser with chromium and domain", async () => {
    mockCookieImportSuccess();
    const { importCookiesToDaemon } = await import("../src/init.js");
    const result = importCookiesToDaemon("http://localhost:3000");
    expect(result.ok).toBe(true);

    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls[0][1]).toEqual(["cookie-import-browser", "chromium", "localhost"]);
  });

  it("verifies cookies landed after import (default verify=true)", async () => {
    mockCookieImportSuccess();
    const { importCookiesToDaemon } = await import("../src/init.js");
    const result = importCookiesToDaemon("http://localhost:3000");
    expect(result.ok).toBe(true);

    // Should have called both cookie-import-browser and cookies
    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls).toHaveLength(2);
    expect(browseCalls[1][1]).toEqual(["cookies"]);
  });

  it("fails when cookies are empty after import", async () => {
    mockCookieImportSuccess([]);  // empty cookie array
    const { importCookiesToDaemon } = await import("../src/init.js");
    const result = importCookiesToDaemon("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no cookies were found");
  });

  it("skips verification when verify=false", async () => {
    mockExec.mockReturnValue(Buffer.from(""));
    const { importCookiesToDaemon } = await import("../src/init.js");
    const result = importCookiesToDaemon("http://localhost:3000", {}, { verify: false });
    expect(result.ok).toBe(true);

    // Should only have called cookie-import-browser, not cookies
    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls).toHaveLength(1);
    expect(browseCalls[0][1]).toEqual(["cookie-import-browser", "chromium", "localhost"]);
  });

  it("uses stdio inherit and 60s timeout when interactive=true", async () => {
    mockCookieImportSuccess();
    const { importCookiesToDaemon } = await import("../src/init.js");
    importCookiesToDaemon("http://localhost:3000", {}, { interactive: true });

    const importCall = mockExec.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1][0] === "cookie-import-browser"
    );
    expect(importCall).toBeDefined();
    expect(importCall![2]).toMatchObject({ timeout: 60_000, stdio: "inherit" });
  });

  it("uses stdio ignore and 15s timeout by default (non-interactive)", async () => {
    mockCookieImportSuccess();
    const { importCookiesToDaemon } = await import("../src/init.js");
    importCookiesToDaemon("http://localhost:3000");

    const importCall = mockExec.mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && c[1][0] === "cookie-import-browser"
    );
    expect(importCall).toBeDefined();
    expect(importCall![2]).toMatchObject({ timeout: 15_000, stdio: "ignore" });
  });

  it("passes extraEnv to execFileSync", async () => {
    mockCookieImportSuccess();
    const { importCookiesToDaemon } = await import("../src/init.js");
    importCookiesToDaemon("http://localhost:3000", { BROWSE_STATE_FILE: "/tmp/test-state/browse.json" });

    const cookieCall = mockExec.mock.calls.find((c: unknown[]) => c[1]?.[0] === "cookie-import-browser");
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
    mockCookieImportSuccess();
    const { importCookiesToDaemon } = await import("../src/init.js");
    importCookiesToDaemon("https://app.example.com:8080/dashboard");

    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls[0][1]).toEqual(["cookie-import-browser", "chromium", "app.example.com"]);
  });
});

describe("exportAuthState", () => {
  const mockExec = vi.mocked(execFileSync);
  let tmpDir: string;

  beforeEach(() => {
    mockExec.mockReset();
    tmpDir = join(tmpdir(), `verify-export-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes Playwright storage-state format from browse cookies", async () => {
    const browseCookies = [
      { name: "session", value: "abc123", domain: "localhost", path: "/", httpOnly: true, secure: false },
      { name: "csrf", value: "xyz", domain: "localhost", path: "/api" },
    ];
    mockExec.mockReturnValue(JSON.stringify(browseCookies) as unknown as Buffer);

    const { exportAuthState } = await import("../src/init.js");
    const authPath = join(tmpDir, "auth.json");
    const result = exportAuthState(authPath);

    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(written).toHaveProperty("cookies");
    expect(written).toHaveProperty("origins");
    expect(written.cookies).toHaveLength(2);
    expect(written.cookies[0]).toMatchObject({ name: "session", value: "abc123", httpOnly: true });
    expect(written.cookies[1]).toMatchObject({ name: "csrf", path: "/api" });
    expect(written.origins).toEqual([]);
  });

  it("writes empty cookies array when daemon has no cookies", async () => {
    mockExec.mockReturnValue("[]" as unknown as Buffer);

    const { exportAuthState } = await import("../src/init.js");
    const authPath = join(tmpDir, "auth.json");
    const result = exportAuthState(authPath);

    expect(result.ok).toBe(true);
    const written = JSON.parse(readFileSync(authPath, "utf-8"));
    expect(written.cookies).toEqual([]);
  });

  it("returns error when browse cookies command fails", async () => {
    mockExec.mockImplementation(() => { throw new Error("daemon not running"); });

    const { exportAuthState } = await import("../src/init.js");
    const authPath = join(tmpDir, "auth.json");
    const result = exportAuthState(authPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to export auth state");
  });

  it("returns error when daemon returns non-array JSON", async () => {
    mockExec.mockReturnValue('{"error":"not ready"}' as unknown as Buffer);

    const { exportAuthState } = await import("../src/init.js");
    const authPath = join(tmpDir, "auth.json");
    const result = exportAuthState(authPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Expected array from browse cookies");
  });
});

describe("validateCookieAuth", () => {
  const mockExec = vi.mocked(execFileSync);

  beforeEach(() => {
    mockExec.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when URL is not an auth redirect", async () => {
    mockExec.mockImplementation(((cmd: string, args: string[]) => {
      if (args[0] === "goto") return Buffer.from("");
      if (args[0] === "url") return "http://localhost:3000/dashboard\n";
      return Buffer.from("");
    }) as typeof execFileSync);

    const { validateCookieAuth } = await import("../src/init.js");
    const result = validateCookieAuth("http://localhost:3000");
    expect(result.ok).toBe(true);
  });

  it("returns error when URL contains /login", async () => {
    mockExec.mockImplementation(((cmd: string, args: string[]) => {
      if (args[0] === "goto") return Buffer.from("");
      if (args[0] === "url") return "http://localhost:3000/login?redirect=/dashboard\n";
      return Buffer.from("");
    }) as typeof execFileSync);

    const { validateCookieAuth } = await import("../src/init.js");
    const result = validateCookieAuth("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("redirected to");
    expect(result.error).toContain("/login");
  });

  it("returns error when URL contains /signin", async () => {
    mockExec.mockImplementation(((cmd: string, args: string[]) => {
      if (args[0] === "goto") return Buffer.from("");
      if (args[0] === "url") return "http://localhost:3000/signin\n";
      return Buffer.from("");
    }) as typeof execFileSync);

    const { validateCookieAuth } = await import("../src/init.js");
    const result = validateCookieAuth("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("redirected to");
  });

  it("returns error when browse goto fails", async () => {
    mockExec.mockImplementation(() => { throw new Error("connection refused"); });

    const { validateCookieAuth } = await import("../src/init.js");
    const result = validateCookieAuth("http://localhost:3000");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cookie validation failed");
  });
});
