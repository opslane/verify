# Seed Data Dump Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** During `index-app`, sample actual rows from ALL data_model tables and write them to `.verify/seed-data.txt` so the setup-writer references real data instead of guessing emails, IDs, and relationships.

**Architecture:** Add a `dumpSeedData` function in `index-app.ts` that iterates every model in `data_model`, runs `SELECT * FROM "table" LIMIT 5` with psql column truncation, and writes the combined output to `.verify/seed-data.txt`. The setup-writer prompt is updated to read this file. Follows the existing `schema.sql` dump pattern exactly.

**Tech Stack:** TypeScript, Node 22 ESM, vitest

**Eng review decisions:**
- Sample ALL `data_model` tables (not just seed_ids) — catches join tables like OrganisationMember
- Use psql column truncation (`-P columns=120`) to avoid JSONB blob bloat in prompts

---

### Task 1: Add `dumpSeedData` function and tests

**Files:**
- Modify: `pipeline/src/lib/index-app.ts` (after `dumpDatabaseSchema`, line 30)
- Test: `pipeline/test/index-app.test.ts`

**Step 1: Write the failing tests**

Update the import at `pipeline/test/index-app.test.ts:2`:

```typescript
import { extractEnvVars, mergeIndexResults, findPrismaSchemaPath, dumpDatabaseSchema, dumpSeedData } from "../src/lib/index-app.js";
```

Add a new `describe` block after the existing `dumpDatabaseSchema` tests (after line 166):

```typescript
describe("dumpSeedData", () => {
  it("returns null when no DATABASE_URL in env", () => {
    const result = dumpSeedData({}, {});
    expect(result).toBeNull();
  });

  it("returns null when data_model is empty", () => {
    const result = dumpSeedData({}, { DATABASE_URL: "postgres://bad:5432/nope" });
    expect(result).toBeNull();
  });

  it("returns null when pg query fails (bad URL)", () => {
    const result = dumpSeedData(
      { User: { table_name: "User", columns: {}, enums: {}, source: "", manual_id_columns: [] } },
      { DATABASE_URL: "postgres://bad:5432/nope" },
    );
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/index-app.test.ts`
Expected: FAIL — `dumpSeedData` is not exported

**Step 3: Write the implementation**

Add to `pipeline/src/lib/index-app.ts` after `dumpDatabaseSchema` (after line 30):

```typescript
/**
 * Sample actual rows from all data_model tables so the setup-writer can reference real data.
 * For each model in data_model, runs SELECT * LIMIT 5 with column truncation.
 * Returns a human-readable text dump, or null if DB is unreachable.
 */
export function dumpSeedData(
  dataModel: AppIndex["data_model"],
  env: Record<string, string | undefined>,
): string | null {
  const dbUrl = env.DATABASE_URL ?? env.DATABASE_URI ?? env.DB_URL;
  if (!dbUrl) return null;

  const tableEntries = Object.entries(dataModel);
  if (tableEntries.length === 0) return null;

  const cleanUrl = dbUrl.split("?")[0];
  const sections: string[] = [];

  for (const [modelName, model] of tableEntries) {
    try {
      const output = execSync(
        `psql "${cleanUrl}" -P columns=120 -c "SELECT * FROM \\"${model.table_name}\\" LIMIT 5"`,
        { timeout: 10_000, encoding: "utf-8", env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
      );
      if (output.trim()) {
        sections.push(`-- ${modelName} (table: "${model.table_name}")\n${output.trim()}`);
      }
    } catch {
      // Table may not exist or query failed — skip silently
    }
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/index-app.test.ts`
Expected: PASS — all existing + 3 new

**Step 5: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

---

### Task 2: Call `dumpSeedData` in the `index-app` CLI command

**Files:**
- Modify: `pipeline/src/cli.ts:77` (update import)
- Modify: `pipeline/src/cli.ts:189` (add dump call after mergeIndexResults)

**Step 1: Update import**

Change `pipeline/src/cli.ts:77` from:
```typescript
  const { extractEnvVars, findPrismaSchemaPath, findSeedFiles, mergeIndexResults, dumpDatabaseSchema } = await import("./lib/index-app.js");
```
To:
```typescript
  const { extractEnvVars, findPrismaSchemaPath, findSeedFiles, mergeIndexResults, dumpDatabaseSchema, dumpSeedData } = await import("./lib/index-app.js");
```

**Step 2: Add seed data dump after merge**

After line 189 (after `mergeIndexResults` returns `appIndex`), before `writeFileSync(outputPath, ...)`:

```typescript
  // Dump seed data — sample actual rows from all data_model tables
  const seedDataDump = dumpSeedData(appIndex.data_model, projectEnvForDump);
  if (seedDataDump) {
    writeFileSync(join(dirname(outputPath), "seed-data.txt"), seedDataDump);
    console.log(`  Dumped seed data: ${Math.round(seedDataDump.length / 1024)}KB`);
  } else {
    console.log("  Warning: could not dump seed data (no tables or DB unreachable)");
  }
```

**Step 3: Typecheck + run all tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add pipeline/src/lib/index-app.ts pipeline/src/cli.ts pipeline/test/index-app.test.ts
git commit -m "feat(pipeline): dump seed data to .verify/seed-data.txt during index-app"
```

---

### Task 3: Update setup-writer prompts to read `seed-data.txt`

**Files:**
- Modify: `pipeline/src/prompts/setup-writer.txt:6-12`
- Modify: `pipeline/src/prompts/setup-writer-prisma.txt:7-12`

**Step 1: Update the generic prompt**

In `pipeline/src/prompts/setup-writer.txt`, replace lines 6-12:

```
FIRST: Read `.verify/app.json`. It has:
- seed_ids: existing record IDs per table — these rows ALREADY EXIST. Use UPDATE.
- data_model.*.columns: maps Prisma field names → actual Postgres column names.
- data_model.*.table_name: actual Postgres table name.

Also read `.verify/learnings.md` if present — it has corrections from past runs
(column name fixes, required JSONB fields, etc). Apply these corrections.
```

With:

```
FIRST: Read `.verify/app.json`. It has:
- seed_ids: existing record IDs per table — these rows ALREADY EXIST. Use UPDATE.
- data_model.*.columns: maps Prisma field names → actual Postgres column names.
- data_model.*.table_name: actual Postgres table name.

THEN: Read `.verify/seed-data.txt` if present — it has ACTUAL ROWS from the database.
Use this to find real IDs, emails, names, and foreign key relationships. Do NOT guess
values — use the real data from this file. If a condition requires referencing an existing
user or org member, find their actual ID and email from seed-data.txt.

Also read `.verify/learnings.md` if present — it has corrections from past runs
(column name fixes, required JSONB fields, etc). Apply these corrections.
```

Also update rule 9 (line 45) from:
```
9. Do NOT explore the application source code. Use only app.json, schema.sql, and learnings.md.
```
To:
```
9. Do NOT explore the application source code. Use only app.json, schema.sql, seed-data.txt, and learnings.md.
```

**Step 2: Update the Prisma prompt**

In `pipeline/src/prompts/setup-writer-prisma.txt`, replace lines 7-12:

```
READ THESE FILES (and ONLY these files):
1. `.verify/app.json` — column mappings, seed IDs, JSONB type annotations
2. `.verify/schema.sql` — full database DDL from pg_dump
3. `.verify/learnings.md` — corrections from past runs (if present)

DO NOT read any application source code. All information you need is in the three files above.
```

With:

```
READ THESE FILES (and ONLY these files):
1. `.verify/app.json` — column mappings, seed IDs, JSONB type annotations
2. `.verify/schema.sql` — full database DDL from pg_dump
3. `.verify/seed-data.txt` — ACTUAL ROWS from the database (if present)
4. `.verify/learnings.md` — corrections from past runs (if present)

CRITICAL: seed-data.txt contains real data from the database. Use it to find actual
user IDs, emails, org IDs, and relationships. Do NOT guess or invent values — reference
the real data. If you need to INSERT a record that references an existing user, find
their actual ID from seed-data.txt.

DO NOT read any application source code. All information you need is in the four files above.
```

Also update rule 9 (line 61) from:
```
9. Do NOT read application source code, Prisma schema files, or TypeScript files.
```
To:
```
9. Do NOT read application source code, Prisma schema files, or TypeScript files. Read ONLY the 4 files listed above.
```

**Step 3: Typecheck + run tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS — prompt changes don't affect tests

**Step 4: Commit**

```bash
git add pipeline/src/prompts/setup-writer.txt pipeline/src/prompts/setup-writer-prisma.txt
git commit -m "feat(pipeline): setup-writer reads seed-data.txt for real data grounding"
```

---

## Summary

| Task | Files | What |
|------|-------|------|
| 1 | `index-app.ts`, `index-app.test.ts` | `dumpSeedData` — samples all data_model tables + 3 tests |
| 2 | `cli.ts` | Call `dumpSeedData` after merge, write `.verify/seed-data.txt` |
| 3 | `setup-writer.txt`, `setup-writer-prisma.txt` | Prompt reads seed-data.txt, uses real data |

**Total: 4 files modified, 0 new files, 3 new tests.**

## Verification (run in this order before final commit)

1. `cd pipeline && npx tsc --noEmit` — no type errors
2. `cd pipeline && npx vitest run` — all tests pass (~217 expected)
3. Manual: run `index-app` on target project — verify `.verify/seed-data.txt` exists with real rows
4. Manual: run pipeline — verify setup-writer SQL uses real IDs/emails from seed-data.txt
