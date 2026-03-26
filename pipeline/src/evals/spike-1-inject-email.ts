#!/usr/bin/env npx tsx
/**
 * Spike 1: Inject auth email into setup-writer prompt to fix user scoping.
 *
 * Problem: The setup-writer generates unscoped SQL (e.g. SELECT FROM Envelope LIMIT 5)
 * which returns rows from any user/team. The test user (ac1-test@test.documenso.com)
 * is in team 7 with user ID 9, but the LLM doesn't know that.
 *
 * Approach: Add an AUTH CONTEXT section to the prompt with the user's email,
 * so the LLM can self-scope by querying User → Team → FK chains.
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-1-inject-email.ts
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";
const VERIFY_DIR = join(PROJECT_DIR, ".verify");
const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const PSQL_CMD = `psql "${DB_URL}"`;
const AUTH_EMAIL = "ac1-test@test.documenso.com";
const EXPECTED_TEAM_ID = 7;
const EXPECTED_USER_ID = 9;

const pipelineDir = resolve(import.meta.dirname ?? ".", "../..");
const runDir = join(VERIFY_DIR, "runs", `spike-1-${Date.now()}`);
mkdirSync(join(runDir, "logs"), { recursive: true });

// ── Load schema from app.json ───────────────────────────────────────────────────

function loadSchema(): string {
  const appJson = JSON.parse(readFileSync(join(VERIFY_DIR, "app.json"), "utf-8"));
  const lines: string[] = [];
  for (const [model, info] of Object.entries(appJson.data_model) as Array<[string, Record<string, unknown>]>) {
    const modelInfo = info as { table_name: string; columns: Record<string, string>; manual_id_columns: string[] };
    const cols = Object.entries(modelInfo.columns).map(([prisma, pg]) => prisma === pg ? pg : `${prisma}->${pg}`);
    const manualIds = modelInfo.manual_id_columns.length > 0 ? ` [manual IDs: ${modelInfo.manual_id_columns.join(", ")}]` : "";
    lines.push(`${model} ("${modelInfo.table_name}"): ${cols.join(", ")}${manualIds}`);
  }
  return lines.join("\n");
}

// ── Build modified prompt with AUTH CONTEXT ─────────────────────────────────────

function buildPromptWithAuth(groupId: string, condition: string): string {
  const schemaLines = loadSchema();

  // Load learnings if present
  const learningsPath = join(VERIFY_DIR, "learnings.md");
  const learnings = existsSync(learningsPath) ? readFileSync(learningsPath, "utf-8").trim() : "";
  const learningsBlock = learnings
    ? `\nLEARNINGS FROM PAST RUNS (apply these corrections):\n${learnings}\n`
    : "";

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${condition}

AUTH CONTEXT:
The logged-in user's email is: ${AUTH_EMAIL}
When the CONDITION refers to "the logged-in user" or "their personal team",
first query the User table to find this user's ID, then find their team(s)
via the appropriate FK chain, and scope all subsequent queries to that team.
Do NOT use unscoped queries — always filter by the correct user/team ID.

DATABASE ACCESS:
Use Bash to run psql commands to query the database and understand current state.
Connection: ${PSQL_CMD} -c "SELECT ..."

SCHEMA (model -> table, columns):
${schemaLines}
${learningsBlock}
PROCESS:
1. Run 2-3 psql SELECT queries to understand current data relevant to the CONDITION
2. Write the minimal SQL (1-5 commands) to achieve the condition
3. Output ONLY the JSON below — nothing else

IMPORTANT: You have a strict time limit. Do NOT explore extensively.
Run at most 3-4 SELECT queries, then output the JSON immediately.
Do NOT read files, grep, or explore the codebase.

COLUMN NAMES: Schema shows "prismaName->pgName" for mapped columns. Always use the Postgres name in SQL.

MANUAL ID COLUMNS: If a model shows [manual IDs: ...], provide an explicit value for those columns in INSERTs (e.g., gen_random_uuid() or 'verify-test-${groupId}-001').

OUTPUT: Valid JSON to stdout:

{
  "group_id": "${groupId}",
  "condition": "${condition}",
  "setup_commands": [
    "${PSQL_CMD} --set ON_ERROR_STOP=1 -c \\"UPDATE ...\\""
  ],
  "teardown_commands": []
}

RULES:
1. Use \`${PSQL_CMD} --set ON_ERROR_STOP=1 -c "..."\` for setup commands.
2. Prefer UPDATE on existing rows. Use INSERT only when new rows are needed.
3. Use Postgres column names (not Prisma field names) in all SQL.
4. Minimal changes — only what's needed for the condition.
5. teardown_commands must be empty — orchestrator handles DB restoration.
6. Keep it to 1-5 commands max.
7. Do NOT read files or explore the codebase. Only use psql.
8. If the condition is null or empty, output empty arrays.

Output ONLY the JSON. No explanation, no markdown fences.`;
}

// ── Test cases ──────────────────────────────────────────────────────────────────

interface TestCase {
  group_id: string;
  condition: string;
  description: string;
}

const TEST_CASES: TestCase[] = [
  {
    group_id: "spike-1-doc",
    condition: "A draft document exists for the logged-in user's personal team, with at least one recipient added",
    description: "Single draft doc with recipient, scoped to team 7",
  },
  {
    group_id: "spike-1-3docs",
    condition: "At least 3 draft documents exist for the logged-in user's personal team so the documents list is non-empty",
    description: "3 draft docs scoped to team 7",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────────

function psqlQuery(sql: string): string {
  return execFileSync("psql", [DB_URL, "-t", "-A", "-c", sql], {
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function getDraftCountForTeam(): number {
  const result = psqlQuery(
    `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${EXPECTED_TEAM_ID} AND status = 'DRAFT'`
  );
  return parseInt(result, 10) || 0;
}

function checkScoping(commands: string[]): { scoping_correct: boolean; references_team: boolean; references_user: boolean; details: string[] } {
  const details: string[] = [];
  let refsTeam = false;
  let refsUser = false;

  for (const cmd of commands) {
    // Check for team ID 7
    if (cmd.includes(String(EXPECTED_TEAM_ID)) && (cmd.includes("teamId") || cmd.includes('"teamId"') || cmd.toLowerCase().includes("team"))) {
      refsTeam = true;
      details.push(`References team ID ${EXPECTED_TEAM_ID}`);
    }
    // Check for user ID 9
    if (cmd.includes(String(EXPECTED_USER_ID)) && (cmd.includes("userId") || cmd.includes('"userId"') || cmd.toLowerCase().includes("user"))) {
      refsUser = true;
      details.push(`References user ID ${EXPECTED_USER_ID}`);
    }
    // Check for unscoped patterns (bad)
    if (/LIMIT\s+\d+/i.test(cmd) && !cmd.includes(String(EXPECTED_TEAM_ID)) && !cmd.includes(String(EXPECTED_USER_ID))) {
      details.push(`WARNING: Unscoped LIMIT query detected — may grab wrong rows`);
    }
  }

  return {
    scoping_correct: refsTeam || refsUser,
    references_team: refsTeam,
    references_user: refsUser,
    details,
  };
}

function parseJsonFromOutput(raw: string): { group_id: string; condition: string; setup_commands: string[]; teardown_commands: string[] } | null {
  // Try to find JSON in the output
  const jsonMatch = raw.match(/\{[\s\S]*"setup_commands"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    // Try to find the last JSON block
    const lines = raw.split("\n");
    let jsonStr = "";
    let inJson = false;
    let braceCount = 0;
    for (const line of lines) {
      if (line.trim().startsWith("{")) {
        inJson = true;
        jsonStr = "";
        braceCount = 0;
      }
      if (inJson) {
        jsonStr += line + "\n";
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;
        if (braceCount === 0) {
          try {
            return JSON.parse(jsonStr);
          } catch {
            inJson = false;
          }
        }
      }
    }
    return null;
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────────

interface CaseResult {
  group_id: string;
  condition: string;
  description: string;
  status: "success" | "parse_error" | "sql_error" | "scoping_failure" | "timeout" | "crash";
  scoping_correct: boolean;
  references_team: boolean;
  references_user: boolean;
  scoping_details: string[];
  commands: string[];
  baseline_draft_count: number;
  final_draft_count: number;
  draft_delta: number;
  error?: string;
  duration_ms: number;
  raw_output_path: string;
}

const results: CaseResult[] = [];

console.log(`\n=== Spike 1: Inject auth email into setup-writer prompt ===\n`);
console.log(`Project:    ${PROJECT_DIR}`);
console.log(`DB URL:     ${DB_URL}`);
console.log(`Auth email: ${AUTH_EMAIL}`);
console.log(`Run dir:    ${runDir}`);
console.log(`Test cases: ${TEST_CASES.length}\n`);

for (const tc of TEST_CASES) {
  console.log(`--- ${tc.group_id}: ${tc.description} ---`);
  console.log(`  Condition: "${tc.condition}"`);

  const start = Date.now();
  const rawOutputPath = join(runDir, `${tc.group_id}-raw.txt`);

  // Baseline
  const baselineDrafts = getDraftCountForTeam();
  console.log(`  Baseline drafts for team ${EXPECTED_TEAM_ID}: ${baselineDrafts}`);

  try {
    // Build the modified prompt
    const prompt = buildPromptWithAuth(tc.group_id, tc.condition);
    const promptPath = join(runDir, `${tc.group_id}-prompt.txt`);
    writeFileSync(promptPath, prompt);

    // Run via claude -p
    console.log(`  Running claude -p with auth-injected prompt...`);

    // Write prompt to a temp file to avoid shell quoting issues
    const promptFile = join(runDir, `${tc.group_id}-input.txt`);
    writeFileSync(promptFile, prompt);

    const promptContent = readFileSync(promptFile, "utf-8");
    const raw = execFileSync("claude", ["-p", promptContent, "--allowedTools", "Bash"], {
      encoding: "utf-8",
      timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    const duration = Date.now() - start;
    writeFileSync(rawOutputPath, raw);

    // Parse JSON output
    const parsed = parseJsonFromOutput(raw);
    if (!parsed) {
      console.log(`  FAIL: Could not parse JSON from LLM output`);
      console.log(`  Raw output (first 500 chars): ${raw.slice(0, 500)}`);
      results.push({
        group_id: tc.group_id, condition: tc.condition, description: tc.description,
        status: "parse_error", scoping_correct: false, references_team: false,
        references_user: false, scoping_details: [], commands: [],
        baseline_draft_count: baselineDrafts, final_draft_count: baselineDrafts,
        draft_delta: 0, duration_ms: duration, raw_output_path: rawOutputPath,
      });
      continue;
    }

    const commands = parsed.setup_commands ?? [];
    console.log(`  Generated ${commands.length} commands in ${Math.round(duration / 1000)}s`);

    // Check scoping before execution
    const scoping = checkScoping(commands);
    console.log(`  Scoping correct: ${scoping.scoping_correct}`);
    console.log(`  References team ${EXPECTED_TEAM_ID}: ${scoping.references_team}`);
    console.log(`  References user ${EXPECTED_USER_ID}: ${scoping.references_user}`);
    for (const d of scoping.details) {
      console.log(`    ${d}`);
    }

    // Print SQL
    for (const cmd of commands) {
      const sqlMatch = cmd.match(/-c\s+"(.+)"/s) ?? cmd.match(/-c\s+'(.+)'/s);
      const sql = sqlMatch?.[1] ?? cmd;
      console.log(`  SQL: ${sql.slice(0, 150)}${sql.length > 150 ? "..." : ""}`);
    }

    // Execute SQL
    let execError: string | undefined;
    for (const sqlCmd of commands) {
      try {
        execSync(sqlCmd, {
          timeout: 15_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        execError = err.stderr?.slice(0, 300) ?? err.message ?? "unknown error";
        console.log(`  SQL execution FAILED: ${execError.slice(0, 150)}`);
        break;
      }
    }

    // Check final state
    const finalDrafts = getDraftCountForTeam();
    const delta = finalDrafts - baselineDrafts;
    console.log(`  Final drafts for team ${EXPECTED_TEAM_ID}: ${finalDrafts} (delta: ${delta >= 0 ? "+" : ""}${delta})`);

    const status = execError ? "sql_error" : !scoping.scoping_correct ? "scoping_failure" : "success";
    console.log(`  Status: ${status}`);

    results.push({
      group_id: tc.group_id, condition: tc.condition, description: tc.description,
      status, scoping_correct: scoping.scoping_correct,
      references_team: scoping.references_team, references_user: scoping.references_user,
      scoping_details: scoping.details, commands,
      baseline_draft_count: baselineDrafts, final_draft_count: finalDrafts,
      draft_delta: delta, error: execError, duration_ms: duration,
      raw_output_path: rawOutputPath,
    });

  } catch (e) {
    const duration = Date.now() - start;
    const err = e as { message?: string; killed?: boolean };
    const status = err.killed ? "timeout" : "crash";
    console.log(`  ${status}: ${err.message?.slice(0, 150)}`);
    results.push({
      group_id: tc.group_id, condition: tc.condition, description: tc.description,
      status, scoping_correct: false, references_team: false,
      references_user: false, scoping_details: [], commands: [],
      baseline_draft_count: baselineDrafts, final_draft_count: baselineDrafts,
      draft_delta: 0, error: err.message?.slice(0, 300),
      duration_ms: duration, raw_output_path: rawOutputPath,
    });
  }

  console.log();
}

// ── Summary ─────────────────────────────────────────────────────────────────────

console.log(`\n=== SPIKE 1 RESULTS ===\n`);

for (const r of results) {
  console.log(`${r.group_id}:`);
  console.log(`  Status:          ${r.status}`);
  console.log(`  Scoping correct: ${r.scoping_correct}`);
  console.log(`  Refs team ${EXPECTED_TEAM_ID}:     ${r.references_team}`);
  console.log(`  Refs user ${EXPECTED_USER_ID}:     ${r.references_user}`);
  console.log(`  Draft delta:     ${r.draft_delta >= 0 ? "+" : ""}${r.draft_delta}`);
  console.log(`  Duration:        ${Math.round(r.duration_ms / 1000)}s`);
  console.log(`  Commands:        ${r.commands.length}`);
  if (r.error) console.log(`  Error:           ${r.error.slice(0, 100)}`);
}

const scopingCorrect = results.filter(r => r.scoping_correct).length;
const sqlSucceeded = results.filter(r => r.status === "success").length;

console.log(`\n  Scoping correct: ${scopingCorrect}/${results.length}`);
console.log(`  SQL succeeded:   ${sqlSucceeded}/${results.length}`);

// Write results
const resultsPath = join(runDir, "spike-1-results.json");
writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`\n  Full results: ${resultsPath}`);

// Verdict
console.log(`\n=== VERDICT ===\n`);
if (scopingCorrect === results.length && sqlSucceeded === results.length) {
  console.log(`SUCCESS: Auth email injection fixes scoping. All ${results.length} cases correctly`);
  console.log(`  scoped to team ${EXPECTED_TEAM_ID} / user ${EXPECTED_USER_ID} and SQL executed without errors.`);
  console.log(`  -> Recommendation: Add config.auth.email to the production setup-writer prompt.`);
} else if (scopingCorrect === results.length) {
  console.log(`PARTIAL: Scoping is correct (${scopingCorrect}/${results.length}), but SQL has errors.`);
  console.log(`  The auth email injection fixes the scoping problem. SQL errors are a separate issue.`);
  console.log(`  -> Recommendation: Add config.auth.email + improve SQL generation.`);
} else if (scopingCorrect > 0) {
  console.log(`MIXED: Scoping correct in ${scopingCorrect}/${results.length} cases.`);
  console.log(`  Auth email injection helps but is not sufficient alone.`);
} else {
  console.log(`FAILURE: Auth email injection did NOT fix scoping. 0/${results.length} cases correct.`);
  console.log(`  The LLM ignored the AUTH CONTEXT section.`);
}
console.log();
