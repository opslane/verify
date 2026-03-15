# Cloud Planner: Code Context for AC Generation

**Date:** 2026-03-14
**Status:** Design (reviewed, simplified)

## Problem

The cloud verify pipeline's planner (`parseAcceptanceCriteria`) receives only the spec/PR body text — no code diff. This produces generic ACs like "verify the small UI change is visible" instead of specific ones like "verify the login heading says 'Sign in to your account'".

The local pipeline's planner receives the git diff and its prompt says "READ THE CODE DIFF FIRST." This produces grounded, specific ACs.

## Key Insight

`fetchPullRequest()` in `pr.ts` already fetches the full unified PR diff and returns it as `prMeta.diff` (truncated to 50K chars via `truncateDiff`). We just don't pass it to the planner. The fix is small.

## Design

### Changes

#### 1. Pass `prMeta.diff` to `parseAcceptanceCriteria()`

**File:** `server/src/verify/pipeline.ts`

New signature:
```typescript
export async function parseAcceptanceCriteria(
  specContent: string,
  diff: string,
): Promise<AcceptanceCriterion[]>
```

The diff is already available in `pipeline.ts` as `pr.diff` — just thread it through.

#### 2. Rewrite the planner prompt

Replace the existing prompt in `parseAcceptanceCriteria` with:

```
You are an autonomous QA engineer. Extract acceptance criteria from this PR
for browser-based verification.

RULES:
1. READ THE CODE DIFF FIRST. The diff tells you exactly what changed.
   Generate ACs that test the delta — what would fail on the old code
   and pass on the new code.
2. Each AC must include a `url` path (e.g. "/auth/login") where the change
   is visible in the browser.
3. Maximum 5 testable ACs. Consolidate related checks into single ACs.
4. Be SPECIFIC — "heading says 'Sign in to your account'" not "UI renders correctly".
5. Focus on OBSERVABLE browser changes — what a user would see or interact with differently.
6. If the change is a locale/translation/i18n file, identify which page renders
   the changed key and write the AC against that page with the expected text.
7. If the change is CSS/styling, describe the visual difference specifically.

<<<DIFF>>>
{sanitized diff}
<<<END_DIFF>>>

<<<SPEC>>>
{sanitized spec, or "No spec provided — generate ACs from the code diff alone."}
<<<END_SPEC>>>

Return ONLY a JSON array:
[{ "id": "AC-1", "description": "...", "testable": true, "url": "/path" }, ...]
```

**Prompt injection mitigation:** Sanitize diff content by stripping delimiter-like patterns before interpolation.

#### 3. Add `url` field to AC schema

```typescript
interface AcceptanceCriterion {
  id: string;
  description: string;
  testable: boolean;
  url?: string;  // path like "/auth/login"
}
```

Update `parseAcceptanceCriteriaJson()` to extract `url` from parsed JSON.

#### 4. Use `ac.url` in browser agent base URL

In `pipeline.ts`, when calling `runBrowserAgent`:
```typescript
{ goal: ac.description, baseUrl: ac.url ? `${baseUrl}${ac.url}` : baseUrl }
```

### What Doesn't Change

- `fetchPrChangedFiles()` return type (no `patch` field needed)
- `discoverSpec()` consumer (unchanged input)
- Sandbox setup flow
- Browser agent prompt / tool definitions
- PR comment formatting

### Not In Scope

- Reading changed file contents from sandbox (diff alone is sufficient for now)
- Pre-written Playwright steps in ACs
- Screenshot checkpoints / video recording
- Agent retry on failure
- Pagination for 100+ file PRs (log warning, fix later)

### Validation

Re-trigger `/verify` on the formbricks test PR. Expected: ACs reference the specific login heading change, not generic "verify UI change".
