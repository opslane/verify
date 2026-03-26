# URL Lookup Column Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 15/26 Documenso eval failures by detecting `@unique` URL-lookup columns from Prisma schema and using them in route resolution instead of primary keys.

**Architecture:** At index-app time, parse `@unique` annotations from the Prisma schema to find columns like `secondaryId` and `slug` that apps use in URLs instead of PKs. Store in `app.json` as `url_lookup_columns`. Route resolver uses these columns when building `example_urls`. Setup-writer captures them via `RETURNING` for future use.

**Tech Stack:** TypeScript, vitest, Prisma schema parsing (regex)

**Spike evidence:** `spike-unique-col-resolver.ts` — `@unique` heuristic is 2/2 correct on ground truth (Envelope.secondaryId, Team.url).

---

## Task 1: Extend Prisma parser to detect @unique columns

**Files:**
- Modify: `pipeline/src/lib/prisma-parser.ts:3-7` (PrismaModel interface)
- Modify: `pipeline/src/lib/prisma-parser.ts:72-101` (parsePrismaSchema field loop)
- Test: `pipeline/test/prisma-parser.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/prisma-parser.test.ts`, after the `"parsePrismaSchema manual ID detection"` describe block (line ~215):

```typescript
describe("parsePrismaSchema @unique detection", () => {
  it("detects @unique fields", () => {
    const schema = `
model Envelope {
  id          String @id @default(cuid())
  secondaryId String @unique
  title       String
}`;
    const result = parsePrismaSchema(schema);
    expect(result.Envelope.unique_columns).toEqual(["secondaryId"]);
  });

  it("excludes @id @unique (PK is not a URL lookup column)", () => {
    const schema = `
model User {
  id    String @id @unique @default(cuid())
  email String @unique
}`;
    const result = parsePrismaSchema(schema);
    // id has @id so it should NOT be in unique_columns; email should
    expect(result.User.unique_columns).toEqual(["email"]);
  });

  it("uses @map name for @unique columns", () => {
    const schema = `
model Team {
  id  Int    @id @default(autoincrement())
  url String @unique @map("team_url")
}`;
    const result = parsePrismaSchema(schema);
    expect(result.Team.unique_columns).toEqual(["team_url"]);
  });

  it("returns empty array when no @unique fields", () => {
    const schema = `
model Post {
  id    String @id @default(cuid())
  title String
}`;
    const result = parsePrismaSchema(schema);
    expect(result.Post.unique_columns).toEqual([]);
  });

  it("detects multiple @unique fields", () => {
    const schema = `
model Organisation {
  id         String @id @default(cuid())
  url        String @unique
  customerId String @unique
}`;
    const result = parsePrismaSchema(schema);
    expect(result.Organisation.unique_columns).toContain("url");
    expect(result.Organisation.unique_columns).toContain("customerId");
    expect(result.Organisation.unique_columns).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/prisma-parser.test.ts`
Expected: FAIL — `unique_columns` is not defined on PrismaModel

**Step 3: Add `unique_columns` to PrismaModel**

In `pipeline/src/lib/prisma-parser.ts`, change the interface (line 3-7):

```typescript
export interface PrismaModel {
  table_name: string;
  columns: Record<string, string>;   // prismaFieldName → postgresColumnName
  manual_id_columns: string[];       // Postgres column names that are @id with no @default
  unique_columns: string[];          // Postgres column names with @unique (non-PK)
}
```

**Step 4: Add @unique detection to parsePrismaSchema**

In the field-parsing loop, after line 73 (`const manualIdColumns: string[] = [];`), add:

```typescript
    const uniqueColumns: string[] = [];
```

After the `@id` detection block (line 96-98), add:

```typescript
      // Detect @unique columns (non-PK) for URL lookup
      if (/@unique(?:\s|\(|$)/.test(trimmed) && !/@id(?:\s|$)/.test(trimmed)) {
        uniqueColumns.push(pgColumnName);
      }
```

Change the model construction (line 101) from:

```typescript
    models[modelName] = { table_name: tableName, columns, manual_id_columns: manualIdColumns };
```

to:

```typescript
    models[modelName] = { table_name: tableName, columns, manual_id_columns: manualIdColumns, unique_columns: uniqueColumns };
```

**Step 5: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/prisma-parser.test.ts`
Expected: PASS — all existing tests + 5 new @unique tests

**Step 6: Typecheck + full suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS — 372+ tests

**Step 7: Commit**

```bash
git add pipeline/src/lib/prisma-parser.ts pipeline/test/prisma-parser.test.ts
git commit -m "feat(prisma-parser): detect @unique columns for URL lookup"
```

---

## Task 2: Add `url_lookup_columns` to AppIndex + populate in mergeIndexResults

**Files:**
- Modify: `pipeline/src/lib/types.ts:119-145` (AppIndex interface)
- Modify: `pipeline/src/lib/index-app.ts:235-246` (mergeIndexResults return)

**Step 1: Add type to AppIndex**

In `pipeline/src/lib/types.ts`, add to `AppIndex` interface before the closing `}`:

```typescript
  /** Model → Postgres column name used for URL lookups (from @unique).
   *  When present, route resolver uses this column instead of PK for :id params. */
  url_lookup_columns?: Record<string, string>;
```

**Step 2: Populate in mergeIndexResults**

In `pipeline/src/lib/index-app.ts`, after the `dataModel` loop (after line 225, before the pages cross-reference), add:

```typescript
  // Build URL lookup columns from @unique annotations
  // Heuristic: if a model has a @unique column with a URL-friendly name, routes likely use it
  const urlLookupColumns: Record<string, string> = {};
  const urlCandidateNames = ["secondaryId", "slug", "url", "uid", "publicId", "handle", "uuid"];
  for (const [modelName, prismaModel] of Object.entries(prismaMapping)) {
    for (const pgCol of prismaModel.unique_columns) {
      // Find the Prisma field name — we compare against Prisma names, store Postgres names
      const prismaField = Object.entries(prismaModel.columns).find(([, pg]) => pg === pgCol)?.[0] ?? pgCol;
      if (urlCandidateNames.includes(prismaField)) {
        urlLookupColumns[prismaModel.table_name] = pgCol;  // Key by TABLE NAME so consumers using Postgres table names can look it up
        break;  // One lookup column per model
      }
    }
  }
```

In the return object (line 235), add:

```typescript
    url_lookup_columns: Object.keys(urlLookupColumns).length > 0 ? urlLookupColumns : undefined,
```

**Step 3: Typecheck + run tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/lib/index-app.ts
git commit -m "feat(types): add url_lookup_columns to AppIndex from @unique detection"
```

---

## Task 3: Use lookup columns in route resolver

**Files:**
- Modify: `pipeline/src/lib/route-resolver.ts:39-93` (resolveParam)
- Modify: `pipeline/src/lib/route-resolver.ts:96-140` (resolveId)
- Modify: `pipeline/src/lib/route-resolver.ts:183-214` (resolveExampleUrls)
- Modify: `pipeline/src/cli.ts` (call site ~line 239)
- Test: `pipeline/test/route-resolver.test.ts`

**Step 1: Write the failing tests**

Add to `pipeline/test/route-resolver.test.ts`, after the existing `resolveParam` describe block:

```typescript
describe("resolveParam with urlLookupColumns", () => {
  beforeEach(() => { mockExec.mockReset(); });

  it("resolves :id using lookup column when available", () => {
    mockExec.mockReturnValueOnce("711926e7-2cba-4b2d\n");
    const dataModel = {
      Envelope: { table_name: "Envelope", columns: { id: "id", secondaryId: "secondaryId" }, enums: {}, source: "prisma-parser", manual_id_columns: [] },
    };
    const result = resolveParam("id", "/t/:teamUrl/documents/:id/edit", "psql connstr", {
      userId: "9", teamId: "7", teamUrl: "personal_abc",
    }, dataModel, { Envelope: "secondaryId" });
    expect(result).toBe("711926e7-2cba-4b2d");
    // Verify the SQL queried secondaryId, not id
    const sqlArg = (mockExec.mock.calls[0][0] as string);
    expect(sqlArg).toContain('"secondaryId"');
    expect(sqlArg).not.toContain('SELECT id FROM');
  });

  it("falls back to PK when no lookup column", () => {
    mockExec.mockReturnValueOnce("123\n");
    const dataModel = {
      Webhook: { table_name: "Webhook", columns: { id: "id" }, enums: {}, source: "prisma-parser", manual_id_columns: [] },
    };
    const result = resolveParam("id", "/t/:teamUrl/webhooks/:id", "psql connstr", {
      userId: "9", teamId: "7", teamUrl: "personal_abc",
    }, dataModel, {});
    expect(result).toBe("123");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/route-resolver.test.ts`
Expected: FAIL — `resolveParam` doesn't accept `urlLookupColumns` parameter

**Step 3: Add `urlLookupColumns` parameter to resolveParam**

In `pipeline/src/lib/route-resolver.ts`, update `resolveParam` signature (line 39-45):

```typescript
export function resolveParam(
  paramName: string,
  route: string,
  psqlCmd: string,
  ctx: RouteResolverContext,
  dataModel: AppIndex["data_model"],
  urlLookupColumns?: Record<string, string>,
): string | null {
```

Thread it to `resolveId` at line 59:

```typescript
  if (paramName === "id") return resolveId(route, psqlCmd, ctx, dataModel, urlLookupColumns);
```

**Step 4: Update resolveId to use lookup column**

In `resolveId` (line 96), update signature:

```typescript
function resolveId(route: string, psqlCmd: string, ctx: RouteResolverContext, dataModel: AppIndex["data_model"], urlLookupColumns?: Record<string, string>): string | null {
```

Add a helper at the top of the function to look up the column:

```typescript
  // urlLookupColumns is keyed by Postgres table name (same as segmentToTable values)
  function lookupCol(table: string): string {
    return urlLookupColumns?.[table] ? `"${urlLookupColumns[table]}"` : '"id"';
  }
```

Replace all `SELECT id FROM` with `SELECT ${lookupCol(table)} FROM` in:
- Line 116: `const val = psqlQuery(psqlCmd, \`SELECT ${lookupCol(table)} FROM "${table}" WHERE ${scope} LIMIT 1\`);`
- Line 123: same pattern
- Line 130: same pattern (Envelope)
- Line 134: same pattern (Envelope)
- Line 139: same pattern (Envelope)

**Step 5: Update resolveExampleUrls to pass urlLookupColumns**

In `resolveExampleUrls` (line 183), add parameter:

```typescript
export function resolveExampleUrls(
  routes: AppIndex["routes"],
  dataModel: AppIndex["data_model"],
  psqlCmd: string,
  ctx: RouteResolverContext,
  urlLookupColumns?: Record<string, string>,
): Record<string, string> {
```

Thread it to `resolveParam` at line 199:

```typescript
      const value = resolveParam(param, route, psqlCmd, ctx, dataModel, urlLookupColumns);
```

**Step 6: Update cli.ts call site**

In `pipeline/src/cli.ts`, find the `resolveExampleUrls` call (~line 239) and pass the new field:

```typescript
    const exampleUrls = resolveExampleUrls(appIndex.routes, appIndex.data_model, psqlCmd, resolverCtx, appIndex.url_lookup_columns);
```

**Step 7: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/route-resolver.test.ts`
Expected: PASS

**Step 8: Typecheck + full suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 9: Commit**

```bash
git add pipeline/src/lib/route-resolver.ts pipeline/test/route-resolver.test.ts pipeline/src/cli.ts
git commit -m "fix(route-resolver): use @unique lookup columns for URL params instead of PK"
```

---

## Task 4: Setup-writer RETURNING lookup columns

**Files:**
- Modify: `pipeline/src/stages/graph-setup.ts:90-174` (generateSqlFromPlan)
- Modify: `pipeline/src/stages/graph-setup.ts:187-265` (graphInformedSetup)
- Test: `pipeline/test/graph-setup.test.ts`

**Step 1: Write the failing test**

Add to `pipeline/test/graph-setup.test.ts`, inside the `generateSqlFromPlan` describe block:

```typescript
  it("generates RETURNING for both id and lookup column when available", () => {
    const plan = {
      root_table: "Envelope",
      inserts: [
        { table: "Envelope", values: { id: "gen_random_uuid()", teamId: "7" } },
      ],
    };
    const result = generateSqlFromPlan(plan, makeGraph(), [], { Envelope: "secondaryId" });
    expect(result.sql).toContain('RETURNING "id", "secondaryId"');
    expect(result.sql).toContain("v_envelope_lookup");
  });

  it("generates RETURNING id only when no lookup column", () => {
    const plan = {
      root_table: "Envelope",
      inserts: [
        { table: "DocumentMeta", values: { id: "gen_random_uuid()", language: "en" } },
      ],
    };
    const result = generateSqlFromPlan(plan, makeGraph(), []);
    expect(result.sql).toContain('RETURNING "id" INTO');
    expect(result.sql).not.toContain("v_documentmeta_lookup");
  });
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/graph-setup.test.ts`
Expected: FAIL — `generateSqlFromPlan` doesn't accept `urlLookupColumns`

**Step 3: Add `urlLookupColumns` parameter to generateSqlFromPlan**

In `pipeline/src/stages/graph-setup.ts`, update the signature (line 90):

```typescript
export function generateSqlFromPlan(
  plan: InsertPlan,
  graph: EntityGraph,
  seedIds: string[],
  urlLookupColumns?: Record<string, string>,
): { sql: string; affectedTables: string[] } {
```

In the INSERT generation loop (~line 164-168), replace the RETURNING logic:

```typescript
    // Add RETURNING INTO for potential FK linking
    if (!declaredVars.has(varName)) {
      declares.push(`${varName} text`);
      declaredVars.add(varName);
    }

    // Check if this table has a URL lookup column (keyed by table name)
    // The lookup var is captured for future use when planner starts using setup-created IDs in URLs
    const lookupCol = urlLookupColumns?.[ins.table];
    if (lookupCol && lookupCol !== "id") {
      const lookupVar = `v_${ins.table.toLowerCase()}_lookup`;
      if (!declaredVars.has(lookupVar)) {
        declares.push(`${lookupVar} text`);
        declaredVars.add(lookupVar);
      }
      statements.push(`${insertSql} RETURNING "id", "${lookupCol}" INTO ${varName}, ${lookupVar};`);
    } else {
      statements.push(`${insertSql} RETURNING "id" INTO ${varName};`);
    }
```

**Step 4: Pass lookup columns from graphInformedSetup**

In `graphInformedSetup`, update the `generateSqlFromPlan` call (~line 259):

```typescript
    const { sql, affectedTables } = generateSqlFromPlan(plan, graph, allSeedIds, appIndex.url_lookup_columns);
```

**Step 5: Run tests to verify they pass**

Run: `cd pipeline && npx vitest run test/graph-setup.test.ts`
Expected: PASS

**Step 6: Typecheck + full suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 7: Commit**

```bash
git add pipeline/src/stages/graph-setup.ts pipeline/test/graph-setup.test.ts
git commit -m "feat(graph-setup): RETURNING lookup columns for future URL resolution"
```

---

## Verification

After all 4 tasks:

1. `cd pipeline && npx tsc --noEmit && npx vitest run` — all tests pass
2. Re-index Documenso:
```bash
cd pipeline && npx tsx src/cli.ts index-app \
  --project-dir /Users/abhishekray/Projects/opslane/evals/documenso
```
3. Check `url_lookup_columns` in app.json — should show:
```json
{ "Envelope": "secondaryId", "Team": "url", "Organisation": "url" }
```
4. Check `example_urls` — document routes should have UUID values (like `711926e7-2cba-...`), not seed PK strings
5. Run a verify against Documenso — the 15 "wrong ID in URL" failures should be resolved
