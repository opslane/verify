#!/usr/bin/env npx tsx
/**
 * Spike 3: Does enriching the condition string with concrete scoping info
 * cause the setup-writer to produce correctly-scoped SQL — WITHOUT any
 * prompt template changes?
 *
 * Hypothesis: the setup-writer prompt is fine; the problem is that vague
 * conditions like "the logged-in user's personal team" give the LLM no way
 * to scope queries. If we inject teamId, userId, and email into the condition
 * string itself, the LLM should produce correctly-scoped SQL.
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-3-enriched-conditions.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { buildSetupWriterPrompt } from "../stages/setup-writer.js";
import { parseJsonOutput } from "../lib/parse-json.js";

// ── Config ──────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";
const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const PSQL = `psql "${DB_URL}"`;
const CLAUDE_TIMEOUT_MS = 120_000;

// ── Test cases ──────────────────────────────────────────────────────────────────

interface TestCase {
  group_id: string;
  original_condition: string;
  enriched_condition: string;
  /** SQL to count team-7 drafts before and after */
  baseline_sql: string;
  /** Description of what correct scoping looks like */
  scoping_check: string;
}

const TEST_CASES: TestCase[] = [
  {
    group_id: "spike-3-doc",
    original_condition:
      "A draft document exists for the logged-in user's personal team, with at least one recipient added",
    enriched_condition:
      'A draft document exists in team with url=\'personal_mwiasvikdmkwinfh\' (teamId=7), with at least one recipient added. The logged-in user\'s email is ac1-test@test.documenso.com (userId=9). All queries MUST be scoped to this team.',
    baseline_sql: `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = 7 AND status = 'DRAFT'`,
    scoping_check: "Commands reference teamId=7 or team 7",
  },
  {
    group_id: "spike-3-3docs",
    original_condition:
      "At least 3 draft documents exist for the logged-in user's personal team so the documents list is non-empty",
    enriched_condition:
      'At least 3 draft documents exist in team with url=\'personal_mwiasvikdmkwinfh\' (teamId=7) so the documents list is non-empty. The logged-in user is ac1-test@test.documenso.com (userId=9). All queries MUST be scoped to this team.',
    baseline_sql: `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = 7 AND status = 'DRAFT'`,
    scoping_check: "Commands reference teamId=7 or team 7",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function psqlQuery(sql: string): string {
  try {
    return execSync(`${PSQL} -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return `ERROR: ${err.stderr?.slice(0, 200) ?? err.message ?? "unknown"}`;
  }
}

/**
 * Check scoping in setup commands AND in the raw LLM output text.
 * When the LLM determines the condition is already satisfied (0 commands),
 * we check the raw output for evidence that it queried with correct scoping.
 */
function checkScoping(commands: string[], rawOutput: string): { scoped: boolean; evidence: string[]; alreadySatisfied: boolean } {
  const evidence: string[] = [];
  let scoped = true;

  // Check if LLM determined the condition was already met (0 commands)
  const alreadySatisfied = commands.length === 0 &&
    (/already\s+(met|satisfied|exists)/i.test(rawOutput) || /no\s+(changes|setup)\s+needed/i.test(rawOutput));

  if (alreadySatisfied) {
    // Check if raw output references the correct team/user IDs
    const outputRefTeam7 = /team\s*7|teamId.*7|"teamId"\s*=\s*7/i.test(rawOutput);
    const outputRefUser9 = /user.*9|userId.*9|id\s*=\s*9/i.test(rawOutput);

    if (outputRefTeam7) {
      evidence.push(`LLM referenced team 7 in reasoning: condition already satisfied`);
    }
    if (outputRefUser9) {
      evidence.push(`LLM referenced user 9 in reasoning: condition already satisfied`);
    }
    if (outputRefTeam7 || outputRefUser9) {
      scoped = true;
    } else {
      evidence.push(`LLM said condition satisfied but no team/user ID references in output`);
      scoped = false;
    }
    return { scoped, evidence, alreadySatisfied };
  }

  // Check scoping in actual commands
  for (const cmd of commands) {
    const hasTeamId7 = /teamId.*=.*7|"teamId"\s*=\s*7|teamid\s*=\s*7/i.test(cmd) || (cmd.includes("teamId") && cmd.includes("7"));
    const hasUserId9 = /userId.*=.*9|"userId"\s*=\s*9|userid\s*=\s*9/i.test(cmd) || (cmd.includes("userId") && cmd.includes("9"));

    if (hasTeamId7) {
      evidence.push(`teamId=7 found in: ${cmd.slice(0, 100)}`);
    }
    if (hasUserId9) {
      evidence.push(`userId=9 found in: ${cmd.slice(0, 100)}`);
    }

    // Check for unscoped queries (no WHERE clause with teamId)
    const upper = cmd.toUpperCase();
    if (upper.includes("SELECT") && !hasTeamId7 && !upper.includes("LIMIT 1")) {
      evidence.push(`UNSCOPED SELECT: ${cmd.slice(0, 100)}`);
      if (!upper.includes("INFORMATION_SCHEMA") && !upper.includes("PG_")) {
        scoped = false;
      }
    }
  }

  if (evidence.length === 0) {
    evidence.push("No teamId or userId references found in commands");
    scoped = false;
  }

  return { scoped, evidence, alreadySatisfied };
}

// ── Main ────────────────────────────────────────────────────────────────────────

interface CaseResult {
  group_id: string;
  original_condition: string;
  enriched_condition: string;
  baseline_count: string;
  post_count: string;
  scoping_correct: boolean;
  scoping_evidence: string[];
  commands: string[];
  sql_success: boolean;
  sql_error?: string;
  already_satisfied: boolean;
  duration_ms: number;
  status: "success" | "scoping_fail" | "sql_error" | "parse_error" | "timeout" | "crash";
}

const results: CaseResult[] = [];

const pipelineDir = resolve(import.meta.dirname ?? ".", "../..");
const runDir = join(pipelineDir, "spike-3-output-" + Date.now());
mkdirSync(runDir, { recursive: true });

console.log(`\n=== Spike 3: Enriched condition strings ===\n`);
console.log(`Project dir:  ${PROJECT_DIR}`);
console.log(`DB URL:       ${DB_URL}`);
console.log(`Run dir:      ${runDir}`);
console.log(`Test cases:   ${TEST_CASES.length}\n`);

for (const tc of TEST_CASES) {
  console.log(`\n--- ${tc.group_id} ---`);
  console.log(`  Original:  "${tc.original_condition}"`);
  console.log(`  Enriched:  "${tc.enriched_condition}"`);

  const start = Date.now();

  // Step 1: Save baseline count
  const baselineCount = psqlQuery(tc.baseline_sql);
  console.log(`  Baseline team-7 drafts: ${baselineCount}`);

  // Step 2: Build prompt using the UNMODIFIED setup-writer prompt with enriched condition
  const prompt = buildSetupWriterPrompt(tc.group_id, tc.enriched_condition, PROJECT_DIR);

  // Save prompt for inspection
  writeFileSync(join(runDir, `${tc.group_id}-prompt.txt`), prompt);

  // Step 3: Run via claude -p
  console.log(`  Running claude -p (timeout ${CLAUDE_TIMEOUT_MS / 1000}s)...`);

  let rawOutput: string;
  try {
    // Write prompt to temp file to avoid shell quoting issues
    const promptPath = join(runDir, `${tc.group_id}-prompt-input.txt`);
    writeFileSync(promptPath, prompt);

    rawOutput = execSync(
      `cat "${promptPath}" | claude -p --allowedTools Bash`,
      {
        encoding: "utf-8",
        timeout: CLAUDE_TIMEOUT_MS + 30_000, // extra buffer
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
      group_id: tc.group_id,
      original_condition: tc.original_condition,
      enriched_condition: tc.enriched_condition,
      baseline_count: baselineCount,
      post_count: "N/A",
      scoping_correct: false,
      scoping_evidence: [],
      commands: [],
      sql_success: false,
      sql_error: err.message?.slice(0, 300),
      already_satisfied: false,
      duration_ms: duration,
      status,
    });
    continue;
  }

  const duration = Date.now() - start;
  console.log(`  claude -p completed in ${Math.round(duration / 1000)}s`);

  // Save raw output
  writeFileSync(join(runDir, `${tc.group_id}-raw-output.txt`), rawOutput);

  // Step 4: Parse JSON output
  interface SetupOutput {
    group_id: string;
    condition: string;
    setup_commands: string[];
    teardown_commands: string[];
  }
  const parsed = parseJsonOutput<SetupOutput>(rawOutput);

  if (!parsed || !Array.isArray(parsed.setup_commands)) {
    console.log(`  FAIL (parse_error): Could not extract JSON from output`);
    console.log(`  Raw output (first 300 chars): ${rawOutput.slice(0, 300)}`);
    results.push({
      group_id: tc.group_id,
      original_condition: tc.original_condition,
      enriched_condition: tc.enriched_condition,
      baseline_count: baselineCount,
      post_count: "N/A",
      scoping_correct: false,
      scoping_evidence: [],
      commands: [],
      sql_success: false,
      sql_error: "Could not parse JSON from LLM output",
      already_satisfied: false,
      duration_ms: duration,
      status: "parse_error",
    });
    continue;
  }

  const commands = parsed.setup_commands;
  console.log(`  Generated ${commands.length} setup commands`);

  // Step 5: Check scoping (pass raw output for "already satisfied" detection)
  const { scoped, evidence, alreadySatisfied } = checkScoping(commands, rawOutput);
  console.log(`  Scoping correct: ${scoped}${alreadySatisfied ? " (condition already satisfied — 0 commands needed)" : ""}`);
  for (const e of evidence) {
    console.log(`    ${e}`);
  }

  // Step 6: Execute SQL commands
  let sqlError: string | undefined;
  for (const cmd of commands) {
    // Print abbreviated SQL
    const sqlMatch = cmd.match(/-c\s+["'](.+?)["']\s*$/s) ?? cmd.match(/-c\s+"(.+)"/s);
    const sql = sqlMatch?.[1] ?? cmd;
    console.log(`  SQL: ${sql.slice(0, 120)}${sql.length > 120 ? "..." : ""}`);

    try {
      execSync(cmd, {
        cwd: PROJECT_DIR,
        timeout: 15_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      sqlError = err.stderr?.slice(0, 300) ?? err.message ?? "unknown";
      console.log(`  SQL FAILED: ${sqlError.slice(0, 150)}`);
      break;
    }
  }

  if (!sqlError) {
    console.log(`  All SQL commands executed successfully`);
  }

  // Step 7: Post-execution count
  const postCount = psqlQuery(tc.baseline_sql);
  console.log(`  Post team-7 drafts: ${postCount} (was: ${baselineCount})`);

  const status = sqlError ? "sql_error" : scoped ? "success" : "scoping_fail";
  results.push({
    group_id: tc.group_id,
    original_condition: tc.original_condition,
    enriched_condition: tc.enriched_condition,
    baseline_count: baselineCount,
    post_count: postCount,
    scoping_correct: scoped,
    scoping_evidence: evidence,
    commands,
    sql_success: !sqlError,
    sql_error: sqlError,
    already_satisfied: alreadySatisfied,
    duration_ms: duration,
    status,
  });
}

// ── Summary ─────────────────────────────────────────────────────────────────────

console.log(`\n\n=== SPIKE 3 RESULTS ===\n`);

const summary = {
  total: results.length,
  success: results.filter(r => r.status === "success").length,
  scoping_fail: results.filter(r => r.status === "scoping_fail").length,
  sql_error: results.filter(r => r.status === "sql_error").length,
  parse_error: results.filter(r => r.status === "parse_error").length,
  timeout: results.filter(r => r.status === "timeout").length,
  crash: results.filter(r => r.status === "crash").length,
  scoping_correct_rate: results.filter(r => r.scoping_correct).length / results.length,
  sql_success_rate: results.filter(r => r.sql_success).length / results.length,
  avg_duration_ms: Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / results.length),
};

console.log(`  Total:              ${summary.total}`);
console.log(`  Success:            ${summary.success}/${summary.total}`);
console.log(`  Scoping correct:    ${results.filter(r => r.scoping_correct).length}/${summary.total} (${Math.round(summary.scoping_correct_rate * 100)}%)`);
console.log(`  SQL executed OK:    ${results.filter(r => r.sql_success).length}/${summary.total} (${Math.round(summary.sql_success_rate * 100)}%)`);
console.log(`  Parse errors:       ${summary.parse_error}`);
console.log(`  Timeouts:           ${summary.timeout}`);
console.log(`  Avg duration:       ${Math.round(summary.avg_duration_ms / 1000)}s`);

const alreadySatisfiedCount = results.filter(r => r.already_satisfied).length;
console.log(`  Already satisfied:  ${alreadySatisfiedCount}/${summary.total} (LLM correctly found data exists)`);

for (const r of results) {
  console.log(`\n  [${r.group_id}] status=${r.status} scoped=${r.scoping_correct} sql_ok=${r.sql_success} already_satisfied=${r.already_satisfied} ${Math.round(r.duration_ms / 1000)}s`);
  console.log(`    baseline=${r.baseline_count} post=${r.post_count}`);
  if (r.scoping_evidence.length > 0) {
    for (const e of r.scoping_evidence) {
      console.log(`    ${e}`);
    }
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────────

console.log(`\n=== VERDICT ===\n`);

if (summary.scoping_correct_rate === 1 && summary.sql_success_rate === 1) {
  console.log(`SUCCESS: Enriching condition strings alone (no prompt changes) produces correctly-scoped SQL.`);
  console.log(`The LLM used the concrete teamId/userId from the condition instead of discovering them.`);
  console.log(`-> Recommendation: add scoping info extraction to ac-generator/precondition-detector.`);
  console.log(`   No setup-writer prompt changes needed.`);
} else if (summary.scoping_correct_rate >= 0.5) {
  console.log(`PARTIAL: Enriched conditions improved scoping (${Math.round(summary.scoping_correct_rate * 100)}%) but not 100%.`);
  console.log(`-> May need both condition enrichment AND prompt reinforcement.`);
} else {
  console.log(`FAIL: Enriched conditions did not produce correctly-scoped SQL.`);
  console.log(`-> Condition enrichment alone is insufficient. Need prompt template changes.`);
}

// Save full results
const resultsPath = join(runDir, "spike-3-results.json");
writeFileSync(resultsPath, JSON.stringify({ summary, results }, null, 2));
console.log(`\nFull results: ${resultsPath}\n`);
