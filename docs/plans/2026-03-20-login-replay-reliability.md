# Login Replay Reliability Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `loginWithCredentials` reliable by removing daemon lifecycle management and replacing fixed sleeps with poll-based auth verification.

**Architecture:** Strip `loginWithCredentials` to pure navigation (fill/click/goto). Callers manage daemon lifecycle. Replace `verifyAuthState`'s fixed sleeps with a poll loop that checks the snapshot every 500ms for up to 10s, returning as soon as the password field disappears.

**Tech Stack:** TypeScript, Node 22 ESM, vitest, execFileSync

---

## Context

The login-recipe-auth branch introduced `loginWithCredentials` — a mechanical replayer that fills email/password and clicks "Sign In" using browse commands. Two bugs surfaced:

1. **ETIMEDOUT**: `browse restart` hangs ~30s when daemons won't shut down cleanly. A `pkill` workaround was added but kills ALL browse daemons system-wide, breaking concurrent sessions.
2. **Auth check race**: A fixed `sleep 3` + `sleep 2` (5s total) is too short for some apps and wastefully long for others.

The eng review agreed on: remove daemon lifecycle from loginWithCredentials (1B), poll instead of sleep (2B), update JSDoc (3A), add poll tests (4A), add browse stop TODO (5A).

---

### Task 1: Remove pkill + daemon lifecycle from loginWithCredentials

**Files:**
- Modify: `pipeline/src/init.ts:1-54`

**Step 1: Edit init.ts — remove execSync import and pkill block**

Remove the `execSync` import (line 4) and replace lines 47-54 with just the step replay — no daemon management at all. The function should assume the daemon is already running (caller's responsibility).

```typescript
// pipeline/src/init.ts — line 1-6, replace import line
import { execFileSync } from "node:child_process";
// (remove execSync — no longer needed)
```

```typescript
// pipeline/src/init.ts — lines 47-54, replace with just the try block opening
  try {
    for (const step of loginSteps) {
```

Remove these lines entirely:
- Line 48-51: the pkill comment and execSync call
- Line 53-54: the "Start a fresh daemon" comment and goto about:blank

**Step 2: Update JSDoc on loginWithCredentials (line 33-36)**

Replace:
```typescript
/**
 * Replay saved login steps from config.json.
 * Restarts the browse daemon first to guarantee a clean cookie jar.
 * No LLM, no regex — pure mechanical replay of steps discovered during /verify-setup.
 */
```

With:
```typescript
/**
 * Replay saved login steps from config.json.
 * Caller must ensure browse daemon is running (via startDaemon or runPreflight).
 * No LLM, no regex — pure mechanical replay of steps discovered during /verify-setup.
 */
```

**Step 3: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Clean (no errors)

**Step 4: Commit**

```bash
git add pipeline/src/init.ts
git commit -m "fix(pipeline): remove pkill + daemon lifecycle from loginWithCredentials

Callers (runPreflight, CLI) manage daemon lifecycle. loginWithCredentials
is now pure navigation: fill, click, goto. Removes the system-wide pkill
that would kill concurrent browse sessions."
```

---

### Task 2: Add startDaemon to standalone verify-login CLI handler

**Files:**
- Modify: `pipeline/src/cli.ts:379-389`

**Step 1: Wire startDaemon before loginWithCredentials in the verify-login case**

The standalone `run-stage verify-login` needs to ensure a daemon is running before calling `loginWithCredentials`. `runPreflight` already does this for full pipeline runs, but the standalone stage skips preflight.

In `pipeline/src/cli.ts`, the `verify-login` case (line 379) should become:

```typescript
    case "verify-login": {
      const { startDaemon } = await import("./lib/browse.js");
      const { loginWithCredentials } = await import("./init.js");
      startDaemon({});
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

**Step 2: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Clean

**Step 3: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "fix(pipeline): ensure browse daemon running for standalone verify-login

startDaemon() gives a clean browser session (stop + goto about:blank).
This was previously done inside loginWithCredentials but now lives in
the caller per the separation of concerns fix."
```

---

### Task 3: Replace verifyAuthState with poll-based waitForAuth

**Files:**
- Modify: `pipeline/src/init.ts:82-111`

**Step 1: Remove the sleep 3 after the step loop and replace verifyAuthState**

Remove line 83-84 (the `sleep 3` after steps). Then replace the `verifyAuthState` function (lines 92-111) with a polling version:

```typescript
/**
 * Poll until authenticated: navigate to baseUrl, take snapshot, check for password field.
 * Returns as soon as password field is gone (auth succeeded) or after maxWait ms (auth failed).
 */
function waitForAuth(
  baseUrl: string,
  bin: string,
  opts: { cwd?: string } = {},
  maxWait = 10_000,
  interval = 500,
): CheckResult {
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    try {
      execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", ...opts });
      const snapshot = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", ...opts });

      const hasPasswordField = /\[textbox\].*password|\[text\].*password/i.test(snapshot);
      if (!hasPasswordField) {
        return { ok: true };
      }
    } catch {
      // Browse command failed — retry on next iteration
    }

    // Sleep between polls
    if (Date.now() < deadline) {
      execFileSync("sleep", ["0.5"], { timeout: 2_000, stdio: "ignore" });
    }
  }

  return { ok: false, error: "Login steps did not authenticate — still on login page after 10s. Re-run /verify-setup." };
}
```

Update the call site (line 86) to use the new function:

```typescript
    return waitForAuth(config.baseUrl, bin, opts);
```

**Step 2: Run typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Clean

**Step 3: Test manually against documenso**

Run: `pkill -f "bun run.*browse/src/server.ts" 2>/dev/null; sleep 1; cd ~/Projects/opslane/evals/documenso && npx tsx ~/Projects/opslane/verify/pipeline/src/cli.ts run-stage verify-login --verify-dir .verify`
Expected: `Login recipe verified — authentication succeeded.`

**Step 4: Commit**

```bash
git add pipeline/src/init.ts
git commit -m "fix(pipeline): replace fixed sleeps with poll-based auth verification

waitForAuth polls every 500ms for up to 10s, checking the snapshot for
password fields. Returns immediately when auth succeeds. Replaces the
fragile sleep 3 + sleep 2 (5s fixed) that was too short for slow apps
and wastefully long for fast ones."
```

---

### Task 4: Update tests for new behavior

**Files:**
- Modify: `pipeline/test/init.test.ts:71-241`

**Step 1: Update the "restarts daemon" test to "starts with first login step"**

The test at line 80 currently asserts the first execFileSync call is `["goto", "about:blank"]`. With Task 1, the first call should now be the first login step's goto. Rename and update:

```typescript
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
    // First call is the first login step — no daemon lifecycle
    expect(mockExec.mock.calls[0][0]).toBe("/mock/browse");
    expect(mockExec.mock.calls[0][1]).toEqual(["goto", "http://localhost:3000/login"]);
  });
```

**Step 2: Update the "replays goto, fill, click steps in order" test**

Remove the `goto about:blank` assertion. The step order should be: goto, fill, fill, click, then poll calls.

```typescript
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

    // Verify step order: goto, fill email, fill password, click, then poll
    const calls = mockExec.mock.calls.map(c => c[1]);
    expect(calls[0]).toEqual(["goto", "http://localhost:3000/auth/login"]);
    expect(calls[1]).toEqual(["fill", "[name='email']", "admin@test.com"]);
    expect(calls[2]).toEqual(["fill", "[name='password']", "secret"]);
    expect(calls[3]).toEqual(["click", "button:has-text('Sign in')"]);
  });
```

**Step 3: Update the "absolute URLs" test**

Remove the `goto about:blank` assertion from the filter:

```typescript
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
```

**Step 4: Update the "browse command throws" test mock sequence**

The mock at line 202 has comments about "restart" and "goto" as first two calls. Update to match new behavior (no restart, no goto about:blank — first call is the login step goto):

```typescript
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
```

**Step 5: Add poll test — auth succeeds on first poll**

```typescript
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
```

**Step 6: Add poll test — auth succeeds after retries**

```typescript
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
```

**Step 7: Add poll test — auth times out**

```typescript
  it("waitForAuth returns error when password field persists after max wait", async () => {
    const { loginWithCredentials } = await import("../src/init.js");
    // Every snapshot shows login page — auth never completes
    mockExec.mockReturnValue(Buffer.from(
      "@e1 [textbox] \"Email\"\n@e2 [textbox] \"Password\"\n@e3 [button] \"Sign In\""
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
    // Note: this test will take ~10s due to the poll loop with real sleep calls.
    // The mock swallows the sleeps instantly since execFileSync is mocked.
    const result = loginWithCredentials(config, "/tmp");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("still on login page");
  });
```

**Step 8: Run tests**

Run: `cd pipeline && npx vitest run test/init.test.ts`
Expected: All tests pass

Run: `cd pipeline && npx vitest run`
Expected: All 257+ tests pass

**Step 9: Commit**

```bash
git add pipeline/test/init.test.ts
git commit -m "test(pipeline): update login tests for poll-based auth verification

- Remove daemon lifecycle assertions (no more goto about:blank first call)
- Add 3 poll test cases: immediate success, delayed success (3rd poll),
  timeout after max retries
- Update mock sequences to match new call order"
```

---

### Task 5: Add browse stop hang TODO

**Files:**
- Modify: `TODOS.md`

**Step 1: Add P1 TODO for upstream browse stop hang**

Add after the first `---` separator (before the P2 items):

```markdown
## P1 — Upstream: gstack browse stop hangs ~30s

**What:** `browse stop` and `browse restart` hang for ~30 seconds when the daemon won't shut down cleanly, then time out. This causes orphaned daemon accumulation.

**Why:** This is the root cause of the ETIMEDOUT errors in verify-login. The verify pipeline works around it by not calling stop/restart, but the underlying browse bug remains. Orphaned daemons accumulate over time and compete for the port.

**Context:** Reproduced consistently: `time ~/.cache/verify/gstack/browse/dist/browse stop` → 31s, exit 1, "The operation timed out". This happens when multiple browse daemons are running (common when multiple Claude sessions use browse). The `startDaemon` function in `browse.ts` also calls `stop` and is affected. File upstream on gstack.

**Depends on:** Nothing — this is an upstream gstack issue.

**Effort:** XS human (file issue) → XS with CC+gstack
```

**Step 2: Commit**

```bash
git add TODOS.md
git commit -m "docs: add P1 TODO for upstream gstack browse stop hang"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: Typecheck clean, all tests pass

**Step 2: E2E test against documenso**

Run: `pkill -f "bun run.*browse/src/server.ts" 2>/dev/null; sleep 1; cd ~/Projects/opslane/evals/documenso && npx tsx ~/Projects/opslane/verify/pipeline/src/cli.ts run-stage verify-login --verify-dir .verify`
Expected: `Login recipe verified — authentication succeeded.`

**Step 3: E2E test with orphaned daemons present**

Start an orphan daemon, then verify login still works:
```bash
~/.cache/verify/gstack/browse/dist/browse goto about:blank
cd ~/Projects/opslane/evals/documenso && npx tsx ~/Projects/opslane/verify/pipeline/src/cli.ts run-stage verify-login --verify-dir .verify
```
Expected: `Login recipe verified — authentication succeeded.` (daemon is reused, not killed)
