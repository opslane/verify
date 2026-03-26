#!/usr/bin/env npx tsx
/**
 * Spike 4: Combined pre-resolve user context + enriched condition strings.
 *
 * Combines the best of Spike 2 (USER CONTEXT section in prompt) and
 * Spike 3 (enriching the condition string with concrete IDs).
 * The LLM gets BOTH explicit instructions AND self-documenting conditions,
 * so there's zero ambiguity about scoping.
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-4-combined.ts
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────────

const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";
const APP_JSON_PATH = join(PROJECT_DIR, ".verify", "app.json");
const LEARNINGS_PATH = join(PROJECT_DIR, ".verify", "learnings.md");
const PSQL_CMD = `psql "${DB_URL}"`;
const CLAUDE_TIMEOUT_MS = 120_000;

// Pre-resolved user context (known from DB)
const USER_ID = 9;
const USER_EMAIL = "ac1-test@test.documenso.com";
const TEAM_ID = 7;
const TEAM_URL = "personal_mwiasvikdmkwinfh";

// ── Load app.json schema ────────────────────────────────────────────────────────

interface AppIndex {
  data_model: Record<string, {
    table_name: string;
    columns: Record<string, string>;
    manual_id_columns: string[];
    enums?: Record<string, string[]>;
  }>;
  db_url_env: string;
}

const appIndex: AppIndex = JSON.parse(readFileSync(APP_JSON_PATH, "utf-8"));

function buildSchemaLines(): string[] {
  const lines: string[] = [];
  for (const [model, info] of Object.entries(appIndex.data_model)) {
    const cols = Object.entries(info.columns).map(([prisma, pg]) =>
      prisma === pg ? pg : `${prisma}->${pg}`
    );
    const manualIds = info.manual_id_columns.length > 0
      ? ` [manual IDs: ${info.manual_id_columns.join(", ")}]`
      : "";
    lines.push(`${model} ("${info.table_name}"): ${cols.join(", ")}${manualIds}`);
  }
  return lines;
}

// ── Build combined prompt: enriched condition + USER CONTEXT section ─────────

function buildCombinedPrompt(groupId: string, enrichedCondition: string): string {
  const schemaLines = buildSchemaLines();

  // Load learnings if present
  const learnings = existsSync(LEARNINGS_PATH)
    ? readFileSync(LEARNINGS_PATH, "utf-8").trim()
    : "";
  const learningsBlock = learnings
    ? `\nLEARNINGS FROM PAST RUNS (apply these corrections):\n${learnings}\n`
    : "";

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${enrichedCondition}

USER CONTEXT (pre-resolved, authoritative):
- Logged-in user: id=${USER_ID}, email=${USER_EMAIL}
- Personal team: id=${TEAM_ID}, url=${TEAM_URL}, name=Personal Team

Use these IDs directly. Do NOT query for users or teams — these are already resolved.
All INSERTs must set "teamId" = ${TEAM_ID} and reference userId = ${USER_ID} where applicable.

DATABASE ACCESS:
Use Bash to run psql commands to query the database and understand current state.
Connection: ${PSQL_CMD} -c "SELECT ..."

SCHEMA (model -> table, columns):
${schemaLines.join("\n")}
${learningsBlock}
PROCESS:
1. Run 2-3 psql SELECT queries to understand current data relevant to the CONDITION (scoped to teamId=${TEAM_ID})
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
  "condition": "${enrichedCondition}",
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
9. Always scope queries to teamId=${TEAM_ID} and userId=${USER_ID}.

Output ONLY the JSON. No explanation, no markdown fences.`;
}

// ── Enrichment: replace vague references with concrete IDs ──────────────────

function enrichCondition(original: string): string {
  return original
    .replace(
      /the logged-in user's personal team/gi,
      `team '${TEAM_URL}' (id=${TEAM_ID})`
    )
    .replace(
      /the logged-in user/gi,
      `user ac1-test@test.documenso.com (userId=${USER_ID})`
    )
    + `. All queries and inserts MUST use teamId=${TEAM_ID}.`;
}

// ── Test cases ──────────────────────────────────────────────────────────────────

interface TestCase {
  group_id: string;
  original_condition: string;
  description: string;
}

const TEST_CASES: TestCase[] = [
  {
    group_id: "spike-4-doc",
    original_condition:
      "A draft document exists for the logged-in user's personal team, with at least one recipient added",
    description: "Single draft envelope scoped to team 7 with a recipient",
  },
  {
    group_id: "spike-4-3docs",
    original_condition:
      "At least 3 draft documents exist for the logged-in user's personal team so the documents list is non-empty",
    description: "3 draft envelopes scoped to team 7",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function psqlQuery(sql: string): string {
  try {
    const safeSql = sql.replace(/'/g, "'\\''");
    const result = execSync(`${PSQL_CMD} -t -A -c '${safeSql}'`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return `ERROR: ${err.stderr?.slice(0, 200) ?? err.message ?? "unknown"}`;
  }
}

function parseJsonFromOutput(raw: string): Record<string, unknown> | null {
  // First try to parse claude JSON output format
  let text = raw;
  try {
    const claudeJson = JSON.parse(raw) as { result?: string; content?: Array<{ text?: string }> };
    if (claudeJson.result) {
      text = claudeJson.result;
    } else if (claudeJson.content) {
      text = claudeJson.content.map(c => c.text ?? "").join("\n");
    }
  } catch {
    // raw output is the text itself
  }

  // Try to find JSON with setup_commands
  const jsonMatch = text.match(/\{[\s\S]*"setup_commands"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────────

const pipelineDir = join(import.meta.dirname ?? ".", "../..");
const runDir = join(pipelineDir, `spike-4-output-${Date.now()}`);
mkdirSync(runDir, { recursive: true });

console.log("\n=== Spike 4: Combined pre-resolve + enriched conditions ===\n");
console.log(`DB URL:       ${DB_URL}`);
console.log(`User:         id=${USER_ID}, email=${USER_EMAIL}`);
console.log(`Team:         id=${TEAM_ID}, url=${TEAM_URL}`);
console.log(`Run dir:      ${runDir}`);
console.log(`Test cases:   ${TEST_CASES.length}\n`);

// Verify pre-resolved IDs are still correct
console.log("--- Verifying pre-resolved user context ---");
const userCheck = psqlQuery(`SELECT id, email FROM "User" WHERE email = '${USER_EMAIL}'`);
console.log(`  User query: ${userCheck}`);
const teamCheck = psqlQuery(`SELECT id, url FROM "Team" WHERE id = ${TEAM_ID}`);
console.log(`  Team query: ${teamCheck}`);

// Check baseline state
const baselineTeam7 = psqlQuery(`SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND status = 'DRAFT'`);
const baselineCrossTeam = psqlQuery(`SELECT COUNT(*) FROM "Envelope" WHERE "teamId" <> ${TEAM_ID} AND status = 'DRAFT'`);
console.log(`  Baseline team-7 drafts: ${baselineTeam7}`);
console.log(`  Baseline cross-team drafts: ${baselineCrossTeam}`);
console.log();

// ── Results tracking ────────────────────────────────────────────────────────────

interface CaseResult {
  group_id: string;
  original_condition: string;
  enriched_condition: string;
  description: string;
  baseline_count: number;
  post_count: number;
  cross_team_baseline: number;
  cross_team_post: number;
  cross_team_pollution: boolean;
  scoping_correct: boolean;
  no_extra_lookups: boolean;
  sql_success: boolean;
  commands: string[];
  raw_output_length: number;
  status: "success" | "parse_error" | "sql_error" | "scoping_fail" | "timeout" | "crash";
  error?: string;
  duration_ms: number;
}

const results: CaseResult[] = [];

for (const tc of TEST_CASES) {
  const enrichedCondition = enrichCondition(tc.original_condition);

  console.log(`\n--- ${tc.group_id}: ${tc.description} ---`);
  console.log(`  Original:  "${tc.original_condition}"`);
  console.log(`  Enriched:  "${enrichedCondition}"`);

  const start = Date.now();

  // Baseline counts
  const baselineRaw = psqlQuery(`SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND status = 'DRAFT'`);
  const baseline = parseInt(baselineRaw, 10) || 0;
  const crossTeamBaselineRaw = psqlQuery(`SELECT COUNT(*) FROM "Envelope" WHERE "teamId" <> ${TEAM_ID} AND status = 'DRAFT'`);
  const crossTeamBaseline = parseInt(crossTeamBaselineRaw, 10) || 0;
  console.log(`  Baseline: team-7 drafts=${baseline}, cross-team drafts=${crossTeamBaseline}`);

  // Build combined prompt
  const prompt = buildCombinedPrompt(tc.group_id, enrichedCondition);
  const promptPath = join(runDir, `${tc.group_id}-prompt.txt`);
  writeFileSync(promptPath, prompt);

  // Run via claude -p
  console.log(`  Running claude -p (timeout ${CLAUDE_TIMEOUT_MS / 1000}s)...`);

  let rawOutput: string;
  try {
    const promptInputPath = join(runDir, `${tc.group_id}-prompt-input.txt`);
    writeFileSync(promptInputPath, prompt);

    rawOutput = execSync(
      `cat "${promptInputPath}" | claude -p --allowedTools Bash`,
      {
        encoding: "utf-8",
        timeout: CLAUDE_TIMEOUT_MS + 60_000,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: PROJECT_DIR,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (e) {
    const duration = Date.now() - start;
    const err = e as { killed?: boolean; stderr?: string; message?: string };
    const status = err.killed ? "timeout" : "crash";
    console.log(`  FAIL (${status}): ${err.stderr?.slice(0, 150) ?? err.message?.slice(0, 150)}`);
    results.push({
      group_id: tc.group_id, original_condition: tc.original_condition,
      enriched_condition: enrichedCondition, description: tc.description,
      baseline_count: baseline, post_count: -1,
      cross_team_baseline: crossTeamBaseline, cross_team_post: -1,
      cross_team_pollution: false, scoping_correct: false,
      no_extra_lookups: false, sql_success: false, commands: [],
      raw_output_length: 0, status, error: err.message?.slice(0, 300),
      duration_ms: duration,
    });
    continue;
  }

  const duration = Date.now() - start;
  console.log(`  claude -p completed in ${Math.round(duration / 1000)}s`);

  // Save raw output
  writeFileSync(join(runDir, `${tc.group_id}-raw-output.txt`), rawOutput);

  // Parse JSON output
  const parsed = parseJsonFromOutput(rawOutput);
  if (!parsed || !Array.isArray(parsed.setup_commands)) {
    console.log(`  PARSE ERROR — could not find JSON in output (${rawOutput.length} chars)`);
    console.log(`  Raw output (first 300 chars): ${rawOutput.slice(0, 300)}`);
    results.push({
      group_id: tc.group_id, original_condition: tc.original_condition,
      enriched_condition: enrichedCondition, description: tc.description,
      baseline_count: baseline, post_count: -1,
      cross_team_baseline: crossTeamBaseline, cross_team_post: -1,
      cross_team_pollution: false, scoping_correct: false,
      no_extra_lookups: false, sql_success: false, commands: [],
      raw_output_length: rawOutput.length, status: "parse_error",
      duration_ms: duration,
    });
    continue;
  }

  const commands = parsed.setup_commands as string[];
  console.log(`  Generated ${commands.length} setup commands`);

  // Print SQL commands
  for (const cmd of commands) {
    const sqlMatch = cmd.match(/-c\s+["'](.+?)["']\s*$/s) ?? cmd.match(/-c\s+"(.+)"/s);
    const sql = sqlMatch?.[1] ?? cmd;
    console.log(`    SQL: ${sql.slice(0, 150)}${sql.length > 150 ? "..." : ""}`);
  }

  // ── Scoping check: do ALL commands reference teamId=7? ──────────────────────
  const allSql = commands.join(" ");
  const scopingCorrect = commands.length === 0 || (
    // Every INSERT/UPDATE should reference team 7
    (allSql.includes("7") || allSql.includes(`${TEAM_ID}`)) &&
    // Check for references to other specific team IDs (not 7) in WHERE/SET clauses
    !(/teamId[^7]*=\s*(?!7\b)\d+/i.test(allSql))
  );

  // ── No extra lookups check: did the LLM avoid querying User/Team tables? ────
  const userLookupPatterns = [
    /SELECT.*FROM\s+"User"\s+WHERE\s+email/i,
    /SELECT.*FROM\s+"Team"\s+WHERE.*url\s*=/i,
  ];
  const noExtraLookups = !userLookupPatterns.some(p => p.test(rawOutput));

  console.log(`  Scoping correct: ${scopingCorrect}`);
  console.log(`  No extra user/team lookups: ${noExtraLookups}`);

  // ── Execute SQL commands ────────────────────────────────────────────────────
  let sqlError: string | undefined;
  for (const sqlCmd of commands) {
    try {
      execSync(sqlCmd, {
        timeout: 15_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      sqlError = err.stderr?.slice(0, 300) ?? err.message ?? "unknown";
      console.log(`  SQL EXEC ERROR: ${sqlError.slice(0, 150)}`);
      break;
    }
  }

  if (!sqlError) {
    console.log(`  All SQL commands executed successfully`);
  }

  // ── Post-execution checks ─────────────────────────────────────────────────
  const postRaw = psqlQuery(`SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND status = 'DRAFT'`);
  const postCount = parseInt(postRaw, 10) || 0;
  const crossTeamPostRaw = psqlQuery(`SELECT COUNT(*) FROM "Envelope" WHERE "teamId" <> ${TEAM_ID} AND status = 'DRAFT'`);
  const crossTeamPost = parseInt(crossTeamPostRaw, 10) || 0;
  const crossTeamPollution = crossTeamPost > crossTeamBaseline;

  console.log(`  Post: team-7 drafts=${postCount} (was ${baseline}), cross-team drafts=${crossTeamPost} (was ${crossTeamBaseline})`);
  console.log(`  Cross-team pollution: ${crossTeamPollution}`);

  const sqlSuccess = !sqlError;
  const status = sqlError ? "sql_error" : scopingCorrect ? "success" : "scoping_fail";

  results.push({
    group_id: tc.group_id, original_condition: tc.original_condition,
    enriched_condition: enrichedCondition, description: tc.description,
    baseline_count: baseline, post_count: postCount,
    cross_team_baseline: crossTeamBaseline, cross_team_post: crossTeamPost,
    cross_team_pollution: crossTeamPollution,
    scoping_correct: scopingCorrect,
    no_extra_lookups: noExtraLookups,
    sql_success: sqlSuccess,
    commands,
    raw_output_length: rawOutput.length,
    status, error: sqlError,
    duration_ms: duration,
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────────

console.log("\n\n=== SPIKE 4 RESULTS ===\n");

for (const r of results) {
  const icon = r.status === "success" ? "PASS" : "FAIL";
  console.log(`  [${icon}] ${r.group_id}:`);
  console.log(`    status:              ${r.status}`);
  console.log(`    scoping_correct:     ${r.scoping_correct}`);
  console.log(`    no_extra_lookups:    ${r.no_extra_lookups}`);
  console.log(`    sql_success:         ${r.sql_success}`);
  console.log(`    baseline_count:      ${r.baseline_count}`);
  console.log(`    post_count:          ${r.post_count}`);
  console.log(`    cross_team_pollution:${r.cross_team_pollution}`);
  console.log(`    duration_ms:         ${r.duration_ms}`);
  if (r.error) console.log(`    error:               ${r.error.slice(0, 150)}`);
}

const allScopingCorrect = results.every(r => r.scoping_correct);
const allNoExtraLookups = results.every(r => r.no_extra_lookups);
const allSqlSuccess = results.every(r => r.sql_success);
const noCrossTeamPollution = results.every(r => !r.cross_team_pollution);
const allCountsIncreased = results.every(r => r.post_count > r.baseline_count);

console.log(`\n=== AGGREGATE ===\n`);
console.log(`  All scoping correct:     ${allScopingCorrect}`);
console.log(`  All no extra lookups:    ${allNoExtraLookups}`);
console.log(`  All SQL success:         ${allSqlSuccess}`);
console.log(`  No cross-team pollution: ${noCrossTeamPollution}`);
console.log(`  All counts increased:    ${allCountsIncreased}`);
console.log(`  Avg duration:            ${Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / results.length / 1000)}s`);

console.log(`\n=== VERDICT ===\n`);

if (allScopingCorrect && allNoExtraLookups && allSqlSuccess && noCrossTeamPollution && allCountsIncreased) {
  console.log(`  PASS: Combined approach (pre-resolve + enriched conditions) produces`);
  console.log(`  correctly-scoped SQL with no extra lookups and no cross-team pollution.`);
  console.log(`  The LLM used injected IDs directly from both the USER CONTEXT section`);
  console.log(`  AND the enriched condition string.`);
  console.log(`  -> Recommendation: implement both enrichment + USER CONTEXT in production.`);
} else if (allScopingCorrect && allSqlSuccess) {
  console.log(`  PARTIAL PASS: Scoping and SQL are correct, but there were extra lookups`);
  console.log(`  or cross-team pollution.`);
  console.log(`  Extra lookups: ${!allNoExtraLookups}`);
  console.log(`  Cross-team pollution: ${!noCrossTeamPollution}`);
} else if (allSqlSuccess) {
  console.log(`  PARTIAL: SQL succeeded but scoping was not fully correct.`);
  console.log(`  -> Combined approach needs further refinement.`);
} else {
  console.log(`  FAIL: Combined approach had SQL errors or scoping failures.`);
  for (const r of results.filter(r => !r.sql_success)) {
    console.log(`    ${r.group_id}: ${r.error?.slice(0, 120)}`);
  }
}

// Save full results
const resultsPath = join(runDir, "spike-4-results.json");
writeFileSync(resultsPath, JSON.stringify({ results, aggregate: { allScopingCorrect, allNoExtraLookups, allSqlSuccess, noCrossTeamPollution, allCountsIncreased } }, null, 2));
console.log(`\n  Full results: ${resultsPath}\n`);
