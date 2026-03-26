# Parallel Browse Daemons — Fix Auth Failures in Concurrent Groups

## Problem

Browse agent eval results show 30 `auth_redirect` root causes across 33 documenso PRs. Investigation revealed two distinct bugs:

### Bug 1: Parallel groups share one browse daemon (root cause for 3 PRs)

The orchestrator runs pure-UI groups in parallel (`Promise.all`), but all groups share a single browse daemon — one Chromium process, one BrowserContext, one active tab. When group A's browse agent runs `goto /templates` and group B simultaneously runs `goto /documents`, they stomp on each other's page state. Group A's next `snapshot` sees group B's page.

Worse: if one group's navigation triggers a page that looks like a login redirect, `isAuthFailure()` fires the circuit breaker and aborts ALL remaining ACs across ALL groups (shared `AbortController`).

```
CURRENT (broken):
                                    ┌─────────────┐
  Group 1 (claude -p) ──goto───►   │             │
  Group 2 (claude -p) ──goto───►   │ ONE daemon  │ ──► ONE Chromium tab
  Group 3 (claude -p) ──goto───►   │ (port 42934)│
                                    └─────────────┘
  Result: groups stomp each other's page state
```

### Bug 2: False positive auth detection (root cause for 1 PR)

When an AC intentionally tests a public auth page (e.g., `/signin`), the browse agent either:
- Sees the sign-in form and follows prompt CRITICAL RULE 3: "report `Auth redirect:`"
- Gets redirected away from `/signin` (authenticated user → dashboard)

Either way, `isAuthFailure()` matches and the circuit breaker kills all remaining ACs.

### Evidence

- Spike confirmed: two daemons with different `BROWSE_STATE_FILE` env vars run fully isolated (different ports, different Chromium processes, no interference under parallel navigation)
- Session survival spike: auth cookies survive 2+ minutes of idle — session expiry is not the issue
- `loginWithCredentials()` works reliably — auth is established correctly each time

## Decisions (from eng review)

1. **Login per daemon** (not cookie transfer) — each group daemon logs in independently. ~5s each, runs in parallel. Simpler than cookie export/import.
2. **Daemon lifecycle inside `executeGroup()`** — each group owns its daemon start → login → ACs → stop. Self-contained.
3. **Per-group AbortController** — auth failure in one group kills only that group's ACs. Other groups continue independently.
4. **Env var on subprocess** — `BROWSE_STATE_FILE` set on the `claude -p` spawn env, not injected into the prompt. Invisible to LLM, can't be forgotten.

## Solution

### Part 1: Per-group browse daemon isolation

```
PROPOSED:
  Group 1 (claude -p) ──► daemon-g1 (port A) ──► Chromium 1
  Group 2 (claude -p) ──► daemon-g2 (port B) ──► Chromium 2
  Group 3 (claude -p) ──► daemon-g3 (port C) ──► Chromium 3

  Each daemon has its own BROWSE_STATE_FILE, port, and Chromium process.
  Groups are fully isolated — no shared page state.
```

**Implementation:**

1. **`browse.ts` — add group daemon helpers**
   - `startGroupDaemon(groupId: string, runDir: string)`: creates state dir at `{runDir}/.browse-{groupId}/`, returns `{ stateFile: string, env: Record<string, string> }`. The first `browse goto` with this env auto-starts the daemon.
   - `stopGroupDaemon(stateDir: string)`: reads the state file to get PID, kills the process via `process.kill(pid)` (avoids `browse stop` which hangs — see TODOS P1). Removes state file.
   - `stopAllGroupDaemons(runDir: string)`: finds all `.browse-*` state dirs under runDir, kills each daemon. Safety net for cleanup.

2. **`init.ts` — `loginOnDaemon(config, env)`**
   - Extract the login replay logic from `loginWithCredentials` into a function that accepts a `env: Record<string, string>` containing `BROWSE_STATE_FILE`.
   - `loginWithCredentials` becomes a thin wrapper: creates default env, calls `loginOnDaemon`.
   - Verbose logging (`VERIFY_VERBOSE_AUTH=1`) already implemented.

3. **`run-claude.ts` / `types.ts` — add `env` to `RunClaudeOptions`**
   - Add `env?: Record<string, string>` to `RunClaudeOptions`.
   - In `runClaude()`, merge into spawn env: `env: { ...process.env, ...opts.env }`.

4. **`orchestrator.ts` — per-group daemon lifecycle**
   - Replace the single `AbortController` with per-group controllers.
   - In `executeGroup()`:
     - Start group daemon via `startGroupDaemon(groupId, runDir)`
     - Login via `loginOnDaemon(config, groupEnv)`
     - If login fails: mark all group ACs as `login_failed`, stop daemon, return
     - Pass `groupEnv` through to `runClaude()` for browse agent calls
     - In `finally` block: `stopGroupDaemon(stateDir)`
   - After `Promise.all`: `stopAllGroupDaemons(runDir)` as safety net
   - Remove the primary daemon login from preflight (groups handle their own auth)
     - Keep preflight's `checkDevServer()` — still validates the app is running

5. **`browse-agent.ts` — accept env for propagation**
   - `buildBrowseAgentPrompt()` unchanged (the prompt doesn't need to know about `BROWSE_STATE_FILE`).
   - The `env` is passed through `runClaude()` options, not the prompt.

### Part 2: Fix false positive auth detection

1. **`types.ts` — make `isAuthFailure()` context-aware**
   - New signature: `isAuthFailure(observed: string, acUrl?: string): boolean`
   - If `acUrl` contains `/login`, `/signin`, `/auth`, `/signup`, or `/forgot-password`, skip the URL-pattern match on `observed`. The agent was intentionally visiting that page.
   - Keep the `"Auth redirect:"` prefix match but only when `acUrl` is NOT an auth page.

2. **`browse-agent.txt` — refine CRITICAL RULE 3**
   - Current: "If you see a login page or auth redirect, report it in 'observed' and start the observed text with `Auth redirect:`. Do NOT try to log in."
   - New: "If you were redirected to a login/signin page that you did NOT intend to visit, start the observed text with `Auth redirect:`. Do NOT try to log in. If your target URL IS a login/signin page, report what you see normally — do NOT prefix with `Auth redirect:`."

3. **`orchestrator.ts` — pass AC URL to `isAuthFailure()`**
   - Change line 389: `isAuthFailure(browseResult.observed)` → `isAuthFailure(browseResult.observed, ac.url)`

### Part 3: Verbose auth logging (already implemented)

`VERIFY_VERBOSE_AUTH=1` logging in `init.ts`. Logs each login step result, daemon PID, and `waitForAuth` poll details. No further changes needed.

## Files touched

1. `pipeline/src/lib/browse.ts` — add `startGroupDaemon`, `stopGroupDaemon`, `stopAllGroupDaemons`
2. `pipeline/src/init.ts` — extract `loginOnDaemon(config, env)`, verbose logging (done)
3. `pipeline/src/run-claude.ts` — merge `opts.env` into spawn env
4. `pipeline/src/lib/types.ts` — add `env` to `RunClaudeOptions`, make `isAuthFailure()` context-aware
5. `pipeline/src/orchestrator.ts` — per-group daemon lifecycle, per-group AbortController, pass AC URL to `isAuthFailure()`
6. `pipeline/src/prompts/browse-agent.txt` — refine CRITICAL RULE 3
7. `pipeline/test/browse.test.ts` — unit tests for group daemon helpers
8. `pipeline/test/types.test.ts` — unit tests for context-aware `isAuthFailure()`
9. `pipeline/test/browse-integration.test.ts` — integration test: 2 real daemons, parallel navigation, verify isolation

## Test plan

### Unit tests (`browse.test.ts`)
- `startGroupDaemon`: creates state dir, returns correct env with `BROWSE_STATE_FILE`
- `stopGroupDaemon`: reads state file, kills PID, handles missing state file, handles dead PID
- `stopAllGroupDaemons`: finds multiple `.browse-*` dirs, kills each; no-op when none exist

### Unit tests (`types.test.ts`)
- `isAuthFailure("Auth redirect: went to /signin")` → true (current behavior preserved)
- `isAuthFailure("Auth redirect: went to /signin", "/signin")` → false (AC targets signin)
- `isAuthFailure("Auth redirect: went to /signin", "/documents")` → true (involuntary redirect)
- `isAuthFailure("Navigated to /signin, saw form", "/signin")` → false (no redirect, AC targets signin)
- `isAuthFailure("Page shows Sign In button", "/dashboard")` → true (on wrong page)

### Integration test (`browse-integration.test.ts`)
- Start 2 daemons with different `BROWSE_STATE_FILE` paths
- Login on both
- Navigate simultaneously to different URLs
- Verify each daemon shows the correct page (no cross-contamination)
- Stop both daemons, verify cleanup

## Failure modes

| Codepath | Failure | Test? | Error handling? | User impact |
|----------|---------|-------|-----------------|-------------|
| Group daemon start | Port conflict | Yes (unit) | Returns error, group gets `login_failed` | AC verdicts show clear error |
| Group login | Login replay fails | Yes (via existing `waitForAuth` tests) | Returns `ok: false`, group aborts | AC verdicts show `login_failed` |
| Group daemon dies mid-run | Chromium crash | No (hard to simulate) | Browse CLI auto-restarts on next command | Next `goto` may see login page → auth circuit breaker fires for this group only |
| Cleanup misses a daemon | PID already dead | Yes (unit) | `kill` throws, caught silently | Orphaned process eventually idles out (30min) |
| `isAuthFailure` false positive on `/signin` | AC tests auth page | Yes (unit) | Skips match when `acUrl` is an auth page | AC evaluated normally |

**Critical gaps:** None. The only untested failure (Chromium crash mid-run) is mitigated by the existing 30-minute idle timeout on the daemon.

## What already exists

- `BROWSE_STATE_FILE` env var — built into gstack browse, fully supported
- `loginWithCredentials()` — works correctly, just needs to be parameterized
- `resetPage()` no-op — already prevents cookie loss between ACs in a group
- `AUTH_FAILURE_PATTERNS` — existing, just needs the `acUrl` exemption
- `waitForAuth()` — existing, works correctly with any daemon

## Not in scope

- Cookie transfer between daemons (login per daemon is simpler and ~5s)
- Playwright tab-based isolation (tabs share BrowserContext — same fundamental problem)
- Fixing `browse stop` hang (tracked in TODOS P1, upstream gstack issue)
- Modifying the eval runner itself
- Changing `maxParallelGroups` config (stays at 5)
- Preflight health check changes (keep `checkDevServer()`, remove daemon login from preflight)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 4 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — ready to implement.
