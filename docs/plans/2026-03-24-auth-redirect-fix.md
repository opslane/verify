# Auth Redirect False Positives Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate auth redirect false positives (20% of pipeline failures) by giving the test user admin roles and retrying with re-login on genuine auth failures.

**Architecture:** Two independent changes. (1) Setup-writer prompt conditionally includes role assignment instructions when app.json has role enums. (2) Orchestrator circuit breaker attempts inline re-login + retry before aborting.

**Tech Stack:** TypeScript, vitest, pipeline stages

---

### Task 1: Setup-writer role extraction and prompt injection

**Files:**
- Modify: `pipeline/src/stages/setup-writer.ts`
- Test: `pipeline/test/setup-writer.test.ts`

**Step 1: Write the failing tests**

In `pipeline/test/setup-writer.test.ts`, add two tests inside the existing `describe("buildSetupWriterPrompt")` block, after the existing tests:

```typescript
it("includes ROLE ASSIGNMENT when app.json has role enums", () => {
  mkdirSync(join(projectDir, ".verify"), { recursive: true });
  writeFileSync(join(projectDir, ".verify", "app.json"), JSON.stringify({
    indexed_at: "", routes: {}, pages: {}, fixtures: {},
    db_url_env: "DATABASE_URL", feature_flags: [], seed_ids: {},
    json_type_annotations: {}, example_urls: {},
    data_model: {
      User: {
        table_name: "users",
        columns: { id: "id", email: "email", role: "role" },
        enums: { Role: ["ADMIN", "USER", "MEMBER"] },
        source: "prisma/schema.prisma:1",
        manual_id_columns: [],
      },
    },
  }));
  const prompt = buildSetupWriterPrompt("group-a", "some condition", projectDir);
  expect(prompt).toContain("ROLE ASSIGNMENT");
  expect(prompt).toContain("Role: ADMIN, USER, MEMBER");
});

it("omits ROLE ASSIGNMENT when app.json has no role enums", () => {
  mkdirSync(join(projectDir, ".verify"), { recursive: true });
  writeFileSync(join(projectDir, ".verify", "app.json"), JSON.stringify({
    indexed_at: "", routes: {}, pages: {}, fixtures: {},
    db_url_env: "DATABASE_URL", feature_flags: [], seed_ids: {},
    json_type_annotations: {}, example_urls: {},
    data_model: {
      User: {
        table_name: "users",
        columns: { id: "id", email: "email" },
        enums: {},
        source: "prisma/schema.prisma:1",
        manual_id_columns: [],
      },
    },
  }));
  const prompt = buildSetupWriterPrompt("group-a", "some condition", projectDir);
  expect(prompt).not.toContain("ROLE ASSIGNMENT");
});
```

**Step 2: Run test to verify it fails**

Run: `cd pipeline && npx vitest run test/setup-writer.test.ts`
Expected: 2 FAIL — "ROLE ASSIGNMENT" not found in prompt

**Step 3: Write minimal implementation**

In `pipeline/src/stages/setup-writer.ts`, inside `buildSetupWriterPrompt()`, after the `schemaLines` loop (after line 25), add:

```typescript
// Extract role-like enums for elevated test user permissions
const roleEnumLines: string[] = [];
if (appIndex) {
  for (const [, info] of Object.entries(appIndex.data_model)) {
    for (const [enumName, values] of Object.entries(info.enums)) {
      if (/role/i.test(enumName)) {
        roleEnumLines.push(`${enumName}: ${values.join(", ")}`);
      }
    }
  }
}

const roleBlock = roleEnumLines.length > 0
  ? `
ROLE ASSIGNMENT:
The app has role-based access control. Assign the test user the highest-privilege role available.
Role enums found: ${roleEnumLines.join("; ")}.
Use the most privileged value (typically ADMIN, OWNER, or similar) to ensure the test user can access all pages.
`
  : "";
```

Then include `${roleBlock}` in the return template string, after `${authContextBlock}`:

```typescript
return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${condition}
${authContextBlock}${roleBlock}
DATABASE ACCESS:
```

**Step 4: Run test to verify it passes**

Run: `cd pipeline && npx vitest run test/setup-writer.test.ts`
Expected: ALL PASS

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add pipeline/src/stages/setup-writer.ts pipeline/test/setup-writer.test.ts
git commit -m "feat(setup-writer): inject role assignment when app.json has role enums"
```

---

### Task 2: Orchestrator inline re-login retry on auth failure

**Files:**
- Modify: `pipeline/src/orchestrator.ts`
- Test: `pipeline/test/orchestrator.test.ts`

**Step 1: Write the failing test**

In `pipeline/test/orchestrator.test.ts`, add a new test inside the existing `describe("circuit breaker")` block. The test file already mocks `loginOnDaemon` at line 58 to return `{ ok: true }`, so re-login will succeed by default.

```typescript
it("retries AC with inline re-login when auth failure detected", async () => {
  const specPath = join(verifyDir, "spec.md");
  writeFileSync(specPath, "# Test spec");

  const acs: ACGeneratorOutput = {
    groups: [
      { id: "group-a", condition: null, acs: [{ id: "ac1", description: "Check A" }] },
    ],
    skipped: [],
  };
  const plan: PlannerOutput = {
    criteria: [
      { id: "ac1", group: "group-a", description: "Check A", url: "/a", steps: ["Go"], screenshot_at: [], timeout_seconds: 90 },
    ],
  };

  mockRunClaudeResult("ac-generator", { stdout: JSON.stringify(acs) });
  mockRunClaudeResult("planner", { stdout: JSON.stringify(plan) });

  // First browse call returns auth failure, second (retry) returns success
  let browseCallCount = 0;
  const origMock = vi.mocked(runClaude);
  origMock.mockImplementation(async (opts: RunClaudeOptions): Promise<RunClaudeResult> => {
    runClaudeCalls.push(opts);
    if (opts.stage === "browse-agent-ac1") {
      browseCallCount++;
      if (browseCallCount === 1) {
        return { stdout: JSON.stringify({ ac_id: "ac1", observed: "Auth redirect to /login detected", screenshots: [], commands_run: [] }), stderr: "", exitCode: 0, durationMs: 1000, timedOut: false };
      }
      return { stdout: JSON.stringify({ ac_id: "ac1", observed: "Dashboard loaded OK", screenshots: ["s1.png"], commands_run: [] }), stderr: "", exitCode: 0, durationMs: 1000, timedOut: false };
    }
    return defaultRunClaudeResult(opts);
  });

  // Judge returns a pass verdict for ac1
  mockRunClaudeResult("judge", { stdout: JSON.stringify({ verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" }] }) });
  mockRunClaudeResult("learner", { stdout: "" });

  const { callbacks } = makeCallbacks();
  const { runPipeline } = await import("../src/orchestrator.js");
  const result = await runPipeline(specPath, verifyDir, callbacks);

  // ac1 should NOT be auth_expired — re-login succeeded and retry passed
  const authVerdicts = result.verdicts!.verdicts.filter(v => v.verdict === "auth_expired");
  expect(authVerdicts.length).toBe(0);
  expect(browseCallCount).toBe(2);

  // loginOnDaemon called twice: once at group init, once for re-login
  const { loginOnDaemon: mockLogin } = await import("../src/init.js");
  expect(vi.mocked(mockLogin)).toHaveBeenCalledTimes(2);
});
```

**Step 2: Run test to verify it fails**

Run: `cd pipeline && npx vitest run test/orchestrator.test.ts`
Expected: FAIL — ac1 gets `auth_expired` because current code aborts immediately without retrying

**Step 3: Write minimal implementation**

In `pipeline/src/orchestrator.ts`, replace the circuit breaker block at lines 409-417. Use an **inline retry** (same pattern as the existing nav-failure replan at lines 333-403) — do NOT restructure the for-of loop.

Replace:
```typescript
        // Circuit breaker: auth failure kills this group's remaining agents
        if (isAuthFailure(browseResult.observed, ac.url)) {
          callbacks.onError(`Auth session expired in group ${groupId}.`);
          groupAbort.abort();
          allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Auth redirect detected" });
          progress.update(ac.id, "error", "auth_expired");
          resetPage();
          continue;
        }
```

With:
```typescript
        // Circuit breaker: auth failure → attempt re-login + inline retry before aborting
        if (isAuthFailure(browseResult.observed, ac.url)) {
          callbacks.onLog(`  ${ac.id}: auth failure detected, attempting re-login...`);
          let relogin: { ok: boolean; error?: string };
          try {
            relogin = loginOnDaemon(config, groupEnv);
          } catch (err: unknown) {
            relogin = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (relogin.ok) {
            callbacks.onLog(`  ${ac.id}: re-login succeeded, retrying AC`);
            resetPage();
            const retryResult = await runClaude({
              prompt: agentPrompt, model: "sonnet", timeoutMs: computeTimeoutMs(enrichedAc.steps),
              stage: `browse-agent-${ac.id}`, runDir, env: groupEnv, ...perms("browse-agent"),
            });
            const retryBrowse = parseBrowseResult(retryResult.stdout);
            if (retryBrowse && !isAuthFailure(retryBrowse.observed, ac.url)) {
              browseResult = retryBrowse;
              writeFileSync(join(evidenceDir, "result.json"), JSON.stringify(browseResult, null, 2));
              // Fall through to normal verdict path below
            } else {
              callbacks.onError(`Auth session expired in group ${groupId} (persists after re-login).`);
              groupAbort.abort();
              allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Auth redirect persists after re-login" });
              progress.update(ac.id, "error", "auth_expired");
              resetPage();
              continue;
            }
          } else {
            callbacks.onLog(`  ${ac.id}: re-login failed — ${relogin.error}`);
            callbacks.onError(`Auth session expired in group ${groupId}.`);
            groupAbort.abort();
            allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: `Re-login failed: ${relogin.error}` });
            progress.update(ac.id, "error", "auth_expired");
            resetPage();
            continue;
          }
        }
```

Key points:
- The for-of loop (`for (const ac of groupAcs)`) stays unchanged
- Retry is inline — re-runs `runClaude` with same args, reassigns `browseResult`, falls through
- `loginOnDaemon` is wrapped in try-catch
- Distinct log messages for "re-login failed" vs "persists after re-login"

**Step 4: Run test to verify it passes**

Run: `cd pipeline && npx vitest run test/orchestrator.test.ts`
Expected: ALL PASS

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 6: Run full test suite**

Run: `cd pipeline && npx vitest run`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add pipeline/src/orchestrator.ts pipeline/test/orchestrator.test.ts
git commit -m "feat(orchestrator): inline re-login retry on auth failure before aborting group"
```

---

### Task 3: Final verification

**Step 1: Full typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 2: Full test suite**

Run: `cd pipeline && npx vitest run`

**Step 3: Verify auth-failure tests still pass**

Run: `cd pipeline && npx vitest run test/auth-failure.test.ts`

---

## Summary

| Task | What | Files | Fixes |
|------|------|-------|-------|
| 1 | Setup-writer injects role assignment | setup-writer.ts | Mode 1 (8/16) |
| 2 | Orchestrator inline re-login retry | orchestrator.ts | Mode 2+3 (8/16) |
| 3 | Full verification | — | — |
