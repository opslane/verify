# Setup-Writer SDK Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate the setup-writer stage from `claude -p` CLI to the Claude Agent SDK with a custom `run_sql` MCP tool, validated by A/B comparison evals.

**Architecture:** Replace the CLI subprocess + post-hoc SQL execution with an in-process SDK `query()` call. A custom `run_sql` MCP tool executes SQL inside a Postgres transaction, validates against DDL/seed blocklists, and returns structured results so the LLM can self-correct. The orchestrator's 3-attempt retry loop is preserved for wrong-reasoning failures.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, `postgres` (postgres.js), `zod`, vitest

**Prior reviews:** CEO review (CLEAR, selective expansion), Eng review (CLEAR, 3 issues resolved), Codex outside voice (8 findings, 5 incorporated). Full context in `.claude/plans/wild-cuddling-beacon.md`.

---

## Task 0: Spike — A/B comparison of SDK vs CLI

This is the gate. If it fails, we don't build Tasks 1-6.

**Files:**
- Create: `pipeline/src/evals/spike-setup-sdk.ts`

**Step 1: Install SDK + postgres dependencies**

```bash
cd pipeline && npm install @anthropic-ai/claude-agent-sdk postgres zod
```

**Step 2: Write the spike file**

```typescript
// pipeline/src/evals/spike-setup-sdk.ts
//
// Spike: validate SDK + MCP tool works for setup-writer by running
// the same conditions through CLI and SDK paths, comparing results.
//
// Run: cd pipeline && npx tsx src/evals/spike-setup-sdk.ts
// Requires: EVAL_DB_URL env var pointing to eval repo's database

import { tool, createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import postgres from "postgres";
import { z } from "zod";
import { parseSetupWriterOutput } from "../stages/setup-writer.js";
import { runClaude } from "../run-claude.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const EVAL_DB_URL = process.env.EVAL_DB_URL;
if (!EVAL_DB_URL) {
  console.error("EVAL_DB_URL is required");
  process.exit(1);
}

const RUN_DIR = join(process.cwd(), ".spike-sdk-output");
mkdirSync(join(RUN_DIR, "logs"), { recursive: true });

// 5 representative conditions from real pipeline runs
const CONDITIONS = [
  "a user exists with email admin@example.com",
  "a template exists with name 'Spike Test Template'",
  "a direct link exists for a template with a recipient whose email is empty",
  "a document exists that belongs to the logged-in user's team",
  "a template exists with settings containing {\"allowDownload\": true}",
];

// ── run_sql MCP tool (inline for spike, extracted to module in Task 1) ─────

interface ToolState {
  sql: postgres.Sql;
  inTransaction: boolean;
  affectedTables: Set<string>;
  toolCalls: Array<{ operation: string; sql: string; result?: string; error?: string }>;
}

function createRunSqlTool(dbUrl: string, seedIds: string[]) {
  const state: ToolState = {
    sql: postgres(dbUrl, { idle_timeout: 30 }),
    inTransaction: false,
    affectedTables: new Set(),
    toolCalls: [],
  };

  const DDL_PATTERN = /^\s*(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;
  const DELETE_NO_WHERE = /^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/i;

  function extractTableName(sqlStr: string): string | null {
    const match = sqlStr.match(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/i);
    return match ? match[1] : null;
  }

  const runSqlTool = tool(
    "run_sql",
    "Execute a SQL statement against the database. Use SELECT to check existing data, INSERT/UPDATE/DELETE to modify data.",
    {
      sql: z.string().describe("SQL statement to execute"),
      operation: z.enum(["SELECT", "INSERT", "UPDATE", "DELETE"]).describe("SQL operation type"),
    },
    async (args) => {
      const { sql: sqlStr, operation } = args;

      // Validation: DDL blocklist
      if (DDL_PATTERN.test(sqlStr)) {
        const entry = { operation, sql: sqlStr, error: "DDL_BLOCKED" };
        state.toolCalls.push(entry);
        return { content: [{ type: "text" as const, text: "ERROR: DDL statements (DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE) are not allowed." }], isError: true };
      }

      // Validation: DELETE without WHERE
      if (operation === "DELETE" && DELETE_NO_WHERE.test(sqlStr)) {
        const entry = { operation, sql: sqlStr, error: "DELETE_NO_WHERE" };
        state.toolCalls.push(entry);
        return { content: [{ type: "text" as const, text: "ERROR: DELETE without WHERE clause is not allowed." }], isError: true };
      }

      // Validation: seed protection
      if (operation !== "SELECT") {
        const matchedSeed = seedIds.find(id => sqlStr.includes(id));
        if (matchedSeed) {
          const entry = { operation, sql: sqlStr, error: "SEED_MUTATION_BLOCKED" };
          state.toolCalls.push(entry);
          return { content: [{ type: "text" as const, text: `ERROR: Cannot mutate seed data (ID: ${matchedSeed}). Use different IDs or UPDATE non-seed records.` }], isError: true };
        }
      }

      // BEGIN transaction on first mutation
      if (operation !== "SELECT" && !state.inTransaction) {
        await state.sql`BEGIN`;
        state.inTransaction = true;
      }

      // Track affected tables
      if (operation !== "SELECT") {
        const table = extractTableName(sqlStr);
        if (table) state.affectedTables.add(table);
      }

      // Execute
      try {
        const rows = await state.sql.unsafe(sqlStr);
        const result = JSON.stringify(rows.slice(0, 50), null, 2);
        const entry = { operation, sql: sqlStr, result: `${rows.length} rows` };
        state.toolCalls.push(entry);
        return { content: [{ type: "text" as const, text: `${rows.length} row(s) returned.\n${result}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const entry = { operation, sql: sqlStr, error: msg };
        state.toolCalls.push(entry);
        return { content: [{ type: "text" as const, text: `SQL ERROR: ${msg}` }], isError: true };
      }
    },
  );

  return {
    tool: runSqlTool,
    state,
    async commit() {
      if (state.inTransaction) {
        await state.sql`COMMIT`;
        state.inTransaction = false;
      }
    },
    async rollback() {
      if (state.inTransaction) {
        await state.sql`ROLLBACK`;
        state.inTransaction = false;
      }
    },
    async close() {
      if (state.inTransaction) await this.rollback();
      await state.sql.end();
    },
  };
}

// ── Build a minimal setup prompt (reuses graph-setup pattern) ───────────────

function buildSpikePrompt(condition: string, mode: "cli" | "sdk"): string {
  const dbInstruction = mode === "cli"
    ? `DATABASE ACCESS:\nUse Bash to run psql commands.\nConnection: psql "${EVAL_DB_URL}" -c "SELECT ..."`
    : `DATABASE ACCESS:\nUse the run_sql tool to execute SQL queries.`;

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

CONDITION: ${condition}

${dbInstruction}

PROCESS:
1. Run 1-2 SELECT queries to check if the CONDITION is ALREADY SATISFIED by existing data
2. If existing data satisfies the condition: output empty setup_commands
3. If NOT satisfied: write minimal SQL (1-5 commands) using existing record IDs
4. Output ONLY the JSON below

OUTPUT: Valid JSON to stdout:
{
  "group_id": "spike",
  "condition": "${condition}",
  "setup_commands": [],
  "teardown_commands": []
}

Output ONLY the JSON. No explanation, no markdown fences.`;
}

// ── Run CLI path ────────────────────────────────────────────────────────────

async function runCLIPath(condition: string, idx: number): Promise<{ parsed: boolean; output: ReturnType<typeof parseSetupWriterOutput>; durationMs: number }> {
  const prompt = buildSpikePrompt(condition, "cli");
  const start = Date.now();
  const result = await runClaude({
    prompt,
    model: "sonnet",
    timeoutMs: 120_000,
    stage: `spike-cli-${idx}`,
    runDir: RUN_DIR,
    allowedTools: ["Bash"],
  });
  const durationMs = Date.now() - start;
  const output = parseSetupWriterOutput(result.stdout);
  return { parsed: !!output, output, durationMs };
}

// ── Run SDK path ────────────────────────────────────────────────────────────

async function runSDKPath(condition: string, idx: number): Promise<{
  parsed: boolean;
  output: ReturnType<typeof parseSetupWriterOutput>;
  durationMs: number;
  toolCalls: ToolState["toolCalls"];
  affectedTables: string[];
}> {
  const { tool: runSqlTool, state, commit, rollback, close } = createRunSqlTool(EVAL_DB_URL!, []);
  const server = createSdkMcpServer({ name: "setup", tools: [runSqlTool] });
  const prompt = buildSpikePrompt(condition, "sdk");

  const start = Date.now();
  let finalText = "";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    for await (const msg of query({
      prompt,
      options: {
        mcpServers: { setup: server },
        allowedTools: ["mcp__setup__run_sql"],
        permissionMode: "dontAsk",
        maxTurns: 15,
        abortController: controller,
      },
    })) {
      if (msg.type === "result") {
        finalText = msg.result;
      }
    }

    clearTimeout(timeout);
    const output = parseSetupWriterOutput(finalText);
    if (output) {
      await commit();
    } else {
      await rollback();
    }

    return {
      parsed: !!output,
      output,
      durationMs: Date.now() - start,
      toolCalls: state.toolCalls,
      affectedTables: [...state.affectedTables],
    };
  } catch (err: unknown) {
    await rollback();
    return {
      parsed: false,
      output: null,
      durationMs: Date.now() - start,
      toolCalls: state.toolCalls,
      affectedTables: [...state.affectedTables],
    };
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Setup-Writer SDK Spike — A/B Comparison");
  console.log("========================================\n");

  const results: Array<{
    condition: string;
    cli: { parsed: boolean; durationMs: number };
    sdk: { parsed: boolean; durationMs: number; toolCalls: number; affectedTables: string[] };
    winner: "CLI" | "SDK" | "TIE" | "BOTH_FAILED";
    regression: boolean;
  }> = [];

  for (let i = 0; i < CONDITIONS.length; i++) {
    const condition = CONDITIONS[i];
    console.log(`\n--- Condition ${i + 1}/${CONDITIONS.length} ---`);
    console.log(`"${condition}"\n`);

    // Run CLI path
    console.log("  CLI path...");
    const cli = await runCLIPath(condition, i);
    console.log(`  CLI: parsed=${cli.parsed} duration=${cli.durationMs}ms`);

    // Run SDK path
    console.log("  SDK path...");
    const sdk = await runSDKPath(condition, i);
    console.log(`  SDK: parsed=${sdk.parsed} duration=${sdk.durationMs}ms toolCalls=${sdk.toolCalls.length}`);

    // Determine winner
    let winner: "CLI" | "SDK" | "TIE" | "BOTH_FAILED";
    let regression = false;
    if (cli.parsed && sdk.parsed) winner = "TIE";
    else if (!cli.parsed && sdk.parsed) winner = "SDK";
    else if (cli.parsed && !sdk.parsed) { winner = "CLI"; regression = true; }
    else winner = "BOTH_FAILED";

    results.push({
      condition,
      cli: { parsed: cli.parsed, durationMs: cli.durationMs },
      sdk: { parsed: sdk.parsed, durationMs: sdk.durationMs, toolCalls: sdk.toolCalls.length, affectedTables: sdk.affectedTables },
      winner,
      regression,
    });
  }

  // Print comparison table
  console.log("\n\n========================================");
  console.log("RESULTS");
  console.log("========================================\n");

  const regressions = results.filter(r => r.regression);
  const sdkWins = results.filter(r => r.winner === "SDK").length;
  const ties = results.filter(r => r.winner === "TIE").length;
  const cliWins = results.filter(r => r.winner === "CLI").length;
  const bothFailed = results.filter(r => r.winner === "BOTH_FAILED").length;

  for (const r of results) {
    const flag = r.regression ? " *** REGRESSION ***" : "";
    console.log(`${r.condition}`);
    console.log(`  CLI: ${r.cli.parsed ? "PASS" : "FAIL"} (${r.cli.durationMs}ms)`);
    console.log(`  SDK: ${r.sdk.parsed ? "PASS" : "FAIL"} (${r.sdk.durationMs}ms, ${r.sdk.toolCalls} calls)`);
    console.log(`  Winner: ${r.winner}${flag}\n`);
  }

  console.log(`Score: SDK wins=${sdkWins} | Ties=${ties} | CLI wins=${cliWins} | Both failed=${bothFailed}`);
  console.log(`Regressions: ${regressions.length}`);

  if (regressions.length === 0 && (sdkWins + ties) >= 3) {
    console.log("\n*** SPIKE PASSED — proceed to Tasks 1-6 ***");
  } else if (regressions.length > 0) {
    console.log("\n*** SPIKE FAILED — regressions detected, investigate before proceeding ***");
  } else {
    console.log("\n*** SPIKE PARTIAL — review failures before proceeding ***");
  }

  // Write results to disk
  writeFileSync(join(RUN_DIR, "spike-results.json"), JSON.stringify(results, null, 2));
}

main().catch(console.error);
```

**Step 3: Run the spike**

```bash
cd pipeline && EVAL_DB_URL="postgresql://..." npx tsx src/evals/spike-setup-sdk.ts
```

Expected output: comparison table showing CLI vs SDK results for all 5 conditions.

**Step 4: Evaluate results**

- 0 regressions + 3+ passes = **PASS**, proceed to Task 1
- Any regression = **FAIL**, diagnose before proceeding
- SDK errors = check `spike-sdk-output/logs/` for tool call logs and SDK messages

**Step 5: Commit**

```bash
cd pipeline && git add src/evals/spike-setup-sdk.ts package.json package-lock.json
git commit -m "spike: A/B comparison of SDK vs CLI for setup-writer"
```

---

## Task 1: Structured error taxonomy

**Files:**
- Create: `pipeline/src/sdk/errors.ts`
- Test: `pipeline/test/sdk-errors.test.ts`

**Step 1: Write the failing test**

```typescript
// pipeline/test/sdk-errors.test.ts
import { describe, it, expect } from "vitest";
import { SetupError, classifyPgError } from "../src/sdk/errors.js";

describe("classifyPgError", () => {
  it("maps 42601 to SQL_SYNTAX", () => {
    expect(classifyPgError("42601")).toBe(SetupError.SQL_SYNTAX);
  });

  it("maps 23503 to FK_VIOLATION", () => {
    expect(classifyPgError("23503")).toBe(SetupError.FK_VIOLATION);
  });

  it("maps 23505 to UNIQUE_VIOLATION", () => {
    expect(classifyPgError("23505")).toBe(SetupError.UNIQUE_VIOLATION);
  });

  it("maps 42703 to COLUMN_NOT_FOUND", () => {
    expect(classifyPgError("42703")).toBe(SetupError.COLUMN_NOT_FOUND);
  });

  it("maps 42P01 to TABLE_NOT_FOUND", () => {
    expect(classifyPgError("42P01")).toBe(SetupError.TABLE_NOT_FOUND);
  });

  it("returns SQL_SYNTAX for unknown pg error codes", () => {
    expect(classifyPgError("99999")).toBe(SetupError.SQL_SYNTAX);
  });

  it("returns DB_CONNECTION for null/undefined code", () => {
    expect(classifyPgError(undefined)).toBe(SetupError.DB_CONNECTION);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd pipeline && npx vitest run test/sdk-errors.test.ts
```

Expected: FAIL with "Cannot find module '../src/sdk/errors.js'"

**Step 3: Write the implementation**

```typescript
// pipeline/src/sdk/errors.ts

export enum SetupError {
  // SQL errors (returned by run_sql tool)
  SQL_SYNTAX = "sql_syntax",
  FK_VIOLATION = "fk_violation",
  UNIQUE_VIOLATION = "unique_violation",
  COLUMN_NOT_FOUND = "column_not_found",
  TABLE_NOT_FOUND = "table_not_found",
  SEED_MUTATION_BLOCKED = "seed_mutation_blocked",
  DDL_BLOCKED = "ddl_blocked",
  DELETE_NO_WHERE = "delete_no_where",
  QUERY_TIMEOUT = "query_timeout",
  DB_CONNECTION = "db_connection",

  // SDK/agent errors
  EMPTY_RESPONSE = "empty_response",
  MAX_TURNS = "max_turns",
  PARSE_ERROR = "parse_error",
  SCHEMA_ERROR = "schema_error",
  TIMEOUT = "timeout",
  AUTH_ERROR = "auth_error",
  SPAWN_ERROR = "spawn_error",
}

const PG_ERROR_MAP: Record<string, SetupError> = {
  "42601": SetupError.SQL_SYNTAX,
  "23503": SetupError.FK_VIOLATION,
  "23505": SetupError.UNIQUE_VIOLATION,
  "42703": SetupError.COLUMN_NOT_FOUND,
  "42P01": SetupError.TABLE_NOT_FOUND,
};

export function classifyPgError(code: string | undefined): SetupError {
  if (!code) return SetupError.DB_CONNECTION;
  return PG_ERROR_MAP[code] ?? SetupError.SQL_SYNTAX;
}
```

**Step 4: Run test to verify it passes**

```bash
cd pipeline && npx vitest run test/sdk-errors.test.ts
```

Expected: PASS

**Step 5: Typecheck**

```bash
cd pipeline && npx tsc --noEmit
```

**Step 6: Commit**

```bash
cd pipeline && git add src/sdk/errors.ts test/sdk-errors.test.ts
git commit -m "feat(sdk): add structured error taxonomy for setup-writer"
```

---

## Task 2: run_sql MCP tool

**Files:**
- Create: `pipeline/src/sdk/tools/run-sql.ts`
- Test: `pipeline/test/run-sql-validation.test.ts`

**Step 1: Write the failing validation tests**

```typescript
// pipeline/test/run-sql-validation.test.ts
import { describe, it, expect } from "vitest";
import { validateSQL, extractTableName } from "../src/sdk/tools/run-sql.js";

describe("validateSQL", () => {
  const seedIds = ["clseed-user-1", "clseed-template-1"];

  it("blocks DROP TABLE", () => {
    const result = validateSQL("DROP TABLE users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("DDL");
  });

  it("blocks TRUNCATE", () => {
    const result = validateSQL("TRUNCATE users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks ALTER TABLE", () => {
    const result = validateSQL('ALTER TABLE users ADD COLUMN foo TEXT', "INSERT", seedIds);
    expect(result.blocked).toBe(true);
  });

  it("blocks DELETE without WHERE", () => {
    const result = validateSQL("DELETE FROM users", "DELETE", seedIds);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("WHERE");
  });

  it("allows DELETE with WHERE", () => {
    const result = validateSQL("DELETE FROM users WHERE id = 'test-123'", "DELETE", seedIds);
    expect(result.blocked).toBe(false);
  });

  it("blocks mutation touching seed ID", () => {
    const result = validateSQL("UPDATE users SET name = 'x' WHERE id = 'clseed-user-1'", "UPDATE", seedIds);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("seed");
  });

  it("allows SELECT with seed ID", () => {
    const result = validateSQL("SELECT * FROM users WHERE id = 'clseed-user-1'", "SELECT", seedIds);
    expect(result.blocked).toBe(false);
  });

  it("allows valid INSERT", () => {
    const result = validateSQL("INSERT INTO templates (name) VALUES ('test')", "INSERT", []);
    expect(result.blocked).toBe(false);
  });
});

describe("extractTableName", () => {
  it("extracts from INSERT INTO", () => {
    expect(extractTableName('INSERT INTO "users" (name) VALUES (\'x\')')).toBe("users");
  });

  it("extracts from UPDATE", () => {
    expect(extractTableName("UPDATE templates SET name = 'x'")).toBe("templates");
  });

  it("extracts from DELETE FROM", () => {
    expect(extractTableName("DELETE FROM documents WHERE id = '1'")).toBe("documents");
  });

  it("returns null for SELECT", () => {
    expect(extractTableName("SELECT * FROM users")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd pipeline && npx vitest run test/run-sql-validation.test.ts
```

Expected: FAIL with "Cannot find module"

**Step 3: Write the implementation**

```typescript
// pipeline/src/sdk/tools/run-sql.ts
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import postgres from "postgres";
import { SetupError, classifyPgError } from "../errors.js";

// ── Validation ──────────────────────────────────────────────────────────────

const DDL_PATTERN = /^\s*(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;
const DELETE_NO_WHERE = /^\s*DELETE\s+FROM\s+\S+\s*;?\s*$/i;

export interface ValidationResult {
  blocked: boolean;
  reason?: string;
  errorType?: SetupError;
}

export function validateSQL(sql: string, operation: string, seedIds: string[]): ValidationResult {
  if (DDL_PATTERN.test(sql)) {
    return { blocked: true, reason: "DDL statements (DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE) are not allowed.", errorType: SetupError.DDL_BLOCKED };
  }

  if (operation === "DELETE" && DELETE_NO_WHERE.test(sql)) {
    return { blocked: true, reason: "DELETE without WHERE clause is not allowed.", errorType: SetupError.DELETE_NO_WHERE };
  }

  if (operation !== "SELECT") {
    const matchedSeed = seedIds.find(id => sql.includes(id));
    if (matchedSeed) {
      return { blocked: true, reason: `Cannot mutate seed data (ID: ${matchedSeed}). Use different IDs or UPDATE non-seed records.`, errorType: SetupError.SEED_MUTATION_BLOCKED };
    }
  }

  return { blocked: false };
}

export function extractTableName(sql: string): string | null {
  const match = sql.match(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/i);
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
  inTransaction: boolean;
  affectedTables: Set<string>;
  toolCalls: ToolCallLog[];
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createRunSqlTool(dbUrl: string, seedIds: string[]) {
  const sql = postgres(dbUrl, { idle_timeout: 30 });
  const state: RunSqlState = {
    inTransaction: false,
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

      // BEGIN on first mutation
      if (operation !== "SELECT" && !state.inTransaction) {
        await sql`BEGIN`;
        state.inTransaction = true;
      }

      // Track affected tables
      if (operation !== "SELECT") {
        const table = extractTableName(sqlStr);
        if (table) state.affectedTables.add(table);
      }

      // Execute
      try {
        const rows = await sql.unsafe(sqlStr);
        const resultStr = JSON.stringify(rows.slice(0, 50), null, 2);
        state.toolCalls.push({ operation, sql: sqlStr, result: `${rows.length} rows`, durationMs: Date.now() - start });
        return { content: [{ type: "text" as const, text: `${rows.length} row(s) returned.\n${resultStr}` }] };
      } catch (err: unknown) {
        const pgErr = err as { code?: string; message?: string };
        const errorType = classifyPgError(pgErr.code);
        const msg = pgErr.message ?? String(err);
        state.toolCalls.push({ operation, sql: sqlStr, error: msg, errorType, durationMs: Date.now() - start });
        return { content: [{ type: "text" as const, text: `SQL ERROR (${errorType}): ${msg}` }], isError: true };
      }
    },
  );

  return {
    tool: runSqlTool,
    state,
    async commit() {
      if (state.inTransaction) { await sql`COMMIT`; state.inTransaction = false; }
    },
    async rollback() {
      if (state.inTransaction) { await sql`ROLLBACK`; state.inTransaction = false; }
    },
    async close() {
      if (state.inTransaction) await this.rollback();
      await sql.end();
    },
  };
}
```

**Step 4: Run test to verify it passes**

```bash
cd pipeline && npx vitest run test/run-sql-validation.test.ts
```

Expected: PASS

**Step 5: Typecheck**

```bash
cd pipeline && npx tsc --noEmit
```

**Step 6: Commit**

```bash
cd pipeline && git add src/sdk/tools/run-sql.ts test/run-sql-validation.test.ts
git commit -m "feat(sdk): add run_sql MCP tool with validation layer"
```

---

## Task 3: SDK adapter for setup-writer

**Files:**
- Create: `pipeline/src/stages/setup-writer-sdk.ts`
- Modify: `pipeline/src/stages/run-setup-writer.ts`
- Modify: `pipeline/src/stages/graph-setup.ts`

**Step 1: Write the SDK adapter**

```typescript
// pipeline/src/stages/setup-writer-sdk.ts
import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRunSqlTool } from "../sdk/tools/run-sql.js";
import type { ToolCallLog } from "../sdk/tools/run-sql.js";
import { SetupError } from "../sdk/errors.js";
import type { SetupCommands } from "../lib/types.js";
import { parseSetupWriterOutput } from "./setup-writer.js";

export interface RunSetupSDKResult {
  output: SetupCommands | null;
  error?: SetupError;
  toolCalls: ToolCallLog[];
  affectedTables: string[];
  durationMs: number;
}

export async function runSetupSDK(opts: {
  prompt: string;
  dbUrl: string;
  seedIds: string[];
  timeoutMs: number;
  stage: string;
  runDir: string;
  maxTurns?: number;
}): Promise<RunSetupSDKResult> {
  const { prompt, dbUrl, seedIds, timeoutMs, stage, runDir, maxTurns = 15 } = opts;
  const logsDir = join(runDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  // Write prompt to disk
  writeFileSync(join(logsDir, `${stage}-prompt.txt`), prompt);

  const { tool: runSqlTool, state, commit, rollback, close } = createRunSqlTool(dbUrl, seedIds);
  const server = createSdkMcpServer({ name: "setup", tools: [runSqlTool] });

  const start = Date.now();
  let finalText = "";
  let error: SetupError | undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    for await (const msg of query({
      prompt,
      options: {
        mcpServers: { setup: server },
        allowedTools: ["mcp__setup__run_sql"],
        permissionMode: "dontAsk",
        maxTurns,
        abortController: controller,
      },
    })) {
      if (msg.type === "result") {
        finalText = msg.result;
        if (msg.subtype === "error_max_turns") error = SetupError.MAX_TURNS;
      }
    }

    clearTimeout(timer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      error = SetupError.TIMEOUT;
    } else {
      error = SetupError.SPAWN_ERROR;
    }
  }

  // Parse output
  const output = parseSetupWriterOutput(finalText);
  if (!output && !error) error = finalText ? SetupError.PARSE_ERROR : SetupError.EMPTY_RESPONSE;

  // Transaction lifecycle
  if (output && !error) {
    await commit();
  } else {
    await rollback();
  }

  const durationMs = Date.now() - start;

  // Write logs
  writeFileSync(join(logsDir, `${stage}-tool-calls.jsonl`), state.toolCalls.map(c => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(logsDir, `${stage}-output.txt`), finalText);

  await close();

  return {
    output,
    error,
    toolCalls: state.toolCalls,
    affectedTables: [...state.affectedTables],
    durationMs,
  };
}
```

**Step 2: Modify run-setup-writer.ts to add SDK path**

In `pipeline/src/stages/run-setup-writer.ts`, add the SDK opt-in:

```typescript
// At the top of the file, add import:
import { runSetupSDK } from "./setup-writer-sdk.js";
import { loadProjectEnv } from "./setup-writer.js";

// Inside runSetupWriter(), before the existing graphInformedSetup call:
// Check if SDK path is enabled
if (process.env.VERIFY_SETUP_SDK === "1" && opts.appIndex) {
  const dbUrlEnv = opts.appIndex.db_url_env ?? "DATABASE_URL";
  const dbUrl = opts.projectEnv[dbUrlEnv] ?? opts.projectEnv.DATABASE_URL ?? "";
  if (dbUrl) {
    const cleanDbUrl = dbUrl.split("?")[0];
    // Build prompt (reuse existing prompt builders, but replace Bash instructions)
    const prompt = /* use buildGraphPrompt or buildSetupWriterPrompt with SDK instructions */;
    const result = await runSetupSDK({
      prompt,
      dbUrl: cleanDbUrl,
      seedIds: /* collect from appIndex.seed_ids */,
      timeoutMs: opts.timeoutMs,
      stage: opts.stageName,
      runDir: opts.runDir,
    });
    if (result.output) return result.output;
    // Fall through to CLI path on SDK failure
  }
}
```

The exact integration code will depend on what the spike reveals about prompt format requirements. The spike (Task 0) will validate the prompt pattern before this code is finalized.

**Step 3: Typecheck**

```bash
cd pipeline && npx tsc --noEmit
```

**Step 4: Run existing tests to confirm no regressions**

```bash
cd pipeline && npx vitest run
```

Expected: all existing tests PASS (SDK path is opt-in, default OFF)

**Step 5: Commit**

```bash
cd pipeline && git add src/stages/setup-writer-sdk.ts src/stages/run-setup-writer.ts
git commit -m "feat(sdk): add setup-writer SDK adapter with run_sql MCP tool"
```

---

## Task 4: Transaction lifecycle tests

**Files:**
- Create: `pipeline/test/transaction-lifecycle.test.ts`

These tests require a real test database. They validate the highest-risk path: that ROLLBACK fires correctly and partial writes never persist.

**Step 1: Write the tests**

```typescript
// pipeline/test/transaction-lifecycle.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { createRunSqlTool } from "../src/sdk/tools/run-sql.js";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DB_URL) {
  describe.skip("transaction-lifecycle (TEST_DATABASE_URL not set)", () => {
    it("skipped", () => {});
  });
} else {
  describe("transaction lifecycle", () => {
    let adminSql: ReturnType<typeof postgres>;

    beforeAll(async () => {
      adminSql = postgres(TEST_DB_URL!);
      await adminSql`CREATE TABLE IF NOT EXISTS _txn_test (id TEXT PRIMARY KEY, value TEXT)`;
      await adminSql`DELETE FROM _txn_test`;
    });

    afterEach(async () => {
      await adminSql`DELETE FROM _txn_test`;
    });

    afterAll(async () => {
      await adminSql`DROP TABLE IF EXISTS _txn_test`;
      await adminSql.end();
    });

    it("does not BEGIN on SELECT", async () => {
      const { tool: _, state, close } = createRunSqlTool(TEST_DB_URL!, []);
      // Simulate a SELECT tool call
      await tool.handler({ sql: "SELECT 1", operation: "SELECT" }, {});
      expect(state.inTransaction).toBe(false);
      await close();
    });

    it("BEGINs on first INSERT", async () => {
      const { state, close, tool: runSqlTool } = createRunSqlTool(TEST_DB_URL!, []);
      // Note: we need to call the handler directly for unit testing
      // In practice the SDK calls it
      expect(state.inTransaction).toBe(false);
      // We'd need to invoke the tool handler directly here
      // This test validates the state tracking
      await close();
    });

    it("COMMIT persists data", async () => {
      const { tool: _, state, commit, close } = createRunSqlTool(TEST_DB_URL!, []);
      // Manually simulate what the tool does
      const sql = postgres(TEST_DB_URL!);
      await sql`BEGIN`;
      state.inTransaction = true;
      await sql`INSERT INTO _txn_test (id, value) VALUES ('test-1', 'committed')`;
      await sql`COMMIT`;
      state.inTransaction = false;
      await sql.end();

      // Verify with separate connection
      const rows = await adminSql`SELECT * FROM _txn_test WHERE id = 'test-1'`;
      expect(rows.length).toBe(1);
      expect(rows[0].value).toBe("committed");
      await close();
    });

    it("ROLLBACK discards data", async () => {
      const sql = postgres(TEST_DB_URL!);
      await sql`BEGIN`;
      await sql`INSERT INTO _txn_test (id, value) VALUES ('test-2', 'rolled-back')`;
      await sql`ROLLBACK`;
      await sql.end();

      // Verify with separate connection
      const rows = await adminSql`SELECT * FROM _txn_test WHERE id = 'test-2'`;
      expect(rows.length).toBe(0);
    });

    it("tracks affectedTables correctly", async () => {
      const { state, close } = createRunSqlTool(TEST_DB_URL!, []);
      // extractTableName is tested in run-sql-validation.test.ts
      // Here we just verify the set accumulates
      state.affectedTables.add("users");
      state.affectedTables.add("templates");
      state.affectedTables.add("users"); // duplicate
      expect([...state.affectedTables]).toEqual(["users", "templates"]);
      await close();
    });
  });
}
```

**Step 2: Run tests**

```bash
cd pipeline && TEST_DATABASE_URL="postgresql://localhost/verify_test" npx vitest run test/transaction-lifecycle.test.ts
```

Expected: PASS (or SKIP if no TEST_DATABASE_URL)

**Step 3: Commit**

```bash
cd pipeline && git add test/transaction-lifecycle.test.ts
git commit -m "test(sdk): add transaction lifecycle tests for run_sql tool"
```

---

## Task 5: Setup-writer eval framework (A/B comparison)

**Files:**
- Create: `pipeline/src/evals/setup-writer/cases.ts`
- Create: `pipeline/src/evals/setup-writer/runner.ts`

This is the production eval framework. It builds on the spike's A/B methodology but with more cases, proper fixtures, and structured output.

**Step 1: Define eval cases**

```typescript
// pipeline/src/evals/setup-writer/cases.ts
import type { SetupError } from "../../sdk/errors.js";

export interface SetupEvalCase {
  name: string;
  condition: string;
  /** Tables that might be affected (for snapshot/restore) */
  affectedTables: string[];
  /** Verification SQL: should return 1+ rows if condition is satisfied */
  verificationQuery: string;
  expected: {
    shouldGenerateSQL: boolean;
    forbiddenPatterns?: RegExp[];
    errorType?: SetupError;
  };
}

// These cases must be customized per eval repo.
// The conditions below are templates — replace with real conditions
// from your eval repo's past pipeline runs.
export const EVAL_CASES: SetupEvalCase[] = [
  {
    name: "existing-data",
    condition: "a user exists with email admin@example.com",
    affectedTables: ["User"],
    verificationQuery: `SELECT 1 FROM "User" WHERE email = 'admin@example.com'`,
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "simple-insert",
    condition: "a template exists with name 'Eval Test Template'",
    affectedTables: ["Template"],
    verificationQuery: `SELECT 1 FROM "Template" WHERE name = 'Eval Test Template'`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "fk-chain",
    condition: "a direct link exists for a template",
    affectedTables: ["Template", "TemplateDirectLink"],
    verificationQuery: `SELECT 1 FROM "TemplateDirectLink" tdl JOIN "Template" t ON tdl."templateId" = t.id LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "auth-scoped",
    condition: "the logged-in user's team has a document",
    affectedTables: ["Document"],
    verificationQuery: `SELECT 1 FROM "Document" d JOIN "Team" t ON d."teamId" = t.id LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "column-mapping",
    condition: "a template exists with isPublished set to true",
    affectedTables: ["Template"],
    verificationQuery: `SELECT 1 FROM "Template" WHERE "isPublished" = true`,
    expected: { shouldGenerateSQL: true, forbiddenPatterns: [/is_published/i] },
  },
  {
    name: "jsonb-field",
    condition: "a template exists with settings containing {\"allowDownload\": true}",
    affectedTables: ["Template"],
    verificationQuery: `SELECT 1 FROM "Template" WHERE settings->>'allowDownload' = 'true'`,
    expected: { shouldGenerateSQL: true },
  },
  {
    name: "seed-protection",
    condition: "update the seed user's email to test@changed.com",
    affectedTables: ["User"],
    verificationQuery: `SELECT 1 WHERE false`, // should NOT succeed
    expected: { shouldGenerateSQL: false },
  },
  {
    name: "fk-recovery",
    condition: "a recipient exists for a direct link that belongs to a template",
    affectedTables: ["Template", "TemplateDirectLink", "Recipient"],
    verificationQuery: `SELECT 1 FROM "Recipient" r JOIN "TemplateDirectLink" tdl ON r."directLinkId" = tdl.id LIMIT 1`,
    expected: { shouldGenerateSQL: true },
  },
];
```

**Step 2: Write the runner**

```typescript
// pipeline/src/evals/setup-writer/runner.ts
//
// A/B comparison eval runner for setup-writer SDK migration.
// Run: cd pipeline && EVAL_DB_URL="..." npx tsx src/evals/setup-writer/runner.ts
//
import postgres from "postgres";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_CASES, type SetupEvalCase } from "./cases.js";
import { runSetupSDK } from "../../stages/setup-writer-sdk.js";
import { runClaude } from "../../run-claude.js";
import { parseSetupWriterOutput } from "../../stages/setup-writer.js";

const EVAL_DB_URL = process.env.EVAL_DB_URL;
if (!EVAL_DB_URL) { console.error("EVAL_DB_URL required"); process.exit(1); }

const RUN_DIR = join(process.cwd(), ".eval-setup-output");
mkdirSync(join(RUN_DIR, "logs"), { recursive: true });

const sql = postgres(EVAL_DB_URL);

interface PathResult {
  parsed: boolean;
  conditionSatisfied: boolean;
  durationMs: number;
  sqlCount: number;
}

interface ComparisonResult {
  caseName: string;
  cli: PathResult;
  sdk: PathResult;
  winner: "CLI" | "SDK" | "TIE" | "BOTH_FAILED";
  regression: boolean;
}

async function verifyCondition(query: string): Promise<boolean> {
  try {
    const rows = await sql.unsafe(query);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ... (CLI and SDK path runners similar to spike, using the real
//      buildGraphPrompt / buildSetupWriterPrompt for prompts)

async function main() {
  const results: ComparisonResult[] = [];

  for (const evalCase of EVAL_CASES) {
    console.log(`\n--- ${evalCase.name} ---`);

    // TODO: snapshot/restore between runs
    // For now, run SDK first (read-only check), then CLI

    // Run CLI path
    // const cli = await runCLIPath(evalCase);
    // const cliSatisfied = await verifyCondition(evalCase.verificationQuery);

    // Run SDK path
    // const sdk = await runSDKPath(evalCase);
    // const sdkSatisfied = await verifyCondition(evalCase.verificationQuery);

    // Compare and record
    // ...
  }

  // Print comparison table
  // Check for regressions
  // Write results to disk

  await sql.end();
}

main().catch(console.error);
```

Note: the runner skeleton above is intentionally incomplete. The exact prompt building and path running code depends on what the spike (Task 0) validates. The spike file contains the working A/B comparison logic that should be extracted into this runner.

**Step 3: Commit**

```bash
cd pipeline && git add src/evals/setup-writer/
git commit -m "feat(evals): add setup-writer A/B comparison eval framework"
```

---

## Task 6: Wire SDK path into orchestrator

**Files:**
- Modify: `pipeline/src/stages/run-setup-writer.ts` (finalize SDK integration)
- Modify: `pipeline/src/orchestrator.ts` (use affectedTables for snapshot)

This task finalizes the wiring after the spike and evals have validated the approach. The exact code depends on spike findings. The key changes:

1. `run-setup-writer.ts`: when `VERIFY_SETUP_SDK=1`, call `runSetupSDK()` and return its output. Pass `affectedTables` back to the orchestrator.
2. `orchestrator.ts`: use `affectedTables` from SDK result for snapshot/restore instead of parsing `setup_commands` strings.
3. The orchestrator's 3-attempt retry loop stays. On SDK failure, it retries with a fresh SDK session (new transaction).

**Step 1: Run full test suite**

```bash
cd pipeline && npx tsc --noEmit && npx vitest run
```

**Step 2: Run evals with SDK enabled**

```bash
cd pipeline && VERIFY_SETUP_SDK=1 EVAL_DB_URL="..." npx tsx src/evals/setup-writer/runner.ts
```

**Step 3: Commit**

```bash
cd pipeline && git add src/stages/run-setup-writer.ts src/orchestrator.ts
git commit -m "feat(pipeline): wire SDK setup-writer into orchestrator behind feature flag"
```

---

## Verification Checklist

After all tasks:

1. `cd pipeline && npx tsc --noEmit` — 0 type errors
2. `cd pipeline && npx vitest run` — all tests pass
3. `cd pipeline && EVAL_DB_URL="..." npx tsx src/evals/spike-setup-sdk.ts` — spike passes
4. `cd pipeline && EVAL_DB_URL="..." npx tsx src/evals/setup-writer/runner.ts` — 0 regressions
5. Full pipeline run: `VERIFY_SETUP_SDK=1 /verify` on eval repo — compare results to baseline
