# Setup Writer ORM Dispatch + Schema Capture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two E2E failures: (1) setup writer times out at 240s exploring codebase for schema knowledge it should already have, (2) judge returns `fail` instead of `spec_unclear` when an element is absent from the expected page. Root cause: LLM stages gather knowledge at runtime instead of consuming pre-gathered data.

**Architecture:** Add `pg_dump --schema-only` to index-app (generic). Add Prisma JSONB type extraction to prisma-parser (Prisma-specific). Dispatch ORM-specific setup writer prompts via existing `detectORM()`. Restrict setup writer tool access. Update judge prompt for absent-element spec_unclear.

**Tech Stack:** TypeScript, vitest. No new dependencies.

**Review findings incorporated:**
- Extract shared `extractModelBody()` helper in prisma-parser.ts (DRY — used by both parsePrismaSchema and extractJsonFieldAnnotations)
- `buildSetupWriterPrompt` projectRoot parameter is REQUIRED (not optional) — fails loudly if missing
- Add unit tests for: extractModelBody, ORM dispatch, dumpDatabaseSchema success path
- Update TODOS.md Multi-ORM entry to reflect Prisma path + dispatch infra is done

---

## Task 1: Add `pg_dump --schema-only` to index-app

**Files:**
- Modify: `pipeline/src/lib/index-app.ts`
- Modify: `pipeline/src/cli.ts` (index-app command)
- Create: `pipeline/test/schema-dump.test.ts`

**Step 1: Write the failing test**

```typescript
// pipeline/test/schema-dump.test.ts
import { describe, it, expect, vi } from "vitest";
import { dumpDatabaseSchema } from "../src/lib/index-app.js";

describe("dumpDatabaseSchema", () => {
  it("returns null when DATABASE_URL not found", () => {
    const result = dumpDatabaseSchema({});
    expect(result).toBeNull();
  });

  it("returns null when pg_dump fails", () => {
    const result = dumpDatabaseSchema({ DATABASE_URL: "postgres://bad:5432/nope" });
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test — expect FAIL**

Run: `cd pipeline && npx vitest run test/schema-dump.test.ts`

**Step 3: Implement `dumpDatabaseSchema`**

Add to `pipeline/src/lib/index-app.ts`:

```typescript
import { execSync } from "node:child_process";

/**
 * Run pg_dump --schema-only against the project's database.
 * Returns raw DDL string, or null if DATABASE_URL is missing or pg_dump fails.
 * Generic — works for any Postgres-backed project regardless of ORM.
 */
export function dumpDatabaseSchema(env: Record<string, string | undefined>): string | null {
  const dbUrl = env.DATABASE_URL ?? env.DATABASE_URI ?? env.DB_URL;
  if (!dbUrl) return null;

  // Strip query params for pg_dump (same pattern as setup-writer psql commands)
  const cleanUrl = dbUrl.split("?")[0];

  try {
    const ddl = execSync(`pg_dump --schema-only "${cleanUrl}"`, {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return ddl.toString("utf-8");
  } catch {
    return null;
  }
}
```

**Step 4: Run test — expect PASS**

**Step 5: Wire into index-app CLI command**

In `pipeline/src/cli.ts`, in the `index-app` command, after the deterministic parsing section and before the LLM agents:

```typescript
// Dump database schema (generic — works for any Postgres project)
const projectEnvForDump = (await import("./stages/setup-writer.js")).loadProjectEnv(projectDir);
const schemaDdl = dumpDatabaseSchema(projectEnvForDump);
if (schemaDdl) {
  writeFileSync(join(dirname(outputPath), "schema.sql"), schemaDdl);
  console.log(`  Dumped database schema: ${Math.round(schemaDdl.length / 1024)}KB`);
} else {
  console.log("  Warning: could not dump database schema (DATABASE_URL missing or pg_dump failed)");
}
```

**Step 6: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 7: Commit**

```bash
git add pipeline/src/lib/index-app.ts pipeline/src/cli.ts pipeline/test/schema-dump.test.ts
git commit -m "feat(pipeline): add pg_dump --schema-only to index-app — generic schema capture"
```

---

## Task 2: Extract Prisma JSONB type annotations

**Files:**
- Modify: `pipeline/src/lib/prisma-parser.ts`
- Modify: `pipeline/test/prisma-parser.test.ts`

Prisma schemas annotate JSONB fields with `/// [TypeName]` comments that reference TypeScript/Zod types. Extract these annotations so the setup writer knows which fields a JSONB column expects.

**Step 1: Write the failing tests**

Add to `pipeline/test/prisma-parser.test.ts`:

```typescript
import { parsePrismaSchema, extractJsonFieldAnnotations } from "../src/lib/prisma-parser.js";

describe("extractJsonFieldAnnotations", () => {
  it("extracts /// [TypeName] annotations for Json fields", () => {
    const schema = `
model OrganizationBilling {
  organizationId   String  @id @map(name: "organization_id")
  /// [OrganizationBillingPlanLimits]
  limits           Json
  /// [OrganizationStripeBilling]
  stripe           Json?
  createdAt        DateTime @default(now())
}
`;
    const result = extractJsonFieldAnnotations(schema);
    expect(result).toEqual({
      OrganizationBilling: {
        limits: "OrganizationBillingPlanLimits",
        stripe: "OrganizationStripeBilling",
      },
    });
  });

  it("returns empty map when no Json fields have annotations", () => {
    const schema = `
model User {
  id    String @id
  name  String
  data  Json
}
`;
    const result = extractJsonFieldAnnotations(schema);
    expect(result).toEqual({});
  });

  it("ignores annotations on non-Json fields", () => {
    const schema = `
model User {
  /// [SomeType]
  name  String
  /// [JsonType]
  data  Json
}
`;
    const result = extractJsonFieldAnnotations(schema);
    expect(result).toEqual({
      User: { data: "JsonType" },
    });
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement `extractJsonFieldAnnotations`**

Add to `pipeline/src/lib/prisma-parser.ts`:

```typescript
/**
 * Extract Prisma /// [TypeName] annotations on Json fields.
 * Returns: { ModelName: { fieldName: "TypeName" } }
 * Prisma-specific: these annotations reference TypeScript/Zod types
 * that define the JSONB field's expected shape.
 */
export function extractJsonFieldAnnotations(
  content: string
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  const modelHeaderRegex = /model\s+(\w+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = modelHeaderRegex.exec(content)) !== null) {
    const modelName = match[1];
    const bodyStart = match.index + match[0].length;
    // Find matching closing brace (reuse balanced-brace logic)
    let depth = 1;
    let i = bodyStart;
    let inQuote = false;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '"' && content[i - 1] !== '\\') inQuote = !inQuote;
      if (!inQuote) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      i++;
    }
    const body = content.slice(bodyStart, i - 1);
    const lines = body.split("\n");

    let pendingAnnotation: string | null = null;
    for (const line of lines) {
      const trimmed = line.trim();

      // Check for /// [TypeName] annotation
      const annotationMatch = trimmed.match(/^\/\/\/\s*\[(\w+)\]/);
      if (annotationMatch) {
        pendingAnnotation = annotationMatch[1];
        continue;
      }

      // Check if this line is a Json field
      if (pendingAnnotation) {
        const fieldMatch = trimmed.match(/^(\w+)\s+Json(\?|\[\])?\s/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          if (!result[modelName]) result[modelName] = {};
          result[modelName][fieldName] = pendingAnnotation;
        }
        pendingAnnotation = null;
      }
    }
  }

  return result;
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add pipeline/src/lib/prisma-parser.ts pipeline/test/prisma-parser.test.ts
git commit -m "feat(pipeline): extract Prisma JSONB type annotations — ORM-specific schema enrichment"
```

---

## Task 3: Store JSONB annotations in AppIndex

**Files:**
- Modify: `pipeline/src/lib/types.ts` (AppIndex type)
- Modify: `pipeline/src/lib/index-app.ts` (mergeIndexResults)
- Modify: `pipeline/src/cli.ts` (wire extraction into index-app command)
- Modify: `pipeline/test/index-app.test.ts`

**Step 1: Extend AppIndex type**

In `pipeline/src/lib/types.ts`, add to the `AppIndex` interface:

```typescript
export interface AppIndex {
  // ... existing fields ...
  json_type_annotations: Record<string, Record<string, string>>;  // model → { field → TypeName }
}
```

**Step 2: Update mergeIndexResults**

Add `jsonAnnotations` parameter and include in output:

```typescript
export function mergeIndexResults(
  routes: ...,
  selectors: ...,
  schema: ...,
  fixtures: ...,
  envVars: ...,
  prismaMapping: ...,
  seedIds: ...,
  jsonAnnotations?: Record<string, Record<string, string>>,
): AppIndex {
  // ... existing code ...
  return {
    // ... existing fields ...
    json_type_annotations: jsonAnnotations ?? {},
  };
}
```

**Step 3: Wire into CLI**

In `pipeline/src/cli.ts` index-app command, after `parsePrismaSchema`:

```typescript
const { extractJsonFieldAnnotations } = await import("./lib/prisma-parser.js");
let jsonAnnotations: Record<string, Record<string, string>> = {};
if (schemaPath) {
  jsonAnnotations = extractJsonFieldAnnotations(readFs(schemaPath, "utf-8"));
  const annotatedFields = Object.values(jsonAnnotations).reduce((n, m) => n + Object.keys(m).length, 0);
  if (annotatedFields > 0) {
    console.log(`  Found ${annotatedFields} JSONB type annotations`);
  }
}
```

Pass `jsonAnnotations` to `mergeIndexResults`.

**Step 4: Update test fixture and tests**

Add `json_type_annotations: {}` to existing test fixture and assertions.

**Step 5: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 6: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/lib/index-app.ts pipeline/src/cli.ts pipeline/test/index-app.test.ts
git commit -m "feat(pipeline): store JSONB type annotations in AppIndex"
```

---

## Task 4: Restrict setup writer tool access

**Files:**
- Modify: `pipeline/src/lib/types.ts`

**Step 1: Update STAGE_PERMISSIONS**

Change:
```typescript
"setup-writer":  { dangerouslySkipPermissions: true },   // needs Read for schema files
```

To:
```typescript
"setup-writer":  { allowedTools: ["Bash", "Read"] },      // Bash for psql, Read for app.json/schema.sql/learnings.md
```

**Step 2: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

**Step 3: Commit**

```bash
git add pipeline/src/lib/types.ts
git commit -m "feat(pipeline): restrict setup writer to Bash + Read — no codebase exploration"
```

---

## Task 5: Create Prisma-specific setup writer prompt

**Files:**
- Create: `pipeline/src/prompts/setup-writer-prisma.txt`
- Modify: `pipeline/src/prompts/setup-writer.txt` (keep as generic fallback)
- Modify: `pipeline/src/stages/setup-writer.ts` (dispatch by ORM)

**Step 1: Write the Prisma-specific prompt**

```
You are a setup writer for a Prisma-backed Postgres application.
Generate the MINIMAL SQL to put the database into the required state.

GROUP: {{groupId}}
CONDITION: {{condition}}

READ THESE FILES (and ONLY these files):
1. `.verify/app.json` — column mappings, seed IDs, JSONB type annotations
2. `.verify/schema.sql` — full database DDL from pg_dump
3. `.verify/learnings.md` — corrections from past runs (if present)

DO NOT read any application source code. All information you need is in the three files above.

FROM app.json:
- seed_ids: existing record IDs per table — these rows ALREADY EXIST. Use UPDATE.
- data_model.*.columns: maps Prisma field names → actual Postgres column names.
- data_model.*.table_name: actual Postgres table name.
- json_type_annotations: which JSONB fields have type annotations (tells you the field exists and is structured).

FROM schema.sql:
- Column types, NOT NULL constraints, defaults, CHECK constraints.
- Use this to understand what values are valid for each column.

FROM learnings.md:
- SQL Corrections: column name fixes from past errors.
- Required Fields: JSONB fields that must be present for the app to render correctly.
- Apply all corrections and include all required fields.

THE #1 RULE: USE UPDATE, NOT INSERT.
The database is already seeded. The rows exist. You only need to change column values.
Look up the seed record ID from app.json seed_ids, then UPDATE that row.

JSONB COLUMNS:
When updating a JSONB column, include ALL fields listed in learnings.md "Required Fields"
for that table. If no Required Fields entry exists yet, include the fields that seem
relevant to the condition being set up. The learner will capture corrections if you miss any.

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
9. Do NOT read application source code, Prisma schema files, or TypeScript files.

Output ONLY the JSON. No explanation, no markdown fences.
```

**Step 2: Update `buildSetupWriterPrompt` to dispatch by ORM**

In `pipeline/src/stages/setup-writer.ts`:

```typescript
export function buildSetupWriterPrompt(groupId: string, condition: string, projectRoot?: string): string {
  // Select prompt based on detected ORM
  let promptFile = "setup-writer.txt";
  if (projectRoot) {
    const orm = detectORM(projectRoot);
    if (orm === "prisma") promptFile = "setup-writer-prisma.txt";
    // Future: "drizzle" → "setup-writer-drizzle.txt"
  }
  const template = readFileSync(join(__dirname, "../prompts", promptFile), "utf-8");
  return template.replaceAll("{{groupId}}", groupId).replaceAll("{{condition}}", condition);
}
```

**Step 3: Update generic fallback prompt**

Keep `setup-writer.txt` but add "Read `.verify/schema.sql` if present" and remove "Read the source code to understand what fields are checked."

**Step 4: Update orchestrator call**

In `pipeline/src/orchestrator.ts`, pass `projectRoot` to `buildSetupWriterPrompt`:

```typescript
const setupPrompt = buildSetupWriterPrompt(groupId, condition, projectRoot);
```

**Step 5: Update CLI run-stage call**

In `pipeline/src/cli.ts` setup-writer case, pass `projectRoot`:

```typescript
const prompt = buildSetupWriterPrompt(groupId, condition, projectRoot);
```

**Step 6: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`

Existing tests mock `buildSetupWriterPrompt` so they won't break. The function signature change (optional `projectRoot`) is backwards-compatible.

**Step 7: Commit**

```bash
git add pipeline/src/prompts/setup-writer-prisma.txt pipeline/src/prompts/setup-writer.txt pipeline/src/stages/setup-writer.ts pipeline/src/orchestrator.ts pipeline/src/cli.ts
git commit -m "feat(pipeline): ORM-dispatched setup writer — Prisma-specific prompt, no source code exploration"
```

---

## Task 6: Update judge prompt for absent-element spec_unclear

**Files:**
- Modify: `pipeline/src/prompts/judge.txt`

**Step 1: Add absent-element guidance**

In the `WHEN TO USE EACH VERDICT` section, update the `spec_unclear` entry:

```
- spec_unclear: Evidence suggests the SPEC is wrong, not the code. Use when:
  - A component exists but in a different location than the spec describes
  - A feature works differently than the spec assumes
  - The expected behavior contradicts what the code clearly intends
  - The browse agent navigated to the correct URL but the expected element is
    COMPLETELY ABSENT from the page — not hidden, not loading, not behind a click,
    but genuinely not part of that page's UI. This suggests the spec assumed the
    wrong page location for this feature.
  Include what the spec says vs what the code actually does in the reasoning.
```

Update rule 8:

```
8. Use spec_unclear when you have evidence that the spec's assumption is wrong.
   This includes: element found elsewhere, feature works differently than spec assumes,
   OR element is completely absent from the page the spec directed the agent to
   (suggesting the spec has the wrong page location). Don't use it as a fallback
   for ambiguous or low-quality evidence — that's "fail" with low confidence.
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/judge.txt
git commit -m "feat(pipeline): judge treats absent-element-on-expected-page as spec_unclear signal"
```

---

## Task 7: Run full test suite + typecheck

**Step 1: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`

**Step 2: Run all tests**

Run: `cd pipeline && npx vitest run`

Expected: All pass. Count should be ~195+ (189 existing + new tests).

---

## Task 8: E2E validation on Formbricks

**Prerequisite:** Re-run `/verify-setup` (index-app) on Formbricks to generate `schema.sql` and updated `app.json` with `json_type_annotations`.

1. Re-index: `cd pipeline && npx tsx src/cli.ts index-app --project-dir ~/Projects/opslane/evals/formbricks`
2. Verify `schema.sql` exists: `ls -la ~/Projects/opslane/evals/formbricks/.verify/schema.sql`
3. Verify `json_type_annotations` in app.json: `python3 -c "import json; d=json.load(open('$HOME/Projects/opslane/evals/formbricks/.verify/app.json')); print(json.dumps(d.get('json_type_annotations', {}), indent=2))"`
4. Delete learnings: `rm ~/Projects/opslane/evals/formbricks/.verify/learnings.md`
5. Re-seed: `cd ~/Projects/opslane/evals/formbricks && npx dotenv -e .env -- tsx packages/database/src/seed.ts --clear && npx dotenv -e .env -- tsx packages/database/src/seed.ts`
6. Run pipeline:
```bash
cd pipeline && npx tsx src/cli.ts run \
  --spec ~/Projects/opslane/evals/formbricks/.verify/spec.md \
  --verify-dir ~/Projects/opslane/evals/formbricks/.verify
```

**Expected results:**
- Setup groups complete in <90s each (no timeout)
- Setup SQL uses correct JSONB fields (subscriptionStatus, hasPaymentMethod, plan, trialEnd)
- ac1-ac5: pass
- ac6: `spec_unclear` (not fail, not timeout)
- Report shows "NEEDS HUMAN REVIEW" section
- Total pipeline time: <8min (down from 18min)

---

## Verification Checklist

```bash
cd pipeline && npx tsc --noEmit                    # No type errors
cd pipeline && npx vitest run                       # All tests pass
ls ~/.verify/schema.sql 2>/dev/null                 # schema.sql generated
grep "json_type_annotations" pipeline/src/lib/types.ts  # Type exists
grep "detectORM" pipeline/src/stages/setup-writer.ts    # ORM dispatch wired
grep "dangerouslySkipPermissions" pipeline/src/lib/types.ts  # Should only appear for ac-generator, planner, learner
```
