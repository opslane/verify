#!/usr/bin/env npx tsx
/**
 * Spike: Graph-Informed LLM — pre-compute FK dependency graph deterministically,
 * then use a TINY focused LLM prompt (~500 tokens) to fill in VALUES only.
 *
 * Hypothesis: splitting the problem (deterministic graph + focused LLM) beats
 * the monolithic setup-writer's reliability at a fraction of the latency.
 *
 * Steps:
 * 1. Deterministic: query FK graph + column metadata from information_schema
 * 2. Build tiny prompt with just the entity graph + column types + enums
 * 3. Run `claude -p` with NO tools (pure reasoning)
 * 4. Parse JSON output → generate SQL deterministically
 * 5. Execute with BEGIN/ROLLBACK
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-graph-informed-llm.ts
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseJsonOutput } from "../lib/parse-json.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const USER_ID = 9;
const TEAM_ID = 7;

interface TestCase {
  id: string;
  condition: string;
  /** Root table(s) the condition centers on */
  rootTables: string[];
  /** Additional child tables the condition requires (not reachable via FK parents) */
  childTables: string[];
}

const TEST_CASES: TestCase[] = [
  {
    id: "draft-with-recipient",
    condition: "A draft document exists for the logged-in user's team with at least one recipient",
    rootTables: ["Envelope"],
    childTables: ["Recipient", "EnvelopeItem", "DocumentData"],
  },
  {
    id: "template-direct-link",
    condition: "A template exists with a TemplateDirectLink enabled",
    rootTables: ["Template"],
    childTables: ["TemplateDirectLink"],
  },
  {
    id: "org-pending-invitations",
    condition: "An organisation has pending admin and member invitations",
    rootTables: ["Team"],
    childTables: ["TeamMemberInvite"],
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

interface TableNode {
  table: string;
  columns: ColumnInfo[];
  requiredParents: FkEdge[];
  allFks: FkEdge[];
}

interface InsertRow {
  table: string;
  values: Record<string, string>;
}

interface LlmOutput {
  inserts: InsertRow[];
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

function psql(sql: string): string {
  const cmd = `psql "${DB_URL}" -t -A -F'\t' -c ${escapeShell(sql)}`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch (e: unknown) {
    const err = e as { stdout?: string };
    return err.stdout?.trim() ?? "";
  }
}

function psqlFull(sql: string): string {
  const cmd = `psql "${DB_URL}" -c ${escapeShell(sql)}`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    return `ERROR: ${(err.stderr ?? err.stdout ?? "").trim().slice(0, 500)}`;
  }
}

function escapeShell(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Step 1: Schema introspection (deterministic) ────────────────────────────

function getFkEdges(tableName: string): FkEdge[] {
  const sql = `
    SELECT tc.table_name, kcu.column_name,
           ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '${tableName}'
  `;
  const raw = psql(sql);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [fromTable, fromColumn, toTable, toColumn] = line.split("\t");
    return { fromTable, fromColumn, toTable, toColumn };
  });
}

function getColumns(tableName: string): ColumnInfo[] {
  const sql = `
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = '${tableName}' ORDER BY ordinal_position
  `;
  const raw = psql(sql);
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

function getEnumValues(): Map<string, string[]> {
  const sql = `
    SELECT t.typname, e.enumlabel
    FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
    ORDER BY t.typname, e.enumsortorder
  `;
  const raw = psql(sql);
  const map = new Map<string, string[]>();
  if (!raw) return map;
  for (const line of raw.split("\n").filter(Boolean)) {
    const [typname, label] = line.split("\t");
    if (!map.has(typname)) map.set(typname, []);
    map.get(typname)!.push(label);
  }
  return map;
}

// ─── Step 2: Walk FK graph (deterministic) ───────────────────────────────────

function walkFkParents(rootTable: string): Map<string, TableNode> {
  const visited = new Map<string, TableNode>();
  const queue = [rootTable];

  while (queue.length > 0) {
    const table = queue.shift()!;
    if (visited.has(table)) continue;

    const allFks = getFkEdges(table);
    const columns = getColumns(table);
    const requiredParents = allFks.filter((fk) => {
      const col = columns.find((c) => c.column_name === fk.fromColumn);
      return col && col.is_nullable === "NO" && !col.column_default;
    });

    visited.set(table, { table, requiredParents, allFks, columns });

    for (const fk of requiredParents) {
      if (fk.toTable !== table && !visited.has(fk.toTable)) {
        queue.push(fk.toTable);
      }
    }
  }

  return visited;
}

function buildEntityGraph(tc: TestCase): Map<string, TableNode> {
  const graph = new Map<string, TableNode>();

  // Walk FK parents from each root table
  for (const root of tc.rootTables) {
    const parents = walkFkParents(root);
    for (const [name, node] of parents) {
      if (!graph.has(name)) graph.set(name, node);
    }
  }

  // Add child tables (which reference the root but aren't FK parents)
  for (const child of tc.childTables) {
    if (graph.has(child)) continue;
    const allFks = getFkEdges(child);
    const columns = getColumns(child);
    const requiredParents = allFks.filter((fk) => {
      const col = columns.find((c) => c.column_name === fk.fromColumn);
      return col && col.is_nullable === "NO" && !col.column_default;
    });
    graph.set(child, { table: child, requiredParents, allFks, columns });

    // Also walk this child's FK parents
    for (const fk of requiredParents) {
      if (!graph.has(fk.toTable) && fk.toTable !== child) {
        const subParents = walkFkParents(fk.toTable);
        for (const [name, node] of subParents) {
          if (!graph.has(name)) graph.set(name, node);
        }
      }
    }
  }

  return graph;
}

// ─── Step 3: Topological sort ────────────────────────────────────────────────

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
    for (const [name, node] of graph) {
      if (name === t) continue;
      if (node.requiredParents.some((fk) => fk.toTable === t && fk.toTable !== name)) {
        inDegree.set(name, (inDegree.get(name) ?? 0) - 1);
        if (inDegree.get(name) === 0) queue.push(name);
      }
    }
  }

  if (sorted.length < graph.size) {
    const missing = [...graph.keys()].filter((t) => !sorted.includes(t));
    console.warn(`  Warning: cycle detected, appending: ${missing.join(", ")}`);
    sorted.push(...missing);
  }

  return sorted;
}

// ─── Step 4: Build tiny focused prompt ───────────────────────────────────────

function buildTinyPrompt(
  tc: TestCase,
  graph: Map<string, TableNode>,
  order: string[],
  enumMap: Map<string, string[]>,
): string {
  const lines: string[] = [];

  lines.push("You are filling in values for a database INSERT sequence.");
  lines.push("");
  lines.push("ALREADY EXIST (do NOT create these — use the given IDs):");
  lines.push(`- User: id=${USER_ID} (already exists)`);
  lines.push(`- Team: id=${TEAM_ID} (already exists)`);
  lines.push("- Organisation, OrganisationClaim, OrganisationGlobalSettings, OrganisationAuthenticationPortal, TeamGlobalSettings: already exist for this user's team");
  lines.push("Only create rows for tables NOT listed above.");
  lines.push("");
  lines.push("ENTITY GRAPH (tables to populate, in order — SKIP tables that already exist):");

  for (let i = 0; i < order.length; i++) {
    const table = order[i];
    const node = graph.get(table)!;

    // Build column descriptions — only NOT NULL or FK-relevant columns
    const colDescs: string[] = [];
    for (const col of node.columns) {
      // Skip columns with serial/auto-increment defaults (unless it's an FK)
      const isRequiredFk = node.requiredParents.some((fk) => fk.fromColumn === col.column_name);
      const hasAutoDefault = col.column_default !== null && (
        col.column_default.includes("nextval") ||
        col.column_default.includes("gen_random_uuid") ||
        col.column_default.includes("now()")
      );

      // Include if: NOT NULL without auto-default, OR it's a required FK
      if (col.is_nullable === "NO" && !hasAutoDefault) {
        let desc = `${col.column_name}`;

        // Add type info
        if (col.data_type === "USER-DEFINED" && enumMap.has(col.udt_name)) {
          const vals = enumMap.get(col.udt_name)!;
          desc += ` (enum: ${vals.join(", ")})`;
        } else if (col.udt_name === "uuid") {
          desc += " (uuid)";
        } else if (col.udt_name === "text" || col.udt_name === "varchar") {
          desc += " (text)";
        } else if (["int4", "int8", "int2"].includes(col.udt_name)) {
          desc += " (int)";
        } else if (col.udt_name === "bool") {
          desc += " (bool)";
        } else if (col.udt_name === "timestamp" || col.udt_name === "timestamptz") {
          desc += " (timestamp)";
        } else if (col.udt_name === "jsonb" || col.udt_name === "json") {
          desc += " (jsonb)";
        } else if (col.udt_name === "bytea") {
          desc += " (bytea)";
        } else if (["float4", "float8", "numeric"].includes(col.udt_name)) {
          desc += " (numeric)";
        } else {
          desc += ` (${col.udt_name})`;
        }

        // Mark FK references
        const fk = node.allFks.find((f) => f.fromColumn === col.column_name);
        if (fk) {
          desc += ` ref:${fk.toTable}.${fk.toColumn}`;
        }

        // Mark known fixed values
        if (col.column_name === "userId" || col.column_name === "ownerTeamId") {
          desc += `=${USER_ID}`;
        } else if (col.column_name === "teamId") {
          desc += `=${TEAM_ID}`;
        }

        colDescs.push(desc);
      }
    }

    lines.push(`${i + 1}. ${table}: [${colDescs.join(", ")}]`);
  }

  lines.push("");
  lines.push(`CONDITION: ${tc.condition}`);
  lines.push(`userId=${USER_ID}, teamId=${TEAM_ID}`);
  lines.push("");
  lines.push("Output JSON with this exact shape:");
  lines.push('{"inserts":[{"table":"TableName","values":{"col":"val",...}},...]}}');
  lines.push("");
  lines.push("LEARNINGS (from past failures — follow these):");
  lines.push("- DocumentData.type MUST be 'BYTES_64' (not S3_PATH or BYTES)");
  lines.push("- DocumentData.data should be empty string '' for test data");
  lines.push("- Envelope.source MUST be 'DOCUMENT' (even for templates)");
  lines.push("- Envelope.internalVersion MUST be 1");
  lines.push("- Envelope.qrToken is NOT NULL — use gen_random_uuid()");
  lines.push("");
  lines.push("Rules:");
  lines.push('- Use gen_random_uuid() for uuid/text ID columns (write it as a string "gen_random_uuid()")');
  lines.push("- Use enum values from the LEARNINGS above when specified, otherwise first enum value");
  lines.push("- For FK ref columns, use the SAME id string as the referenced table's id");
  lines.push(`- Set userId=${USER_ID}, teamId=${TEAM_ID} — do NOT create new User/Team/Org rows`);
  lines.push("- SKIP tables listed in ALREADY EXIST section");
  lines.push("- For text columns, use realistic placeholder values");
  lines.push("- Output ONLY the JSON, no explanation");

  return lines.join("\n");
}

// ─── Step 5: Run LLM with NO tools ──────────────────────────────────────────

function runTinyLLM(prompt: string): { text: string; durationMs: number } {
  const start = Date.now();

  // Try --output-format text first (works when no tools are used)
  try {
    const textOutput = execSync(
      `claude -p --output-format text`,
      {
        timeout: 120_000,
        encoding: "utf-8",
        input: prompt,
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 5 * 1024 * 1024,
      },
    );

    if (textOutput.trim()) {
      return { text: textOutput.trim(), durationMs: Date.now() - start };
    }
  } catch {
    // Fall through to stream-json
  }

  // Fallback: stream-json + verbose
  const raw = execSync(
    `claude -p --output-format stream-json --verbose`,
    {
      timeout: 120_000,
      encoding: "utf-8",
      input: prompt,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  // Parse NDJSON for the last assistant text
  let finalText = "";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === "result" && typeof evt.result === "string" && evt.result) {
        finalText = evt.result;
      }
      if (evt.type === "assistant" && evt.message && typeof evt.message === "object") {
        const msg = evt.message as { content?: Array<{ type: string; text?: string }> };
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              finalText = block.text;
            }
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  return { text: finalText, durationMs: Date.now() - start };
}

// ─── Step 6: Generate SQL from LLM JSON output ──────────────────────────────

function generateSqlFromInserts(
  inserts: InsertRow[],
  graph: Map<string, TableNode>,
  enumMap: Map<string, string[]>,
): string {
  const lines: string[] = ["BEGIN;", ""];
  const varDecls: string[] = [];
  const stmts: string[] = [];
  // Track UUID references: "gen_random_uuid()" placeholder → variable name
  const uuidVarMap = new Map<string, string>();
  let uuidCounter = 0;

  for (const insert of inserts) {
    const node = graph.get(insert.table);
    if (!node) {
      stmts.push(`  -- SKIPPED: table "${insert.table}" not in graph`);
      continue;
    }

    const cols: string[] = [];
    const vals: string[] = [];

    // Find id column for variable capture
    const idCol = node.columns.find((c) => c.column_name === "id");
    const varName = `v_${insert.table.toLowerCase().replace(/[^a-z0-9]/g, "_")}_id`;

    for (const [colName, rawValRaw] of Object.entries(insert.values)) {
      // Coerce all values to strings (LLM may return booleans, numbers, etc.)
      const rawVal = String(rawValRaw);
      const colInfo = node.columns.find((c) => c.column_name === colName);
      if (!colInfo) continue;

      cols.push(`"${colName}"`);

      // Check if this is a FK column that references a table we already inserted into
      const fk = node.allFks.find((f) => f.fromColumn === colName);
      if (fk && uuidVarMap.has(`${fk.toTable}_id`)) {
        // Use the PL/pgSQL variable from the referenced table's INSERT...RETURNING
        vals.push(uuidVarMap.get(`${fk.toTable}_id`)!);
      } else if (rawVal === "gen_random_uuid()") {
        vals.push("gen_random_uuid()");
      } else {
        // Format value based on column type
        vals.push(formatSqlValue(rawVal, colInfo, enumMap));
      }
    }

    if (cols.length === 0) continue;

    if (idCol) {
      const pkType = idCol.udt_name === "uuid" ? "uuid"
        : idCol.udt_name === "int4" ? "integer"
        : idCol.udt_name === "int8" ? "bigint"
        : "text";
      varDecls.push(`${varName} ${pkType};`);
      uuidVarMap.set(`${insert.table}_id`, varName);

      stmts.push(
        `  -- ${insert.table}`,
        `  INSERT INTO "${insert.table}" (${cols.join(", ")})`,
        `  VALUES (${vals.join(", ")})`,
        `  RETURNING "id" INTO ${varName};`,
        `  RAISE NOTICE '${insert.table}.id = %', ${varName};`,
      );
    } else {
      stmts.push(
        `  -- ${insert.table} (no id column)`,
        `  INSERT INTO "${insert.table}" (${cols.join(", ")})`,
        `  VALUES (${vals.join(", ")});`,
        `  RAISE NOTICE '${insert.table} inserted';`,
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

  return sql;
}

function formatSqlValue(
  rawVal: string,
  col: ColumnInfo,
  enumMap: Map<string, string[]>,
): string {
  // NULL handling
  if (rawVal === "null" || rawVal === "NULL") return "NULL";

  // Boolean
  if (col.udt_name === "bool") {
    return rawVal === "true" || rawVal === "TRUE" ? "true" : "false";
  }

  // Integer
  if (["int2", "int4", "int8", "serial", "bigserial"].includes(col.udt_name)) {
    const num = parseInt(rawVal, 10);
    return isNaN(num) ? "1" : String(num);
  }

  // Float/decimal
  if (["float4", "float8", "numeric"].includes(col.udt_name)) {
    const num = parseFloat(rawVal);
    return isNaN(num) ? "1.0" : String(num);
  }

  // UUID
  if (col.udt_name === "uuid") return "gen_random_uuid()";

  // Timestamp
  if (col.udt_name === "timestamp" || col.udt_name === "timestamptz") {
    if (rawVal.toLowerCase() === "now()" || rawVal.toLowerCase().includes("current")) return "NOW()";
    return `'${rawVal.replace(/'/g, "''")}'::timestamptz`;
  }

  // Enum
  if (col.data_type === "USER-DEFINED" && enumMap.has(col.udt_name)) {
    const validVals = enumMap.get(col.udt_name)!;
    const cleaned = rawVal.replace(/'/g, "");
    const matched = validVals.find((v) => v === cleaned) ?? validVals[0];
    return `'${matched}'::"${col.udt_name}"`;
  }

  // JSONB
  if (col.udt_name === "jsonb" || col.udt_name === "json") {
    if (rawVal.startsWith("{") || rawVal.startsWith("[")) {
      return `'${rawVal.replace(/'/g, "''")}'::jsonb`;
    }
    return "'{}'"  + "::jsonb";
  }

  // Bytea
  if (col.udt_name === "bytea") return "'\\x00'::bytea";

  // Text/varchar — escape single quotes
  return `'${rawVal.replace(/'/g, "''")}'`;
}

// ─── Step 7: Fix FK references in generated SQL ──────────────────────────────
// The LLM might use placeholder UUIDs for FK refs. We replace them with PL/pgSQL vars.

function fixFkReferences(sql: string, inserts: InsertRow[], graph: Map<string, TableNode>): string {
  // Build a map: for each table, collect the id value the LLM assigned
  const tableIdValues = new Map<string, string>();
  for (const insert of inserts) {
    if (insert.values["id"]) {
      tableIdValues.set(insert.table, insert.values["id"]);
    }
  }

  // For each FK column, if the LLM used a matching UUID string, replace with the variable
  let fixed = sql;
  for (const insert of inserts) {
    const node = graph.get(insert.table);
    if (!node) continue;

    for (const fk of node.allFks) {
      const fkValue = insert.values[fk.fromColumn];
      if (!fkValue || fkValue === "gen_random_uuid()") continue;

      // Check if this value matches the ID of the referenced table
      const refIdValue = tableIdValues.get(fk.toTable);
      if (refIdValue && fkValue === refIdValue && refIdValue !== "gen_random_uuid()") {
        // Replace the hardcoded UUID with the PL/pgSQL variable
        const varName = `v_${fk.toTable.toLowerCase().replace(/[^a-z0-9]/g, "_")}_id`;
        fixed = fixed.replace(
          new RegExp(`'${escapeRegex(fkValue)}'`, "g"),
          varName,
        );
      }
    }
  }

  return fixed;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Step 8: Verify rows were created ────────────────────────────────────────

function verifyInserts(sql: string): { success: boolean; output: string } {
  // Replace ROLLBACK with COMMIT temporarily for verification, then manually rollback
  // Actually, we just run with BEGIN/ROLLBACK and check NOTICE output
  const output = psqlFull(sql);
  const success = !output.startsWith("ERROR") && !output.includes("ERROR:");
  return { success, output };
}

// ─── Main ────────────────────────────────────────────────────────────────────

const outDir = join(
  resolve(import.meta.dirname ?? ".", "../.."),
  `spike-graph-llm-output-${Date.now()}`,
);
mkdirSync(outDir, { recursive: true });

console.log("================================================================");
console.log("  SPIKE: Graph-Informed LLM — FK graph + tiny focused prompt");
console.log("================================================================\n");
console.log(`Output: ${outDir}`);
console.log(`DB: ${DB_URL}`);
console.log(`userId=${USER_ID}, teamId=${TEAM_ID}\n`);

// Check connectivity
const version = psql("SELECT version()");
if (!version) {
  console.log("ERROR: Cannot connect to database. Is it running?");
  process.exit(1);
}
console.log(`Connected: ${version.slice(0, 60)}...\n`);

// Load all enums once
const enumMap = getEnumValues();
console.log(`Enums discovered: ${enumMap.size}\n`);

// ─── Run test cases ──────────────────────────────────────────────────────────

interface CaseResult {
  id: string;
  condition: string;
  tableCount: number;
  insertOrder: string[];
  promptTokenEstimate: number;
  llmParseOk: boolean;
  llmInsertCount: number;
  sqlGenerated: boolean;
  execSuccess: boolean;
  execError?: string;
  durationMs: number;
}

const results: CaseResult[] = [];

for (const tc of TEST_CASES) {
  console.log(`${"─".repeat(60)}`);
  console.log(`[${tc.id}] ${tc.condition}`);
  console.log(`${"─".repeat(60)}`);

  const result: CaseResult = {
    id: tc.id,
    condition: tc.condition,
    tableCount: 0,
    insertOrder: [],
    promptTokenEstimate: 0,
    llmParseOk: false,
    llmInsertCount: 0,
    sqlGenerated: false,
    execSuccess: false,
    durationMs: 0,
  };

  // Step 1: Build entity graph
  console.log("\n  Step 1: Building entity graph...");
  const graph = buildEntityGraph(tc);
  result.tableCount = graph.size;
  console.log(`  Tables in graph: ${[...graph.keys()].join(", ")} (${graph.size})`);

  for (const [name, node] of graph) {
    const reqFks = node.requiredParents.map(
      (fk) => `${fk.fromColumn} -> ${fk.toTable}`,
    );
    const notNullCols = node.columns.filter(
      (c) => c.is_nullable === "NO" && !c.column_default,
    );
    console.log(`    ${name}: ${notNullCols.length} required cols, ${reqFks.length} required FKs${reqFks.length ? ` (${reqFks.join(", ")})` : ""}`);
  }

  // Step 2: Topological sort
  const order = topoSort(graph);
  result.insertOrder = order;
  console.log(`\n  Step 2: Insert order: ${order.join(" -> ")}`);

  // Step 3: Build tiny prompt
  console.log("\n  Step 3: Building tiny prompt...");
  const prompt = buildTinyPrompt(tc, graph, order, enumMap);
  const tokenEstimate = Math.ceil(prompt.length / 4); // rough char/token ratio
  result.promptTokenEstimate = tokenEstimate;
  console.log(`  Prompt length: ${prompt.length} chars (~${tokenEstimate} tokens)`);
  writeFileSync(join(outDir, `${tc.id}-prompt.txt`), prompt);

  // Step 4: Run LLM with NO tools
  console.log("\n  Step 4: Running LLM (no tools, pure reasoning)...");
  const llmResult = runTinyLLM(prompt);
  writeFileSync(join(outDir, `${tc.id}-llm-output.txt`), llmResult.text);
  console.log(`  LLM duration: ${Math.round(llmResult.durationMs / 1000)}s`);

  if (!llmResult.text.trim()) {
    console.log("  ERROR: Empty LLM output");
    result.durationMs = llmResult.durationMs;
    results.push(result);
    continue;
  }

  // Step 5: Parse JSON
  console.log("\n  Step 5: Parsing JSON...");
  const parsed = parseJsonOutput<LlmOutput>(llmResult.text);
  if (!parsed || !Array.isArray(parsed.inserts)) {
    console.log("  ERROR: Failed to parse JSON from LLM output");
    console.log(`  Raw output (first 300 chars): ${llmResult.text.slice(0, 300)}`);
    result.durationMs = llmResult.durationMs;
    results.push(result);
    continue;
  }

  result.llmParseOk = true;
  result.llmInsertCount = parsed.inserts.length;
  console.log(`  Parsed ${parsed.inserts.length} inserts`);
  writeFileSync(join(outDir, `${tc.id}-parsed.json`), JSON.stringify(parsed, null, 2));

  for (const ins of parsed.inserts) {
    console.log(`    ${ins.table}: ${Object.keys(ins.values).join(", ")}`);
  }

  // Step 6: Generate SQL from JSON
  console.log("\n  Step 6: Generating SQL...");
  let sql = generateSqlFromInserts(parsed.inserts, graph, enumMap);
  sql = fixFkReferences(sql, parsed.inserts, graph);
  result.sqlGenerated = true;
  writeFileSync(join(outDir, `${tc.id}-generated.sql`), sql);
  console.log("  SQL generated. Preview:");
  for (const line of sql.split("\n").slice(0, 25)) {
    console.log(`    ${line}`);
  }
  if (sql.split("\n").length > 25) {
    console.log(`    ... (${sql.split("\n").length - 25} more lines)`);
  }

  // Step 7: Execute with BEGIN/ROLLBACK
  console.log("\n  Step 7: Executing with BEGIN/ROLLBACK...");
  const execResult = verifyInserts(sql);
  result.execSuccess = execResult.success;
  if (!execResult.success) {
    result.execError = execResult.output.slice(0, 300);
    console.log(`  FAILED: ${execResult.output.slice(0, 300)}`);
  } else {
    console.log(`  SUCCESS`);
    // Show NOTICE lines
    const notices = execResult.output.split("\n").filter((l) => l.includes("NOTICE"));
    for (const n of notices) {
      console.log(`    ${n.trim()}`);
    }
  }

  result.durationMs = llmResult.durationMs;
  results.push(result);
  console.log("");
}

// ─── Summary ─────────────────────────────────────────────────────────────────

writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));

const total = results.length;
const parseOk = results.filter((r) => r.llmParseOk).length;
const sqlOk = results.filter((r) => r.sqlGenerated).length;
const execOk = results.filter((r) => r.execSuccess).length;
const avgDuration = results.reduce((s, r) => s + r.durationMs, 0) / total;
const avgPromptTokens = results.reduce((s, r) => s + r.promptTokenEstimate, 0) / total;

console.log(`\n${"=".repeat(60)}`);
console.log(`  SPIKE SUMMARY: Graph-Informed LLM (${total} test cases)`);
console.log(`${"=".repeat(60)}\n`);

console.log(`  JSON parse rate:     ${parseOk}/${total} (${pct(parseOk, total)})`);
console.log(`  SQL generation rate: ${sqlOk}/${total} (${pct(sqlOk, total)})`);
console.log(`  Execution rate:      ${execOk}/${total} (${pct(execOk, total)})`);
console.log(`  Avg LLM duration:    ${Math.round(avgDuration / 1000)}s`);
console.log(`  Avg prompt tokens:   ~${Math.round(avgPromptTokens)}`);
console.log("");

// Per-case breakdown
for (const r of results) {
  const status = r.execSuccess ? "PASS" : r.llmParseOk ? "FAIL(exec)" : "FAIL(parse)";
  console.log(
    `  [${status}] ${r.id}: ${r.tableCount} tables, ${r.llmInsertCount} inserts, ~${r.promptTokenEstimate} tokens, ${Math.round(r.durationMs / 1000)}s`,
  );
  if (r.execError) console.log(`         Error: ${r.execError.slice(0, 100)}`);
}

console.log(`\n${"=".repeat(60)}`);
if (execOk === total) {
  console.log("  VERDICT: Graph-informed tiny LLM achieves 100% execution rate.");
  console.log("  The split approach (deterministic graph + focused LLM) WORKS.");
  console.log("  Recommendation: adopt this as the setup-writer architecture.");
} else if (execOk >= total * 0.66) {
  console.log(`  VERDICT: ${pct(execOk, total)} execution rate — promising but needs tuning.`);
  console.log("  The approach is viable. Fix failure cases and re-test.");
} else {
  console.log(`  VERDICT: ${pct(execOk, total)} execution rate — needs investigation.`);
  console.log("  Check the generated SQL and LLM output for patterns.");
}
console.log(`${"=".repeat(60)}\n`);

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${Math.round((n / d) * 100)}%`;
}
