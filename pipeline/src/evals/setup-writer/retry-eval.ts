// pipeline/src/evals/setup-writer/retry-eval.ts
//
// Retry-focused eval: tests whether SDK's structured error feedback
// helps the LLM self-correct better than CLI's raw shell errors.
//
// Run: cd pipeline && EVAL_DB_URL="..." npx tsx src/evals/setup-writer/retry-eval.ts
//
// Only runs mutation cases (expected.shouldGenerateSQL === true).
// Each case gets up to 3 attempts. Between attempts:
// - CLI: re-runs with shell error output as retry context
// - SDK: re-runs with structured tool call errors as retry context
// After each attempt, a verification query checks if the condition is satisfied.

import postgres from "postgres";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_CASES, type SetupEvalCase } from "./cases.js";
import { CALCOM_EVAL_CASES } from "./cases-calcom.js";
import { runSetupSDK, type RunSetupSDKResult } from "../../stages/setup-writer-sdk.js";
import { runClaude } from "../../run-claude.js";
import { parseSetupWriterOutput } from "../../stages/setup-writer.js";
import type { ToolCallLog } from "../../sdk/tools/run-sql.js";

const EVAL_DB_URL = process.env.EVAL_DB_URL;
if (!EVAL_DB_URL) { console.error("EVAL_DB_URL required"); process.exit(1); }

// Select case set: EVAL_CASES_SET=calcom for calcom, default for documenso
const CASE_SET = process.env.EVAL_CASES_SET === "calcom" ? CALCOM_EVAL_CASES : EVAL_CASES;
const CASE_SET_NAME = process.env.EVAL_CASES_SET === "calcom" ? "calcom" : "documenso";

const MAX_ATTEMPTS = 3;
const RUN_DIR = join(process.cwd(), ".eval-retry-output");
mkdirSync(join(RUN_DIR, "logs"), { recursive: true });

const sql = postgres(EVAL_DB_URL);

// ── Helpers ─────────────────────────────────────────────────────────────────

async function verifyCondition(query: string): Promise<boolean> {
  try {
    const rows = await sql.unsafe(query);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Snapshot a set of tables so we can restore between attempts. */
async function snapshotTables(tables: string[]): Promise<Map<string, unknown[]>> {
  const snapshots = new Map<string, unknown[]>();
  for (const table of tables) {
    try {
      const rows = await sql.unsafe(`SELECT * FROM "${table}"`);
      snapshots.set(table, rows as unknown[]);
    } catch {
      // Table might not exist
    }
  }
  return snapshots;
}

/** Restore tables from snapshot — delete current data, re-insert snapshot rows. */
async function restoreSnapshot(snapshots: Map<string, unknown[]>): Promise<void> {
  for (const [table, rows] of snapshots) {
    await sql.unsafe(`DELETE FROM "${table}" WHERE true`).catch(() => {});
    if (rows.length > 0) {
      // Re-insert via temp table approach to avoid column ordering issues
      for (const row of rows) {
        const obj = row as Record<string, unknown>;
        const cols = Object.keys(obj).map(c => `"${c}"`).join(", ");
        const vals = Object.keys(obj).map((_, i) => `$${i + 1}`).join(", ");
        await sql.unsafe(`INSERT INTO "${table}" (${cols}) VALUES (${vals})`, Object.values(obj) as never[]).catch(() => {});
      }
    }
  }
}

// ── CLI retry path ──────────────────────────────────────────────────────────

function buildCLIPrompt(condition: string, retryContext?: { commands: string[]; error: string }): string {
  const base = `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

CONDITION: ${condition}

DATABASE ACCESS:
Use Bash to run psql commands.
Connection: psql "${EVAL_DB_URL}" -c "SELECT ..."

PROCESS:
1. Run 1-2 SELECT queries to check if the CONDITION is ALREADY SATISFIED by existing data
2. If existing data satisfies the condition: output empty setup_commands
3. If NOT satisfied: write minimal SQL (1-5 commands) using existing record IDs
4. Output ONLY the JSON below

OUTPUT: Valid JSON to stdout:
{
  "group_id": "eval",
  "condition": "${condition}",
  "setup_commands": [],
  "teardown_commands": []
}

Output ONLY the JSON. No explanation, no markdown fences.`;

  if (!retryContext) return base;

  const failedBlock = retryContext.commands.map((c, i) => `  Command ${i + 1}: ${c}`).join("\n");
  return base + `

YOUR PREVIOUS ATTEMPT FAILED. Fix the error and try again.

Failed commands:
${failedBlock}

Error: ${retryContext.error}

Analyze the error, fix the SQL, and output corrected JSON.`;
}

interface AttemptResult {
  parsed: boolean;
  satisfied: boolean;
  durationMs: number;
  commands: string[];
  error?: string;
}

async function runCLIAttempt(
  evalCase: SetupEvalCase,
  attempt: number,
  retryContext?: { commands: string[]; error: string },
): Promise<AttemptResult> {
  const prompt = buildCLIPrompt(evalCase.condition, retryContext);
  const start = Date.now();
  const result = await runClaude({
    prompt,
    model: "sonnet",
    timeoutMs: 120_000,
    stage: `retry-cli-${evalCase.name}-a${attempt}`,
    runDir: RUN_DIR,
    allowedTools: ["Bash"],
  });
  const durationMs = Date.now() - start;
  const output = parseSetupWriterOutput(result.stdout);

  if (!output) return { parsed: false, satisfied: false, durationMs, commands: [] };

  // Execute the setup commands
  let execError: string | undefined;
  for (const cmd of output.setup_commands) {
    try {
      execSync(cmd, { timeout: 30_000, stdio: "pipe", env: { ...process.env, PGPASSWORD: "password" } });
    } catch (err: unknown) {
      execError = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  const satisfied = await verifyCondition(evalCase.verificationQuery);
  return { parsed: true, satisfied, durationMs, commands: output.setup_commands, error: execError };
}

// ── SDK retry path ──────────────────────────────────────────────────────────

function buildSDKPrompt(condition: string, retryContext?: { toolCalls: ToolCallLog[]; error?: string }): string {
  const base = `You are a database setup agent. Your job is to EXECUTE SQL to put the database into the required state.

CONDITION: ${condition}

You have one tool: run_sql. Use it for ALL database operations.

STEP 1 — CHECK: Call run_sql(operation="SELECT", sql="...") to see if the condition is already met.
STEP 2 — MUTATE: If not met, call run_sql(operation="INSERT", sql="...") or UPDATE/DELETE to fix it.
  - If an INSERT fails, read the error, fix the SQL, try again.
STEP 3 — VERIFY: Call run_sql(operation="SELECT", sql="...") to confirm the condition is now satisfied.
STEP 4 — OUTPUT: Print this JSON (and nothing else):
{"group_id":"eval","condition":"${condition}","satisfied":true}

If the condition was already satisfied in step 1, skip to step 4.
If you could not satisfy the condition after trying, output: {"group_id":"eval","condition":"${condition}","satisfied":false}

RULES:
- ALL database changes MUST go through run_sql tool calls. Do NOT output SQL strings without executing them.
- Use Postgres column names (quoted, e.g. "teamId").
- Use gen_random_uuid() for IDs.
- NEVER create new User, Team, or Organisation records — use existing ones.
- Output ONLY the JSON. No explanation.`;

  if (!retryContext) return base;

  // Build structured error feedback from tool call log
  const errorCalls = retryContext.toolCalls.filter(c => c.error);
  const errorBlock = errorCalls.map(c =>
    `  ${c.operation} "${c.sql.slice(0, 120)}${c.sql.length > 120 ? "..." : ""}"\n    → ERROR (${c.errorType ?? "unknown"}): ${c.error}`
  ).join("\n\n");

  const successCalls = retryContext.toolCalls.filter(c => !c.error);
  const successBlock = successCalls.map(c =>
    `  ${c.operation}: ${c.result ?? "ok"} (${c.durationMs}ms)`
  ).join("\n");

  return base + `

YOUR PREVIOUS ATTEMPT FAILED. Here is what happened:

Successful queries:
${successBlock || "  (none)"}

Failed queries:
${errorBlock || "  (none)"}
${retryContext.error ? `\nOverall error: ${retryContext.error}` : ""}

Analyze the structured errors above. Common issues:
- fk_violation → missing parent record, INSERT the parent first
- column_not_found → wrong column name, check schema with SELECT from information_schema
- unique_violation → record already exists, use a different ID or UPDATE instead
- table_not_found → wrong table name, check available tables

Fix the SQL and try again.`;
}

async function runSDKAttempt(
  evalCase: SetupEvalCase,
  attempt: number,
  retryContext?: { toolCalls: ToolCallLog[]; error?: string },
): Promise<AttemptResult & { toolCalls: ToolCallLog[] }> {
  const prompt = buildSDKPrompt(evalCase.condition, retryContext);
  const start = Date.now();
  try {
    const result = await runSetupSDK({
      prompt,
      dbUrl: EVAL_DB_URL!.split("?")[0],
      seedIds: [],
      timeoutMs: 180_000,
      stage: `retry-sdk-${evalCase.name}-a${attempt}`,
      runDir: RUN_DIR,
      maxTurns: 30,
    });
    const durationMs = Date.now() - start;
    const satisfied = await verifyCondition(evalCase.verificationQuery);

    return {
      parsed: !!result.output,
      satisfied,
      durationMs,
      commands: result.output?.setup_commands ?? [],
      error: result.errorDetail ?? result.error,
      toolCalls: result.toolCalls,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      parsed: false,
      satisfied: false,
      durationMs,
      commands: [],
      error: msg,
      toolCalls: [],
    };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

interface CaseResult {
  name: string;
  condition: string;
  cli: { attempts: AttemptResult[]; finalSatisfied: boolean; totalMs: number };
  sdk: { attempts: (AttemptResult & { toolCalls: ToolCallLog[] })[]; finalSatisfied: boolean; totalMs: number };
}

async function main() {
  console.log(`Setup-Writer SDK Retry Eval (${CASE_SET_NAME})`);
  console.log("=".repeat(45));
  console.log(`Max attempts: ${MAX_ATTEMPTS}\n`);

  // Only mutation cases
  const mutationCases = CASE_SET.filter(c => c.expected.shouldGenerateSQL);
  console.log(`Running ${mutationCases.length} mutation cases from ${CASE_SET_NAME}\n`);

  const results: CaseResult[] = [];

  for (const evalCase of mutationCases) {
    console.log(`\n━━━ ${evalCase.name} ━━━`);
    console.log(`"${evalCase.condition}"\n`);

    // Snapshot affected tables before each path
    const snapshot = await snapshotTables(evalCase.affectedTables);

    // ── CLI path with retries ──
    console.log("  CLI path:");
    const cliAttempts: AttemptResult[] = [];
    let cliRetryCtx: { commands: string[]; error: string } | undefined;

    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      // Restore snapshot before each retry
      if (a > 1) await restoreSnapshot(snapshot);

      const result = await runCLIAttempt(evalCase, a, cliRetryCtx);
      cliAttempts.push(result);
      console.log(`    attempt ${a}: parsed=${result.parsed} satisfied=${result.satisfied} ${result.durationMs}ms${result.error ? ` err="${result.error.slice(0, 80)}"` : ""}`);

      if (result.satisfied) break;
      if (result.commands.length > 0 && result.error) {
        cliRetryCtx = { commands: result.commands, error: result.error };
      } else if (!result.parsed) {
        cliRetryCtx = { commands: [], error: "Failed to parse output — produce valid JSON" };
      } else {
        // Parsed OK, commands may have run, but condition not satisfied
        // Check verification to give a more useful error
        cliRetryCtx = { commands: result.commands, error: "Commands executed but condition is still not satisfied. Check the verification query." };
      }
    }

    // Restore for SDK path
    await restoreSnapshot(snapshot);

    // ── SDK path with retries ──
    console.log("  SDK path:");
    const sdkAttempts: (AttemptResult & { toolCalls: ToolCallLog[] })[] = [];
    let sdkRetryCtx: { toolCalls: ToolCallLog[]; error?: string } | undefined;

    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      if (a > 1) await restoreSnapshot(snapshot);

      const result = await runSDKAttempt(evalCase, a, sdkRetryCtx);
      sdkAttempts.push(result);
      const selects = result.toolCalls.filter(c => c.operation === "SELECT" && !c.error).length;
      const mutations = result.toolCalls.filter(c => c.operation !== "SELECT" && !c.error).length;
      const errors = result.toolCalls.filter(c => c.error).length;
      console.log(`    attempt ${a}: parsed=${result.parsed} satisfied=${result.satisfied} ${result.durationMs}ms selects=${selects} mutations=${mutations} errors=${errors}${result.error ? ` err="${result.error}"` : ""}`);

      if (result.satisfied) break;
      sdkRetryCtx = { toolCalls: result.toolCalls, error: result.error };
    }

    // Restore after case
    await restoreSnapshot(snapshot);

    // Cooldown between cases to avoid rate limiting
    console.log("  (5s cooldown)");
    await new Promise(r => setTimeout(r, 5000));

    const cliTotal = cliAttempts.reduce((sum, a) => sum + a.durationMs, 0);
    const sdkTotal = sdkAttempts.reduce((sum, a) => sum + a.durationMs, 0);

    results.push({
      name: evalCase.name,
      condition: evalCase.condition,
      cli: { attempts: cliAttempts, finalSatisfied: cliAttempts[cliAttempts.length - 1].satisfied, totalMs: cliTotal },
      sdk: { attempts: sdkAttempts, finalSatisfied: sdkAttempts[sdkAttempts.length - 1].satisfied, totalMs: sdkTotal },
    });
  }

  // ── Summary ──
  console.log("\n\n===========================");
  console.log("RETRY EVAL RESULTS");
  console.log("===========================\n");

  let cliSatisfied = 0, sdkSatisfied = 0;
  let cliFirstAttempt = 0, sdkFirstAttempt = 0;

  for (const r of results) {
    const cliStatus = r.cli.finalSatisfied ? "SATISFIED" : "UNSATISFIED";
    const sdkStatus = r.sdk.finalSatisfied ? "SATISFIED" : "UNSATISFIED";
    const cliAtt = r.cli.attempts.length;
    const sdkAtt = r.sdk.attempts.length;

    if (r.cli.finalSatisfied) cliSatisfied++;
    if (r.sdk.finalSatisfied) sdkSatisfied++;
    if (r.cli.attempts[0].satisfied) cliFirstAttempt++;
    if (r.sdk.attempts[0].satisfied) sdkFirstAttempt++;

    const winner = r.cli.finalSatisfied === r.sdk.finalSatisfied
      ? "TIE"
      : r.sdk.finalSatisfied ? "SDK" : "CLI";

    console.log(`${r.name}: ${winner}`);
    console.log(`  CLI: ${cliStatus} in ${cliAtt} attempt(s) (${r.cli.totalMs}ms total)`);
    console.log(`  SDK: ${sdkStatus} in ${sdkAtt} attempt(s) (${r.sdk.totalMs}ms total)\n`);
  }

  console.log("─── Scorecard ───");
  console.log(`Cases satisfied:   CLI ${cliSatisfied}/${results.length}  |  SDK ${sdkSatisfied}/${results.length}`);
  console.log(`First-attempt win: CLI ${cliFirstAttempt}/${results.length}  |  SDK ${sdkFirstAttempt}/${results.length}`);

  const cliTotalMs = results.reduce((s, r) => s + r.cli.totalMs, 0);
  const sdkTotalMs = results.reduce((s, r) => s + r.sdk.totalMs, 0);
  console.log(`Total time:        CLI ${(cliTotalMs / 1000).toFixed(1)}s  |  SDK ${(sdkTotalMs / 1000).toFixed(1)}s`);

  if (sdkSatisfied > cliSatisfied) {
    console.log("\n*** SDK WINS — better self-correction via structured errors ***");
  } else if (sdkSatisfied === cliSatisfied) {
    console.log("\n*** TIE — same satisfaction rate ***");
  } else {
    console.log("\n*** CLI WINS — SDK retry did not help ***");
  }

  writeFileSync(join(RUN_DIR, "retry-results.json"), JSON.stringify(results, null, 2));
  await sql.end();
}

main().catch(console.error);
