# Login Recipe Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace brittle regex-based login and cookie-import auth with a two-phase approach: an LLM agent discovers how to log in during setup and saves a replayable recipe; the pipeline replays those steps mechanically on every run.

**Architecture:** During `/verify-setup`, an LLM browse agent navigates to the app (unauthenticated), follows redirects to discover the login page, logs in with seed credentials, and reports the stable CSS selectors it used. These steps are verified by mechanical replay, then saved to `config.json` as `auth.loginSteps`. During `/verify` runs, `loginWithCredentials` restarts the browse daemon (clean slate) and replays those steps — no LLM, no regex, no guessing.

**Tech Stack:** TypeScript, `claude -p` (non-interactive Claude CLI), gstack browse CLI, vitest

---

## Task 1: Add `LoginStep` type and update `VerifyConfig.auth`

**Files:**
- Modify: `pipeline/src/lib/types.ts:5-17`

**Step 1: Write the failing test**

Create test for the new type shape in the existing config test file.

File: `pipeline/test/config.test.ts` — add a test that loads a config with `loginSteps` and asserts the shape:

```typescript
it("loads config with loginSteps auth", () => {
  writeFileSync(join(verifyDir, "config.json"), JSON.stringify({
    baseUrl: "http://localhost:3000",
    auth: {
      email: "admin@example.com",
      password: "secret",
      loginSteps: [
        { action: "goto", url: "/auth/login" },
        { action: "fill", selector: "[name='email']", value: "{{email}}" },
        { action: "fill", selector: "[name='password']", value: "{{password}}" },
        { action: "click", selector: "button:has-text('Sign in')" },
      ],
    },
  }));
  const config = loadConfig(verifyDir);
  expect(config.auth?.loginSteps).toHaveLength(4);
  expect(config.auth?.loginSteps?.[0]).toEqual({ action: "goto", url: "/auth/login" });
  expect(config.auth?.email).toBe("admin@example.com");
});
```

**Step 2: Run test to verify it fails**

Run: `cd pipeline && npx vitest run test/config.test.ts`
Expected: FAIL — `loginSteps` does not exist on the type yet

**Step 3: Update the types**

In `pipeline/src/lib/types.ts`, replace lines 5-17 with:

```typescript
export type LoginStep =
  | { action: "goto"; url: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "click"; selector: string }
  | { action: "sleep"; ms: number };

export interface VerifyConfig {
  baseUrl: string;
  authCheckUrl?: string;
  specPath?: string;
  diffBase?: string;
  maxParallelGroups?: number;
  auth?: {
    email: string;
    password: string;
    loginSteps: LoginStep[];
  };
}
```

Notes:
- `method` field removed — there's only one auth method now (login steps)
- `loginUrl` removed — encoded in the first `goto` step
- `email` and `password` are required when `auth` is present (no more optional)
- `loginSteps` is required when `auth` is present
- `sleep` action added for pages that need transition time between steps

**Step 4: Fix any type errors from removing `method` and `loginUrl`**

Run: `cd pipeline && npx tsc --noEmit`

The only consumer of `auth.method` and `auth.loginUrl` is `pipeline/src/init.ts:43-48`. This will be rewritten in Task 2, so for now just update the guard to match the new shape:

In `pipeline/src/init.ts:42-45`, change the guard to:
```typescript
export function loginWithCredentials(config: VerifyConfig, projectRoot?: string): CheckResult {
  if (!config.auth || !config.auth.email || !config.auth.password || !config.auth.loginSteps?.length) {
    return { ok: false, error: "No auth config — run /verify-setup to configure login" };
  }
```

Remove the `loginUrl` reference on line 48 — it will be replaced in Task 2.

For now, to keep the function compiling, replace the body (lines 47-89) with a stub:
```typescript
  // TODO: Task 2 replaces this with step replay
  return { ok: true };
```

**Step 5: Run tests to verify everything passes**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: all pass

**Step 6: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/init.ts pipeline/test/config.test.ts
git commit -m "feat(pipeline): add LoginStep type, update VerifyConfig.auth shape"
```

---

## Task 2: Rewrite `loginWithCredentials` as a step replayer

**Files:**
- Modify: `pipeline/src/init.ts:42-105` (replace `loginWithCredentials` and `verifyAuthState`)
- Modify: `pipeline/test/init.test.ts` (add replay tests)

**Step 1: Write the failing tests**

Add to `pipeline/test/init.test.ts`:

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/init.test.ts`
Expected: FAIL — `loginWithCredentials` is stubbed from Task 1

**Step 3: Implement the step replayer**

Replace `loginWithCredentials` and `verifyAuthState` in `pipeline/src/init.ts`:

```typescript
/**
 * Replay saved login steps from config.json.
 * Restarts the browse daemon first to guarantee a clean cookie jar.
 * No LLM, no regex — pure mechanical replay of steps discovered during /verify-setup.
 */
export function loginWithCredentials(config: VerifyConfig, projectRoot?: string): CheckResult {
  if (!config.auth || !config.auth.email || !config.auth.password || !config.auth.loginSteps?.length) {
    return { ok: false, error: "No auth config — run /verify-setup to configure login" };
  }

  const bin = resolveBrowseBin();
  const opts = projectRoot ? { cwd: projectRoot } : {};
  const { email, password, loginSteps } = config.auth;

  try {
    // Restart daemon — clean slate, no stale cookies from prior sessions
    execFileSync(bin, ["restart"], { timeout: 10_000, stdio: "ignore", ...opts });

    for (const step of loginSteps) {
      switch (step.action) {
        case "goto": {
          const url = (step.url.startsWith("http://") || step.url.startsWith("https://")) ? step.url : `${config.baseUrl}${step.url}`;
          execFileSync(bin, ["goto", url], { timeout: 10_000, stdio: "ignore", ...opts });
          break;
        }
        case "fill": {
          const value = step.value
            .replaceAll("{{email}}", email)
            .replaceAll("{{password}}", password);
          execFileSync(bin, ["fill", step.selector, value], { timeout: 5_000, stdio: "ignore", ...opts });
          break;
        }
        case "click":
          execFileSync(bin, ["click", step.selector], { timeout: 5_000, stdio: "ignore", ...opts });
          break;
        case "sleep":
          execFileSync("sleep", [String(Math.ceil(step.ms / 1000))], { timeout: step.ms + 2_000, stdio: "ignore" });
          break;
      }
    }

    return verifyAuthState(config.baseUrl, bin, opts);
  } catch (err: unknown) {
    return { ok: false, error: `Login replay failed: ${err instanceof Error ? err.message : String(err)}. Re-run /verify-setup.` };
  }
}

/**
 * Verify we're NOT on a login page by checking for password input fields.
 * A password field in the snapshot = still on login form.
 */
function verifyAuthState(baseUrl: string, bin: string, opts: { cwd?: string } = {}): CheckResult {
  try {
    execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", ...opts });
    execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });
    const snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });

    // Generic detection: if snapshot has a password-type input, we're on a login page
    const hasPasswordField = /\[textbox\].*password|\[text\].*password/i.test(snapshot);
    if (hasPasswordField) {
      return { ok: false, error: "Login steps did not authenticate — still on login page. Re-run /verify-setup." };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to verify auth state after login" };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run test/init.test.ts`
Expected: all pass

**Step 5: Run full test suite**

Run: `cd pipeline && npx vitest run`
Expected: all 231+ tests pass

**Step 6: Commit**

```bash
git add pipeline/src/init.ts pipeline/test/init.test.ts
git commit -m "feat(pipeline): rewrite loginWithCredentials as mechanical step replayer"
```

---

## Task 3: Create the login agent prompt

**Files:**
- Create: `pipeline/src/prompts/login-agent.txt`

**Step 1: Write the prompt template**

The prompt uses `__EMAIL__` and `__PASSWORD__` for actual credential values (replaced by `buildLoginAgentPrompt`), and `{{email}}` / `{{password}}` as literal placeholder tokens the LLM should emit in its output. The `__DUNDER__` style tokens are visually distinct from the `{{curly}}` output tokens, preventing accidental substitution collisions.

File: `pipeline/src/prompts/login-agent.txt`

```
You are a login agent. Your job is to log in to a web application using provided credentials and report the exact steps you took using STABLE CSS selectors.

CREDENTIALS:
- Email: __EMAIL__
- Password: __PASSWORD__

BROWSE CLI (available as a Bash command):
- `__BROWSE_BIN__ goto <url>` — navigate to a URL
- `__BROWSE_BIN__ snapshot` — take a DOM snapshot
- `__BROWSE_BIN__ click <selector>` — click an element
- `__BROWSE_BIN__ fill <selector> <value>` — fill an input field
- `__BROWSE_BIN__ screenshot <path>` — save a screenshot

WORKFLOW:
1. Run: __BROWSE_BIN__ goto "__BASE_URL__"
2. Run: __BROWSE_BIN__ snapshot — see where you were redirected (the login page)
3. Identify the email field, password field, and submit button
4. Fill in the credentials and click submit
5. Run: __BROWSE_BIN__ snapshot — verify you landed on an authenticated page (NOT a login form)
6. If login succeeded, output the steps you took
7. If login failed (still on login page, error message visible), report the failure

SELECTOR RULES — Use stable selectors, NOT @eN refs. Prefer in this order:
1. [data-testid="..."] — most stable
2. [name="..."] or [type="email"] / [type="password"] — semantic HTML attributes
3. button:has-text("...") — text content for buttons
4. CSS selector (role, aria-label, etc.) as last resort

NEVER use @e1, @e2, etc. in your output — those are session-specific and will break on replay.

For fill steps, use the placeholder {{email}} or {{password}} in the value field — these will be substituted at runtime with actual credentials.

MULTI-STEP LOGINS:
- Some apps have a "Login with Email" or "Continue with Email" button before showing the form. Click it first if present.
- Some apps show email on one page, password on the next. Handle both pages.
- After clicking submit, wait a moment and take a snapshot to confirm login succeeded.

OUTPUT: Write valid JSON to stdout with this exact schema:

Success:
{
  "success": true,
  "loginSteps": [
    {"action": "goto", "url": "/auth/login"},
    {"action": "fill", "selector": "[name='email']", "value": "{{email}}"},
    {"action": "fill", "selector": "[name='password']", "value": "{{password}}"},
    {"action": "click", "selector": "button:has-text('Sign in')"}
  ]
}

Failure:
{
  "success": false,
  "error": "Describe what went wrong",
  "page_snapshot": "paste the current snapshot here"
}

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/login-agent.txt
git commit -m "feat(pipeline): add login agent prompt template for verify-setup"
```

---

## Task 4: Add login agent stage functions

**Files:**
- Create: `pipeline/src/stages/login-agent.ts`
- Create: `pipeline/test/login-agent.test.ts`

**Step 1: Write the failing tests**

File: `pipeline/test/login-agent.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { buildLoginAgentPrompt, parseLoginAgentOutput } from "../src/stages/login-agent.js";

describe("login-agent", () => {
  describe("buildLoginAgentPrompt", () => {
    it("substitutes all template variables", () => {
      const prompt = buildLoginAgentPrompt({
        baseUrl: "http://localhost:3000",
        email: "test@example.com",
        password: "secret123",
        browseBin: "/usr/local/bin/browse",
      });
      expect(prompt).toContain("test@example.com");
      expect(prompt).toContain("secret123");
      expect(prompt).toContain("http://localhost:3000");
      expect(prompt).toContain("/usr/local/bin/browse");
      // Template vars should be replaced
      expect(prompt).not.toContain("__EMAIL__");
      expect(prompt).not.toContain("__PASSWORD__");
      expect(prompt).not.toContain("__BASE_URL__");
      expect(prompt).not.toContain("__BROWSE_BIN__");
      // But {{email}}/{{password}} output tokens must remain as literals
      expect(prompt).toContain("{{email}}");
      expect(prompt).toContain("{{password}}");
    });
  });

  describe("parseLoginAgentOutput", () => {
    it("parses successful login result", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "goto", url: "/login" },
          { action: "fill", selector: "[name='email']", value: "{{email}}" },
          { action: "fill", selector: "[name='password']", value: "{{password}}" },
          { action: "click", selector: "button:has-text('Log in')" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      expect(result!.loginSteps).toHaveLength(4);
    });

    it("parses failure result", () => {
      const raw = JSON.stringify({
        success: false,
        error: "Could not find login form",
        page_snapshot: "@e1 [heading] 404",
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.error).toContain("login form");
    });

    it("returns null for unparseable output", () => {
      expect(parseLoginAgentOutput("not json")).toBeNull();
      expect(parseLoginAgentOutput("{}")).toBeNull();
    });

    it("rejects steps containing @eN refs", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "goto", url: "/login" },
          { action: "click", selector: "@e5" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });

    it("rejects steps with empty selectors", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "fill", selector: "", value: "{{email}}" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });

    it("requires at least one fill and one goto step", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "click", selector: "button" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });

    it("rejects unknown action types", () => {
      const raw = JSON.stringify({
        success: true,
        loginSteps: [
          { action: "goto", url: "/login" },
          { action: "fill", selector: "#email", value: "{{email}}" },
          { action: "hover", selector: "#btn" },
        ],
      });
      const result = parseLoginAgentOutput(raw);
      expect(result).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/login-agent.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement the login agent stage**

File: `pipeline/src/stages/login-agent.ts`

```typescript
// pipeline/src/stages/login-agent.ts — Login agent stage (used during /verify-setup only)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoginStep } from "../lib/types.js";
import { parseJsonOutput } from "../lib/parse-json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LoginAgentOpts {
  baseUrl: string;
  email: string;
  password: string;
  browseBin: string;
}

export function buildLoginAgentPrompt(opts: LoginAgentOpts): string {
  const template = readFileSync(join(__dirname, "../prompts/login-agent.txt"), "utf-8");
  return template
    .replaceAll("__BASE_URL__", opts.baseUrl)
    .replaceAll("__BROWSE_BIN__", opts.browseBin)
    .replaceAll("__EMAIL__", opts.email)
    .replaceAll("__PASSWORD__", opts.password);
}

interface LoginAgentSuccess {
  success: true;
  loginSteps: LoginStep[];
}

interface LoginAgentFailure {
  success: false;
  error: string;
  page_snapshot?: string;
}

type LoginAgentResult = LoginAgentSuccess | LoginAgentFailure;

const AT_REF_PATTERN = /@e\d+/;

export function parseLoginAgentOutput(raw: string): LoginAgentResult | null {
  const parsed = parseJsonOutput<LoginAgentResult>(raw);
  if (!parsed || typeof parsed.success !== "boolean") return null;

  if (!parsed.success) {
    if (typeof parsed.error !== "string") return null;
    return parsed;
  }

  if (!Array.isArray(parsed.loginSteps) || parsed.loginSteps.length === 0) return null;

  // Validate each step
  for (const step of parsed.loginSteps) {
    if (!step || typeof step.action !== "string") return null;

    switch (step.action) {
      case "goto":
        if (typeof step.url !== "string" || !step.url) return null;
        break;
      case "fill":
        if (typeof step.selector !== "string" || !step.selector) return null;
        if (typeof step.value !== "string") return null;
        if (AT_REF_PATTERN.test(step.selector)) return null;
        break;
      case "click":
        if (typeof step.selector !== "string" || !step.selector) return null;
        if (AT_REF_PATTERN.test(step.selector)) return null;
        break;
      case "sleep":
        if (typeof step.ms !== "number" || step.ms <= 0) return null;
        break;
      default:
        return null;
    }
  }

  // Must have at least one goto and one fill
  const hasGoto = parsed.loginSteps.some(s => s.action === "goto");
  const hasFill = parsed.loginSteps.some(s => s.action === "fill");
  if (!hasGoto || !hasFill) return null;

  return parsed;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run test/login-agent.test.ts`
Expected: all pass

**Step 5: Commit**

```bash
git add pipeline/src/stages/login-agent.ts pipeline/src/prompts/login-agent.txt pipeline/test/login-agent.test.ts
git commit -m "feat(pipeline): login-agent stage — prompt builder and output parser"
```

---

## Task 5: Add `STAGE_PERMISSIONS` entry for login-agent

**Files:**
- Modify: `pipeline/src/lib/types.ts:172-180`

**Step 1: Add the permission entry**

In `pipeline/src/lib/types.ts`, add to the `STAGE_PERMISSIONS` object:

```typescript
  "login-agent": { allowedTools: ["Bash"] },        // Bash for browse CLI only — used during /verify-setup
```

Add it after the `"learner"` entry.

**Step 2: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): add login-agent stage permissions"
```

---

## Task 6: Update `/verify-setup` skill to use login agent

**Files:**
- Modify: `skills/verify-setup/SKILL.md`

**Step 1: Rewrite the skill**

Replace the entire content of `skills/verify-setup/SKILL.md`:

````markdown
---
name: verify-setup
description: One-time auth setup for /verify. Discovers login steps using seed credentials and saves a replayable recipe.
---

# /verify-setup

Run once before using /verify on any app that requires authentication.

## Steps

### 1. Add .verify/ to .gitignore

```bash
for pattern in ".verify/config.json" ".verify/evidence/" ".verify/prompts/" ".verify/report.json" ".verify/plan.json" ".verify/.spec_path" ".verify/browse.json" ".verify/report.html" ".verify/judge-prompt.txt" ".verify/progress.jsonl"; do
  grep -qF "$pattern" .gitignore 2>/dev/null || echo "$pattern" >> .gitignore
done
echo "✓ .gitignore updated"
```

### 2. Create .verify/config.json if missing

```bash
mkdir -p .verify
if [ ! -f .verify/config.json ]; then
  cat > .verify/config.json << 'CONFIG'
{
  "baseUrl": "http://localhost:3000"
}
CONFIG
fi
```

Ask the user:
- "What is your dev server URL? (default: http://localhost:3000)"

Update .verify/config.json with their answer:
```bash
jq --arg url "THEIR_URL" '.baseUrl = $url' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
```

### 3. Install browse binary

```bash
BROWSE_BIN=$(bash ~/.claude/tools/verify/install-browse.sh | tail -1)
echo "✓ Browse binary: $BROWSE_BIN"
```

### 4. Check dev server is running

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before continuing."
```

### 5. Collect seed credentials

Ask the user:
- "What email and password can I use to log in? (These should be from your seed data)"

Save credentials to config:
```bash
jq --arg email "THEIR_EMAIL" --arg password "THEIR_PASSWORD" \
  '.auth = { email: $email, password: $password, loginSteps: [] }' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
```

### 6. Discover login steps

Run the login agent to figure out how to log in. This uses an LLM to navigate the login form once and record the steps.

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
EMAIL=$(jq -r '.auth.email' .verify/config.json)
PASSWORD=$(jq -r '.auth.password' .verify/config.json)
BROWSE_BIN="${BROWSE_BIN:-$(cat ~/.cache/verify/browse-path 2>/dev/null || echo ~/.cache/verify/browse)}"

cd "$(git rev-parse --show-toplevel)"

npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run-stage login-agent \
  --verify-dir .verify \
  --run-dir .verify/runs/setup-login \
  --base-url "$BASE_URL" \
  --email "$EMAIL" \
  --password "$PASSWORD" \
  --browse-bin "$BROWSE_BIN"
```

If the login agent succeeds, it outputs login steps. The CLI automatically saves them to config.json.

If it fails, show the error and ask the user to verify their credentials and dev server.

### 7. Verify login recipe by replay

Clear cookies and replay the saved steps mechanically to confirm they work:

```bash
BROWSE_BIN="${BROWSE_BIN:-$(cat ~/.cache/verify/browse-path 2>/dev/null || echo ~/.cache/verify/browse)}"

npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run-stage verify-login \
  --verify-dir .verify
```

If replay succeeds:
```
✓ Login recipe verified — /verify will authenticate automatically on every run.
```

If replay fails:
```
✗ Login replay failed. Check the credentials and try again, or re-run /verify-setup.
```

### 8. Index the application

After auth is confirmed, build the app index.

```bash
cd "$(git rev-parse --show-toplevel)"
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts index-app \
  --project-dir . \
  --output .verify/app.json
```

Show the summary:

```bash
echo "App index built:"
echo "  Routes: $(jq '.routes | length' .verify/app.json)"
echo "  Models: $(jq '.data_model | length' .verify/app.json)"
echo "  Seed IDs: $(jq '[.seed_ids[]] | flatten | length' .verify/app.json)"
echo "  DB URL env: $(jq -r '.db_url_env // "not found"' .verify/app.json)"
```

If the model count is 0, warn: "No Prisma schema found. Setup writer will have to discover column names from the codebase — this may cause SQL column name errors."
````

**Step 2: Commit**

```bash
git add skills/verify-setup/SKILL.md
git commit -m "feat(skill): rewrite verify-setup to use login agent instead of cookie import"
```

---

## Task 7: Wire login-agent and verify-login into the CLI

**Files:**
- Modify: `pipeline/src/cli.ts:9-22,227-343` (add CLI args and stage cases)
- Modify: `pipeline/test/cli.test.ts` (add acceptance tests)

**Step 1: Write the failing tests**

Add to `pipeline/test/cli.test.ts`:

```typescript
it("login-agent stage is accepted (not unknown)", async () => {
  const result = spawnSync("npx", ["tsx", "src/cli.ts", "run-stage", "login-agent",
    "--verify-dir", "/tmp/nonexistent",
    "--base-url", "http://localhost:3000",
    "--email", "a@b.com",
    "--password", "x",
    "--browse-bin", "/nonexistent/browse",
  ], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    timeout: 10_000,
  });
  // Should not error with "Unknown stage" — may fail for other reasons (no browse binary, etc.)
  expect(result.stderr).not.toContain("Unknown stage: login-agent");
});

it("verify-login stage is accepted (not unknown)", async () => {
  const result = spawnSync("npx", ["tsx", "src/cli.ts", "run-stage", "verify-login",
    "--verify-dir", "/tmp/nonexistent",
  ], {
    cwd: join(__dirname, ".."),
    encoding: "utf-8",
    timeout: 10_000,
  });
  expect(result.stderr).not.toContain("Unknown stage: verify-login");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/cli.test.ts`
Expected: FAIL — "Unknown stage: login-agent" and "Unknown stage: verify-login"

**Step 3: Add CLI args and stage cases**

First, add the new CLI args to `parseArgs` options in `pipeline/src/cli.ts:9-22`:

```typescript
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "verify-dir": { type: "string", default: ".verify" },
    "run-dir": { type: "string" },
    "project-dir": { type: "string" },
    output: { type: "string" },
    spec: { type: "string" },
    group: { type: "string" },
    condition: { type: "string" },
    ac: { type: "string" },
    timeout: { type: "string" },
    "base-url": { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
    "browse-bin": { type: "string" },
  },
});
```

Then, in the `switch (stageName)` block, add these cases before the `default:` case:

```typescript
    case "login-agent": {
      const baseUrl = values["base-url"];
      const email = values.email;
      const password = values.password;
      const browseBin = values["browse-bin"];
      if (!baseUrl || !email || !password || !browseBin) {
        console.error("login-agent requires --base-url, --email, --password, --browse-bin");
        process.exit(1);
      }
      const { buildLoginAgentPrompt, parseLoginAgentOutput } = await import("./stages/login-agent.js");
      const prompt = buildLoginAgentPrompt({ baseUrl, email, password, browseBin });
      const result = await runClaude({
        prompt, model: "sonnet", timeoutMs: 60_000,
        stage: "login-agent", runDir, settingSources: "", ...permissions,
      });
      const parsed = parseLoginAgentOutput(result.stdout);
      if (!parsed) {
        console.error("Failed to parse login agent output. Check logs:", join(runDir, "logs"));
        process.exit(1);
      }
      if (!parsed.success) {
        console.error(`Login agent failed: ${parsed.error}`);
        process.exit(1);
      }
      // Save discovered loginSteps to config.json
      const updatedConfig = loadConfig(verifyDir);
      updatedConfig.auth = {
        email,
        password,
        loginSteps: parsed.loginSteps,
      };
      writeFileSync(join(verifyDir, "config.json"), JSON.stringify(updatedConfig, null, 2));
      console.log(`Login recipe saved: ${parsed.loginSteps.length} steps`);
      break;
    }
    case "verify-login": {
      const { loginWithCredentials } = await import("./init.js");
      const loginResult = loginWithCredentials(config, projectRoot);
      if (loginResult.ok) {
        console.log("Login recipe verified — authentication succeeded.");
      } else {
        console.error(loginResult.error);
        process.exit(1);
      }
      break;
    }
```

Also update the default error message and usage help to include the new stages:

```typescript
    default:
      console.error(`Unknown stage: ${stageName}. Available: ac-generator, planner, plan-validator, setup-writer, browse-agent, judge, learner, login-agent, verify-login`);
      process.exit(1);
```

And in the usage block at the bottom, add:
```typescript
  console.error("  login-agent    --base-url <url> --email <e> --password <p> --browse-bin <path>");
  console.error("  verify-login");
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: all pass

**Step 5: Commit**

```bash
git add pipeline/src/cli.ts pipeline/test/cli.test.ts
git commit -m "feat(pipeline): wire login-agent and verify-login into CLI"
```

---

## Task 8: Clean up dead code

**Files:**
- Modify: `pipeline/src/lib/types.ts` (remove `authCheckUrl` if unused)
- Modify: `pipeline/src/lib/config.ts` (remove `VERIFY_AUTH_CHECK_URL` env override if unused)
- Modify: `pipeline/src/lib/browse.ts` (remove `loadCookies` if unused)

**Step 1: Check for dead references**

Search for `authCheckUrl`, `loadCookies`, `method.*credentials`, `method.*cookies` across the pipeline. Remove any that are no longer referenced.

`authCheckUrl` — defined in `types.ts:7`, loaded in `config.ts:24`, never read anywhere else. Remove both.

`loadCookies` — defined in `browse.ts:44-56`, only reference is mock in `orchestrator.test.ts:42`. Remove function and mock.

**Step 2: Run tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: all pass

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/lib/config.ts pipeline/src/lib/browse.ts pipeline/test/orchestrator.test.ts
git commit -m "chore(pipeline): remove dead auth code (loadCookies, authCheckUrl, method field)"
```

---

## Task 9: Update calcom config to new shape

**Files:**
- Modify: `~/Projects/opslane/evals/calcom/.verify/config.json`

**Step 1: Run `/verify-setup` against calcom**

With the dev server running, run the new setup flow to discover login steps:

```bash
cd ~/Projects/opslane/evals/calcom
# The skill will prompt for credentials and run the login agent
```

This replaces the old config with the new shape including `loginSteps`.

**Step 2: Verify by running `/verify`**

Run a pipeline invocation and confirm browse agents are authenticated:

```bash
cd ~/Projects/opslane/evals/calcom
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run --spec .verify/spec.md
```

Confirm: browse agents navigate to `/event-types` and see the authenticated dashboard, not the login page.
