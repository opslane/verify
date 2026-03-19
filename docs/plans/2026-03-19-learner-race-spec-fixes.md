# Learner Redesign + Race Condition + Spec Escalation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three issues found during e2e eval: (1) learner self-poisoning from behavioral conclusions, (2) parallel group race condition on shared seed rows, (3) no way to escalate spec inaccuracies to humans.

**Architecture:** Learner becomes structured-output-only with a deterministic post-validator. Orchestrator detects seed-row overlap between groups and serializes conflicting ones. Judge gets a new `spec_unclear` verdict for spec-vs-code mismatches.

**Tech Stack:** TypeScript, vitest. No new dependencies.

---

## Task 1: Add `spec_unclear` to Verdict type

**Files:**
- Modify: `pipeline/src/lib/types.ts`

**Step 1: Update the Verdict type**

Change:
```typescript
export type Verdict = "pass" | "fail" | "error" | "timeout" | "skipped"
  | "setup_failed" | "setup_unsupported" | "plan_error" | "auth_expired";
```

To:
```typescript
export type Verdict = "pass" | "fail" | "error" | "timeout" | "skipped"
  | "setup_failed" | "setup_unsupported" | "plan_error" | "auth_expired"
  | "spec_unclear";
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS (no existing code pattern-matches on all verdict values).

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): add spec_unclear verdict for spec-vs-code mismatches"
```

---

## Task 2: Update judge prompt with spec_unclear

**Files:**
- Modify: `pipeline/src/prompts/judge.txt`

**Step 1: Update the prompt**

Replace the current `judge.txt` with:

```
You are a verification judge. Review ALL evidence and decide pass/fail for each acceptance criterion.

You are the ONLY stage that produces verdicts. Browse agents collected evidence — you interpret it.

EVIDENCE FILES:
{{evidenceList}}

Read each evidence file listed above using tool calls. Also look at any screenshots in those directories.

OUTPUT: Write valid JSON to stdout with this exact schema:

{
  "verdicts": [
    {
      "ac_id": "ac1",
      "verdict": "pass",
      "confidence": "high",
      "reasoning": "Screenshot shows trial alert banner with correct text"
    }
  ]
}

VERDICT VALUES: pass, fail, error, spec_unclear
CONFIDENCE VALUES: high, medium, low

WHEN TO USE EACH VERDICT:
- pass: Evidence confirms the AC is satisfied.
- fail: Evidence shows the AC is NOT satisfied, and the code appears to be the cause.
- error: No evidence was collected (timeout, crash, no output).
- spec_unclear: Evidence suggests the SPEC is wrong, not the code. Use when:
  - A component exists but in a different location than the spec describes
  - A feature works differently than the spec assumes
  - The expected behavior contradicts what the code clearly intends
  Include what the spec says vs what the code actually does in the reasoning.

CONFIDENCE GUIDELINES:
- high: screenshot directly confirms/refutes the AC. Clear, unambiguous evidence.
- medium: text evidence supports the verdict but screenshot is unclear or missing.
- low: evidence is indirect or ambiguous. The verdict is a best guess.

RULES:
1. Read ALL evidence before making any judgment.
2. Look for PATTERNS across ACs. If every screenshot shows a login page, that's an auth failure — not individual AC failures.
3. If observed says "Auth redirect", verdict is "fail" with reasoning noting the auth issue.
4. If observed is empty or missing, verdict is "error" with reasoning "no evidence collected".
5. Screenshots are primary evidence. If the screenshot contradicts the agent's observed text, trust the screenshot.
6. Be conservative: if evidence is ambiguous, verdict is "fail" with confidence "low".
7. Every AC in the evidence list must appear in your verdicts array.
8. Use spec_unclear sparingly — only when you have positive evidence that the spec's assumption is wrong (e.g., the component exists elsewhere). Don't use it as a fallback for unclear evidence.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/judge.txt
git commit -m "feat(pipeline): judge prompt supports spec_unclear verdict for human escalation"
```

---

## Task 3: Update report to highlight spec_unclear verdicts

**Files:**
- Modify: `pipeline/src/report.ts`

**Step 1: Read current report.ts**

Read `pipeline/src/report.ts` to understand the `formatTerminalReport` function.

**Step 2: Add spec_unclear section**

In `formatTerminalReport`, after the pass/fail/other summary, add a section for `spec_unclear` verdicts:

```typescript
const specUnclear = verdicts.filter(v => v.verdict === "spec_unclear");
if (specUnclear.length > 0) {
  lines.push("");
  lines.push("  NEEDS HUMAN REVIEW (spec may be inaccurate):");
  for (const v of specUnclear) {
    lines.push(`    ? ${v.ac_id}: ${v.reasoning}`);
  }
}
```

**Step 3: Run tests**

Run: `cd pipeline && npx vitest run test/report.test.ts`

**Step 4: Add test for spec_unclear in report**

```typescript
it("highlights spec_unclear verdicts separately", () => {
  const verdicts: ACVerdict[] = [
    { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "OK" },
    { ac_id: "ac2", verdict: "spec_unclear", confidence: "medium", reasoning: "Component found in onboarding, not billing" },
  ];
  const output = formatTerminalReport(verdicts);
  expect(output).toContain("NEEDS HUMAN REVIEW");
  expect(output).toContain("ac2");
  expect(output).toContain("onboarding");
});
```

**Step 5: Run tests — expect PASS**

**Step 6: Commit**

```bash
git add pipeline/src/report.ts pipeline/test/report.test.ts
git commit -m "feat(pipeline): report highlights spec_unclear verdicts for human review"
```

---

## Task 4: Rewrite learner prompt — structured categories only

**Files:**
- Modify: `pipeline/src/prompts/learner.txt`

**Step 1: Replace the prompt**

```
You are a learnings agent. Capture ONLY deterministic facts from this run's results.

Read these files using tool calls:
1. {{verdictsPath}} — the verdicts from this run
2. {{timelinePath}} — the timeline of events
3. {{learningsPath}} — the existing learnings file (may not exist)
4. Any setup error logs in the run directory (look for *-stderr.txt files)

Write the updated learnings to {{learningsPath}}.

YOU MAY ONLY WRITE THESE SECTIONS:

## SQL Corrections
Capture SQL errors and their fixes. Format: exact error message → exact fix.
Example:
- ERROR: column "stripeCustomerId" of relation "OrganizationBilling" does not exist
  FIX: Use "stripe_customer_id" (actual Postgres column name)

Only add entries from actual error messages in this run. Never guess.

## Column Mappings
Prisma field names that differ from Postgres column names, discovered from errors.
Format: TableName.prismaName → postgres_name
Only add entries confirmed by actual SQL errors.

## Required Fields
JSONB or NOT NULL columns that must be included for the app to render correctly.
Format: TableName.column needs: field1, field2, field3 (discovered when app showed error with field missing)
Only add entries when a run succeeded WITH the field and failed WITHOUT it.

## Timing
Average stage durations from timeline.jsonl. Update each run.
Format: stage_name: Xs (average across N runs)

RULES:
1. NEVER write conclusions about whether an AC is testable or untestable.
2. NEVER write advice about what the planner or AC generator should do.
3. NEVER write "MUST", "NEVER", "ALWAYS" directives to other stages.
4. NEVER write authentication instructions or login steps.
5. ONLY write facts derived from actual error messages or timing data.
6. If the existing file has entries that violate rules 1-4, REMOVE them.
7. Keep the file under 100 lines. Prune duplicate or stale entries.

Output the full updated learnings.md content to stdout as well.
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/learner.txt
git commit -m "feat(pipeline): rewrite learner prompt — structured categories only, no behavioral conclusions"
```

---

## Task 5: Add learnings post-validator

**Files:**
- Modify: `pipeline/src/stages/learner.ts`
- Create: `pipeline/test/learner-validator.test.ts`

Defense-in-depth: after the learner writes `learnings.md`, parse it and strip any content outside the allowed sections or containing banned patterns.

**Step 1: Write the failing tests**

```typescript
// pipeline/test/learner-validator.test.ts
import { describe, it, expect } from "vitest";
import { validateLearnings } from "../src/stages/learner.js";

describe("validateLearnings", () => {
  it("keeps valid structured sections", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"

## Timing
- planner: 65s
`;
    const result = validateLearnings(input);
    expect(result).toContain("## SQL Corrections");
    expect(result).toContain("## Timing");
    expect(result).toContain("FIX: Use \"bar\"");
  });

  it("strips unauthorized sections", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"

## Auth — Critical Rules
- NEVER use admin@example.com
- Planner MUST embed login steps

## Known ACs / App Behavior
- ac2 is LOCALLY UNTESTABLE
`;
    const result = validateLearnings(input);
    expect(result).toContain("## SQL Corrections");
    expect(result).not.toContain("Auth");
    expect(result).not.toContain("NEVER");
    expect(result).not.toContain("UNTESTABLE");
    expect(result).not.toContain("Known ACs");
  });

  it("strips lines with banned patterns inside valid sections", () => {
    const input = `# Learnings

## SQL Corrections
- ERROR: column "foo" does not exist
  FIX: Use "bar"
- Planner MUST always use group-b IDs
- NEVER use admin credentials
`;
    const result = validateLearnings(input);
    expect(result).toContain("FIX: Use \"bar\"");
    expect(result).not.toContain("MUST always");
    expect(result).not.toContain("NEVER use");
  });

  it("handles empty input", () => {
    expect(validateLearnings("")).toBe("");
    expect(validateLearnings("# Learnings\n")).toBe("# Learnings\n");
  });

  it("preserves Column Mappings and Required Fields sections", () => {
    const input = `# Learnings

## Column Mappings
- OrganizationBilling.organizationId → organization_id

## Required Fields
- OrganizationBilling.stripe needs: subscriptionStatus, trialEnd, plan
`;
    const result = validateLearnings(input);
    expect(result).toContain("## Column Mappings");
    expect(result).toContain("## Required Fields");
    expect(result).toContain("organization_id");
    expect(result).toContain("trialEnd");
  });
});
```

**Step 2: Run tests — expect FAIL**

Run: `cd pipeline && npx vitest run test/learner-validator.test.ts`

**Step 3: Implement**

Add to `pipeline/src/stages/learner.ts`:

```typescript
const ALLOWED_SECTIONS = new Set([
  "SQL Corrections",
  "Column Mappings",
  "Required Fields",
  "Timing",
]);

const BANNED_PATTERNS = [
  /\bMUST\b/,
  /\bNEVER\b/,
  /\bALWAYS\b/,
  /\bUNTESTABLE\b/i,
  /\buntestable\b/i,
  /\bplanner\s+(must|should)\b/i,
  /\bac\s+generator\s+(must|should)\b/i,
  /\blogin\s+steps?\b/i,
  /\bauth(entication)?\s+(must|should|steps?)\b/i,
];

/**
 * Validate learnings.md — strip unauthorized sections and banned patterns.
 * Defense-in-depth: the prompt tells the LLM what to write, this enforces it.
 */
export function validateLearnings(content: string): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const result: string[] = [];
  let inAllowedSection = false;
  let headerSeen = false;

  for (const line of lines) {
    // Keep the top-level header
    if (line.startsWith("# ") && !headerSeen) {
      result.push(line);
      headerSeen = true;
      continue;
    }

    // Check for section headers
    if (line.startsWith("## ")) {
      const sectionName = line.replace("## ", "").trim();
      inAllowedSection = ALLOWED_SECTIONS.has(sectionName);
      if (inAllowedSection) result.push(line);
      continue;
    }

    // Only include lines from allowed sections
    if (!inAllowedSection) continue;

    // Strip lines with banned patterns
    if (BANNED_PATTERNS.some((p) => p.test(line))) continue;

    result.push(line);
  }

  return result.join("\n");
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Wire the validator into the orchestrator**

In `pipeline/src/orchestrator.ts`, after the learner runs and `restore()` is called, add:

```typescript
// Validate learnings — strip unauthorized content
if (existsSync(learningsPath)) {
  const { validateLearnings } = await import("./stages/learner.js");
  const raw = readFileSync(learningsPath, "utf-8");
  const validated = validateLearnings(raw);
  if (validated !== raw) {
    writeFileSync(learningsPath, validated);
    callbacks.onLog("  Validated learnings.md — stripped unauthorized content");
  }
}
```

Note: `validateLearnings` is already imported from `learner.ts` — just add the call after `restore()`.

**Step 6: Run all tests — expect PASS**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 7: Commit**

```bash
git add pipeline/src/stages/learner.ts pipeline/test/learner-validator.test.ts pipeline/src/orchestrator.ts
git commit -m "feat(pipeline): add learnings post-validator — strips unauthorized sections and banned patterns"
```

---

## Task 6: Build execution chains — serialize conflicting groups

**Files:**
- Modify: `pipeline/src/orchestrator.ts`
- Add to: `pipeline/test/orchestrator.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/orchestrator.test.ts` (or create a new file `pipeline/test/execution-chains.test.ts`):

```typescript
// pipeline/test/execution-chains.test.ts
import { describe, it, expect } from "vitest";
import { buildExecutionChains } from "../src/orchestrator.js";

describe("buildExecutionChains", () => {
  it("puts groups sharing a seed ID in the same chain", () => {
    const groupSetupIds = new Map([
      ["group-a", ["clseedorg0000000000000"]],
      ["group-b", ["clseedorg0000000000000"]],
      ["group-c", ["clseeduser0000000000000"]],
    ]);
    const chains = buildExecutionChains(groupSetupIds);
    // group-a and group-b share clseedorg → same chain
    // group-c is independent → own chain
    expect(chains).toHaveLength(2);
    const sharedChain = chains.find(c => c.length === 2);
    expect(sharedChain).toBeDefined();
    expect(sharedChain!.sort()).toEqual(["group-a", "group-b"]);
    const independentChain = chains.find(c => c.length === 1);
    expect(independentChain).toEqual(["group-c"]);
  });

  it("keeps all groups parallel when no overlap", () => {
    const groupSetupIds = new Map([
      ["group-a", ["id-1"]],
      ["group-b", ["id-2"]],
      ["group-c", ["id-3"]],
    ]);
    const chains = buildExecutionChains(groupSetupIds);
    expect(chains).toHaveLength(3);
    expect(chains.every(c => c.length === 1)).toBe(true);
  });

  it("chains three groups that all share one ID", () => {
    const groupSetupIds = new Map([
      ["group-a", ["shared-id"]],
      ["group-b", ["shared-id"]],
      ["group-c", ["shared-id"]],
    ]);
    const chains = buildExecutionChains(groupSetupIds);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toHaveLength(3);
  });

  it("handles groups with no setup (no IDs)", () => {
    const groupSetupIds = new Map([
      ["group-a", [] as string[]],
      ["group-b", ["clseedorg"]],
    ]);
    const chains = buildExecutionChains(groupSetupIds);
    expect(chains).toHaveLength(2);
  });

  it("merges transitive overlaps", () => {
    // group-a shares id-1 with group-b, group-b shares id-2 with group-c
    // All three must be in the same chain
    const groupSetupIds = new Map([
      ["group-a", ["id-1"]],
      ["group-b", ["id-1", "id-2"]],
      ["group-c", ["id-2"]],
    ]);
    const chains = buildExecutionChains(groupSetupIds);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toHaveLength(3);
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement**

Add to `pipeline/src/orchestrator.ts` (export the function for testing):

```typescript
/**
 * Build execution chains from group setup dependencies.
 * Groups that modify the same seed row must run sequentially (same chain).
 * Groups with no overlap run in parallel (separate chains).
 *
 * Uses union-find to detect transitive overlaps:
 * If A shares id-1 with B, and B shares id-2 with C, all three are in one chain.
 */
export function buildExecutionChains(
  groupSetupIds: Map<string, string[]>
): string[][] {
  const groupIds = [...groupSetupIds.keys()];

  // Union-find
  const parent = new Map<string, string>();
  for (const id of groupIds) parent.set(id, id);

  function find(x: string): string {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  }

  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // For each seed ID, union all groups that reference it
  const seedToGroups = new Map<string, string[]>();
  for (const [groupId, ids] of groupSetupIds) {
    for (const seedId of ids) {
      if (!seedToGroups.has(seedId)) seedToGroups.set(seedId, []);
      seedToGroups.get(seedId)!.push(groupId);
    }
  }

  for (const groups of seedToGroups.values()) {
    for (let i = 1; i < groups.length; i++) {
      union(groups[0], groups[i]);
    }
  }

  // Collect chains
  const chains = new Map<string, string[]>();
  for (const groupId of groupIds) {
    const root = find(groupId);
    if (!chains.has(root)) chains.set(root, []);
    chains.get(root)!.push(groupId);
  }

  return [...chains.values()];
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Wire into orchestrator execution loop**

Replace the current "Run groups with concurrency cap" section (around line 284) with:

```typescript
// Build execution chains — groups sharing seed rows run sequentially
const groupSetupIds = new Map<string, string[]>();
for (const groupId of groupMap.keys()) {
  const condition = groupConditions.get(groupId);
  if (!condition) {
    groupSetupIds.set(groupId, []);
    continue;
  }
  // Extract seed IDs that this group's setup would reference
  // (We don't have the setup commands yet, so check if the condition
  // mentions any seed IDs from app.json)
  const referencedSeeds = seedIds.filter(id =>
    condition.includes(id) || groupId.includes(id)
  );
  // Default: all setup groups share the same seed org
  if (referencedSeeds.length === 0 && condition) {
    referencedSeeds.push("_shared_setup");
  }
  groupSetupIds.set(groupId, referencedSeeds);
}

const chains = buildExecutionChains(groupSetupIds);
callbacks.onLog(`  Execution: ${chains.length} chain(s), ${groupMap.size} group(s)`);

// Execute chains in parallel, groups within a chain sequentially
const chainPromises: Promise<void>[] = [];
for (const chain of chains) {
  if (abortController.signal.aborted) break;
  const chainPromise = (async () => {
    for (const groupId of chain) {
      if (abortController.signal.aborted) break;
      await executeGroup(groupId);
    }
  })();
  chainPromises.push(chainPromise);
}
await Promise.all(chainPromises);

// Handle any remaining queued groups that were aborted
if (abortController.signal.aborted) {
  for (const groupId of groupMap.keys()) {
    const groupAcs = groupMap.get(groupId) ?? [];
    for (const ac of groupAcs) {
      if (!allVerdicts.some(v => v.ac_id === ac.id)) {
        allVerdicts.push({ ac_id: ac.id, verdict: "auth_expired", confidence: "high", reasoning: "Skipped: auth session expired" });
        progress.update(ac.id, "skipped", "auth_expired");
      }
    }
  }
}
```

**Step 6: Run all tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 7: Commit**

```bash
git add pipeline/src/orchestrator.ts pipeline/test/execution-chains.test.ts
git commit -m "feat(pipeline): serialize groups that share seed rows — prevents race condition"
```

---

## Task 7: Genericize setup writer prompt

**Files:**
- Modify: `pipeline/src/prompts/setup-writer.txt`

**Step 1: Replace the prompt — remove all Formbricks-specific content**

```
You are a setup writer. Generate the MINIMAL SQL to put the database into the required state.

GROUP: {{groupId}}
CONDITION: {{condition}}

FIRST: Read `.verify/app.json`. It has:
- seed_ids: existing record IDs per table — these rows ALREADY EXIST. Use UPDATE.
- data_model.*.columns: maps Prisma field names → actual Postgres column names.
- data_model.*.table_name: actual Postgres table name.

Also read `.verify/learnings.md` if present — it has corrections from past runs
(column name fixes, required JSONB fields, etc). Apply these corrections.

THE #1 RULE: USE UPDATE, NOT INSERT.
The database is already seeded. The rows exist. You only need to change column values.
Look up the seed record ID from app.json seed_ids, then UPDATE that row.

IMPORTANT: For JSONB columns, include ALL fields the app needs, not just the one
being tested. Read the source code to understand what fields are checked.
If learnings.md has a "Required Fields" entry for a table, include those fields.

COLUMN NAMES:
app.json "columns" maps Prisma→Postgres. ALWAYS use the Postgres name (the value).

OUTPUT: Valid JSON to stdout:

{
  "group_id": "{{groupId}}",
  "condition": "{{condition}}",
  "setup_commands": [
    "psql \"${DATABASE_URL%%\\?*}\" --set ON_ERROR_STOP=1 -c \"UPDATE ...\""
  ],
  "teardown_commands": []
}

RULES:
1. Use `psql "${DATABASE_URL%%\?*}" --set ON_ERROR_STOP=1 -c "..."`.
2. Use UPDATE on seed records. Get IDs from app.json seed_ids.
3. Look up column names in app.json — use the Postgres column name.
4. Minimal changes — only SET columns needed for the condition.
5. For JSONB columns, include all required fields from learnings.md.
6. If the condition is null or empty, output empty arrays.
7. teardown_commands must be empty — orchestrator handles DB restoration.
8. Keep it to 1-3 commands max.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Verify no Formbricks-specific content remains**

```bash
grep -i "formbricks\|OrganizationBilling\|trialing\|stripe\|clseedorg" pipeline/src/prompts/setup-writer.txt
```

Expected: no matches.

**Step 3: Commit**

```bash
git add pipeline/src/prompts/setup-writer.txt
git commit -m "feat(pipeline): genericize setup writer prompt — no app-specific examples"
```

---

## Task 8: Run full test suite + typecheck

**Step 1: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS.

**Step 2: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: All pass. Count should be ~190+ (181 existing + new tests).

**Step 3: Commit any fixes**

---

## Task 9: E2E validation on Formbricks

**This is a manual test.** After all tasks are complete:

1. Delete learnings.md: `rm ~/Projects/opslane/evals/formbricks/.verify/learnings.md`
2. Re-seed: `cd ~/Projects/opslane/evals/formbricks && npx dotenv -e .env -- tsx packages/database/src/seed.ts --clear && npx dotenv -e .env -- tsx packages/database/src/seed.ts`
3. Run pipeline:
```bash
cd pipeline && npx tsx src/cli.ts run \
  --spec ~/Projects/opslane/evals/formbricks/.verify/spec.md \
  --verify-dir ~/Projects/opslane/evals/formbricks/.verify
```

**Expected results:**
- 6 ACs generated, ≤2 skipped
- Groups sharing seed org serialized (check for "Execution: N chain(s)" in output)
- Setup SQL uses UPDATE (not INSERT)
- Browse agents reach the app (no auth redirect)
- ac6 (feature list): verdict is `spec_unclear` (not fail)
- ac2 (payment method state): should now be correct because groups are serialized
- Report shows "NEEDS HUMAN REVIEW" section for spec_unclear ACs

**If first run fails setup (column name wrong, missing field):**
- Check learnings.md — should have a structured SQL Corrections entry
- Re-run — second run should succeed because it reads the correction
- This IS the learning loop working correctly

---

## Verification Checklist

```bash
cd pipeline && npx tsc --noEmit        # No type errors
cd pipeline && npx vitest run           # All tests pass
grep -i "formbricks\|stripe" pipeline/src/prompts/setup-writer.txt  # No app-specific content
grep -i "formbricks\|stripe" pipeline/src/prompts/learner.txt       # No app-specific content
```
