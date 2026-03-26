# Setup Writer User Context Scoping — Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the setup-writer the logged-in user's email so it can scope all generated SQL to the correct user/team — generically, for any project schema.

**Architecture:** The orchestrator passes `config.auth.email` to `buildSetupWriterPrompt`, which adds an AUTH CONTEXT section to the prompt. The LLM discovers the user's team by querying the schema (1-2 extra SELECTs). No hardcoded joins, no schema-specific code, no new DB queries in the orchestrator.

**Tech Stack:** TypeScript, vitest

**Spike evidence:** Spike 5 validated this approach — 3/3 cases correctly scoped to team 7, LLM discovered the FK chain `User → OrganisationMember → Organisation → Team` without hints. SQL execution failures were schema-detail errors (wrong enum, missing NOT NULL) unrelated to scoping — handled by existing retry/learnings loop.

---

## Task 1: Add `authEmail` parameter to `buildSetupWriterPrompt` and `buildSetupWriterRetryPrompt`

**Files:**
- Modify: `pipeline/src/stages/setup-writer.ts:12-87` (`buildSetupWriterPrompt`)
- Modify: `pipeline/src/stages/setup-writer.ts:98-140` (`buildSetupWriterRetryPrompt`)
- Test: `pipeline/test/setup-writer.test.ts`

**Step 1: Write the failing tests**

Add to the existing `describe("buildSetupWriterPrompt")` block in `pipeline/test/setup-writer.test.ts`:

```typescript
  it("includes AUTH CONTEXT section when authEmail is provided", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state", projectDir, "test@example.com");
    expect(prompt).toContain("AUTH CONTEXT");
    expect(prompt).toContain("test@example.com");
    expect(prompt).toContain("logged-in user");
  });

  it("AUTH CONTEXT appears before DATABASE ACCESS", () => {
    const prompt = buildSetupWriterPrompt("group-a", "trialing state", projectDir, "test@example.com");
    const authIdx = prompt.indexOf("AUTH CONTEXT");
    const dbIdx = prompt.indexOf("DATABASE ACCESS");
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(dbIdx);
  });

  it("works without authEmail (backwards compatible)", () => {
    const prompt = buildSetupWriterPrompt("group-a", "org in trialing state", projectDir);
    expect(prompt).not.toContain("AUTH CONTEXT");
    expect(prompt).toContain("group-a");
    expect(prompt).toContain("org in trialing state");
  });
```

Add to the existing `describe("buildSetupWriterRetryPrompt")` block:

```typescript
  it("passes authEmail through to base prompt", () => {
    const prompt = buildSetupWriterRetryPrompt("group-a", "trialing state", projectDir, {
      type: "exec_error",
      failedCommands: ["psql -c 'SELECT 1'"],
      error: "connection refused",
    }, "test@example.com");
    expect(prompt).toContain("AUTH CONTEXT");
    expect(prompt).toContain("test@example.com");
    expect(prompt).toContain("YOUR PREVIOUS SQL FAILED");
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/setup-writer.test.ts`
Expected: FAIL — `buildSetupWriterPrompt` doesn't accept a 4th string argument

**Step 3: Write minimal implementation**

In `pipeline/src/stages/setup-writer.ts`, change the `buildSetupWriterPrompt` signature (line 12):

```typescript
export function buildSetupWriterPrompt(groupId: string, condition: string, projectRoot: string, authEmail?: string): string {
```

After line 38 (the `learningsBlock` declaration), add the auth context block:

```typescript
  // Build auth context section if email is available
  const authContextBlock = authEmail
    ? `
AUTH CONTEXT:
The logged-in user's email is: ${authEmail}
When the CONDITION refers to "the logged-in user", "their team", or "their personal team":
1. First query to find this user's ID from the "User" table using their email
2. Then discover their team(s) by following FK relationships in the SCHEMA above
3. Scope ALL subsequent queries and INSERTs to that user's team
Do NOT use data from other users or teams.
`
    : "";
```

In the prompt template string, insert `${authContextBlock}` between the CONDITION line and the DATABASE ACCESS line:

```typescript
  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${condition}
${authContextBlock}
DATABASE ACCESS:
...rest unchanged...`;
```

Then change the `buildSetupWriterRetryPrompt` signature (around line 98):

```typescript
export function buildSetupWriterRetryPrompt(
  groupId: string, condition: string, projectRoot: string,
  retryContext: SetupRetryContext,
  authEmail?: string,
): string {
  const base = buildSetupWriterPrompt(groupId, condition, projectRoot, authEmail);
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/setup-writer.test.ts`
Expected: PASS — all existing tests still pass (backward compatible), new tests pass

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/stages/setup-writer.ts pipeline/test/setup-writer.test.ts
git commit -m "feat(setup-writer): add authEmail to prompt for user-scoped SQL"
```

---

## Task 2: Wire auth email into the orchestrator

**Files:**
- Modify: `pipeline/src/orchestrator.ts:225-227` (pass authEmail to prompt builders)

**Step 1: Pass `config.auth.email` to prompt builders**

In `pipeline/src/orchestrator.ts`, at line 225-227, change:

```typescript
          const setupPrompt = attempt === 1
            ? buildSetupWriterPrompt(groupId, condition, projectRoot)
            : buildSetupWriterRetryPrompt(groupId, condition, projectRoot, lastRetryContext!);
```

To:

```typescript
          const setupPrompt = attempt === 1
            ? buildSetupWriterPrompt(groupId, condition, projectRoot, config.auth?.email)
            : buildSetupWriterRetryPrompt(groupId, condition, projectRoot, lastRetryContext!, config.auth?.email);
```

No new imports needed — `config` is already in scope (line 59), and `buildSetupWriterPrompt` / `buildSetupWriterRetryPrompt` are already imported (line 20).

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 3: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS — all 335+ tests pass

**Step 4: Commit**

```bash
git add pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): pass auth email to setup-writer for user scoping"
```

---

## Task 3: Final verification

**Step 1: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS — zero errors

**Step 2: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS — all tests pass

---

## Summary of changes

| File | Change |
|------|--------|
| `pipeline/src/stages/setup-writer.ts` | Add optional `authEmail` param to `buildSetupWriterPrompt` and `buildSetupWriterRetryPrompt`, inject AUTH CONTEXT block into prompt |
| `pipeline/src/orchestrator.ts` | Pass `config.auth?.email` to both prompt builders (2 lines changed) |
| `pipeline/test/setup-writer.test.ts` | 4 new tests: auth context present, ordering, backward compat, retry passthrough |

**Total: ~15 lines of production code, ~30 lines of tests.**
