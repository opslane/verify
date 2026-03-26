#!/usr/bin/env npx tsx
/**
 * Spike D: Schema-validated LLM setup-writer
 *
 * Hypothesis: 80% of setup-writer failures are schema-detail errors (wrong enum,
 * missing NOT NULL column, wrong column name). A pre-execution validation layer
 * that catches these and retries with specific feedback should push reliability
 * from ~50% to ~90%.
 *
 * For each condition we measure:
 *   1. Raw pass rate — does the LLM's first output pass schema validation?
 *   2. Retry pass rate — after 1 retry with validation feedback, does it pass?
 *   3. Exec pass rate — does the validated SQL actually execute (BEGIN/ROLLBACK)?
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-d-validated-llm.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { buildSetupWriterPrompt } from "../stages/setup-writer.js";
import { parseJsonOutput } from "../lib/parse-json.js";

// ── Repo configs ────────────────────────────────────────────────────────────

interface RepoConfig {
  name: string;
  projectDir: string;
  dbUrl: string;
  authEmail: string;
  conditions: Array<{ id: string; condition: string }>;
}

const REPOS: RepoConfig[] = [
  {
    name: "documenso",
    projectDir: "/Users/abhishekray/Projects/opslane/evals/documenso",
    dbUrl: "postgresql://documenso:password@localhost:54320/documenso",
    authEmail: "ac1-test@test.documenso.com",
    conditions: [
      { id: "doc-draft-recipient", condition: "A draft document exists for the logged-in user's personal team, with at least one recipient added" },
      { id: "doc-3-drafts", condition: "At least 3 draft documents exist for the logged-in user's personal team" },
      { id: "doc-template", condition: "A template exists for the logged-in user's personal team" },
    ],
  },
  {
    name: "calcom",
    projectDir: "/Users/abhishekray/Projects/opslane/evals/cal.com",
    dbUrl: "postgresql://calcom:calcom@localhost:5432/calcom",
    authEmail: "pro@example.com",
    conditions: [
      { id: "cal-event-type", condition: "An event type exists for the logged-in user" },
      { id: "cal-booking", condition: "A booking exists for the logged-in user's event type" },
      { id: "cal-webhook", condition: "A webhook exists for the logged-in user" },
    ],
  },
];

// ── Schema introspection ────────────────────────────────────────────────────

interface ColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;   // "YES" or "NO"
  column_default: string | null;
}

interface EnumValue {
  typname: string;
  enumlabel: string;
}

interface ForeignKey {
  column_name: string;
  foreign_table: string;
  foreign_column: string;
}

interface TableSchema {
  columns: Map<string, ColumnInfo>;
  enums: Map<string, Set<string>>;  // enum type name -> set of valid values
  foreignKeys: Map<string, ForeignKey>;  // column_name -> FK info
}

function psqlQuery(dbUrl: string, sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -F'\t' -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return `ERROR: ${(err.stderr ?? err.message ?? "").slice(0, 200)}`;
  }
}

function loadAllEnums(dbUrl: string): Map<string, Set<string>> {
  const raw = psqlQuery(dbUrl,
    "SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid ORDER BY t.typname, e.enumsortorder",
  );
  const enums = new Map<string, Set<string>>();
  if (raw.startsWith("ERROR:") || !raw) return enums;
  for (const line of raw.split("\n")) {
    const [typname, label] = line.split("\t");
    if (!typname || !label) continue;
    if (!enums.has(typname)) enums.set(typname, new Set());
    enums.get(typname)!.add(label);
  }
  return enums;
}

function loadTableSchema(dbUrl: string, tableName: string, allEnums: Map<string, Set<string>>): TableSchema {
  // Columns
  const colRaw = psqlQuery(dbUrl,
    `SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${tableName}' ORDER BY ordinal_position`,
  );
  const columns = new Map<string, ColumnInfo>();
  if (!colRaw.startsWith("ERROR:")) {
    for (const line of colRaw.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      columns.set(parts[0], {
        column_name: parts[0],
        data_type: parts[1],
        udt_name: parts[2],
        is_nullable: parts[3],
        column_default: parts[4] || null,
      });
    }
  }

  // Enum values for this table's columns
  const tableEnums = new Map<string, Set<string>>();
  for (const [, col] of columns) {
    if (col.data_type === "USER-DEFINED" && allEnums.has(col.udt_name)) {
      tableEnums.set(col.udt_name, allEnums.get(col.udt_name)!);
    }
  }

  // Foreign keys
  const fkRaw = psqlQuery(dbUrl,
    `SELECT kcu.column_name, ccu.table_name, ccu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '${tableName}'`,
  );
  const foreignKeys = new Map<string, ForeignKey>();
  if (!fkRaw.startsWith("ERROR:")) {
    for (const line of fkRaw.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      foreignKeys.set(parts[0], { column_name: parts[0], foreign_table: parts[1], foreign_column: parts[2] });
    }
  }

  return { columns, enums: tableEnums, foreignKeys };
}

// ── SQL Validator ───────────────────────────────────────────────────────────

interface ValidationError {
  command_index: number;
  table: string;
  error_type: "unknown_table" | "unknown_column" | "missing_not_null" | "invalid_enum" | "unknown_fk_table";
  detail: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Extract table name from an INSERT or UPDATE SQL statement */
function extractTableName(sql: string): string | null {
  // INSERT INTO "TableName" or INSERT INTO TableName
  const insertMatch = sql.match(/INSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
  if (insertMatch) return insertMatch[1];

  // UPDATE "TableName" or UPDATE TableName
  const updateMatch = sql.match(/UPDATE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
  if (updateMatch) return updateMatch[1];

  return null;
}

/** Extract column names from INSERT ... (col1, col2, ...) VALUES ... */
function extractInsertColumns(sql: string): string[] {
  // Match the columns between INSERT INTO "Table" ( ... ) VALUES
  const match = sql.match(/INSERT\s+INTO\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s*\(([^)]+)\)/i);
  if (!match) return [];
  return match[1].split(",").map(c => c.trim().replace(/^"|"$/g, ""));
}

/** Extract column=value pairs from INSERT ... VALUES (...) or UPDATE ... SET col=val */
function extractEnumValues(sql: string, tableSchema: TableSchema): Array<{ column: string; value: string; enumType: string }> {
  const results: Array<{ column: string; value: string; enumType: string }> = [];

  for (const [, col] of tableSchema.columns) {
    if (col.data_type !== "USER-DEFINED") continue;
    const enumSet = tableSchema.enums.get(col.udt_name);
    if (!enumSet) continue;

    // Look for the column name in the SQL followed by a quoted string value
    // Pattern: "columnName" ... 'VALUE' or columnName = 'VALUE'
    const colName = col.column_name;
    // Check in INSERT VALUES context: find position of column in column list, then match value
    const insertCols = extractInsertColumns(sql);
    const colIdx = insertCols.findIndex(c => c === colName);
    if (colIdx >= 0) {
      // Extract values from VALUES (...)
      const valMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
      if (valMatch) {
        const vals = splitSqlValues(valMatch[1]);
        if (colIdx < vals.length) {
          const val = vals[colIdx].trim().replace(/^'|'$/g, "").replace(/::[^,)]+$/, "");
          results.push({ column: colName, value: val, enumType: col.udt_name });
        }
      }
    }

    // Check in UPDATE SET context: col = 'VALUE'
    const setMatch = sql.match(new RegExp(`"?${escapeRegex(colName)}"?\\s*=\\s*'([^']+)'`, "i"));
    if (setMatch) {
      const val = setMatch[1].replace(/::[^,)]+$/, "");
      results.push({ column: colName, value: val, enumType: col.udt_name });
    }
  }

  return results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split SQL values list respecting nested parens and quoted strings */
function splitSqlValues(valuesStr: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote = false;

  for (let i = 0; i < valuesStr.length; i++) {
    const c = valuesStr[i];
    if (c === "'" && !inQuote) { inQuote = true; current += c; continue; }
    if (c === "'" && inQuote) {
      if (valuesStr[i + 1] === "'") { current += "''"; i++; continue; } // escaped quote
      inQuote = false; current += c; continue;
    }
    if (inQuote) { current += c; continue; }
    if (c === "(") { depth++; current += c; continue; }
    if (c === ")") { depth--; current += c; continue; }
    if (c === "," && depth === 0) { result.push(current); current = ""; continue; }
    current += c;
  }
  if (current.trim()) result.push(current);
  return result;
}

function validateCommand(
  cmdIndex: number,
  sql: string,
  dbUrl: string,
  allEnums: Map<string, Set<string>>,
  schemaCache: Map<string, TableSchema>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const tableName = extractTableName(sql);
  if (!tableName) return []; // Not an INSERT/UPDATE, skip

  // Load schema for this table (with cache)
  if (!schemaCache.has(tableName)) {
    const schema = loadTableSchema(dbUrl, tableName, allEnums);
    schemaCache.set(tableName, schema);
  }
  const tableSchema = schemaCache.get(tableName)!;

  // Check table exists (has columns)
  if (tableSchema.columns.size === 0) {
    errors.push({ command_index: cmdIndex, table: tableName, error_type: "unknown_table", detail: `Table "${tableName}" not found in database` });
    return errors; // Can't validate further
  }

  // For INSERT: check columns exist and NOT NULL columns are present
  const insertCols = extractInsertColumns(sql);
  if (insertCols.length > 0) {
    // Check each column exists
    for (const col of insertCols) {
      if (!tableSchema.columns.has(col)) {
        errors.push({ command_index: cmdIndex, table: tableName, error_type: "unknown_column", detail: `Column "${col}" does not exist in table "${tableName}". Valid columns: ${[...tableSchema.columns.keys()].join(", ")}` });
      }
    }

    // Check NOT NULL columns without defaults are present
    for (const [colName, colInfo] of tableSchema.columns) {
      if (colInfo.is_nullable === "NO" && !colInfo.column_default && !insertCols.includes(colName)) {
        errors.push({ command_index: cmdIndex, table: tableName, error_type: "missing_not_null", detail: `NOT NULL column "${colName}" (type: ${colInfo.data_type}) has no default and is missing from INSERT` });
      }
    }
  }

  // Check enum values
  const enumUsages = extractEnumValues(sql, tableSchema);
  for (const usage of enumUsages) {
    const validValues = tableSchema.enums.get(usage.enumType);
    if (validValues && !validValues.has(usage.value)) {
      errors.push({
        command_index: cmdIndex, table: tableName, error_type: "invalid_enum",
        detail: `Invalid value '${usage.value}' for enum "${usage.enumType}" on column "${usage.column}". Valid values: ${[...validValues].join(", ")}`,
      });
    }
  }

  // Check FK referenced tables exist (light check — just that the table is real)
  for (const [colName, fk] of tableSchema.foreignKeys) {
    if (insertCols.includes(colName) || sql.includes(`"${colName}"`)) {
      if (!schemaCache.has(fk.foreign_table)) {
        const refSchema = loadTableSchema(dbUrl, fk.foreign_table, allEnums);
        schemaCache.set(fk.foreign_table, refSchema);
      }
      // We just ensure the referenced table has columns (exists)
      // We can't easily check the referenced value is valid without executing
    }
  }

  return errors;
}

function validateCommands(
  commands: string[],
  dbUrl: string,
  allEnums: Map<string, Set<string>>,
  schemaCache: Map<string, TableSchema>,
): ValidationResult {
  const allErrors: ValidationError[] = [];

  for (let i = 0; i < commands.length; i++) {
    // Extract the raw SQL from psql wrapper: psql "..." -c "SQL"
    const sqlMatch = commands[i].match(/-c\s+"((?:[^"\\]|\\.)*)"\s*$/);
    const rawSql = sqlMatch ? sqlMatch[1].replace(/\\"/g, '"') : commands[i];
    const errors = validateCommand(i, rawSql, dbUrl, allEnums, schemaCache);
    allErrors.push(...errors);
  }

  return { valid: allErrors.length === 0, errors: allErrors };
}

// ── LLM runner ──────────────────────────────────────────────────────────────

function runLLM(prompt: string, timeoutMs = 150_000): string {
  return execSync(
    `claude -p --allowedTools Bash --output-format text`,
    { timeout: timeoutMs, encoding: "utf-8", input: prompt, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
  );
}

function parseSetupCommands(raw: string): string[] | null {
  const parsed = parseJsonOutput<{ setup_commands?: string[] }>(raw);
  if (!parsed || !Array.isArray(parsed.setup_commands)) return null;
  return parsed.setup_commands;
}

// ── Retry with validation feedback ──────────────────────────────────────────

function buildValidationRetryPrompt(
  originalPrompt: string,
  commands: string[],
  validationErrors: ValidationError[],
): string {
  const errorBlock = validationErrors.map((e, i) =>
    `  ${i + 1}. [${e.error_type}] Command ${e.command_index + 1}, table "${e.table}": ${e.detail}`,
  ).join("\n");

  const commandBlock = commands.map((c, i) => `  Command ${i + 1}: ${c}`).join("\n");

  const retryBlock = `

SCHEMA VALIDATION FAILED. Fix these errors and try again.

Your previous commands:
${commandBlock}

Validation errors:
${errorBlock}

Fix each error:
- unknown_table: use the correct table name from the SCHEMA section above
- unknown_column: use the correct Postgres column name from the SCHEMA section
- missing_not_null: include all required NOT NULL columns that have no default
- invalid_enum: use one of the listed valid enum values (exact spelling, case-sensitive)

Re-run your psql queries if needed, then output corrected JSON.`;

  // Insert before the last "Output ONLY" marker
  const marker = "Output ONLY the JSON.";
  const markerIdx = originalPrompt.lastIndexOf(marker);
  if (markerIdx === -1) return `${originalPrompt}\n${retryBlock}`;
  return `${originalPrompt.slice(0, markerIdx)}${retryBlock}\n\n${originalPrompt.slice(markerIdx)}`;
}

// ── Execution test (BEGIN/ROLLBACK) ─────────────────────────────────────────

function testExecute(commands: string[], dbUrl: string): { success: boolean; error?: string } {
  // Wrap all SQL in a single BEGIN/ROLLBACK transaction
  const sqlStatements: string[] = [];
  for (const cmd of commands) {
    const sqlMatch = cmd.match(/-c\s+"((?:[^"\\]|\\.)*)"\s*$/);
    if (sqlMatch) {
      sqlStatements.push(sqlMatch[1].replace(/\\"/g, '"'));
    }
  }

  if (sqlStatements.length === 0) return { success: true };

  const wrappedSql = `BEGIN; ${sqlStatements.join("; ")}; ROLLBACK;`;
  try {
    execSync(
      `psql "${dbUrl}" -c "${wrappedSql.replace(/"/g, '\\"')}"`,
      { timeout: 15_000, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
    );
    return { success: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { success: false, error: (err.stderr ?? err.message ?? "").slice(0, 300) };
  }
}

// ── Test case runner ────────────────────────────────────────────────────────

interface CaseResult {
  repo: string;
  condition_id: string;
  condition: string;

  // Raw LLM output
  raw_parse_ok: boolean;
  raw_commands_count: number;
  raw_validation_pass: boolean;
  raw_validation_errors: ValidationError[];
  raw_exec_pass: boolean;
  raw_exec_error?: string;

  // After retry (only if raw validation failed)
  retry_attempted: boolean;
  retry_parse_ok: boolean;
  retry_commands_count: number;
  retry_validation_pass: boolean;
  retry_validation_errors: ValidationError[];
  retry_exec_pass: boolean;
  retry_exec_error?: string;

  // Final
  final_validation_pass: boolean;
  final_exec_pass: boolean;

  duration_ms: number;
  error?: string;
}

function runCase(
  repo: RepoConfig,
  cond: { id: string; condition: string },
  outDir: string,
  allEnums: Map<string, Set<string>>,
  schemaCache: Map<string, TableSchema>,
): CaseResult {
  const start = Date.now();
  const groupId = `spike-d-${cond.id}`;
  const result: CaseResult = {
    repo: repo.name,
    condition_id: cond.id,
    condition: cond.condition,
    raw_parse_ok: false,
    raw_commands_count: 0,
    raw_validation_pass: false,
    raw_validation_errors: [],
    raw_exec_pass: false,
    retry_attempted: false,
    retry_parse_ok: false,
    retry_commands_count: 0,
    retry_validation_pass: false,
    retry_validation_errors: [],
    retry_exec_pass: false,
    final_validation_pass: false,
    final_exec_pass: false,
    duration_ms: 0,
  };

  try {
    // Build prompt using the REAL buildSetupWriterPrompt
    const prompt = buildSetupWriterPrompt(groupId, cond.condition, repo.projectDir, repo.authEmail);
    writeFileSync(join(outDir, `${cond.id}-prompt.txt`), prompt);

    // Run LLM (raw)
    console.log(`    Running LLM (raw)...`);
    const rawOutput = runLLM(prompt);
    writeFileSync(join(outDir, `${cond.id}-raw-output.txt`), rawOutput);

    const rawCommands = parseSetupCommands(rawOutput);
    if (!rawCommands) {
      result.error = "Failed to parse JSON from raw LLM output";
      result.duration_ms = Date.now() - start;
      return result;
    }
    result.raw_parse_ok = true;
    result.raw_commands_count = rawCommands.length;
    writeFileSync(join(outDir, `${cond.id}-raw-commands.json`), JSON.stringify(rawCommands, null, 2));

    // Validate raw commands
    const rawValidation = validateCommands(rawCommands, repo.dbUrl, allEnums, schemaCache);
    result.raw_validation_pass = rawValidation.valid;
    result.raw_validation_errors = rawValidation.errors;
    writeFileSync(join(outDir, `${cond.id}-raw-validation.json`), JSON.stringify(rawValidation, null, 2));

    // Test execute raw commands (BEGIN/ROLLBACK)
    if (rawCommands.length > 0) {
      const rawExec = testExecute(rawCommands, repo.dbUrl);
      result.raw_exec_pass = rawExec.success;
      result.raw_exec_error = rawExec.error;
    } else {
      result.raw_exec_pass = true;
    }

    // If raw validation passed AND execution passed, we're done
    if (rawValidation.valid && result.raw_exec_pass) {
      result.final_validation_pass = true;
      result.final_exec_pass = true;
      result.duration_ms = Date.now() - start;
      return result;
    }

    // Retry with validation feedback
    result.retry_attempted = true;
    console.log(`    Validation failed (${rawValidation.errors.length} errors), retrying...`);
    const retryPrompt = buildValidationRetryPrompt(prompt, rawCommands, rawValidation.errors);
    writeFileSync(join(outDir, `${cond.id}-retry-prompt.txt`), retryPrompt);

    const retryOutput = runLLM(retryPrompt);
    writeFileSync(join(outDir, `${cond.id}-retry-output.txt`), retryOutput);

    const retryCommands = parseSetupCommands(retryOutput);
    if (!retryCommands) {
      result.error = "Failed to parse JSON from retry LLM output";
      result.duration_ms = Date.now() - start;
      return result;
    }
    result.retry_parse_ok = true;
    result.retry_commands_count = retryCommands.length;
    writeFileSync(join(outDir, `${cond.id}-retry-commands.json`), JSON.stringify(retryCommands, null, 2));

    // Validate retry commands
    const retryValidation = validateCommands(retryCommands, repo.dbUrl, allEnums, schemaCache);
    result.retry_validation_pass = retryValidation.valid;
    result.retry_validation_errors = retryValidation.errors;
    writeFileSync(join(outDir, `${cond.id}-retry-validation.json`), JSON.stringify(retryValidation, null, 2));

    // Test execute retry commands
    if (retryCommands.length > 0) {
      const retryExec = testExecute(retryCommands, repo.dbUrl);
      result.retry_exec_pass = retryExec.success;
      result.retry_exec_error = retryExec.error;
    } else {
      result.retry_exec_pass = true;
    }

    // Final result: use retry if attempted
    result.final_validation_pass = retryValidation.valid;
    result.final_exec_pass = result.retry_exec_pass;

  } catch (e) {
    const err = e as { message?: string };
    result.error = (err.message ?? "").slice(0, 300);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

const outDir = join(resolve(import.meta.dirname ?? ".", "../.."), `spike-d-validated-output-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

console.log("=== Spike D: Schema-Validated LLM Setup Writer ===\n");
console.log(`Output: ${outDir}\n`);

const allResults: CaseResult[] = [];

for (const repo of REPOS) {
  console.log(`\n--- ${repo.name} ---\n`);

  // Pre-load all enum values for this DB
  console.log(`  Loading enums...`);
  const allEnums = loadAllEnums(repo.dbUrl);
  console.log(`  Found ${allEnums.size} enum types`);

  // Save enum catalog for debugging
  const enumCatalog: Record<string, string[]> = {};
  for (const [name, values] of allEnums) {
    enumCatalog[name] = [...values];
  }
  writeFileSync(join(outDir, `${repo.name}-enums.json`), JSON.stringify(enumCatalog, null, 2));

  const schemaCache = new Map<string, TableSchema>();

  for (const cond of repo.conditions) {
    console.log(`\n  [${cond.id}] ${cond.condition}`);
    const result = runCase(repo, cond, outDir, allEnums, schemaCache);
    allResults.push(result);

    // Print inline results
    console.log(`    Raw:   parse=${result.raw_parse_ok ? "ok" : "FAIL"}  validate=${result.raw_validation_pass ? "ok" : `FAIL(${result.raw_validation_errors.length})`}  exec=${result.raw_exec_pass ? "ok" : "FAIL"}`);
    if (result.retry_attempted) {
      console.log(`    Retry: parse=${result.retry_parse_ok ? "ok" : "FAIL"}  validate=${result.retry_validation_pass ? "ok" : `FAIL(${result.retry_validation_errors.length})`}  exec=${result.retry_exec_pass ? "ok" : "FAIL"}`);
    }
    console.log(`    Final: validate=${result.final_validation_pass ? "PASS" : "FAIL"}  exec=${result.final_exec_pass ? "PASS" : "FAIL"}  (${Math.round(result.duration_ms / 1000)}s)`);
    if (result.error) console.log(`    Error: ${result.error.slice(0, 120)}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

writeFileSync(join(outDir, "results.json"), JSON.stringify(allResults, null, 2));

const total = allResults.length;
const rawParseOk = allResults.filter(r => r.raw_parse_ok).length;
const rawValidOk = allResults.filter(r => r.raw_validation_pass).length;
const rawExecOk = allResults.filter(r => r.raw_exec_pass).length;
const retryAttempted = allResults.filter(r => r.retry_attempted).length;
const retryValidOk = allResults.filter(r => r.retry_attempted && r.retry_validation_pass).length;
const retryExecOk = allResults.filter(r => r.retry_attempted && r.retry_exec_pass).length;
const finalValidOk = allResults.filter(r => r.final_validation_pass).length;
const finalExecOk = allResults.filter(r => r.final_exec_pass).length;

console.log(`\n\n${"=".repeat(60)}`);
console.log(`=== SPIKE D SUMMARY (${total} conditions across ${REPOS.length} repos) ===`);
console.log(`${"=".repeat(60)}\n`);

console.log(`Raw LLM output:`);
console.log(`  Parse OK:          ${rawParseOk}/${total} (${pct(rawParseOk, total)})`);
console.log(`  Validation pass:   ${rawValidOk}/${total} (${pct(rawValidOk, total)})`);
console.log(`  Execution pass:    ${rawExecOk}/${total} (${pct(rawExecOk, total)})`);

if (retryAttempted > 0) {
  console.log(`\nAfter 1 retry with validation feedback:`);
  console.log(`  Retries attempted: ${retryAttempted}/${total}`);
  console.log(`  Validation pass:   ${retryValidOk}/${retryAttempted} (${pct(retryValidOk, retryAttempted)})`);
  console.log(`  Execution pass:    ${retryExecOk}/${retryAttempted} (${pct(retryExecOk, retryAttempted)})`);
}

console.log(`\nFinal (best of raw + retry):`);
console.log(`  Validation pass:   ${finalValidOk}/${total} (${pct(finalValidOk, total)})`);
console.log(`  Execution pass:    ${finalExecOk}/${total} (${pct(finalExecOk, total)})`);

// Error breakdown
const validationErrorTypes = new Map<string, number>();
for (const r of allResults) {
  for (const e of [...r.raw_validation_errors, ...r.retry_validation_errors]) {
    validationErrorTypes.set(e.error_type, (validationErrorTypes.get(e.error_type) ?? 0) + 1);
  }
}
if (validationErrorTypes.size > 0) {
  console.log(`\nValidation error breakdown (across all attempts):`);
  for (const [type, count] of [...validationErrorTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
}

// Per-repo breakdown
for (const repo of REPOS) {
  const repoResults = allResults.filter(r => r.repo === repo.name);
  const rTotal = repoResults.length;
  const rRawValid = repoResults.filter(r => r.raw_validation_pass).length;
  const rRawExec = repoResults.filter(r => r.raw_exec_pass).length;
  const rFinalValid = repoResults.filter(r => r.final_validation_pass).length;
  const rFinalExec = repoResults.filter(r => r.final_exec_pass).length;
  console.log(`\n  ${repo.name}: raw_valid=${rRawValid}/${rTotal} raw_exec=${rRawExec}/${rTotal} final_valid=${rFinalValid}/${rTotal} final_exec=${rFinalExec}/${rTotal}`);
}

// Verdict
console.log(`\n${"=".repeat(60)}`);
const rawValidPct = total > 0 ? rawValidOk / total * 100 : 0;
const finalExecPct = total > 0 ? finalExecOk / total * 100 : 0;

if (finalExecPct >= 80) {
  console.log(`VERDICT: Schema validation + retry achieves ${pct(finalExecOk, total)} execution success.`);
  console.log(`  The validator approach WORKS. Raw validation pass rate was ${pct(rawValidOk, total)}.`);
  console.log(`  Recommendation: integrate schema validator into setup-writer pipeline.`);
} else if (finalExecPct >= 60) {
  console.log(`VERDICT: Schema validation + retry achieves ${pct(finalExecOk, total)} execution success.`);
  console.log(`  MODERATE improvement over raw (${pct(rawExecOk, total)}). May need 2nd retry or prompt tuning.`);
} else {
  console.log(`VERDICT: Schema validation + retry only achieves ${pct(finalExecOk, total)} execution success.`);
  console.log(`  LLM is fundamentally unreliable for SQL generation. Go deterministic.`);
}
console.log(`${"=".repeat(60)}\n`);

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${Math.round(n / d * 100)}%`;
}
