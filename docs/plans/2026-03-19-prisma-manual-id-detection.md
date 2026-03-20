# Prisma Manual ID Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect Prisma `@id` fields that have no `@default(...)` and expose them in `app.json` so the setup-writer knows to generate explicit IDs instead of relying on DB auto-generation.

**Architecture:** Extend `parsePrismaSchema` to track which fields are `@id` without `@default`. Surface this as `manual_id_columns` (Postgres column names) per model in the `AppIndex` type. The setup-writer prompt tells the LLM to use `gen_random_uuid()` or a literal string for these columns. The retry loop provides defense in depth — if the LLM still forgets, the psql error feedback will catch it.

**Tech Stack:** TypeScript, Node 22 ESM, vitest

**Eng review decisions:**
- Export `PrismaModel` type from `prisma-parser.ts` — reuse in `cli.ts` and `index-app.ts` (DRY fix)
- Add merge test in `index-app.test.ts` for `manual_id_columns` pass-through

---

### Task 1: Export `PrismaModel`, add `manual_id_columns`, write parser tests

**Files:**
- Modify: `pipeline/src/lib/prisma-parser.ts:2-6` (export PrismaModel, add field)
- Modify: `pipeline/src/lib/prisma-parser.ts:71-93` (field parsing loop)
- Test: `pipeline/test/prisma-parser.test.ts`

**Step 1: Write the failing tests**

Add a new `describe` block in `pipeline/test/prisma-parser.test.ts` right before `describe("extractModelBody")` (line 163):

```typescript
describe("parsePrismaSchema manual ID detection", () => {
  it("flags @id field with no @default as manual", () => {
    const schema = `
model Document {
  id        String   @id
  title     String
  createdAt DateTime @default(now())
}`;
    const result = parsePrismaSchema(schema);
    expect(result.Document.manual_id_columns).toEqual(["id"]);
  });

  it("does not flag @id with @default(cuid())", () => {
    const schema = `
model User {
  id    String @id @default(cuid())
  name  String
}`;
    const result = parsePrismaSchema(schema);
    expect(result.User.manual_id_columns).toEqual([]);
  });

  it("does not flag @id with @default(autoincrement())", () => {
    const schema = `
model Post {
  id    Int    @id @default(autoincrement())
  title String
}`;
    const result = parsePrismaSchema(schema);
    expect(result.Post.manual_id_columns).toEqual([]);
  });

  it("handles @id with @map but no @default", () => {
    const schema = `
model ApiKey {
  id        String @id @map("api_key_id")
  label     String
}`;
    const result = parsePrismaSchema(schema);
    expect(result.ApiKey.manual_id_columns).toEqual(["api_key_id"]);
  });

  it("handles compound @@id (no manual_id_columns)", () => {
    const schema = `
model UserRole {
  userId String
  roleId String
  @@id([userId, roleId])
}`;
    const result = parsePrismaSchema(schema);
    expect(result.UserRole.manual_id_columns).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/prisma-parser.test.ts`
Expected: FAIL — `manual_id_columns` property does not exist on result

**Step 3: Write the implementation**

In `pipeline/src/lib/prisma-parser.ts`:

1. Export and extend the `PrismaModel` interface (replace lines 2-6):

```typescript
export interface PrismaModel {
  table_name: string;
  columns: Record<string, string>;   // prismaFieldName → postgresColumnName
  manual_id_columns: string[];       // Postgres column names that are @id with no @default
}
```

2. In the field parsing loop, add `manual_id_columns` tracking. Add `const manualIdColumns: string[] = [];` before the loop (after line 71's `const columns`), then replace lines 88-90 with:

```typescript
      // Check for @map("column_name") or @map(name: "column_name")
      const mapMatch = trimmed.match(/@map\(\s*(?:name:\s*)?"([^"]+)"\s*\)/);
      const pgColumnName = mapMatch ? mapMatch[1] : fieldName;
      columns[fieldName] = pgColumnName;

      // Detect @id fields with no @default — these need explicit IDs in SQL
      if (/@id(?:\s|$)/.test(trimmed) && !/@default\(/.test(trimmed)) {
        manualIdColumns.push(pgColumnName);
      }
```

3. Update the model assignment (replace line 93):

```typescript
    models[modelName] = { table_name: tableName, columns, manual_id_columns: manualIdColumns };
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/prisma-parser.test.ts`
Expected: PASS — all 16 existing + 5 new = 21 tests

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: Type errors in `index-app.ts` and `cli.ts` — `PrismaModel` shape changed. Fixed in Task 2.

---

### Task 2: Wire `manual_id_columns` through AppIndex, fix types everywhere

**Files:**
- Modify: `pipeline/src/lib/types.ts:114-119` (AppIndex.data_model)
- Modify: `pipeline/src/lib/index-app.ts:155,179-184` (mergeIndexResults signature + body)
- Modify: `pipeline/src/cli.ts:78,87` (import PrismaModel, use it)
- Modify: `pipeline/test/fixtures/app-index.json:14-20`
- Modify: `pipeline/test/index-app.test.ts:2,44,61` (import + update merge calls)

**Step 1: Update `AppIndex` type**

In `pipeline/src/lib/types.ts`, add `manual_id_columns` to the `data_model` entry. Replace lines 114-119:

```typescript
  data_model: Record<string, {
    columns: Record<string, string>;    // prismaFieldName → postgresColumnName
    table_name: string;                 // actual Postgres table name (from @@map, or model name)
    enums: Record<string, string[]>;
    source: string;
    manual_id_columns: string[];        // @id columns with no @default — need explicit IDs in SQL
  }>;
```

**Step 2: Update `mergeIndexResults` in `index-app.ts`**

Replace the `prismaMapping` parameter type (line 155). Import `PrismaModel` and use it:

Add at top of file:
```typescript
import type { PrismaModel } from "./prisma-parser.js";
```

Change line 155 from:
```typescript
  prismaMapping: Record<string, { table_name: string; columns: Record<string, string> }>,
```
To:
```typescript
  prismaMapping: Record<string, PrismaModel>,
```

Add `manual_id_columns` to the model assignment (line 179-184). Replace that block:

```typescript
    dataModel[modelName] = {
      columns,
      table_name: mapping?.table_name ?? modelName,
      enums: (llmData && typeof llmData.enums === "object" && !Array.isArray(llmData.enums)) ? llmData.enums : {},
      source: llmData?.source ?? "prisma-parser",
      manual_id_columns: mapping?.manual_id_columns ?? [],
    };
```

**Step 3: Update CLI to use `PrismaModel` type**

In `pipeline/src/cli.ts`, update the import at line 78 to also import `PrismaModel`:

```typescript
  const { parsePrismaSchema, extractJsonFieldAnnotations } = await import("./lib/prisma-parser.js");
```

Since `parsePrismaSchema` returns `Record<string, PrismaModel>`, we can use TypeScript inference. Replace line 87:

```typescript
  let prismaMapping: Record<string, { table_name: string; columns: Record<string, string> }> = {};
```

With:

```typescript
  let prismaMapping: Awaited<ReturnType<typeof parsePrismaSchema>> = {};
```

This uses the return type of `parsePrismaSchema` directly — no manual type duplication. When `PrismaModel` changes, this adapts automatically.

Note: `typeof parsePrismaSchema` works here because the import is `await import(...)` in the same scope. If TypeScript complains, fall back to:

```typescript
  const { parsePrismaSchema, extractJsonFieldAnnotations } = await import("./lib/prisma-parser.js");
  type PrismaMapping = ReturnType<typeof parsePrismaSchema>;
  let prismaMapping: PrismaMapping = {};
```

**Step 4: Update test fixture**

In `pipeline/test/fixtures/app-index.json`, add `manual_id_columns` to the Organization model (after `"source"` line):

```json
    "Organization": {
      "columns": { "id": "id", "name": "name", "billingStatus": "billing_status" },
      "table_name": "Organization",
      "enums": { "BillingStatus": ["active", "trialing", "canceled"] },
      "source": "prisma/schema.prisma:42",
      "manual_id_columns": []
    }
```

**Step 5: Update index-app merge tests**

In `pipeline/test/index-app.test.ts`, update the `prismaMapping` arguments in merge tests to include `manual_id_columns`:

Line 44 — first merge test:
```typescript
      { User: { table_name: "User", columns: { id: "id", name: "name" }, manual_id_columns: [] } },
```

Line 61 — "includes models from prismaMapping" test:
```typescript
      { ApiKey: { table_name: "api_keys", columns: { id: "id", label: "label" }, manual_id_columns: ["id"] } },
```

Then add assertion on line 67:
```typescript
    expect(result.data_model.ApiKey.manual_id_columns).toEqual(["id"]);
```

**Step 6: Add merge pass-through test** (eng review decision)

Add a new test in the `describe("mergeIndexResults")` block:

```typescript
  it("passes manual_id_columns from prismaMapping to data_model", () => {
    const result = mergeIndexResults(
      { routes: {} },
      { pages: {} },
      { data_model: {} },
      { fixtures: {} },
      { db_url_env: null, feature_flags: [] },
      { Document: { table_name: "Document", columns: { id: "id", title: "title" }, manual_id_columns: ["id"] } },
      {}
    );
    expect(result.data_model.Document.manual_id_columns).toEqual(["id"]);
  });

  it("defaults manual_id_columns to empty when no prismaMapping", () => {
    const result = mergeIndexResults(
      { routes: {} },
      { pages: {} },
      { data_model: { User: { columns: ["id"], enums: {}, source: "s" } } },
      { fixtures: {} },
      { db_url_env: null, feature_flags: [] },
      {},
      {}
    );
    expect(result.data_model.User.manual_id_columns).toEqual([]);
  });
```

**Step 7: Typecheck + run all tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS — all tests, zero type errors

**Step 8: Commit**

```bash
git add pipeline/src/lib/prisma-parser.ts pipeline/test/prisma-parser.test.ts \
       pipeline/src/lib/types.ts pipeline/src/lib/index-app.ts pipeline/src/cli.ts \
       pipeline/test/fixtures/app-index.json pipeline/test/index-app.test.ts
git commit -m "feat(pipeline): detect @id columns without @default — surface as manual_id_columns in app.json"
```

---

### Task 3: Update setup-writer prompts to reference `manual_id_columns`

**Files:**
- Modify: `pipeline/src/prompts/setup-writer.txt:22-23`
- Modify: `pipeline/src/prompts/setup-writer-prisma.txt:38-39`

**Step 1: Add manual ID instruction to generic prompt**

In `pipeline/src/prompts/setup-writer.txt`, add after the `COLUMN NAMES:` block (after line 23):

```
MANUAL ID COLUMNS:
Some tables have ID columns with no database default — the app generates IDs in code.
Check data_model.*.manual_id_columns in app.json. For any listed column, you MUST provide
an explicit value. Use gen_random_uuid() for UUID-style or 'verify-test-{{groupId}}-001'
for string IDs. Never omit these columns from INSERT statements.
```

**Step 2: Add manual ID instruction to Prisma prompt**

In `pipeline/src/prompts/setup-writer-prisma.txt`, add after the `COLUMN NAMES:` block (after line 39):

```
MANUAL ID COLUMNS:
Some Prisma models have @id fields with no @default — the app generates IDs in application code.
Check data_model.*.manual_id_columns in app.json. For any listed column, you MUST provide
an explicit value. Use gen_random_uuid() for UUID-style or 'verify-test-{{groupId}}-001'
for string IDs. Never omit these columns from INSERT statements.
```

**Step 3: Typecheck + run tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS — prompt changes don't affect tests

**Step 4: Commit**

```bash
git add pipeline/src/prompts/setup-writer.txt pipeline/src/prompts/setup-writer-prisma.txt
git commit -m "feat(pipeline): setup-writer prompt instructs LLM to provide explicit IDs for manual_id_columns"
```

---

## Summary

| Task | Files | What |
|------|-------|------|
| 1 | `prisma-parser.ts`, `prisma-parser.test.ts` | Export `PrismaModel`, add `manual_id_columns` detection + 5 unit tests |
| 2 | `types.ts`, `index-app.ts`, `cli.ts`, fixture, `index-app.test.ts` | Wire through `AppIndex`, DRY type fix, 2 merge tests |
| 3 | `setup-writer.txt`, `setup-writer-prisma.txt` | Prompt instruction for explicit ID generation |

**Total: 8 files modified, 0 new files, 7 new tests.**

## Verification (run in this order before final commit)

1. `cd pipeline && npx tsc --noEmit` — no type errors
2. `cd pipeline && npx vitest run` — all tests pass (~214 expected)
