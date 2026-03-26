# Graph-Informed Setup Writer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the monolithic LLM setup-writer (5K token prompt, ~50% reliability on hard conditions) with a 3-phase approach: deterministic FK graph discovery → tiny focused LLM (~1K tokens, no tools) → deterministic SQL generation.

**Architecture:** At `index-app` time, walk FK relationships from `information_schema` and store entity graphs + NOT NULL columns in `app.json`. At runtime, load the graph, use a micro-LLM-prompt to pick the root table, check if the condition is already satisfied, build a ~1000-token prompt that asks the LLM to fill in values only, generate SQL deterministically with PL/pgSQL variable linking, validate against seed IDs, and execute. Same `SetupCommands` interface — orchestrator changes minimally.

**Tech Stack:** TypeScript, psql via shared helper, `runClaude()` (no tools), vitest

**Spike evidence:** `spike-graph-informed-llm.ts` — 3/3 conditions pass (100% execution rate), ~20s per condition, ~1000 tokens per prompt. Current monolithic approach: ~60s, ~5000 tokens.

---

## Task 1: Add types + shared psql helper

**Files:**
- Modify: `pipeline/src/lib/types.ts:72-77` (SetupCommands) and `pipeline/src/lib/types.ts:119-143` (AppIndex)
- Create: `pipeline/src/lib/psql.ts`
- Modify: `pipeline/src/lib/index-app.ts` (mergeIndexResults)
- Modify: `pipeline/test/plan-validator.test.ts` (fixture)

**Step 1: Add `affected_tables` to SetupCommands**

In `pipeline/src/lib/types.ts`, find the `SetupCommands` interface (line 72):

```typescript
export interface SetupCommands {
  group_id: string;
  condition: string;
  setup_commands: string[];
  teardown_commands: string[];
}
```

Add `affected_tables`:

```typescript
export interface SetupCommands {
  group_id: string;
  condition: string;
  setup_commands: string[];
  teardown_commands: string[];
  /** Tables modified by setup — used for snapshotting when commands are opaque (e.g. PL/pgSQL DO blocks) */
  affected_tables?: string[];
}
```

**Step 2: Add `entity_graphs` to AppIndex**

In `pipeline/src/lib/types.ts`, add before the closing `}` of `AppIndex` (line 142):

```typescript
  /** FK dependency graphs for entity creation — computed by index-app from information_schema. Optional: missing in old app.json files. */
  entity_graphs?: Record<string, {
    /** Tables in topological order (parents first) */
    insert_order: string[];
    /** Per-table metadata for SQL generation */
    tables: Record<string, {
      columns: Array<{
        name: string;
        pg_type: string;         // udt_name from information_schema
        nullable: boolean;
        has_default: boolean;
      }>;
      fk_parents: Array<{
        column: string;          // FK column in this table
        parent_table: string;    // referenced table
        parent_column: string;   // referenced column
        required: boolean;       // NOT NULL and no default
      }>;
    }>;
  }>;
```

Note: no `enum_values` in columns — enums come from `AppIndex.data_model[model].enums` at runtime (review decision 3A).

**Step 3: Create shared psql helper**

Create `pipeline/src/lib/psql.ts`:

```typescript
// pipeline/src/lib/psql.ts — shared psql shell-out helper
import { execSync } from "node:child_process";

/**
 * Run a psql query and return tab-delimited rows.
 * Uses -t (tuples only), -A (unaligned), -F'\t' (tab separator).
 * Returns empty string on error (caller decides how to handle).
 */
export function psqlQuery(psqlCmd: string, sql: string): string {
  try {
    return (execSync(
      `${psqlCmd} -t -A -F'\t' -c ${JSON.stringify(sql)}`,
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ) as string).trim();
  } catch {
    return "";
  }
}

```

**Step 4: Fix compilation**

Add `entity_graphs: {}` to:
- `pipeline/src/lib/index-app.ts` in `mergeIndexResults` return value (around line 245)
- `pipeline/test/plan-validator.test.ts` in any AppIndex fixtures

**Step 5: Typecheck + run tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/lib/psql.ts pipeline/src/lib/index-app.ts pipeline/test/plan-validator.test.ts
git commit -m "feat(types): add entity_graphs to AppIndex, affected_tables to SetupCommands, shared psql helper"
```

---

## Task 2: Build FK graph walker for index-app

**Files:**
- Create: `pipeline/src/lib/entity-graph.ts`
- Create: `pipeline/test/entity-graph.test.ts`

**Step 1: Write the failing tests**

Create `pipeline/test/entity-graph.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildEntityGraphs, topoSort } from "../src/lib/entity-graph.js";

// Mock the shared psql helper
vi.mock("../src/lib/psql.js", () => ({
  psqlQuery: vi.fn().mockReturnValue(""),
}));

import { psqlQuery } from "../src/lib/psql.js";
const mockPsqlQuery = vi.mocked(psqlQuery);

describe("topoSort", () => {
  it("sorts parents before children", () => {
    const deps = new Map([
      ["Envelope", ["DocumentMeta", "User"]],
      ["DocumentMeta", []],
      ["User", []],
      ["Recipient", ["Envelope"]],
    ]);
    const sorted = topoSort(deps);
    expect(sorted.indexOf("DocumentMeta")).toBeLessThan(sorted.indexOf("Envelope"));
    expect(sorted.indexOf("User")).toBeLessThan(sorted.indexOf("Envelope"));
    expect(sorted.indexOf("Envelope")).toBeLessThan(sorted.indexOf("Recipient"));
  });

  it("handles tables with no dependencies", () => {
    const deps = new Map([["TableA", []], ["TableB", []]]);
    const sorted = topoSort(deps);
    expect(sorted).toHaveLength(2);
    expect(sorted).toContain("TableA");
    expect(sorted).toContain("TableB");
  });

  it("handles self-referential FK", () => {
    const deps = new Map([
      ["Category", ["Category"]],  // self-referencing
      ["Product", ["Category"]],
    ]);
    const sorted = topoSort(deps);
    expect(sorted).toContain("Category");
    expect(sorted).toContain("Product");
    expect(sorted.indexOf("Category")).toBeLessThan(sorted.indexOf("Product"));
  });

  it("handles A→B→A cycle by appending remaining", () => {
    const deps = new Map([
      ["A", ["B"]],
      ["B", ["A"]],
    ]);
    const sorted = topoSort(deps);
    expect(sorted).toHaveLength(2);
    expect(sorted).toContain("A");
    expect(sorted).toContain("B");
  });
});

describe("buildEntityGraphs", () => {
  beforeEach(() => {
    mockPsqlQuery.mockReset();
    mockPsqlQueryWithTable.mockReset();
  });

  it("returns empty object when psqlCmd is empty", () => {
    const result = buildEntityGraphs("", {});
    expect(result).toEqual({});
  });

  it("builds graph from batched query results", () => {
    // Mock batched FK query: Envelope has FK to DocumentMeta
    mockPsqlQuery.mockImplementation((_cmd, sql) => {
      if (sql.includes("table_constraints") && sql.includes("FOREIGN KEY")) {
        // FK edges batch: child_table, fk_column, parent_table, parent_column, required
        return "Envelope\tdocumentMetaId\tDocumentMeta\tid\trequired";
      }
      if (sql.includes("information_schema.columns")) {
        // Columns batch: table_name, column_name, udt_name, is_nullable, column_default
        return [
          "Envelope\tid\ttext\tNO\t",
          "Envelope\tdocumentMetaId\ttext\tNO\t",
          "DocumentMeta\tid\ttext\tNO\t",
        ].join("\n");
      }
      return "";
    });

    const dataModel = {
      Envelope: { table_name: "Envelope", columns: { id: "id" }, enums: {}, source: "prisma-parser", manual_id_columns: [] },
      DocumentMeta: { table_name: "DocumentMeta", columns: { id: "id" }, enums: {}, source: "prisma-parser", manual_id_columns: [] },
    };
    const result = buildEntityGraphs("psql connstr", dataModel);
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/entity-graph.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `pipeline/src/lib/entity-graph.ts`:

```typescript
// pipeline/src/lib/entity-graph.ts — FK graph walker for entity creation
import { psqlQuery } from "./psql.js";
import type { AppIndex } from "./types.js";

type EntityGraphs = AppIndex["entity_graphs"];

interface FkEdge {
  child_table: string;
  column: string;
  parent_table: string;
  parent_column: string;
  required: boolean;
}

interface ColumnMeta {
  table_name: string;
  name: string;
  pg_type: string;
  nullable: boolean;
  has_default: boolean;
}

/**
 * Batch-query all FK edges for tables in the data model.
 * One query total instead of per-table (review decision 8A).
 */
function batchFkEdges(psqlCmd: string, tableNames: string[]): FkEdge[] {
  if (tableNames.length === 0) return [];
  const inList = tableNames.map(t => `'${t.replace(/'/g, "''")}'`).join(",");
  const sql = `
    SELECT tc.table_name, kcu.column_name, ccu.table_name, ccu.column_name,
      CASE WHEN c.is_nullable = 'NO' AND c.column_default IS NULL THEN 'required' ELSE 'optional' END
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    JOIN information_schema.columns c
      ON c.table_name = tc.table_name AND c.column_name = kcu.column_name AND c.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name IN (${inList})
  `;
  const raw = psqlQuery(psqlCmd, sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const [childTable, col, parentTable, parentCol, req] = line.split("\t");
    return { child_table: childTable, column: col, parent_table: parentTable, parent_column: parentCol, required: req === "required" };
  });
}

/**
 * Batch-query all columns for tables in the data model.
 * One query total instead of per-table (review decision 8A).
 */
function batchColumns(psqlCmd: string, tableNames: string[]): ColumnMeta[] {
  if (tableNames.length === 0) return [];
  const inList = tableNames.map(t => `'${t.replace(/'/g, "''")}'`).join(",");
  const sql = `
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name IN (${inList}) ORDER BY table_name, ordinal_position
  `;
  const raw = psqlQuery(psqlCmd, sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const [tableName, name, pgType, nullable, colDefault] = line.split("\t");
    return { table_name: tableName, name, pg_type: pgType, nullable: nullable === "YES", has_default: !!colDefault && colDefault !== "" };
  });
}

/**
 * Topological sort: given a map of table → required parent tables,
 * return tables in insert order (parents first).
 */
export function topoSort(deps: Map<string, string[]>): string[] {
  const inDegree = new Map<string, number>();
  for (const [t] of deps) inDegree.set(t, 0);
  for (const [child, parents] of deps) {
    for (const p of parents) {
      // Skip self-references and parents not in our set
      if (deps.has(p) && p !== child) {
        inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const [t, deg] of inDegree) if (deg === 0) queue.push(t);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    sorted.push(t);
    for (const [name, parents] of deps) {
      if (parents.includes(t) && t !== name) {
        inDegree.set(name, (inDegree.get(name) ?? 0) - 1);
        if (inDegree.get(name) === 0) queue.push(name);
      }
    }
  }
  // Append any remaining (cycles) — SQL will likely fail on FK constraint, triggering retry
  for (const [t] of deps) {
    if (!sorted.includes(t)) {
      console.warn(`  Warning: FK cycle detected, appending: ${t}`);
      sorted.push(t);
    }
  }
  return sorted;
}

/**
 * Build entity graphs for all tables in the data model.
 * Uses batched queries (2 total) instead of per-table (review decision 8A).
 * Does NOT query pg_enum — enums come from AppIndex.data_model at runtime (review decision 3A).
 */
export function buildEntityGraphs(
  psqlCmd: string,
  dataModel: AppIndex["data_model"],
): EntityGraphs {
  if (!psqlCmd) return {};

  // Collect all table names
  const allTableNames = [...new Set(Object.values(dataModel).map(m => m.table_name))];

  // Batch queries — 2 total instead of N per table
  const allFks = batchFkEdges(psqlCmd, allTableNames);
  const allCols = batchColumns(psqlCmd, allTableNames);

  // Index by table
  const fksByTable = new Map<string, FkEdge[]>();
  for (const fk of allFks) {
    if (!fksByTable.has(fk.child_table)) fksByTable.set(fk.child_table, []);
    fksByTable.get(fk.child_table)!.push(fk);
  }
  const colsByTable = new Map<string, ColumnMeta[]>();
  for (const col of allCols) {
    if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
    colsByTable.get(col.table_name)!.push(col);
  }

  const graphs: EntityGraphs = {};

  // Discover additional parent tables not in the data model
  // (tables referenced by FKs but not in Prisma schema)
  const additionalTables = new Set<string>();
  for (const fk of allFks) {
    if (!allTableNames.includes(fk.parent_table)) {
      additionalTables.add(fk.parent_table);
    }
  }
  if (additionalTables.size > 0) {
    const extraFks = batchFkEdges(psqlCmd, [...additionalTables]);
    const extraCols = batchColumns(psqlCmd, [...additionalTables]);
    for (const fk of extraFks) {
      if (!fksByTable.has(fk.child_table)) fksByTable.set(fk.child_table, []);
      fksByTable.get(fk.child_table)!.push(fk);
    }
    for (const col of extraCols) {
      if (!colsByTable.has(col.table_name)) colsByTable.set(col.table_name, []);
      colsByTable.get(col.table_name)!.push(col);
    }
  }

  // Build a graph for each table in the data model
  for (const [_modelName, modelInfo] of Object.entries(dataModel)) {
    const rootTable = modelInfo.table_name;
    if (graphs[rootTable]) continue;

    // Walk required FK parents recursively
    const visited = new Set<string>();
    const queue = [rootTable];
    const tableMeta: EntityGraphs[string]["tables"] = {};
    const parentDeps = new Map<string, string[]>();

    while (queue.length > 0) {
      const table = queue.shift()!;
      if (visited.has(table)) continue;
      visited.add(table);

      const fks = fksByTable.get(table) ?? [];
      const cols = colsByTable.get(table) ?? [];
      const requiredParents = fks.filter(fk => fk.required);

      parentDeps.set(table, requiredParents.map(fk => fk.parent_table).filter(p => p !== table));

      const requiredCols = cols.filter(c => !c.nullable && !c.has_default);

      tableMeta[table] = {
        columns: requiredCols.map(c => ({
          name: c.name, pg_type: c.pg_type, nullable: c.nullable, has_default: c.has_default,
        })),
        fk_parents: fks.map(fk => ({
          column: fk.column, parent_table: fk.parent_table,
          parent_column: fk.parent_column, required: fk.required,
        })),
      };

      for (const fk of requiredParents) {
        if (fk.parent_table !== table && !visited.has(fk.parent_table)) {
          queue.push(fk.parent_table);
        }
      }
    }

    // Also walk children (tables that reference this root) — one additional batch query
    const childSql = `
      SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = '${rootTable.replace(/'/g, "''")}'
    `;
    const childRows = psqlQuery(psqlCmd, childSql);
    for (const childTable of childRows.split("\n").filter(Boolean)) {
      if (visited.has(childTable)) continue;
      visited.add(childTable);
      const fks = fksByTable.get(childTable) ?? [];
      const cols = colsByTable.get(childTable) ?? [];
      const requiredCols = cols.filter(c => !c.nullable && !c.has_default);
      parentDeps.set(childTable, fks.filter(fk => fk.required).map(fk => fk.parent_table).filter(p => p !== childTable));
      tableMeta[childTable] = {
        columns: requiredCols.map(c => ({
          name: c.name, pg_type: c.pg_type, nullable: c.nullable, has_default: c.has_default,
        })),
        fk_parents: fks.map(fk => ({
          column: fk.column, parent_table: fk.parent_table,
          parent_column: fk.parent_column, required: fk.required,
        })),
      };
    }

    const insertOrder = topoSort(parentDeps);
    graphs[rootTable] = { insert_order: insertOrder, tables: tableMeta };
  }

  return graphs;
}
```

**Step 4: Run tests**

Run: `cd pipeline && npx vitest run test/entity-graph.test.ts`
Expected: PASS

**Step 5: Typecheck + full suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/lib/entity-graph.ts pipeline/test/entity-graph.test.ts
git commit -m "feat(entity-graph): FK graph walker with batched queries and topo sort"
```

---

## Task 3: Wire graph walker into index-app

**Files:**
- Modify: `pipeline/src/cli.ts` (add graph walker step before writing app.json)

**Step 1: Add the graph walker call**

In `pipeline/src/cli.ts`, hoist `psqlCmd` to a `let` declaration before the resolver block so it's accessible later. Then, before the `writeFileSync(outputPath, ...)` line (~247), add:

```typescript
  // Ensure psqlCmd is available for entity graph discovery
  if (!psqlCmd) {
    const dbUrlEnv = appIndex.db_url_env ?? "DATABASE_URL";
    const dbUrl = (projectEnvForDump[dbUrlEnv] ?? projectEnvForDump.DATABASE_URL ?? "") as string;
    const cleanDbUrl = dbUrl.split("?")[0];
    psqlCmd = cleanDbUrl ? `psql "${cleanDbUrl}"` : "";
  }

  // Step 4: Entity graph discovery — walk FK relationships for setup-writer
  if (psqlCmd) {
    console.log("  Discovering entity graphs...");
    const { buildEntityGraphs } = await import("./lib/entity-graph.js");
    const entityGraphs = buildEntityGraphs(psqlCmd, appIndex.data_model);
    appIndex.entity_graphs = entityGraphs;
    const rootTables = Object.keys(entityGraphs);
    console.log(`  Entity graphs: ${rootTables.length} root tables`);
  }
```

**Step 2: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 3: Integration test — run index-app against Documenso**

```bash
cd pipeline && npx tsx src/cli.ts index-app \
  --project-dir /Users/abhishekray/Projects/opslane/evals/documenso \
  --output /tmp/test-entity-graphs.json
```

Then verify:

```bash
python3 -c "
import json
d = json.load(open('/tmp/test-entity-graphs.json'))
eg = d.get('entity_graphs', {})
print(f'Entity graphs: {len(eg)} root tables')
for table, graph in list(eg.items())[:3]:
    print(f'  {table}: {len(graph[\"insert_order\"])} tables in order, {len(graph[\"tables\"])} table metas')
    print(f'    Insert order: {\" → \".join(graph[\"insert_order\"][:5])}...')
"
```

Expected: 40+ root tables with entity graphs.

**Step 4: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(index-app): wire entity graph discovery into app indexing"
```

---

## Task 4: Build the graph-informed setup-writer

**Files:**
- Create: `pipeline/src/stages/graph-setup.ts`
- Create: `pipeline/test/graph-setup.test.ts`

This is the core task. The module has 3 exported functions:
1. `buildGraphPrompt(condition, entityGraphs, existingTables, authCtx, learnings)` — builds ~1.2K token prompt that includes root table selection + value generation in one call
2. `generateSqlFromPlan(plan, graph, psqlCmd, seedIds)` — turns LLM JSON into PL/pgSQL with seed validation (review decision 1A). Returns `{ sql: string; affectedTables: string[] }`
3. `graphInformedSetup(groupId, condition, appIndex, projectEnv, authEmail, retryContext, runDir, stageName, runClaudeFn)` — main async function returning `SetupCommands | null`. Takes `runClaude` as a parameter for testability (review fix #3).

Root table selection is inlined into the main prompt (review fix #5) — the LLM outputs `{ "root_table": "TableName", "inserts": [...] }`. One LLM call instead of two.

**Step 1: Write the failing tests**

Create `pipeline/test/graph-setup.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { buildGraphPrompt, generateSqlFromPlan, graphInformedSetup } from "../src/stages/graph-setup.js";
import type { AppIndex, RunClaudeResult } from "../src/lib/types.js";

// Shared test graph fixture
function makeGraph(): NonNullable<AppIndex["entity_graphs"]>[string] {
  return {
    insert_order: ["DocumentMeta", "Envelope"],
    tables: {
      DocumentMeta: {
        columns: [{ name: "id", pg_type: "text", nullable: false, has_default: false }],
        fk_parents: [],
      },
      Envelope: {
        columns: [
          { name: "id", pg_type: "text", nullable: false, has_default: false },
          { name: "teamId", pg_type: "int4", nullable: false, has_default: false },
          { name: "documentMetaId", pg_type: "text", nullable: false, has_default: false },
        ],
        fk_parents: [{ column: "documentMetaId", parent_table: "DocumentMeta", parent_column: "id", required: true }],
      },
    },
  };
}

function makeEntityGraphs(): NonNullable<AppIndex["entity_graphs"]> {
  return { Envelope: makeGraph(), Template: makeGraph() };
}

function mockRunClaudeResult(stdout: string): RunClaudeResult {
  return { stdout, stderr: "", exitCode: 0, durationMs: 1000, timedOut: false };
}

describe("buildGraphPrompt", () => {
  it("includes all entity graph table names, condition, and ALREADY EXIST section", () => {
    const prompt = buildGraphPrompt(
      "A draft document exists",
      makeEntityGraphs(),
      ["User", "Team"],
      { userId: "9", teamId: "7", email: "test@test.com" },
    );
    expect(prompt).toContain("AVAILABLE TABLES");
    expect(prompt).toContain("Envelope");
    expect(prompt).toContain("Template");
    expect(prompt).toContain("draft document");
    expect(prompt).toContain("ALREADY EXIST");
    expect(prompt).toContain("root_table");
    expect(prompt.length).toBeLessThan(5000);
  });

  it("includes CHECK FIRST instruction", () => {
    const prompt = buildGraphPrompt("A draft document exists", makeEntityGraphs(), ["User"], {});
    expect(prompt).toMatch(/check|already satisfied|SELECT/i);
  });
});

describe("generateSqlFromPlan", () => {
  it("generates PL/pgSQL with RETURNING INTO for FK linking", () => {
    const plan = {
      root_table: "Envelope",
      inserts: [
        { table: "DocumentMeta", values: { id: "gen_random_uuid()", language: "en" } },
        { table: "Envelope", values: { id: "gen_random_uuid()", teamId: "7", documentMetaId: "ref:DocumentMeta" } },
      ],
    };
    const result = generateSqlFromPlan(plan, makeGraph(), "psql connstr", []);
    expect(result.sql).toContain("BEGIN");
    expect(result.sql).toContain("RETURNING");
    expect(result.sql).toContain("v_documentmeta_id");
    expect(result.affectedTables).toContain("DocumentMeta");
    expect(result.affectedTables).toContain("Envelope");
  });

  it("blocks SQL referencing seed IDs", () => {
    const plan = {
      root_table: "Envelope",
      inserts: [
        { table: "DocumentMeta", values: { id: "clseed123abc" } },
      ],
    };
    expect(() => generateSqlFromPlan(plan, makeGraph(), "psql connstr", ["clseed123abc"]))
      .toThrow(/seed/i);
  });

  it("handles special characters in values", () => {
    const plan = {
      root_table: "Envelope",
      inserts: [
        { table: "DocumentMeta", values: { id: "gen_random_uuid()", subject: "It's a test \"doc\"" } },
      ],
    };
    const result = generateSqlFromPlan(plan, makeGraph(), "psql connstr", []);
    expect(result.sql).toBeDefined();
    expect(result.affectedTables).toContain("DocumentMeta");
  });
});

describe("graphInformedSetup", () => {
  it("returns SetupCommands on valid LLM response", async () => {
    const llmOutput = JSON.stringify({
      root_table: "Envelope",
      inserts: [{ table: "DocumentMeta", values: { id: "gen_random_uuid()" } }],
    });
    const mockRunClaude = vi.fn().mockResolvedValue(mockRunClaudeResult(llmOutput));
    const appIndex = {
      entity_graphs: makeEntityGraphs(),
      data_model: { Envelope: { table_name: "Envelope", columns: {}, enums: {}, source: "prisma-parser", manual_id_columns: [] } },
      seed_ids: {},
    } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "A draft document exists", appIndex, {}, "test@test.com",
      null, "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).not.toBeNull();
    expect(result!.setup_commands.length).toBeGreaterThan(0);
    expect(result!.affected_tables).toContain("DocumentMeta");
  });

  it("returns null when entity_graphs is missing", async () => {
    const mockRunClaude = vi.fn();
    const appIndex = { entity_graphs: undefined, data_model: {}, seed_ids: {} } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "condition", appIndex, {}, undefined,
      null, "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).toBeNull();
    expect(mockRunClaude).not.toHaveBeenCalled();
  });

  it("returns null when LLM returns unparseable output", async () => {
    const mockRunClaude = vi.fn().mockResolvedValue(mockRunClaudeResult("not json at all"));
    const appIndex = {
      entity_graphs: makeEntityGraphs(),
      data_model: {},
      seed_ids: {},
    } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "condition", appIndex, {}, undefined,
      null, "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).toBeNull();
  });

  it("returns empty setup_commands when LLM says condition is already satisfied", async () => {
    const llmOutput = JSON.stringify({ root_table: "Envelope", inserts: [] });
    const mockRunClaude = vi.fn().mockResolvedValue(mockRunClaudeResult(llmOutput));
    const appIndex = {
      entity_graphs: makeEntityGraphs(),
      data_model: {},
      seed_ids: {},
    } as unknown as AppIndex;

    const result = await graphInformedSetup(
      "group-1", "condition", appIndex, {}, undefined,
      null, "/tmp/run", "setup-group-1", mockRunClaude,
    );
    expect(result).not.toBeNull();
    expect(result!.setup_commands).toHaveLength(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/graph-setup.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `pipeline/src/stages/graph-setup.ts`. Key design points:

- **`buildGraphPrompt`**: Assembles AVAILABLE TABLES (all entity graph root table keys) + per-table ENTITY GRAPH details + ALREADY EXIST + CONDITION + LEARNINGS + Rules sections. The LLM picks the root table AND fills values in a single call. Output format: `{ "root_table": "TableName", "inserts": [{ "table": "...", "values": {...} }] }`. Includes CHECK FIRST instruction: "If the condition is already satisfied by existing seed data, output `{ root_table: \"...\", inserts: [] }`." (review decision C1). Only includes NOT NULL columns without defaults. Looks up enum values from `AppIndex.data_model[model].enums` at call site. Prompt stays under ~1.2K tokens since only the chosen root table's graph details are needed — list all table names but only expand the graph details inline.

- **`generateSqlFromPlan`**: Takes `{ root_table, inserts: [{ table, values }] }` from the LLM. Before wrapping in DO block:
  1. Validate `root_table` is a known entity graph key — if not, throw
  2. Collect all table names from inserts → `affectedTables` (for snapshotting, review decision C3)
  3. Validate: scan each INSERT's values against seedIds — if any value contains a seed ID string, throw (review decision 1A)
  4. Generate PL/pgSQL `DO $$ DECLARE ... BEGIN ... END $$` with `RETURNING "id" INTO v_tablename_id` for FK linking
  5. Return `{ sql: string; affectedTables: string[] }`

- **`graphInformedSetup`**: Async orchestration function. Takes `runClaudeFn` as last parameter for testability (review fix #3):
  1. Check if `appIndex.entity_graphs` exists and has entries — if not, return `null` (caller falls back to old path, review decision C4)
  2. Build prompt with `buildGraphPrompt` — includes all root table names for the LLM to pick from
  3. Call `runClaudeFn({ prompt, model: "sonnet", timeoutMs: 90_000, allowedTools: [], ... })` — one LLM call, no tools
  4. Parse JSON output. Validate `root_table` is in entity_graphs keys.
  5. If empty inserts, return `SetupCommands` with empty `setup_commands` (condition already satisfied)
  6. Load the specific entity graph for `root_table`, call `generateSqlFromPlan` with seedIds
  7. Return `SetupCommands` with the PL/pgSQL command and `affected_tables`

Learnings: load `learnings.md` from the verify dir and inject into the prompt (same as current setup-writer).

**Step 4: Run tests**

Run: `cd pipeline && npx vitest run test/graph-setup.test.ts`
Expected: PASS

**Step 5: Typecheck + full suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/stages/graph-setup.ts pipeline/test/graph-setup.test.ts
git commit -m "feat(graph-setup): graph-informed setup-writer with LLM root picker and seed validation"
```

---

## Task 5: Create shared `runSetupWriter` + wire into orchestrator

**Files:**
- Create: `pipeline/src/stages/run-setup-writer.ts` — shared function used by both orchestrator and CLI (review fix #7)
- Modify: `pipeline/src/orchestrator.ts`

The graph-informed path and the monolithic fallback share the same try-graph-then-fallback logic. Instead of duplicating it in the orchestrator and CLI, extract a shared function.

**Step 1: Create shared `runSetupWriter`**

Create `pipeline/src/stages/run-setup-writer.ts`:

```typescript
// pipeline/src/stages/run-setup-writer.ts — shared setup-writer runner (graph-informed + fallback)
import { graphInformedSetup } from "./graph-setup.js";
import { buildSetupWriterPrompt, parseSetupWriterOutput } from "./setup-writer.js";
import type { SetupCommands, AppIndex, RunClaudeOptions, RunClaudeResult, SetupRetryContext } from "../lib/types.js";
import { loadAppIndex } from "../lib/app-index.js";

type RunClaudeFn = (opts: RunClaudeOptions) => Promise<RunClaudeResult>;

/**
 * Run setup-writer: try graph-informed first, fall back to monolithic.
 * Used by both orchestrator and CLI run-stage (review fix #7: deduplication).
 */
export async function runSetupWriter(opts: {
  groupId: string;
  condition: string;
  appIndex: AppIndex;
  projectEnv: Record<string, string>;
  projectRoot: string;
  authEmail?: string;
  retryContext: SetupRetryContext | null;
  runDir: string;
  stageName: string;
  runClaudeFn: RunClaudeFn;
  permissions: Pick<RunClaudeOptions, "dangerouslySkipPermissions" | "allowedTools">;
  timeoutMs: number;
}): Promise<SetupCommands | null> {
  // Try graph-informed first (review decision C4: returns null if entity_graphs missing)
  let commands = await graphInformedSetup(
    opts.groupId, opts.condition, opts.appIndex, opts.projectEnv, opts.authEmail,
    opts.retryContext, opts.runDir, opts.stageName, opts.runClaudeFn,
  );

  // Fallback to old monolithic setup-writer
  if (!commands) {
    const prompt = opts.retryContext
      ? (await import("./setup-writer.js")).buildSetupWriterRetryPrompt(opts.groupId, opts.condition, opts.projectRoot, opts.retryContext, opts.authEmail)
      : buildSetupWriterPrompt(opts.groupId, opts.condition, opts.projectRoot, opts.authEmail);
    const result = await opts.runClaudeFn({
      prompt, model: "sonnet", timeoutMs: opts.timeoutMs,
      stage: opts.stageName, runDir: opts.runDir, ...opts.permissions,
    });
    commands = parseSetupWriterOutput(result.stdout);
  }

  return commands;
}
```

**Step 2: Wire into orchestrator**

In `pipeline/src/orchestrator.ts`, add the import:

```typescript
import { runSetupWriter } from "./stages/run-setup-writer.js";
```

Replace the setup prompt building (lines 223-276) in `executeGroup`:

```typescript
      if (condition) {
        const MAX_SETUP_ATTEMPTS = 3;
        let setupSuccess = false;
        let lastRetryContext: SetupRetryContext | null = null;

        for (let attempt = 1; attempt <= MAX_SETUP_ATTEMPTS; attempt++) {
          const stageName = attempt === 1
            ? `setup-${groupId}`
            : `setup-${groupId}-retry${attempt - 1}`;
          const timeoutMs = attempt === 1 ? 120_000 : 90_000;

          const commands = await runSetupWriter({
            groupId, condition, appIndex: appIndex!, projectEnv, projectRoot,
            authEmail: config.auth?.email, retryContext: lastRetryContext,
            runDir, stageName, runClaudeFn: runClaude,
            permissions: perms("setup-writer"), timeoutMs,
          });

          if (!commands) {
            lastRetryContext = { type: "parse_error" };
            callbacks.onLog(`  Setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS} for ${groupId}: parse error`);
            continue;
          }

          // Restore snapshot if retry
          if (attempt > 1 && snapshotPath) {
            const restoreResult = restoreSnapshot(snapshotPath, snapshotTableList, projectEnv);
            if (!restoreResult.success) {
              callbacks.onLog(`  Snapshot restore failed for ${groupId}: ${restoreResult.error}`);
              break;
            }
          }

          // Snapshot affected tables — use affected_tables from graph path, or parse from commands (review decision C3)
          snapshotTableList = commands.affected_tables ?? extractTableNames(commands.setup_commands);
          const snapshotDir = join(runDir, "setup", groupId);
          mkdirSync(snapshotDir, { recursive: true });
          snapshotPath = snapshotTables(snapshotTableList, snapshotDir, projectEnv);

          // Execute setup SQL
          const setupExec = executeSetupCommands(commands.setup_commands, projectEnv, projectRoot, seedIds);
          if (setupExec.success) {
            setupSuccess = true;
            writeFileSync(join(runDir, "setup", groupId, "commands.json"), JSON.stringify(commands, null, 2));
            break;
          }

          lastRetryContext = {
            type: "exec_error",
            failedCommands: commands.setup_commands,
            error: setupExec.error ?? "Unknown error",
          };
          callbacks.onLog(`  Setup attempt ${attempt}/${MAX_SETUP_ATTEMPTS} for ${groupId}: ${setupExec.error}${attempt < MAX_SETUP_ATTEMPTS ? " — retrying..." : ""}`);
        }
```

**Step 3: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add pipeline/src/stages/run-setup-writer.ts pipeline/src/orchestrator.ts
git commit -m "feat(orchestrator): shared runSetupWriter with graph-informed + fallback"
```

---

## Task 6: Update `run-stage` CLI for parity

**Files:**
- Modify: `pipeline/src/cli.ts` (run-stage setup-writer handler, around line 314)

**Step 1: Update the setup-writer case**

The CLI now calls the same shared `runSetupWriter` function. Add `legacy` to `parseArgs` options:

```typescript
  options: {
    // ... existing options ...
    legacy: { type: "boolean", default: false },
  },
```

Update the `setup-writer` case in the `run-stage` switch:

```typescript
    case "setup-writer": {
      const groupId = values.group ?? "default";
      const condition = values.condition ?? "";

      if (values.legacy) {
        // Old monolithic path only
        const { buildSetupWriterPrompt, parseSetupWriterOutput } = await import("./stages/setup-writer.js");
        const prompt = buildSetupWriterPrompt(groupId, condition, projectRoot, config.auth?.email);
        const result = await runClaude({ prompt, model: "sonnet", timeoutMs: 90_000, stage: stageName, runDir, ...permissions });
        const parsed = parseSetupWriterOutput(result.stdout);
        if (parsed) {
          console.log(`Setup writer (legacy): ${parsed.setup_commands.length} setup commands`);
          writeFileSync(join(runDir, "setup.json"), JSON.stringify(parsed, null, 2));
        } else {
          console.error("Failed to parse setup writer output");
          process.exitCode = 1;
        }
      } else {
        // Graph-informed + fallback via shared function (review fix #7)
        const { runSetupWriter } = await import("./stages/run-setup-writer.js");
        const { loadAppIndex } = await import("./lib/app-index.js");
        const appIndex = loadAppIndex(join(projectRoot, ".verify"));
        if (!appIndex) {
          console.error("No app.json found — run index-app first");
          process.exitCode = 1;
          break;
        }
        const projectEnv = process.env as Record<string, string>;
        const commands = await runSetupWriter({
          groupId, condition, appIndex, projectEnv, projectRoot,
          authEmail: config.auth?.email, retryContext: null,
          runDir, stageName, runClaudeFn: runClaude,
          permissions, timeoutMs: 90_000,
        });
        if (commands) {
          console.log(`Setup writer: ${commands.setup_commands.length} setup, ${commands.affected_tables?.length ?? 0} affected tables`);
          writeFileSync(join(runDir, "setup.json"), JSON.stringify(commands, null, 2));
        } else {
          console.error("Failed to produce setup commands");
          process.exitCode = 1;
        }
      }
      break;
    }
```

**Step 2: Typecheck + tests**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(cli): update run-stage setup-writer to use shared runSetupWriter"
```

---

## Task 7: Final verification

**Step 1: Typecheck + full test suite**

Run: `cd pipeline && npx tsc --noEmit && npx vitest run`
Expected: PASS

**Step 2: Integration test — run setup-writer against Documenso**

First re-index to get entity graphs:

```bash
cd pipeline && npx tsx src/cli.ts index-app \
  --project-dir /Users/abhishekray/Projects/opslane/evals/documenso \
  --output /tmp/documenso-verify/app.json
```

Then run a condition:

```bash
mkdir -p /tmp/graph-setup-test/logs && npx tsx src/cli.ts run-stage setup-writer \
  --verify-dir /Users/abhishekray/Projects/opslane/evals/documenso/.verify \
  --run-dir /tmp/graph-setup-test \
  --group test-graph \
  --condition "A draft document exists for the logged-in user's team with at least one recipient" \
  --timeout 60
```

Expected: Setup writer produces commands, executes successfully.

**Step 3: Commit final**

```bash
git commit --allow-empty -m "chore: verify graph-informed setup-writer integration"
```

---

## Summary of changes

| File | Change |
|------|--------|
| `pipeline/src/lib/types.ts` | Add optional `entity_graphs` to `AppIndex`, add `affected_tables` to `SetupCommands` |
| `pipeline/src/lib/psql.ts` | **New:** shared `psqlQuery` helper (single function) |
| `pipeline/src/lib/entity-graph.ts` | **New:** FK graph walker — batched `information_schema` queries, topo sort |
| `pipeline/src/stages/graph-setup.ts` | **New:** graph-informed setup-writer — single LLM call (root table + values), CHECK FIRST, deterministic SQL gen, seed validation |
| `pipeline/src/stages/run-setup-writer.ts` | **New:** shared runner — graph-informed + monolithic fallback, used by orchestrator and CLI |
| `pipeline/src/cli.ts` | Wire graph walker into `index-app`; update `run-stage` to use shared `runSetupWriter` |
| `pipeline/src/lib/index-app.ts` | Add `entity_graphs: {}` to `mergeIndexResults` |
| `pipeline/src/orchestrator.ts` | Call `runSetupWriter`, use `affected_tables` for snapshot |
| `pipeline/test/entity-graph.test.ts` | Tests for topoSort (including cycles), buildEntityGraphs |
| `pipeline/test/graph-setup.test.ts` | Tests for buildGraphPrompt, generateSqlFromPlan (seed validation, FK linking, special chars), graphInformedSetup (happy path, missing graphs, invalid LLM output, already satisfied) |
| `pipeline/test/plan-validator.test.ts` | Add `entity_graphs: {}` to fixtures |

**Total: ~500 lines new code, ~250 lines tests, ~60 lines modified.**

**What's preserved:** SetupCommands interface (extended), retry loop, snapshot/restore, executeSetupCommands, seedId validation, learnings injection, fallback to old path.

**What's new:** Single-call root table selection + value generation, CHECK FIRST condition check, explicit `affected_tables` for snapshotting, `runClaude` via DI (testable), shared `runSetupWriter` (no duplication), shared psql helper, batched info_schema queries, backward compat fallback.

---

## Review Decisions Applied

| # | Decision | Where applied |
|---|----------|---------------|
| 1A | Seed ID validation in `generateSqlFromPlan` | Task 4 |
| 2A | Root table selection via LLM | Task 4, inlined into main prompt (single call) |
| 3A | Reuse `data_model` enums, no `pg_enum` query | Task 1 (no `enum_values` in type), Task 2 (no `getEnumMap`) |
| 5A | CLI `run-stage` uses graph-informed path | Task 6 via shared `runSetupWriter` |
| 6A | Shared `psqlQuery` in `lib/psql.ts` | Task 1 |
| 7A | Full test coverage | Task 2 (topo cycles), Task 4 (graphInformedSetup, seed validation, special chars) |
| 8A | Batch FK + column queries | Task 2 (`batchFkEdges`, `batchColumns`) |
| C1 | CHECK FIRST — condition already satisfied? | Task 4, `buildGraphPrompt` |
| C2 | Use `runClaude` via DI, not `execSync` | Task 4, `graphInformedSetup` takes `runClaudeFn` param |
| C3 | Explicit `affected_tables` for snapshot | Task 1 (type), Task 4 (return), Task 5 (use) |
| C4 | Fallback when `entity_graphs` missing | Task 4 (returns null), Task 5 (shared `runSetupWriter` falls back) |

### Code Review Fixes Applied

| # | Fix | Where applied |
|---|-----|---------------|
| CR1 | `entity_graphs` is optional (`?`) on AppIndex | Task 1 |
| CR2 | `generateSqlFromPlan` returns `{ sql, affectedTables }`, tests use `result.sql` | Task 4 tests |
| CR3 | `runClaude` passed as parameter for testability | Task 4 (`runClaudeFn`), Task 5 (`runSetupWriter`) |
| CR4 | Remove dead `psqlQueryWithTable` | Task 1 |
| CR5 | Inline root table selection into main prompt (one LLM call) | Task 4 |
| CR6 | Add `graphInformedSetup` tests (happy, fallback, error, already-satisfied) | Task 4 tests |
| CR7 | Deduplicate fallback into shared `runSetupWriter` | Task 5 (`run-setup-writer.ts`) |
| CR8 | Fix missing imports in CLI `run-stage` handler | Task 6 (dynamic imports) |
