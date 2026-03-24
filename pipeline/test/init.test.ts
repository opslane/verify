// pipeline/test/init.test.ts — Preflight check tests
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(), execSync: vi.fn() };
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts replay with first login step (no daemon management)", async () => {
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
    // First browse call is the first login step — no daemon lifecycle
    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse");
    expect(browseCalls[0][0]).toBe("/mock/browse");
    expect(browseCalls[0][1]).toEqual(["goto", "http://localhost:3000/login"]);
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

    // Verify step order: goto, fill email, fill password, click, then poll (filter out sleep calls)
    const browseCalls = mockExec.mock.calls.filter(c => c[0] === "/mock/browse").map(c => c[1]);
    expect(browseCalls[0]).toEqual(["goto", "http://localhost:3000/auth/login"]);
    expect(browseCalls[1]).toEqual(["fill", "[name='email']", "admin@test.com"]);
    expect(browseCalls[2]).toEqual(["fill", "[name='password']", "secret"]);
    expect(browseCalls[3]).toEqual(["click", "button:has-text('Sign in')"]);
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
    // First goto is the login URL (no about:blank prefix)
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
    // Every snapshot shows a password field — waitForAuth will poll until timeout
    const loginPage = Buffer.from(
      "@e1 [text]: Email\n@e2 [textbox] \"\"\n@e3 [text]: Password\n@e4 [textbox] \"\"\n@e5 [button] \"Sign in\""
    );
    // Advance Date.now by 2s on each call so the 10s deadline is hit after ~5 iterations
    const realNow = Date.now.bind(Date);
    let callCount = 0;
    const startTime = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => startTime + (callCount++) * 2000);

    mockExec.mockReturnValue(loginPage);
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
    // goto succeeds, then fill throws
    mockExec
      .mockReturnValueOnce(Buffer.from("")) // goto /login
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
    // Find the login step's sleep (arg "2"), not the port-release sleep (arg "1")
    const sleepCall = mockExec.mock.calls.find(c => c[0] === "sleep" && c[1]?.[0] === "2");
    expect(sleepCall?.[1]).toEqual(["2"]);
  });

  it("waitForAuth succeeds immediately when no password field in snapshot", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    // Snapshot shows dashboard (no password field) on first check
    mockExec.mockReturnValue(Buffer.from("@e1 [link] Dashboard\n@e2 [button] Logout"));
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
    expect(result.ok).toBe(true);
  });

  it("waitForAuth retries and succeeds when auth completes after delay", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    const loginPageSnapshot = Buffer.from(
      "@e1 [textbox] \"Email\"\n@e2 [textbox] \"Password\"\n@e3 [button] \"Sign In\""
    );
    const dashboardSnapshot = Buffer.from("@e1 [link] Dashboard\n@e2 [button] Logout");

    // Login steps succeed, then poll: first 2 checks show login page, third shows dashboard
    mockExec
      .mockReturnValueOnce(Buffer.from("")) // goto /login (step)
      .mockReturnValueOnce(Buffer.from("")) // click #submit (step)
      .mockReturnValueOnce(Buffer.from("")) // poll: goto baseUrl (attempt 1)
      .mockReturnValueOnce(loginPageSnapshot) // poll: snapshot (attempt 1) — still login
      .mockReturnValueOnce(Buffer.from("")) // poll: sleep 0.5
      .mockReturnValueOnce(Buffer.from("")) // poll: goto baseUrl (attempt 2)
      .mockReturnValueOnce(loginPageSnapshot) // poll: snapshot (attempt 2) — still login
      .mockReturnValueOnce(Buffer.from("")) // poll: sleep 0.5
      .mockReturnValueOnce(Buffer.from("")) // poll: goto baseUrl (attempt 3)
      .mockReturnValueOnce(dashboardSnapshot); // poll: snapshot (attempt 3) — success!

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
    expect(result.ok).toBe(true);
  });

  it("waitForAuth returns error when password field persists after max wait", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    // Every snapshot shows login page — auth never completes
    const loginPage = Buffer.from(
      "@e1 [textbox] \"Email\"\n@e2 [textbox] \"Password\"\n@e3 [button] \"Sign In\""
    );
    // Advance Date.now by 2s on each call so the 10s deadline is hit after ~5 iterations
    const realNow = Date.now.bind(Date);
    let callCount = 0;
    const startTime = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => startTime + (callCount++) * 2000);

    mockExec.mockReturnValue(loginPage);
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
    expect(result.error).toContain("still on login page");
  });
});

describe("loginOnDaemon", () => {
  const mockExec = vi.mocked(execFileSync);

  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockReturnValue(Buffer.from("@e1 [link] Dashboard"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes BROWSE_STATE_FILE to execFileSync via extraEnv", async () => {
    const { loginOnDaemon } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "test@test.com",
        password: "pass",
        loginSteps: [{ action: "goto" as const, url: "/login" }],
      },
    };
    loginOnDaemon(config, { BROWSE_STATE_FILE: "/tmp/test-state/browse.json" });

    // Verify execFileSync was called with env containing BROWSE_STATE_FILE
    const calls = (execFileSync as unknown as MockInstance).mock.calls;
    const gotoCall = calls.find((c: unknown[]) => c[1]?.[0] === "goto");
    expect(gotoCall).toBeDefined();
    expect(gotoCall![2]?.env?.BROWSE_STATE_FILE).toBe("/tmp/test-state/browse.json");
  });

  it("works identically to loginWithCredentials when no extraEnv", async () => {
    const { loginOnDaemon } = await import("../src/init.js");
    const config = {
      baseUrl: "http://localhost:3000",
      auth: {
        email: "a@b.com",
        password: "x",
        loginSteps: [
          { action: "goto" as const, url: "/login" },
          { action: "click" as const, selector: "#btn" },
        ],
      },
    };
    const result = loginOnDaemon(config);
    expect(result.ok).toBe(true);
  });
});
