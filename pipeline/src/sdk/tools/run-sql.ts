import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import postgres from "postgres";
import { SetupError, classifyPgError } from "../errors.js";

// ── Validation ──────────────────────────────────────────────────────────────

// Scans entire string (not just start) — catches DDL embedded after semicolons or comments
const DDL_PATTERN = /\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;
const DELETE_NO_WHERE = /^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/i;

// Allowed first keywords for each declared operation
const OPERATION_KEYWORDS: Record<string, string[]> = {
  SELECT: ["SELECT", "WITH"],
  INSERT: ["INSERT", "WITH"],
  UPDATE: ["UPDATE", "WITH"],
  DELETE: ["DELETE", "WITH"],
};

export interface ValidationResult {
  blocked: boolean;
  reason?: string;
  errorType?: SetupError;
}

export function validateSQL(sql: string, operation: string, seedIds: string[]): ValidationResult {
  // Block multi-statement SQL (semicolons outside string literals)
  const stripped = sql.replace(/'[^']*'/g, "").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (stripped.includes(";")) {
    return { blocked: true, reason: "Multi-statement SQL is not allowed. Send one statement per tool call.", errorType: SetupError.SQL_SYNTAX };
  }

  // Verify declared operation matches actual SQL
  const firstKeyword = sql.trim().replace(/^\/\*[\s\S]*?\*\/\s*/, "").replace(/^--[^\n]*\n\s*/g, "").split(/\s+/)[0]?.toUpperCase();
  const allowed = OPERATION_KEYWORDS[operation];
  if (allowed && firstKeyword && !allowed.includes(firstKeyword)) {
    return { blocked: true, reason: `Declared operation ${operation} does not match SQL starting with ${firstKeyword}.`, errorType: SetupError.SQL_SYNTAX };
  }

  if (DDL_PATTERN.test(sql)) {
    return { blocked: true, reason: "DDL statements (DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE) are not allowed.", errorType: SetupError.DDL_BLOCKED };
  }

  if (operation === "DELETE" && DELETE_NO_WHERE.test(sql)) {
    return { blocked: true, reason: "DELETE without WHERE clause is not allowed.", errorType: SetupError.DELETE_NO_WHERE };
  }

  // Seed protection: substring match is acceptable because seed IDs use long prefixed formats (clseed-...)
  if (operation !== "SELECT") {
    const matchedSeed = seedIds.find(id => sql.includes(id));
    if (matchedSeed) {
      return { blocked: true, reason: `Cannot mutate seed data (ID: ${matchedSeed}). Use different IDs or UPDATE non-seed records.`, errorType: SetupError.SEED_MUTATION_BLOCKED };
    }
  }

  return { blocked: false };
}

export function extractTableName(sql: string): string | null {
  // Handles both "table" and "schema"."table" forms
  const match = sql.match(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:\w+"\."?)?(\w+)"?/i);
  return match ? match[1] : null;
}

// ── Tool State ──────────────────────────────────────────────────────────────

export interface ToolCallLog {
  operation: string;
  sql: string;
  result?: string;
  error?: string;
  errorType?: SetupError;
  durationMs: number;
}

export interface RunSqlState {
  affectedTables: Set<string>;
  toolCalls: ToolCallLog[];
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createRunSqlTool(dbUrl: string, seedIds: string[]) {
  const sql = postgres(dbUrl, { idle_timeout: 30 });
  const state: RunSqlState = {
    affectedTables: new Set(),
    toolCalls: [],
  };

  const runSqlTool = tool(
    "run_sql",
    "Execute a SQL statement against the database. Use SELECT to check existing data, INSERT/UPDATE/DELETE to modify data. Returns query results as JSON.",
    {
      sql: z.string().describe("SQL statement to execute"),
      operation: z.enum(["SELECT", "INSERT", "UPDATE", "DELETE"]).describe("SQL operation type"),
    },
    async (args) => {
      const start = Date.now();
      const { sql: sqlStr, operation } = args;

      // Validate
      const validation = validateSQL(sqlStr, operation, seedIds);
      if (validation.blocked) {
        state.toolCalls.push({ operation, sql: sqlStr, error: validation.reason, errorType: validation.errorType, durationMs: Date.now() - start });
        return { content: [{ type: "text" as const, text: `ERROR: ${validation.reason}` }], isError: true };
      }

      // Track affected tables (no manual BEGIN — postgres.js auto-commits each statement on pooled connections)
      if (operation !== "SELECT") {
        const table = extractTableName(sqlStr);
        if (table) state.affectedTables.add(table);
      }

      // Execute
      try {
        const rows = await sql.unsafe(sqlStr);
        const truncated = rows.length > 50;
        const resultStr = JSON.stringify(rows.slice(0, 50), null, 2);
        const summary = truncated
          ? `${rows.length} row(s) returned (showing first 50).\n${resultStr}`
          : `${rows.length} row(s) returned.\n${resultStr}`;
        state.toolCalls.push({ operation, sql: sqlStr, result: `${rows.length} rows`, durationMs: Date.now() - start });
        return { content: [{ type: "text" as const, text: summary }] };
      } catch (err: unknown) {
        const code = err instanceof Error && "code" in err && typeof (err as Record<string, unknown>).code === "string"
          ? (err as Record<string, unknown>).code as string
          : undefined;
        const errorType = classifyPgError(code);
        const msg = err instanceof Error ? err.message : String(err);
        state.toolCalls.push({ operation, sql: sqlStr, error: msg, errorType, durationMs: Date.now() - start });
        return { content: [{ type: "text" as const, text: `SQL ERROR (${errorType}): ${msg}` }], isError: true };
      }
    },
  );

  return {
    tool: runSqlTool,
    state,
    async close() {
      await sql.end();
    },
  };
}
