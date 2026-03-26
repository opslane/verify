# Parallel Browse Daemons Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix auth failures caused by parallel browse groups sharing one Chromium daemon — give each group its own isolated daemon.

**Architecture:** Each parallel group starts its own browse daemon via `BROWSE_STATE_FILE` env isolation, logs in independently, runs its ACs, then kills the daemon. Per-group `AbortController` ensures auth failures are group-scoped. False positive auth detection is fixed by making `isAuthFailure()` aware of the AC's target URL.

**Tech Stack:** TypeScript, Node 22 ESM, gstack browse daemon (Playwright/Chromium), vitest

---

### Task 1: Make `isAuthFailure()` context-aware + add `login_failed` verdict

**Files:**
- Modify: `pipeline/src/lib/types.ts:98,213-227`
- Modify: `pipeline/test/auth-failure.test.ts`

**IMPORTANT:** The `url` parameter in the current `isAuthFailure(observed, url?)` meant "the URL
the browser ended up at." We are repurposing it to mean "the AC's intended target URL" (renamed
to `acTargetUrl`). The old URL-parameter check (line 225) is removed — it's dead code in the new
design since the orchestrator only passes the AC's target, not the observed URL.

**Step 1: Add `login_failed` to `Verdict` type**

In `pipeline/src/lib/types.ts`, find the `Verdict` type union (line ~98):
```typescript
export type Verdict = "pass" | "fail" | "error" | "timeout" | "skipped"
  | "setup_failed" | "setup_unsupported" | "plan_error" | "auth_expired"
```

Add `| "login_failed"` to the union.

**Step 2: Write the failing tests**

Add these tests to `pipeline/test/auth-failure.test.ts`:

```typescript
// New: context-aware detection with acTargetUrl parameter
it("returns false when AC targets /signin and observed mentions /signin", () => {
  expect(isAuthFailure("Auth redirect: navigated to /signin, was redirected to dashboard", "/signin")).toBe(false);
});

it("returns false when AC targets /signup", () => {
  expect(isAuthFailure("Page shows sign up form at /signup", "/signup")).toBe(false);
});

it("returns false when AC targets /forgot-password (contains /auth path)", () => {
  expect(isAuthFailure("Navigated to /auth/forgot-password", "/auth/forgot-password")).toBe(false);
});

it("returns true when AC targets /documents but observed says Auth redirect", () => {
  expect(isAuthFailure("Auth redirect: redirected to /signin", "/documents")).toBe(true);
});

it("returns true when AC targets /documents and observed mentions /signin", () => {
  expect(isAuthFailure("Ended up at /signin page", "/documents")).toBe(true);
});

it("does not match /authorize or /author when checking auth page patterns", () => {
  expect(isAuthFailure("Auth redirect: went to /authorize", "/authorize")).toBe(true);
});
```

Also **update the two existing tests** that pass a URL — their semantics changed. The `url`
parameter now means "AC target URL", not "URL the browser ended up at":

```typescript
// UPDATED: url param is now acTargetUrl (the AC's intended page)
// When AC targets /auth/callback, auth detection is suppressed (AC is testing that page)
it("suppresses auth detection when AC targets an auth URL", () => {
  expect(isAuthFailure("Some page loaded", "/auth/callback")).toBe(false);
});

// When AC targets /login, auth detection is suppressed
it("suppresses auth detection when AC targets /login", () => {
  expect(isAuthFailure("Page loaded OK", "/login?next=/dashboard")).toBe(false);
});
```

**Step 3: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/auth-failure.test.ts`
Expected: Multiple tests FAIL

**Step 4: Implement context-aware `isAuthFailure()`**

Replace `isAuthFailure` in `pipeline/src/lib/types.ts:223-227`:

```typescript
/** Auth page URL patterns — ACs testing these pages should not trigger the circuit breaker.
 *  Uses boundary-aware matching to avoid false matches on /authorize, /author, etc. */
const AUTH_PAGE_PATTERNS = /\/login(?:\/|$|\?)|\/signin(?:\/|$|\?)|\/signup(?:\/|$|\?)|\/auth(?:\/|$|\?)|\/forgot-password/i;

export function isAuthFailure(observed: string, acTargetUrl?: string): boolean {
  // If this AC intentionally targets an auth page, don't trigger on auth patterns
  // in the observed text — the agent was supposed to be on that page.
  if (acTargetUrl && AUTH_PAGE_PATTERNS.test(acTargetUrl)) {
    return false;
  }

  return AUTH_FAILURE_PATTERNS.some(p => p.test(observed));
}
```

Note: the old `url` parameter check (`if (url && /\/login|\/signin|\/auth/.test(url)) return true`)
is removed. In the new design, `acTargetUrl` is the AC's intended page, not the observed URL.
That check was dead code — if the AC targets `/login`, we suppress (return false above);
if not, the observed text patterns already catch it.

**Step 5: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/auth-failure.test.ts`
Expected: ALL tests PASS (updated existing + new)

**Step 6: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/test/auth-failure.test.ts
git commit -m "fix(pipeline): make isAuthFailure context-aware, add login_failed verdict"
```

---

### Task 2: Refine browse agent CRITICAL RULE 3

**Files:**
- Modify: `pipeline/src/prompts/browse-agent.txt:42`

**Step 1: Update CRITICAL RULE 3**

Replace line 42 in `pipeline/src/prompts/browse-agent.txt`:

Old:
```
3. If you see a login page or auth redirect, report it in "observed" and start the observed text with `Auth redirect:`. Do NOT try to log in.
```

New:
```
3. If you were redirected to a login or signin page that you did NOT intend to visit, start the observed text with `Auth redirect:`. Do NOT try to log in. If your target URL IS a login/signin/signup page (i.e., the AC is about testing that page), report what you see normally — do NOT prefix with `Auth redirect:`.
```

**Step 2: Run existing browse-agent tests**

Run: `cd pipeline && npx vitest run test/browse-agent.test.ts`
Expected: PASS (prompt content isn't tested by unit tests, but verify nothing breaks)

**Step 3: Commit**

```bash
git add pipeline/src/prompts/browse-agent.txt
git commit -m "fix(pipeline): refine browse agent auth redirect rule for auth page ACs"
```

---

### Task 3: Add `env` to `RunClaudeOptions`

**Files:**
- Modify: `pipeline/src/lib/types.ts:155-167`
- Modify: `pipeline/src/run-claude.ts:45-46`

**Step 1: Add `env` field to `RunClaudeOptions`**

In `pipeline/src/lib/types.ts`, add after line 166 (`onProgress`):

```typescript
  env?: Record<string, string>;         // extra env vars merged into subprocess (e.g. BROWSE_STATE_FILE)
```

**Step 2: Merge env in `runClaude` spawn**

In `pipeline/src/run-claude.ts:45-46`, change:

```typescript
    const child = spawn(claudeBin, args, {
      env: { ...process.env },
```

To:

```typescript
    const child = spawn(claudeBin, args, {
      env: { ...process.env, ...opts.env },
```

**Step 3: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 4: Run existing tests**

Run: `cd pipeline && npx vitest run test/run-claude.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/run-claude.ts
git commit -m "feat(pipeline): add env option to RunClaudeOptions for subprocess env vars"
```

---

### Task 4: Add group daemon helpers to `browse.ts`

**Files:**
- Modify: `pipeline/src/lib/browse.ts`
- Modify: `pipeline/test/browse.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/browse.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startGroupDaemon, stopGroupDaemon, stopAllGroupDaemons } from "../src/lib/browse.js";

const TEST_RUN_DIR = "/tmp/verify-browse-test-" + process.pid;

describe("group daemon helpers", () => {
  beforeEach(() => {
    mkdirSync(TEST_RUN_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up any daemons we started
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
      // Should not throw
      expect(() => stopGroupDaemon(stateDir)).not.toThrow();
    });

    it("handles dead PID gracefully", () => {
      const stateDir = join(TEST_RUN_DIR, ".browse-dead");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, "browse.json"), JSON.stringify({ pid: 999999999, port: 12345, token: "test" }));
      // Should not throw even though PID doesn't exist
      expect(() => stopGroupDaemon(stateDir)).not.toThrow();
    });
  });

  describe("stopAllGroupDaemons", () => {
    it("is a no-op when no group dirs exist", () => {
      expect(() => stopAllGroupDaemons(TEST_RUN_DIR)).not.toThrow();
    });

    it("finds and processes all .browse-* dirs", () => {
      // Create fake state dirs
      for (const g of ["g1", "g2", "g3"]) {
        const dir = join(TEST_RUN_DIR, `.browse-${g}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "browse.json"), JSON.stringify({ pid: 999999999, port: 12345, token: "test" }));
      }
      // Should process all 3 without throwing
      expect(() => stopAllGroupDaemons(TEST_RUN_DIR)).not.toThrow();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/browse.test.ts`
Expected: FAIL — `startGroupDaemon`, `stopGroupDaemon`, `stopAllGroupDaemons` don't exist

**Step 3: Implement group daemon helpers**

Add to `pipeline/src/lib/browse.ts`:

```typescript
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";

export interface GroupDaemonEnv {
  env: Record<string, string>;
  stateDir: string;
}

/**
 * Create an isolated state directory for a group's browse daemon.
 * The daemon auto-starts on the first `browse goto` command that uses this env.
 */
export function startGroupDaemon(groupId: string, runDir: string): GroupDaemonEnv {
  const stateDir = join(runDir, `.browse-${groupId}`);
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "browse.json");
  return {
    env: { BROWSE_STATE_FILE: stateFile },
    stateDir,
  };
}

/**
 * Kill a group daemon by reading its PID from the state file.
 * Uses process.kill directly — avoids `browse stop` which hangs (TODOS P1).
 */
export function stopGroupDaemon(stateDir: string): void {
  const stateFile = join(stateDir, "browse.json");
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (state.pid) {
      try { process.kill(state.pid, "SIGTERM"); } catch { /* already dead */ }
    }
  } catch {
    // State file missing or unparseable — daemon was never started or already cleaned up
  }
}

/**
 * Kill all group daemons under a run directory. Safety net for cleanup.
 */
export function stopAllGroupDaemons(runDir: string): void {
  try {
    const entries = readdirSync(runDir);
    for (const entry of entries) {
      if (entry.startsWith(".browse-")) {
        stopGroupDaemon(join(runDir, entry));
      }
    }
  } catch {
    // runDir doesn't exist or can't be read — nothing to clean up
  }
}
```

Update the imports at the top of `browse.ts` to include `mkdirSync`, `readFileSync`, `readdirSync` from `node:fs` (replace the existing `existsSync` import).

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/browse.test.ts`
Expected: ALL tests PASS

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/lib/browse.ts pipeline/test/browse.test.ts
git commit -m "feat(pipeline): add group daemon helpers for per-group browse isolation"
```

---

### Task 5: Extract `loginOnDaemon()` from `loginWithCredentials()`

**Files:**
- Modify: `pipeline/src/init.ts`

**Step 1: Extract login logic**

Refactor `loginWithCredentials` in `pipeline/src/init.ts` to:

1. Add a new exported function `loginOnDaemon(config: VerifyConfig, extraEnv: Record<string, string>): CheckResult` that contains the login replay logic. It uses `extraEnv` when calling `execFileSync` for browse commands (merged into `process.env`).

2. Simplify `loginWithCredentials` to be a thin wrapper that calls `loginOnDaemon(config, {})` (empty extra env = use default daemon).

The key change: every `execFileSync(bin, [...], { ... })` call inside the login replay needs to pass `env: { ...process.env, ...extraEnv }` so the browse CLI targets the right daemon.

```typescript
/**
 * Login on a specific browse daemon identified by env vars (e.g., BROWSE_STATE_FILE).
 * Reusable for both the primary daemon (preflight) and per-group daemons.
 */
export function loginOnDaemon(config: VerifyConfig, extraEnv: Record<string, string> = {}): CheckResult {
  if (!config.auth || !config.auth.email || !config.auth.password || !config.auth.loginSteps?.length) {
    return { ok: false, error: "No auth config — run /verify-setup to configure login" };
  }

  const bin = resolveBrowseBin();
  const { email, password, loginSteps } = config.auth;
  const verbose = process.env.VERIFY_VERBOSE_AUTH === "1";
  const log = verbose ? (msg: string) => console.error(`[auth] ${msg}`) : (_msg: string) => {};
  const spawnEnv = { ...process.env, ...extraEnv };

  try {
    for (let i = 0; i < loginSteps.length; i++) {
      const step = loginSteps[i];
      log(`Step ${i + 1}/${loginSteps.length}: ${step.action} ${step.action === "goto" ? step.url : step.action === "fill" ? step.selector : step.action === "click" ? step.selector : ""}`);
      switch (step.action) {
        case "goto": {
          const url = step.url.startsWith("http://") || step.url.startsWith("https://")
            ? step.url
            : `${config.baseUrl}${step.url}`;
          const gotoOut = execFileSync(bin, ["goto", url], { timeout: 10_000, encoding: "utf-8", env: spawnEnv });
          log(`  goto result: ${gotoOut.trim()}`);
          execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });
          if (verbose) {
            const snap = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: spawnEnv });
            log(`  post-goto snapshot (first 5 lines):\n${snap.split("\n").slice(0, 5).map(l => `    ${l}`).join("\n")}`);
          }
          break;
        }
        case "fill": {
          const value = step.value
            .replaceAll("{{email}}", email)
            .replaceAll("{{password}}", password);
          const fillOut = execFileSync(bin, ["fill", step.selector, value], { timeout: 5_000, encoding: "utf-8", env: spawnEnv });
          log(`  fill result: ${fillOut.trim()}`);
          break;
        }
        case "click": {
          const clickOut = execFileSync(bin, ["click", step.selector], { timeout: 5_000, encoding: "utf-8", env: spawnEnv });
          log(`  click result: ${clickOut.trim()}`);
          break;
        }
        case "sleep": {
          const seconds = Math.min(Math.ceil(step.ms / 1000), 30);
          execFileSync("sleep", [String(seconds)], { timeout: seconds * 1000 + 2_000, stdio: "ignore" });
          break;
        }
      }
    }

    log("Post-submit sleep 3s...");
    execFileSync("sleep", ["3"], { timeout: 5_000, stdio: "ignore" });

    if (verbose) {
      try {
        const pid = execSync("pgrep -f 'bun run.*/\\.cache/verify/.*browse/src/server\\.ts'", { timeout: 2_000, encoding: "utf-8" }).trim();
        log(`Daemon PID: ${pid}`);
      } catch { log("Daemon PID: not found"); }
    }

    return waitForAuth(config.baseUrl, bin, 10_000, 500, verbose, spawnEnv);
  } catch (err: unknown) {
    return { ok: false, error: `Login replay failed: ${err instanceof Error ? err.message : String(err)}. Re-run /verify-setup.` };
  }
}

export function loginWithCredentials(config: VerifyConfig, _projectRoot?: string): CheckResult {
  // Kill zombie browse daemons (only for the primary daemon, not per-group daemons)
  const verbose = process.env.VERIFY_VERBOSE_AUTH === "1";
  if (verbose) console.error("[auth] Killing zombie browse daemons...");
  try { execSync("pkill -f 'bun run.*/\\.cache/verify/.*browse/src/server\\.ts'", { timeout: 3_000, stdio: "ignore" }); } catch { /* none running */ }
  try { execFileSync("sleep", ["1"], { timeout: 3_000, stdio: "ignore" }); } catch { /* ignore */ }

  return loginOnDaemon(config);
}
```

Also update `waitForAuth` to accept and pass through `spawnEnv`.
**NOTE:** `process.env` is `NodeJS.ProcessEnv` (`Record<string, string | undefined>`), not
`Record<string, string>`. Do NOT use `as Record<string, string>` cast. Type the parameter
correctly:

```typescript
function waitForAuth(
  baseUrl: string,
  bin: string,
  maxWait = 10_000,
  interval = 500,
  verbose = false,
  spawnEnv: NodeJS.ProcessEnv = process.env,
): CheckResult {
  // ... same logic but use spawnEnv in execFileSync calls:
  // execFileSync(bin, ["goto", baseUrl], { timeout: 10_000, stdio: "ignore", env: spawnEnv });
  // execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: spawnEnv });
```

Similarly, update `loginOnDaemon`'s `spawnEnv` line to:
```typescript
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
```

**Step 2: Add test for env propagation**

Add a test to `pipeline/test/init.test.ts` that verifies `loginOnDaemon` passes the extra
env to `execFileSync` calls:

```typescript
it("loginOnDaemon passes BROWSE_STATE_FILE to execFileSync", async () => {
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
```

**Step 3: Run existing tests**

Run: `cd pipeline && npx vitest run test/init.test.ts`
Expected: PASS (loginWithCredentials behaves identically for the default daemon)

**Step 4: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/init.ts
git commit -m "refactor(pipeline): extract loginOnDaemon for per-group daemon auth"
```

---

### Task 6: Wire per-group daemons into `orchestrator.ts`

**Files:**
- Modify: `pipeline/src/orchestrator.ts:149-457`

This is the core change. The orchestrator needs to:
1. Remove the single shared `AbortController`
2. In `executeGroup()`: start a group daemon, login, run ACs with the group's env, stop daemon
3. Pass `ac.url` to `isAuthFailure()` for context-aware detection
4. Clean up all group daemons after `Promise.all`

**Step 1: Update imports**

At the top of `orchestrator.ts`, add:

```typescript
import { startGroupDaemon, stopGroupDaemon, stopAllGroupDaemons } from "./lib/browse.js";
import { loginOnDaemon } from "./init.js";
```

**Step 2: Remove global AbortController**

Delete line 152: `const abortController = new AbortController();`

**Step 3: Update `executeGroup()` to own its daemon lifecycle**

Replace the function to add daemon lifecycle. Key changes (line references to current code):

At the start of `executeGroup()` (after line 191):
```typescript
  async function executeGroup(groupId: string): Promise<void> {
    const groupAcs = groupMap.get(groupId)!;
    const condition = groupConditions.get(groupId);

    // Per-group browse daemon isolation
    const { env: groupEnv, stateDir: groupStateDir } = startGroupDaemon(groupId, runDir);
    const groupAbort = new AbortController();

    // Login on this group's daemon
    const loginResult = loginOnDaemon(config, groupEnv);
    if (!loginResult.ok) {
      callbacks.onLog(`  ${groupId}: login failed — ${loginResult.error}`);
      for (const ac of groupAcs) {
        allVerdicts.push({ ac_id: ac.id, verdict: "login_failed", confidence: "high", reasoning: loginResult.error ?? "Login failed" });
        progress.update(ac.id, "error", "login_failed");
      }
      stopGroupDaemon(groupStateDir);
      return;
    }

    try {
      // ... existing setup logic (unchanged) ...
```

In the AC loop (around line 276), replace `abortController` with `groupAbort`:
```typescript
      if (groupAbort.signal.aborted) {
        allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", ... });
```

In the `runClaude` calls for browse agents (line 294), add env:
```typescript
      const agentResult = await runClaude({
        prompt: agentPrompt, model: "sonnet", timeoutMs: computeTimeoutMs(enrichedAc.steps),
        stage: `browse-agent-${ac.id}`, runDir, env: groupEnv, ...perms("browse-agent"),
      });
```

Also add `env: groupEnv` to replan browse agent retry calls (around line 345-348).

In the auth circuit breaker (line 389), pass `ac.url` and use `groupAbort`:
```typescript
        if (isAuthFailure(browseResult.observed, ac.url)) {
          callbacks.onError(`Auth session expired in group ${groupId}.`);
          groupAbort.abort();
          allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", ... });
```

At the end of `executeGroup()`, add finally block:
```typescript
    } finally {
      stopGroupDaemon(groupStateDir);
    }
  }
```

**Step 4: Remove global abort handling after `Promise.all`**

Delete lines 446-457 (the block that iterates all groups looking for unprocessed ACs with the global abortController). Each group now handles its own abort internally.

**Step 5: Add safety net cleanup**

After `Promise.all` (line 444), add:
```typescript
  // Safety net: kill any group daemons that survived (crash, exception)
  stopAllGroupDaemons(runDir);
```

**Step 6: Remove `browseBin` from `executeGroup` scope**

The `browseBin` variable (line 151) is still needed for `buildBrowseAgentPrompt`. Keep it.

**Step 7: Optimize setup groups — shared daemon for serial chain**

Setup groups run sequentially (they share the DB). Since they never run concurrently,
they can share a single daemon — no contention. This avoids ~5-8s login overhead per
serial group.

Create one shared daemon before the serial chain, pass it to each setup group, kill it
after all setup groups complete:

```typescript
  // Setup groups share one daemon (they run serially — no contention)
  let setupDaemonEnv: Record<string, string> | null = null;
  let setupDaemonStateDir: string | null = null;

  const setupChainPromise = (async () => {
    if (setupGroupIds.length > 0) {
      const { env, stateDir } = startGroupDaemon("setup-shared", runDir);
      setupDaemonEnv = env;
      setupDaemonStateDir = stateDir;
      const loginResult = loginOnDaemon(config, env);
      if (!loginResult.ok) {
        callbacks.onLog(`  setup-shared: login failed — ${loginResult.error}`);
        for (const groupId of setupGroupIds) {
          for (const ac of groupMap.get(groupId)!) {
            allVerdicts.push({ ac_id: ac.id, verdict: "login_failed", confidence: "high", reasoning: loginResult.error ?? "Login failed" });
            progress.update(ac.id, "error", "login_failed");
          }
        }
        stopGroupDaemon(stateDir);
        return;
      }
      for (const groupId of setupGroupIds) {
        await executeGroup(groupId, env);  // pass shared daemon env
      }
      stopGroupDaemon(stateDir);
    }
  })();
```

Update `executeGroup` signature to accept optional pre-existing daemon env:

```typescript
  async function executeGroup(groupId: string, sharedDaemonEnv?: Record<string, string>): Promise<void> {
    // If shared env provided, use it; otherwise start own daemon (pure-UI groups)
    const ownsDaemon = !sharedDaemonEnv;
    const { env: groupEnv, stateDir: groupStateDir } = sharedDaemonEnv
      ? { env: sharedDaemonEnv, stateDir: "" }
      : startGroupDaemon(groupId, runDir);

    if (ownsDaemon) {
      const loginResult = loginOnDaemon(config, groupEnv);
      if (!loginResult.ok) { /* ... handle login failure, stop daemon, return ... */ }
    }

    try {
      // ... rest of executeGroup (setup, browse agents, teardown) ...
    } finally {
      if (ownsDaemon) stopGroupDaemon(groupStateDir);
    }
  }
```

The pure-UI parallel groups still create their own daemon (no `sharedDaemonEnv` passed):
```typescript
  const pureUIPromises = pureUIGroupIds.map((groupId) => executeGroup(groupId));
```

**Step 8: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 9: Run existing tests**

Run: `cd pipeline && npx vitest run test/orchestrator.test.ts`
Expected: PASS (existing tests may need mock updates if they reference the old AbortController)

**Step 10: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(pipeline): per-group browse daemon isolation and group-scoped abort"
```

---

### Task 7: Integration test — parallel daemon isolation

**Files:**
- Create: `pipeline/test/browse-parallel.test.ts`

This test starts 2 real daemons, logs in on both, navigates them to different pages in parallel, and verifies no cross-contamination. Requires the documenso dev server running on localhost:3003.

**Step 1: Write the integration test**

```typescript
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
    resolveBrowseBin();  // throws if missing
    execFileSync("curl", ["-sf", "-o", "/dev/null", BASE_URL], { timeout: 3_000 });
    return true;
  } catch { return false; }
})();

describe.skipIf(!canRun)("parallel browse daemon isolation", () => {
  afterEach(() => {
    try { stopAllGroupDaemons(TEST_RUN_DIR); } catch { /* ignore */ }
    try { rmSync(TEST_RUN_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  it("two daemons navigate to different pages without interference", async () => {
    mkdirSync(TEST_RUN_DIR, { recursive: true });
    const bin = resolveBrowseBin();

    // Start two isolated daemons
    const d1 = startGroupDaemon("g1", TEST_RUN_DIR);
    const d2 = startGroupDaemon("g2", TEST_RUN_DIR);

    const env1 = { ...process.env, ...d1.env };
    const env2 = { ...process.env, ...d2.env };

    // Navigate both to different pages (sequentially for determinism in test)
    execFileSync(bin, ["goto", `${BASE_URL}/signin`], { timeout: 10_000, env: env1, stdio: "ignore" });
    execFileSync(bin, ["goto", `${BASE_URL}/signup`], { timeout: 10_000, env: env2, stdio: "ignore" });

    // Give pages time to load
    execFileSync("sleep", ["2"], { timeout: 5_000, stdio: "ignore" });

    // Snapshot both — they should show DIFFERENT pages
    const snap1 = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: env1 });
    const snap2 = execFileSync(bin, ["snapshot", "-i"], { timeout: 5_000, encoding: "utf-8", env: env2 });

    // D1 should show sign-in form (has "Sign In" button)
    expect(snap1).toMatch(/Sign In/);
    // D2 should show sign-up form (has "Create account" or "Sign up")
    expect(snap2).toMatch(/Sign up|Create account/i);

    // Crucially: D1 should NOT show sign-up content
    expect(snap1).not.toMatch(/Create account/i);

    // Cleanup
    stopGroupDaemon(d1.stateDir);
    stopGroupDaemon(d2.stateDir);
  }, 30_000);
});
```

**Step 2: Run the test**

Run: `cd pipeline && npx vitest run test/browse-parallel.test.ts`
Expected: PASS (if dev server is running) or SKIP (if not)

**Step 3: Commit**

```bash
git add pipeline/test/browse-parallel.test.ts
git commit -m "test(pipeline): integration test for parallel browse daemon isolation"
```

---

### Task 8: Full verification

**Step 1: Typecheck everything**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS — zero errors

**Step 2: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: ALL PASS

**Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(pipeline): address test/typecheck issues from parallel browse daemons"
```
