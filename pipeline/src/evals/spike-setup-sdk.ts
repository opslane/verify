// pipeline/src/evals/spike-setup-sdk.ts
//
// Spike: validate SDK + MCP tool works for setup-writer by running
// the same conditions through CLI and SDK paths, comparing results.
//
// Run: cd pipeline && EVAL_DB_URL="postgresql://..." npx tsx src/evals/spike-setup-sdk.ts
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

// 5 representative conditions — adapted to documenso schema
const CONDITIONS = [
  "a user exists with email test1@test.documenso.com",
  "a team exists that has at least one member",
  "a TemplateDirectLink exists that is enabled",
  "a DocumentData record exists with type 'BYTES_64'",
  "an Organisation exists with at least one OrganisationMember",
];

// ── run_sql MCP tool (inline for spike, extracted to module in Task 2) ─────

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

async function runCLIPath(condition: string, idx: number): Promise<{ parsed: boolean; durationMs: number }> {
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
  return { parsed: !!output, durationMs };
}

// ── Run SDK path ────────────────────────────────────────────────────────────

async function runSDKPath(condition: string, idx: number): Promise<{
  parsed: boolean;
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
      if ("result" in msg) {
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
      durationMs: Date.now() - start,
      toolCalls: state.toolCalls,
      affectedTables: [...state.affectedTables],
    };
  } catch (err: unknown) {
    await rollback();
    return {
      parsed: false,
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
