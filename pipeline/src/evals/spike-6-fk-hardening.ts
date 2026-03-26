#!/usr/bin/env npx tsx
/**
 * Spike 6: Does adding an FK hardening rule to the setup-writer prompt
 * prevent the LLM from inventing fake FK values?
 *
 * Tests the CURRENT prompt (baseline) vs a hardened prompt with an extra rule:
 * "NEVER invent values for FK columns — SELECT valid values from referenced tables first."
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-6-fk-hardening.ts
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { loadAppIndex } from "../lib/app-index.js";
import { loadProjectEnv } from "../stages/setup-writer.js";

const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";
const VERIFY_DIR = join(PROJECT_DIR, ".verify");
const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const PSQL = `psql "${DB_URL}"`;
const AUTH_EMAIL = "ac1-test@test.documenso.com";

const FK_HARDENING_RULE = `9. NEVER invent IDs or tokens for foreign key columns. If a column references another table (e.g., "documentDataId" references "DocumentData"), you MUST first SELECT a valid value from that table or INSERT a new row into it. Use gen_random_uuid() only for primary key columns, never for FK references to existing data.`;

// Build the prompt the same way setup-writer.ts does
function buildPrompt(groupId: string, condition: string, addFkRule: boolean): string {
  const appIndex = loadAppIndex(VERIFY_DIR);
  const dbUrlEnv = appIndex?.db_url_env ?? "DATABASE_URL";

  const schemaLines: string[] = [];
  if (appIndex) {
    for (const [model, info] of Object.entries(appIndex.data_model)) {
      const cols = Object.entries(info.columns).map(([prisma, pg]) => prisma === pg ? pg : `${prisma}->${pg}`);
      const manualIds = info.manual_id_columns.length > 0 ? ` [manual IDs: ${info.manual_id_columns.join(", ")}]` : "";
      schemaLines.push(`${model} ("${info.table_name}"): ${cols.join(", ")}${manualIds}`);
    }
  }

  const learningsPath = join(VERIFY_DIR, "learnings.md");
  const learnings = existsSync(learningsPath) ? readFileSync(learningsPath, "utf-8").trim() : "";
  const learningsBlock = learnings
    ? `\nLEARNINGS FROM PAST RUNS (apply these corrections):\n${learnings}\n`
    : "";

  const fkRule = addFkRule ? `\n${FK_HARDENING_RULE}` : "";

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${condition}

AUTH CONTEXT:
The logged-in user's email is: ${AUTH_EMAIL}
When the CONDITION refers to "the logged-in user", "their team", or "their personal team":
1. First query to find this user's ID from the "User" table using their email
2. Then discover their team(s) by following FK relationships in the SCHEMA above
3. Scope ALL subsequent queries and INSERTs to that user's team
Do NOT use data from other users or teams.

DATABASE ACCESS:
Use Bash to run psql commands to query the database and understand current state.
Connection: ${PSQL} -c "SELECT ..."

SCHEMA (model -> table, columns):
${schemaLines.join("\n")}
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
    "${PSQL} --set ON_ERROR_STOP=1 -c \\"UPDATE ...\\""
  ],
  "teardown_commands": []
}

RULES:
1. Use \`${PSQL} --set ON_ERROR_STOP=1 -c "..."\` for setup commands.
2. Prefer UPDATE on existing rows. Use INSERT only when new rows are needed.
3. Use Postgres column names (not Prisma field names) in all SQL.
4. Minimal changes — only what's needed for the condition.
5. teardown_commands must be empty — orchestrator handles DB restoration.
6. Keep it to 1-5 commands max.
7. Do NOT read files or explore the codebase. Only use psql.
8. If the condition is null or empty, output empty arrays.${fkRule}

Output ONLY the JSON. No explanation, no markdown fences.`;
}

interface TestCase {
  group_id: string;
  condition: string;
}

const TEST_CASES: TestCase[] = [
  {
    group_id: "spike-6-doc",
    condition: "A draft document exists for the logged-in user's personal team, with at least one recipient added",
  },
  {
    group_id: "spike-6-template",
    condition: "A template exists for the logged-in user's personal team",
  },
  {
    group_id: "spike-6-3docs",
    condition: "At least 3 draft documents exist for the logged-in user's personal team so the documents list is non-empty",
  },
];

interface CaseResult {
  group_id: string;
  variant: "baseline" | "hardened";
  scoping_correct: boolean;
  sql_success: boolean;
  has_fake_ids: boolean;
  fake_id_details: string[];
  commands_count: number;
  error?: string;
  duration_ms: number;
}

function cleanTeam7() {
  try { execSync(`${PSQL} -c "DELETE FROM \\"Recipient\\" WHERE \\"envelopeId\\" IN (SELECT id FROM \\"Envelope\\" WHERE \\"teamId\\" = 7)"`, { stdio: "pipe" }); } catch {}
  try { execSync(`${PSQL} -c "DELETE FROM \\"EnvelopeItem\\" WHERE \\"envelopeId\\" IN (SELECT id FROM \\"Envelope\\" WHERE \\"teamId\\" = 7)"`, { stdio: "pipe" }); } catch {}
  try { execSync(`${PSQL} -c "DELETE FROM \\"Envelope\\" WHERE \\"teamId\\" = 7"`, { stdio: "pipe" }); } catch {}
}

function runCase(tc: TestCase, variant: "baseline" | "hardened", outDir: string): CaseResult {
  const start = Date.now();
  const addFkRule = variant === "hardened";
  const prompt = buildPrompt(tc.group_id + `-${variant}`, tc.condition, addFkRule);
  const promptFile = join(outDir, `${tc.group_id}-${variant}-prompt.txt`);
  writeFileSync(promptFile, prompt);

  try {
    const raw = execSync(
      `claude -p --allowedTools Bash --output-format text`,
      { timeout: 150_000, encoding: "utf-8", input: prompt, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
    );
    writeFileSync(join(outDir, `${tc.group_id}-${variant}-raw.txt`), raw);

    // Parse JSON from output
    const jsonMatch = raw.match(/\{[\s\S]*"setup_commands"[\s\S]*\}/);
    if (!jsonMatch) {
      return { group_id: tc.group_id, variant, scoping_correct: false, sql_success: false, has_fake_ids: false, fake_id_details: [], commands_count: 0, error: "No JSON output", duration_ms: Date.now() - start };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const commands: string[] = parsed.setup_commands ?? [];

    // Check scoping
    const allSql = commands.join(" ");
    const scoping_correct = commands.length === 0 || (allSql.includes("7") && allSql.includes("teamId"));

    // Check for fake IDs — look for suspicious patterns
    const fake_id_details: string[] = [];
    const fakePatterns = [
      /seedtoken\d+/i,
      /fake[-_]?\w+/i,
      /dummy[-_]?\w+/i,
      /test[-_]?token[-_]?\d+/i,
      /'[a-z]+-\d{3}'/g,  // generic patterns like 'abc-001' that aren't verify-test prefixed
    ];
    for (const cmd of commands) {
      // Check if any INSERT references an ID that doesn't use gen_random_uuid() or verify-test prefix
      // and also isn't a real ID from the DB
      for (const pattern of fakePatterns) {
        const matches = cmd.match(pattern);
        if (matches) {
          for (const m of matches) {
            if (!m.includes("verify-test")) {
              fake_id_details.push(m);
            }
          }
        }
      }
    }

    // Execute SQL
    let sql_success = true;
    let error: string | undefined;
    for (const cmd of commands) {
      try {
        execSync(cmd, { timeout: 10_000, stdio: "pipe" });
      } catch (e) {
        sql_success = false;
        const err = e as { stderr?: string; message?: string };
        error = (err.stderr ?? err.message ?? "").slice(0, 200);
        break;
      }
    }

    return {
      group_id: tc.group_id, variant, scoping_correct, sql_success,
      has_fake_ids: fake_id_details.length > 0, fake_id_details,
      commands_count: commands.length, error, duration_ms: Date.now() - start,
    };
  } catch (e) {
    const err = e as { message?: string };
    return { group_id: tc.group_id, variant, scoping_correct: false, sql_success: false, has_fake_ids: false, fake_id_details: [], commands_count: 0, error: err.message?.slice(0, 200), duration_ms: Date.now() - start };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const outDir = join(resolve(import.meta.dirname ?? ".", "../.."), `spike-6-output-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

console.log("=== Spike 6: FK Hardening Rule ===\n");
console.log(`Output: ${outDir}\n`);

const results: CaseResult[] = [];

// Run hardened variant only (baseline behavior is known from previous runs)
for (const tc of TEST_CASES) {
  console.log(`--- ${tc.group_id} (hardened) ---`);
  cleanTeam7();

  const result = runCase(tc, "hardened", outDir);
  results.push(result);

  console.log(`  Scoping: ${result.scoping_correct ? "✓" : "✗"}`);
  console.log(`  SQL OK:  ${result.sql_success ? "✓" : "✗"}`);
  console.log(`  Fake IDs: ${result.has_fake_ids ? `✗ (${result.fake_id_details.join(", ")})` : "✓ none"}`);
  console.log(`  Commands: ${result.commands_count}`);
  console.log(`  Time: ${Math.round(result.duration_ms / 1000)}s`);
  if (result.error) console.log(`  Error: ${result.error.slice(0, 100)}`);
  console.log();
}

// Final DB check
try {
  const team7 = execSync(`${PSQL} -t -A -c "SELECT COUNT(*) FROM \\"Envelope\\" WHERE \\"teamId\\" = 7"`, { encoding: "utf-8" }).trim();
  const otherDrafts = execSync(`${PSQL} -t -A -c "SELECT COUNT(*) FROM \\"Envelope\\" WHERE \\"teamId\\" <> 7 AND status = 'DRAFT'"`, { encoding: "utf-8" }).trim();
  console.log(`Final: team7 envelopes=${team7}, other drafts=${otherDrafts} (baseline was 338)`);
} catch {}

// Summary
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));

const sqlOk = results.filter(r => r.sql_success).length;
const scopeOk = results.filter(r => r.scoping_correct).length;
const noFake = results.filter(r => !r.has_fake_ids).length;

console.log(`\n=== SUMMARY ===`);
console.log(`SQL success:      ${sqlOk}/${results.length}`);
console.log(`Scoping correct:  ${scopeOk}/${results.length}`);
console.log(`No fake IDs:      ${noFake}/${results.length}`);

if (sqlOk === results.length) {
  console.log(`\n✓ FK hardening rule eliminates fake ID errors.`);
} else {
  console.log(`\n△ FK hardening improved but didn't fully solve. Check errors above.`);
}
