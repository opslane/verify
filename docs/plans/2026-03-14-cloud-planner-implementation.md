# Cloud Planner Code Context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Pass the PR diff to the cloud planner so it generates specific, code-grounded acceptance criteria instead of generic ones.

**Architecture:** Thread `prMeta.diff` (already fetched, already truncated to 50K chars) through to `parseAcceptanceCriteria()`. Rewrite the planner prompt to prioritize the diff. Add `url` field to AC schema so the browser agent starts on the right page.

**Tech Stack:** TypeScript, Anthropic SDK (Claude Sonnet), vitest

**Design doc:** `docs/plans/2026-03-14-cloud-planner-code-context.md`

---

## Task 1: Add `url` field to AC schema and parser

**Files:**
- Modify: `server/src/verify/pipeline.ts:212-281`
- Modify: `server/src/verify/pipeline.test.ts:33-62`

**Step 1: Add test for `url` field extraction in `parseAcceptanceCriteriaJson`**

In `server/src/verify/pipeline.test.ts`, add inside the `parseAcceptanceCriteriaJson` describe block after the last `it`:

```typescript
  it('extracts url field when present', () => {
    const input = '[{"id":"AC-1","description":"Check login heading","testable":true,"url":"/auth/login"}]';
    const result = parseAcceptanceCriteriaJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('/auth/login');
  });

  it('defaults url to undefined when not present', () => {
    const input = '[{"id":"AC-1","description":"Check page"}]';
    const result = parseAcceptanceCriteriaJson(input);
    expect(result[0].url).toBeUndefined();
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/verify/pipeline.test.ts`
Expected: FAIL — `url` property doesn't exist on result.

**Step 3: Update `AcceptanceCriterion` interface and `parseAcceptanceCriteriaJson`**

In `server/src/verify/pipeline.ts`, update the interface (line 212-216):

```typescript
interface AcceptanceCriterion {
  id: string;
  description: string;
  testable?: boolean;
  url?: string;
}
```

Update `parseAcceptanceCriteriaJson` (line 273-277) — the `.map()` callback:

```typescript
      .map((item) => ({
        id: item.id,
        description: item.description,
        testable: typeof item.testable === 'boolean' ? item.testable : true,
        url: typeof (item as Record<string, unknown>).url === 'string' ? (item as Record<string, unknown>).url as string : undefined,
      }));
```

Also update the filter type guard (line 268) to include `url`:

```typescript
      .filter((item): item is { id: string; description: string; testable?: boolean; url?: string } =>
```

**Step 4: Run tests to verify they pass**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/verify/pipeline.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/src/verify/pipeline.ts server/src/verify/pipeline.test.ts
git commit -m "feat: add url field to AcceptanceCriterion schema"
```

---

## Task 2: Rewrite `parseAcceptanceCriteria` to accept and use diff

**Files:**
- Modify: `server/src/verify/pipeline.ts:222-258`

**Step 1: Update `parseAcceptanceCriteria` signature and prompt**

Replace the entire `parseAcceptanceCriteria` function (lines 222-258) with:

```typescript
/**
 * Use Claude to parse a spec document + code diff into individual, testable acceptance criteria.
 * The diff is the primary input — ACs should test what actually changed.
 * Exported for testing.
 */
export async function parseAcceptanceCriteria(specContent: string, diff: string): Promise<AcceptanceCriterion[]> {
  // Sanitize inputs to prevent prompt injection via XML-like delimiters
  const sanitizedSpec = specContent.replace(/<<<\/?(?:SPEC|DIFF|END_SPEC|END_DIFF)>>>/gi, '[delimiter-removed]');
  const sanitizedDiff = diff.replace(/<<<\/?(?:SPEC|DIFF|END_SPEC|END_DIFF)>>>/gi, '[delimiter-removed]');

  // Cap diff at ~500 lines to stay within reasonable token budget
  const diffLines = sanitizedDiff.split('\n');
  const cappedDiff = diffLines.length > 500
    ? diffLines.slice(0, 500).join('\n') + '\n\n[diff truncated at 500 lines]'
    : sanitizedDiff;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are an autonomous QA engineer. Extract acceptance criteria from this PR for browser-based verification.

RULES:
1. READ THE CODE DIFF FIRST. The diff tells you exactly what changed. Generate ACs that test the delta — what would fail on the old code and pass on the new code.
2. Each AC must include a "url" field with the path (e.g. "/auth/login") where the change is visible in the browser.
3. Maximum 5 testable ACs. Consolidate related checks into single ACs.
4. Be SPECIFIC — "heading says 'Sign in to your account'" not "UI renders correctly".
5. Focus on OBSERVABLE browser changes — what a user would see or interact with differently.
6. If the change is a locale/translation/i18n file, identify which page renders the changed key and write the AC against that page with the expected text.
7. If the change is CSS/styling, describe the visual difference specifically.
8. Each AC description must include navigation steps. A browser agent will execute each AC independently with no prior context.
9. Mark ACs as "testable": false only if they genuinely cannot be checked in a browser.

<<<DIFF>>>
${cappedDiff}
<<<END_DIFF>>>

<<<SPEC>>>
${sanitizedSpec || 'No spec provided — generate ACs from the code diff alone.'}
<<<END_SPEC>>>

Respond with ONLY a JSON array, no other text:
[{ "id": "AC-1", "description": "Navigate to /auth/login and verify...", "testable": true, "url": "/auth/login" }]`,
      },
    ],
  });

  const text = response.content.find((c) => c.type === 'text')?.text ?? '[]';
  return parseAcceptanceCriteriaJson(text);
}
```

**Step 2: Verify compilation**

Run: `cd server && npx tsc --noEmit`
Expected: Error at line 145 — `parseAcceptanceCriteria` now requires 2 args. Fix in Task 3.

---

## Task 3: Wire diff through pipeline and use `ac.url`

**Files:**
- Modify: `server/src/verify/pipeline.ts:144-185`

**Step 1: Pass `pr.diff` to `parseAcceptanceCriteria`**

Update line 145 in `pipeline.ts`:

```typescript
    const criteria = await parseAcceptanceCriteria(specContent, prMeta.diff);
```

**Step 2: Use `ac.url` in the browser agent call**

Update line 185 (inside the `for` loop over criteria):

```typescript
      const verdict = await runBrowserAgent(
        provider, sandbox.id,
        { goal: ac.description, baseUrl: ac.url ? `${baseUrl}${ac.url}` : baseUrl, testEmail, testPassword },
        (msg) => log('agent', msg),
      );
```

**Step 3: Verify compilation**

Run: `cd server && npx tsc --noEmit`
Expected: No errors.

**Step 4: Run all tests**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run`
Expected: ALL PASS (121 tests).

**Step 5: Commit**

```bash
git add server/src/verify/pipeline.ts
git commit -m "feat: pass PR diff to planner, use ac.url for agent navigation"
```

---

## Task 4: Update callers of `parseAcceptanceCriteria`

**Files:**
- Modify: `server/src/verify/test-steps.ts:232-234` (if it exists and calls `parseAcceptanceCriteria`)
- Modify: `server/src/verify/test-live.ts:120` (if it exists and calls `parseAcceptanceCriteria`)

**Step 1: Check and fix callers**

Run: `cd server && grep -rn 'parseAcceptanceCriteria(' src/ --include='*.ts' | grep -v 'pipeline.ts' | grep -v 'pipeline.test.ts'`

For each caller, add a second argument (empty string if no diff is available):

```typescript
// Before:
const criteria = await parseAcceptanceCriteria(specContent);
// After:
const criteria = await parseAcceptanceCriteria(specContent, pr.diff ?? '');
```

**Step 2: Verify compilation**

Run: `cd server && npx tsc --noEmit`
Expected: No errors.

**Step 3: Run all tests**

Run: `cd server && node --env-file=.env ./node_modules/.bin/vitest run`
Expected: ALL PASS.

**Step 4: Commit (only if changes were needed)**

```bash
git add server/src/verify/
git commit -m "fix: update parseAcceptanceCriteria callers for new diff parameter"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add `url` field to AC schema + parser | pipeline.ts, pipeline.test.ts |
| 2 | Rewrite planner prompt with diff context | pipeline.ts |
| 3 | Wire diff through pipeline, use `ac.url` | pipeline.ts |
| 4 | Fix remaining callers | test-steps.ts, test-live.ts |

**After all tasks:** Restart dev server, trigger `/verify` on the formbricks PR. Expected: ACs now reference the specific heading change ("Sign in to your account") and include `url: "/auth/login"`.
