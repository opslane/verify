#!/usr/bin/env npx tsx
/**
 * Spike: FK Graph Walker — auto-discover the full entity graph from FK
 * relationships and generate topologically-ordered INSERTs.
 *
 * Questions:
 * 1. Does the FK graph capture ALL required parent tables?
 * 2. Can we generate valid SQL purely from schema metadata?
 * 3. Does this generalise across apps (Documenso + Cal.com)?
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-fk-graph-walker.ts
 */

import { execSync } from "node:child_process";

// ─── Config ──────────────────────────────────────────────────────────────────

interface DbTarget {
  name: string;
  url: string;
  rootTables: string[];
}

const TARGETS: DbTarget[] = [
  {
    name: "Documenso",
    url: "postgresql://documenso:password@localhost:54320/documenso",
    rootTables: ["Envelope", "Recipient", "TemplateDirectLink"],
  },
  {
    name: "Cal.com",
    url: "postgresql://calcom:calcom@localhost:5432/calcom",
    rootTables: ["Booking"],
  },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface FkEdge {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

interface EnumValue {
  enumName: string;
  value: string;
}

interface TableNode {
  table: string;
  requiredParents: FkEdge[]; // FK edges where this table references a NOT NULL FK
  allFks: FkEdge[];
  columns: ColumnInfo[];
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

function psql(dbUrl: string, sql: string): string {
  const cmd = `psql "${dbUrl}" -t -A -F'\t' -c ${escapeShell(sql)}`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    return err.stdout?.trim() ?? "";
  }
}

function psqlFull(dbUrl: string, sql: string): string {
  const cmd = `psql "${dbUrl}" -c ${escapeShell(sql)}`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    const msg = err.stderr ?? err.stdout ?? "unknown error";
    return `ERROR: ${msg.trim()}`;
  }
}

function escapeShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Step 1: Discover FK edges for a table ───────────────────────────────────

function getFkEdges(dbUrl: string, tableName: string): FkEdge[] {
  const sql = `
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_name = '${tableName}'
  `;
  const raw = psql(dbUrl, sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [fromTable, fromColumn, toTable, toColumn] = line.split("\t");
    return { fromTable, fromColumn, toTable, toColumn };
  });
}

// ─── Step 2: Get column metadata for a table ─────────────────────────────────

function getColumns(dbUrl: string, tableName: string): ColumnInfo[] {
  const sql = `
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = '${tableName}'
    ORDER BY ordinal_position
  `;
  const raw = psql(dbUrl, sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return {
      column_name: parts[0],
      data_type: parts[1],
      udt_name: parts[2],
      is_nullable: parts[3],
      column_default: parts[4] || null,
    };
  });
}

// ─── Step 3: Get enum values ─────────────────────────────────────────────────

function getEnumValues(dbUrl: string): Map<string, string[]> {
  const sql = `
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    ORDER BY t.typname, e.enumsortorder
  `;
  const raw = psql(dbUrl, sql);
  const map = new Map<string, string[]>();
  if (!raw) return map;
  for (const line of raw.split("\n").filter(Boolean)) {
    const [typname, label] = line.split("\t");
    if (!map.has(typname)) map.set(typname, []);
    map.get(typname)!.push(label);
  }
  return map;
}

// ─── Step 4: Walk FK graph recursively ───────────────────────────────────────

function walkFkGraph(
  dbUrl: string,
  rootTable: string,
): Map<string, TableNode> {
  const visited = new Map<string, TableNode>();
  const queue = [rootTable];

  while (queue.length > 0) {
    const table = queue.shift()!;
    if (visited.has(table)) continue;

    const allFks = getFkEdges(dbUrl, table);
    const columns = getColumns(dbUrl, table);

    // Determine which FKs are required (NOT NULL, no default)
    const requiredParents = allFks.filter((fk) => {
      const col = columns.find((c) => c.column_name === fk.fromColumn);
      return col && col.is_nullable === "NO" && !col.column_default;
    });

    visited.set(table, { table, requiredParents, allFks, columns });

    // Enqueue parent tables (but skip self-references)
    for (const fk of requiredParents) {
      if (fk.toTable !== table && !visited.has(fk.toTable)) {
        queue.push(fk.toTable);
      }
    }
  }

  return visited;
}

// ─── Step 5: Topological sort ────────────────────────────────────────────────

function topoSort(graph: Map<string, TableNode>): string[] {
  const inDegree = new Map<string, number>();
  for (const [t] of graph) inDegree.set(t, 0);

  for (const [, node] of graph) {
    for (const fk of node.requiredParents) {
      if (graph.has(fk.toTable) && fk.toTable !== node.table) {
        inDegree.set(node.table, (inDegree.get(node.table) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [t, deg] of inDegree) {
    if (deg === 0) queue.push(t);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    sorted.push(t);
    // Find tables that depend on t
    for (const [name, node] of graph) {
      if (name === t) continue;
      const dependsOnT = node.requiredParents.some(
        (fk) => fk.toTable === t && fk.toTable !== name,
      );
      if (dependsOnT) {
        inDegree.set(name, (inDegree.get(name) ?? 0) - 1);
        if (inDegree.get(name) === 0) queue.push(name);
      }
    }
  }

  // Detect cycles
  if (sorted.length < graph.size) {
    const missing = [...graph.keys()].filter((t) => !sorted.includes(t));
    console.warn(`  ⚠ Cycle detected — tables not in topo order: ${missing.join(", ")}`);
    sorted.push(...missing);
  }

  return sorted;
}

// ─── Step 6: Generate INSERT SQL ─────────────────────────────────────────────

function generateInserts(
  graph: Map<string, TableNode>,
  order: string[],
  enumMap: Map<string, string[]>,
): string {
  const lines: string[] = ["BEGIN;", ""];
  // Track which table's PK we've assigned to a variable
  const varMap = new Map<string, string>(); // table -> variable name for its PK

  for (const table of order) {
    const node = graph.get(table);
    if (!node) continue;

    const cols = node.columns;
    // Skip columns with defaults (serial, gen_random_uuid(), etc.) EXCEPT required FKs
    const requiredFkCols = new Set(node.requiredParents.map((fk) => fk.fromColumn));

    const insertCols: string[] = [];
    const insertVals: string[] = [];

    // Find the PK column (usually "id")
    const pkCol = cols.find(
      (c) =>
        c.column_name === "id" &&
        c.column_default !== null,
    );
    const pkName = pkCol?.column_name ?? "id";

    for (const col of cols) {
      // Skip columns with defaults unless they're required FKs
      if (col.column_default && !requiredFkCols.has(col.column_name)) continue;
      // Skip nullable columns (not required)
      if (col.is_nullable === "YES") continue;

      insertCols.push(`"${col.column_name}"`);

      // Is this an FK column?
      const fk = node.requiredParents.find((f) => f.fromColumn === col.column_name);
      if (fk && varMap.has(fk.toTable)) {
        insertVals.push(varMap.get(fk.toTable)!);
        continue;
      }

      // Generate value based on type
      insertVals.push(generateDefault(col, enumMap));
    }

    // Use a CTE or RETURNING to capture the PK
    const varName = `_${table.toLowerCase()}_id`;
    varMap.set(table, varName);

    lines.push(`-- ${table}`);

    // Check if id column has a default (auto-generated)
    const hasAutoId = pkCol?.column_default != null;

    if (hasAutoId && !insertCols.includes(`"${pkName}"`)) {
      // id is auto-generated, capture it with RETURNING
      lines.push(
        `INSERT INTO "${table}" (${insertCols.join(", ")})`,
        `VALUES (${insertVals.join(", ")})`,
        `RETURNING "${pkName}";`,
      );
      lines.push("");
    } else {
      lines.push(
        `INSERT INTO "${table}" (${insertCols.join(", ")})`,
        `VALUES (${insertVals.join(", ")});`,
      );
      lines.push("");
    }
  }

  lines.push("ROLLBACK;");
  return lines.join("\n");
}

function generateDefault(col: ColumnInfo, enumMap: Map<string, string[]>): string {
  const { column_name, data_type, udt_name } = col;

  // Check if it's an enum
  if (data_type === "USER-DEFINED" && enumMap.has(udt_name)) {
    const vals = enumMap.get(udt_name)!;
    return `'${vals[0]}'::"${udt_name}"`;
  }

  // UUID
  if (udt_name === "uuid") return "gen_random_uuid()";

  // Timestamps
  if (udt_name === "timestamp" || udt_name === "timestamptz") return "NOW()";

  // Booleans
  if (udt_name === "bool") return "false";

  // Integer types
  if (["int2", "int4", "int8", "serial", "bigserial"].includes(udt_name)) return "1";

  // Float/decimal
  if (["float4", "float8", "numeric"].includes(udt_name)) return "1.0";

  // Text/varchar — use column name as hint
  if (["text", "varchar", "bpchar"].includes(udt_name)) {
    if (column_name.toLowerCase().includes("email")) return "'test@example.com'";
    if (column_name.toLowerCase().includes("url")) return "'https://example.com'";
    if (column_name.toLowerCase().includes("name")) return `'test-${column_name}'`;
    if (column_name.toLowerCase().includes("slug")) return `'test-slug-${Date.now()}'`;
    return `'test-${column_name}'`;
  }

  // JSONB/JSON
  if (udt_name === "jsonb" || udt_name === "json") return "'{}'::jsonb";

  // Bytea
  if (udt_name === "bytea") return "'\\x00'::bytea";

  // Fallback
  return `'default-${column_name}'`;
}

// ─── Step 7: Execute with BEGIN/ROLLBACK and capture result ──────────────────

function testInserts(
  dbUrl: string,
  graph: Map<string, TableNode>,
  order: string[],
  enumMap: Map<string, string[]>,
): { sql: string; success: boolean; output: string } {
  // Generate SQL that uses DO $$ block for variable capture
  const lines: string[] = [];
  const varDecls: string[] = [];
  const stmts: string[] = [];

  const varMap = new Map<string, string>();

  for (const table of order) {
    const node = graph.get(table);
    if (!node) continue;

    const cols = node.columns;
    const requiredFkCols = new Set(node.requiredParents.map((fk) => fk.fromColumn));

    const insertCols: string[] = [];
    const insertVals: string[] = [];

    // Find PK
    const pkCol = cols.find(
      (c) => c.column_name === "id" && c.column_default !== null,
    );
    // Also check for non-defaulted "id"
    const idCol = cols.find((c) => c.column_name === "id");

    for (const col of cols) {
      if (col.column_default && !requiredFkCols.has(col.column_name)) continue;
      if (col.is_nullable === "YES") continue;

      const fk = node.requiredParents.find((f) => f.fromColumn === col.column_name);
      if (fk && varMap.has(fk.toTable)) {
        insertCols.push(`"${col.column_name}"`);
        insertVals.push(varMap.get(fk.toTable)!);
        continue;
      }

      insertCols.push(`"${col.column_name}"`);
      insertVals.push(generateDefault(col, enumMap));
    }

    if (idCol) {
      const varName = `v_${table.toLowerCase().replace(/[^a-z0-9]/g, "_")}_id`;
      varMap.set(table, varName);

      // Determine PK type
      const pkType =
        idCol.udt_name === "uuid"
          ? "uuid"
          : idCol.udt_name === "int4"
            ? "integer"
            : idCol.udt_name === "int8"
              ? "bigint"
              : "text";

      varDecls.push(`${varName} ${pkType};`);
      stmts.push(
        `  -- ${table}`,
        `  INSERT INTO "${table}" (${insertCols.join(", ")})`,
        `  VALUES (${insertVals.join(", ")})`,
        `  RETURNING "id" INTO ${varName};`,
        `  RAISE NOTICE '${table}.id = %', ${varName};`,
      );
    } else {
      stmts.push(
        `  -- ${table} (no id column)`,
        `  INSERT INTO "${table}" (${insertCols.join(", ")})`,
        `  VALUES (${insertVals.join(", ")});`,
        `  RAISE NOTICE '${table} inserted';`,
      );
    }
  }

  const sql = [
    "BEGIN;",
    "DO $$",
    "DECLARE",
    ...varDecls.map((d) => `  ${d}`),
    "BEGIN",
    ...stmts,
    "END $$;",
    "ROLLBACK;",
  ].join("\n");

  const output = psqlFull(dbUrl, sql);
  const success = !output.startsWith("ERROR");

  return { sql, success, output };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function runTarget(target: DbTarget): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${target.name} — ${target.url}`);
  console.log(`${"═".repeat(70)}\n`);

  // Check connectivity
  const version = psql(target.url, "SELECT version()");
  if (!version) {
    console.log(`  ✗ Cannot connect to ${target.name} — skipping\n`);
    return;
  }
  console.log(`  Connected: ${version.slice(0, 60)}...\n`);

  // Load enums once
  const enumMap = getEnumValues(target.url);
  console.log(`  Enums discovered: ${enumMap.size}`);
  for (const [name, vals] of enumMap) {
    console.log(`    ${name}: ${vals.slice(0, 5).join(", ")}${vals.length > 5 ? ` (+${vals.length - 5} more)` : ""}`);
  }
  console.log("");

  for (const rootTable of target.rootTables) {
    console.log(`  ${"─".repeat(60)}`);
    console.log(`  Root: ${rootTable}`);
    console.log(`  ${"─".repeat(60)}`);

    // Walk the graph
    const graph = walkFkGraph(target.url, rootTable);
    console.log(`\n  Tables in FK graph (${graph.size}):`);
    for (const [name, node] of graph) {
      const reqFks = node.requiredParents.map(
        (fk) => `${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`,
      );
      const optFks = node.allFks
        .filter((fk) => !node.requiredParents.includes(fk))
        .map((fk) => `${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`);
      console.log(`    ${name}`);
      if (reqFks.length) console.log(`      Required FKs: ${reqFks.join(", ")}`);
      if (optFks.length) console.log(`      Optional FKs: ${optFks.join(", ")}`);

      const notNullNoDef = node.columns.filter(
        (c) => c.is_nullable === "NO" && !c.column_default,
      );
      if (notNullNoDef.length) {
        console.log(
          `      NOT NULL (no default): ${notNullNoDef.map((c) => `${c.column_name}(${c.udt_name})`).join(", ")}`,
        );
      }
    }

    // Topological sort
    const order = topoSort(graph);
    console.log(`\n  Topological insert order: ${order.join(" → ")}`);

    // Generate readable SQL
    const readableSql = generateInserts(graph, order, enumMap);
    console.log(`\n  Generated SQL:\n`);
    for (const line of readableSql.split("\n")) {
      console.log(`    ${line}`);
    }

    // Test execution
    console.log(`\n  Testing execution (BEGIN/ROLLBACK)...`);
    const result = testInserts(target.url, graph, order, enumMap);
    if (result.success) {
      console.log(`  ✓ SQL executed successfully`);
    } else {
      console.log(`  ✗ SQL execution FAILED`);
    }
    console.log(`  Output:\n    ${result.output.replace(/\n/g, "\n    ")}`);

    // If it failed, show the actual SQL that was run
    if (!result.success) {
      console.log(`\n  Actual DO $$ SQL:\n`);
      for (const line of result.sql.split("\n")) {
        console.log(`    ${line}`);
      }
    }

    console.log("");
  }
}

// ─── Summary analysis ────────────────────────────────────────────────────────

function analyzeConventionLinks(dbUrl: string, table: string): void {
  // Check for columns that LOOK like FKs but aren't enforced by constraints
  const cols = getColumns(dbUrl, table);
  const fks = getFkEdges(dbUrl, table);
  const fkCols = new Set(fks.map((fk) => fk.fromColumn));

  const suspectCols = cols.filter(
    (c) =>
      (c.column_name.endsWith("Id") || c.column_name.endsWith("_id")) &&
      !fkCols.has(c.column_name) &&
      c.column_name !== "id",
  );

  if (suspectCols.length > 0) {
    console.log(`  Convention-linked columns (no FK constraint):`);
    for (const col of suspectCols) {
      console.log(
        `    ${col.column_name} (${col.udt_name}, nullable=${col.is_nullable})`,
      );
    }
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║  SPIKE: FK Graph Walker — Schema-driven entity graph discovery  ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");

for (const target of TARGETS) {
  runTarget(target);

  // Extra analysis: convention-linked columns
  console.log(`  Convention-link analysis for ${target.name}:`);
  for (const table of target.rootTables) {
    analyzeConventionLinks(target.url, table);
  }
  console.log("");
}

console.log("\n═══ KEY FINDINGS ═══\n");
console.log("Check the output above to answer:");
console.log("1. Does the FK graph capture ALL required parents?");
console.log("2. Are there convention-linked columns (ending in Id) without FK constraints?");
console.log("3. Can pure schema metadata generate valid SQL?");
console.log("4. Does it generalise across Documenso and Cal.com?");
