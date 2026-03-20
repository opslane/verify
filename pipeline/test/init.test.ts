// pipeline/test/init.test.ts — Preflight check tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  healthCheck: vi.fn(() => true),
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

describe("loginWithCredentials", () => {
  const mockExec = vi.mocked(execFileSync);

  beforeEach(() => {
    mockExec.mockReset();
    // Default: snapshot returns a dashboard (no login form)
    mockExec.mockReturnValue(Buffer.from("@e1 [link] Dashboard"));
  });

  it("restarts daemon before replaying steps", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "a@b.com",
        password: "x",
        loginSteps: [
          { action: "goto" as const, url: "/login" },
          { action: "fill" as const, selector: "#email", value: "{{email}}" },
          { action: "fill" as const, selector: "#pass", value: "{{password}}" },
          { action: "click" as const, selector: "#btn" },
        ],
      },
    };
    loginWithCredentials(config, "/tmp/project");
    // First call must be browse restart to clear all cookies/state
    expect(mockExec.mock.calls[0][0]).toBe("/mock/browse");
    expect(mockExec.mock.calls[0][1]).toEqual(["restart"]);
  });

  it("replays goto, fill, click steps in order", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "admin@test.com",
        password: "secret",
        loginSteps: [
          { action: "goto" as const, url: "/auth/login" },
          { action: "fill" as const, selector: "[name='email']", value: "{{email}}" },
          { action: "fill" as const, selector: "[name='password']", value: "{{password}}" },
          { action: "click" as const, selector: "button:has-text('Sign in')" },
        ],
      },
    };
    const result = loginWithCredentials(config, "/tmp/project");
    expect(result.ok).toBe(true);

    // Verify step order: restart, goto, fill email, fill password, click, then verify
    const calls = mockExec.mock.calls.map(c => c[1]);
    expect(calls[0]).toEqual(["restart"]);
    expect(calls[1]).toEqual(["goto", "http://localhost:3000/auth/login"]);
    expect(calls[2]).toEqual(["fill", "[name='email']", "admin@test.com"]);
    expect(calls[3]).toEqual(["fill", "[name='password']", "secret"]);
    expect(calls[4]).toEqual(["click", "button:has-text('Sign in')"]);
  });

  it("passes through absolute URLs without prepending baseUrl", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "a@b.com",
        password: "x",
        loginSteps: [
          { action: "goto" as const, url: "http://localhost:4000/custom-login" },
          { action: "fill" as const, selector: "#email", value: "{{email}}" },
          { action: "click" as const, selector: "#btn" },
        ],
      },
    };
    loginWithCredentials(config, "/tmp");
    const gotoCalls = mockExec.mock.calls.filter(c => c[1]?.[0] === "goto");
    expect(gotoCalls[0][1]).toEqual(["goto", "http://localhost:4000/custom-login"]);
  });

  it("substitutes {{email}} and {{password}} placeholders", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "user@app.io",
        password: "p@ss",
        loginSteps: [
          { action: "goto" as const, url: "/login" },
          { action: "fill" as const, selector: "#email", value: "{{email}}" },
          { action: "fill" as const, selector: "#pass", value: "{{password}}" },
          { action: "click" as const, selector: "#submit" },
        ],
      },
    };
    loginWithCredentials(config, "/tmp/project");
    const fillCalls = mockExec.mock.calls.filter(c => c[1]?.[0] === "fill");
    expect(fillCalls[0][1]).toEqual(["fill", "#email", "user@app.io"]);
    expect(fillCalls[1][1]).toEqual(["fill", "#pass", "p@ss"]);
  });

  it("returns error when no auth config", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const result = loginWithCredentials({ baseUrl: "http://localhost:3000" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("verify-setup");
  });

  it("returns error when login form still visible after replay", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    // After replay, verification snapshot shows a password field = still on login page
    mockExec.mockReturnValue(Buffer.from(
      "@e1 [text]: Email\n@e2 [textbox] \"\"\n@e3 [text]: Password\n@e4 [textbox] \"\"\n@e5 [button] \"Sign in\""
    ));
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "a@b.com",
        password: "x",
        loginSteps: [
          { action: "goto" as const, url: "/login" },
          { action: "click" as const, selector: "#submit" },
        ],
      },
    };
    const result = loginWithCredentials(config, "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("verify-setup");
  });

  it("returns error when browse command throws (bad selector)", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    // Restart succeeds, then goto succeeds, then fill throws
    mockExec
      .mockReturnValueOnce(Buffer.from("")) // restart
      .mockReturnValueOnce(Buffer.from("")) // goto
      .mockImplementationOnce(() => { throw new Error("Operation timed out"); }); // fill
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "a@b.com",
        password: "x",
        loginSteps: [
          { action: "goto" as const, url: "/login" },
          { action: "fill" as const, selector: "[data-testid='gone']", value: "{{email}}" },
        ],
      },
    };
    const result = loginWithCredentials(config, "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("verify-setup");
  });

  it("handles sleep steps", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "a@b.com",
        password: "x",
        loginSteps: [
          { action: "goto" as const, url: "/login" },
          { action: "sleep" as const, ms: 2000 },
          { action: "click" as const, selector: "#btn" },
        ],
      },
    };
    const result = loginWithCredentials(config, "/tmp");
    expect(result.ok).toBe(true);
    const sleepCall = mockExec.mock.calls.find(c => c[0] === "sleep");
    expect(sleepCall?.[1]).toEqual(["2"]);
  });
});
