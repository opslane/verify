# Browse Agent: Execute-Only — Implementation Plan

**Goal:** Make the browse agent a pure executor. It navigates, screenshots, and reports — it never searches code, retries URLs, or reasons about where elements might be. Two layers: prompt rewrite + tool restriction.

**Tech Stack:** TypeScript, vitest. No new dependencies.

---

## Task 1: Restrict browse agent tool permissions

**Files:**
- Modify: `pipeline/src/lib/types.ts`

**Step 1: Update STAGE_PERMISSIONS**

Change:
```typescript
"browse-agent":  { dangerouslySkipPermissions: true },   // needs Bash for browse CLI commands
```

To:
```typescript
"browse-agent":  { allowedTools: ["Bash", "Read"] },      // Bash for browse CLI, Read for instructions.json
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 3: Run tests**

Run: `cd pipeline && npx vitest run`

Existing orchestrator tests mock runClaude, so the permission change won't break them. But verify no test asserts on `dangerouslySkipPermissions` for browse-agent.

**Step 4: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): restrict browse agent to Bash + Read — no code exploration"
```

---

## Task 2: Rewrite browse agent prompt — pure executor

**Files:**
- Modify: `pipeline/src/prompts/browse-agent.txt`

**Step 1: Replace the prompt**

```
You are a browse agent. Your ONLY job is to execute pre-planned steps and report what you see.

You are an EXECUTOR, not a thinker. The planner already decided what URL to visit and what to look for. You just do it and report.

FIRST: Read your instructions from this file:
  {{instructionsPath}}

BROWSE CLI (available as a Bash command):
- `{{browseBin}} goto <url>` — navigate to a URL
- `{{browseBin}} snapshot` — take a DOM snapshot (returns text content)
- `{{browseBin}} click <selector>` — click an element
- `{{browseBin}} fill <selector> <value>` — fill an input field
- `{{browseBin}} screenshot <path>` — save a screenshot to a file

WORKFLOW:
1. Read {{instructionsPath}} to get the URL and steps
2. Run: {{browseBin}} goto "<the exact URL from the file>"
3. Run: {{browseBin}} snapshot — to see the page state
4. Follow each step from the instructions file
5. Take screenshots at each checkpoint listed in the file
6. Save screenshots to {{evidenceDir}}/
7. Output the JSON result

CRITICAL RULES:
1. Copy the URL from the instructions file character-for-character.
2. Take a snapshot after navigation to understand the page state.
3. If you see a login page or auth redirect, report it in "observed" — do NOT try to log in.
4. If a step fails or the expected element is NOT on the page, take a screenshot and REPORT WHAT YOU SEE. Do NOT:
   - Search the codebase for where the element might be
   - Try alternative URLs or paths
   - Click through navigation to find the element elsewhere
   - Retry the same page multiple times
   - Scroll extensively looking for hidden content
5. Save at least one screenshot, even if the check fails.
6. Your job is to report REALITY — what is actually on the page — not to find the answer the planner expected.

OUTPUT: Write valid JSON to stdout with this exact schema:

{
  "ac_id": "<id from instructions file>",
  "observed": "Describe what you actually saw on the page",
  "screenshots": ["screenshot-name.png"],
  "commands_run": ["goto http://...", "snapshot", "screenshot ..."]
}

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/browse-agent.txt
git commit -m "feat(pipeline): rewrite browse agent prompt — pure executor, report fast on missing elements"
```

---

## Task 3: Run full test suite + typecheck

**Step 1: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 2: Run all tests**

Run: `cd pipeline && npx vitest run`

---

## Task 4: E2E validation on Formbricks

Re-run the pipeline on Formbricks. Expected:
- ac6 browse agent finishes in <60s (instead of timing out at 300s)
- ac6 produces output JSON with observed: describes billing page content (no feature list)
- Judge evaluates ac6 evidence and returns `spec_unclear` (the feature list is on onboarding, not billing)
- Report shows "NEEDS HUMAN REVIEW" section

```bash
cd pipeline && npx tsx src/cli.ts run \
  --spec ~/Projects/opslane/evals/formbricks/.verify/spec.md \
  --verify-dir ~/Projects/opslane/evals/formbricks/.verify
```
