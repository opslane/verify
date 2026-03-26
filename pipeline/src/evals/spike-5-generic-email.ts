#!/usr/bin/env npx tsx
/**
 * Spike 5: Generic email-based scoping for setup-writer.
 *
 * Tests whether injecting auth email + generic FK-discovery instructions
 * (no hardcoded joins) lets the LLM correctly scope SQL to the logged-in
 * user's team. The LLM must discover the User → Team FK chain from the
 * schema that's already in the prompt.
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-5-generic-email.ts
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ── Config ──────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";
const VERIFY_DIR = join(PROJECT_DIR, ".verify");
const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const PSQL = `psql "${DB_URL}"`;
const AUTH_EMAIL = "ac1-test@test.documenso.com";
const EXPECTED_TEAM_ID = 7;

const timestamp = Date.now();
const outputDir = resolve(
  import.meta.dirname ?? ".",
  `../../spike-5-output-${timestamp}`,
);
mkdirSync(join(outputDir, "logs"), { recursive: true });

// ── Load app.json schema ────────────────────────────────────────────────────

interface AppIndex {
  data_model: Record<
    string,
    {
      table_name: string;
      columns: Record<string, string>;
      manual_id_columns: string[];
    }
  >;
  db_url_env?: string;
  seed_ids?: string[];
}

function loadAppIndex(): AppIndex | null {
  const path = join(VERIFY_DIR, "app.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AppIndex;
  } catch {
    return null;
  }
}

// ── Build schema lines (same as setup-writer.ts) ────────────────────────────

function buildSchemaLines(appIndex: AppIndex): string[] {
  const lines: string[] = [];
  for (const [model, info] of Object.entries(appIndex.data_model)) {
    const cols = Object.entries(info.columns).map(([prisma, pg]) =>
      prisma === pg ? pg : `${prisma}->${pg}`,
    );
    const manualIds =
      info.manual_id_columns.length > 0
        ? ` [manual IDs: ${info.manual_id_columns.join(", ")}]`
        : "";
    lines.push(
      `${model} ("${info.table_name}"): ${cols.join(", ")}${manualIds}`,
    );
  }
  return lines;
}

// ── Build the modified prompt with AUTH CONTEXT ─────────────────────────────

function buildPromptWithAuth(
  groupId: string,
  condition: string,
  schemaLines: string[],
  learnings: string,
): string {
  const learningsBlock = learnings
    ? `\nLEARNINGS FROM PAST RUNS (apply these corrections):\n${learnings}\n`
    : "";

  return `You are a setup writer. Generate MINIMAL SQL to put the database into the required state.

GROUP: ${groupId}
CONDITION: ${condition}

AUTH CONTEXT:
The logged-in user's email is: ${AUTH_EMAIL}
When the CONDITION refers to "the logged-in user", "their team", or "their personal team":
1. First query to find this user's ID: SELECT id FROM "User" WHERE email = '${AUTH_EMAIL}'
2. Then discover their team(s) by following FK relationships in the schema above
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
8. If the condition is null or empty, output empty arrays.

Output ONLY the JSON. No explanation, no markdown fences.`;
}

// ── Parse JSON from LLM output ─────────────────────────────────────────────

interface SetupOutput {
  group_id: string;
  condition: string;
  setup_commands: string[];
  teardown_commands: string[];
}

function parseJsonOutput(raw: string): SetupOutput | null {
  if (!raw || !raw.trim()) return null;
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  try {
    return JSON.parse(text) as SetupOutput;
  } catch {
    // Fall through
  }

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let lastClose = text.lastIndexOf("}");
      while (lastClose >= i) {
        try {
          return JSON.parse(text.slice(i, lastClose + 1)) as SetupOutput;
        } catch {
          lastClose = text.lastIndexOf("}", lastClose - 1);
        }
      }
    }
  }
  return null;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

function psqlQuery(sql: string): string {
  return execSync(`psql "${DB_URL}" -t -A -c '${sql.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
}

function psqlQueryCount(sql: string): number {
  const result = psqlQuery(sql);
  return parseInt(result, 10) || 0;
}

// ── Test cases ──────────────────────────────────────────────────────────────

interface TestCase {
  group: string;
  condition: string;
  postCheck: () => { passed: boolean; details: string };
}

const TEST_CASES: TestCase[] = [
  {
    group: "spike-5-doc",
    condition:
      "A draft document exists for the logged-in user's personal team, with at least one recipient added",
    postCheck: () => {
      const envCount = psqlQueryCount(
        `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${EXPECTED_TEAM_ID} AND status = 'DRAFT'`,
      );
      const recipCount = psqlQueryCount(
        `SELECT COUNT(*) FROM "Recipient" r JOIN "Envelope" e ON r."envelopeId" = e.id WHERE e."teamId" = ${EXPECTED_TEAM_ID} AND e.status = 'DRAFT'`,
      );
      const passed = envCount >= 1 && recipCount >= 1;
      return {
        passed,
        details: `Envelopes(draft, team ${EXPECTED_TEAM_ID}): ${envCount}, Recipients on those: ${recipCount}`,
      };
    },
  },
  {
    group: "spike-5-3docs",
    condition:
      "At least 3 draft documents exist for the logged-in user's personal team so the documents list is non-empty",
    postCheck: () => {
      const envCount = psqlQueryCount(
        `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${EXPECTED_TEAM_ID} AND status = 'DRAFT'`,
      );
      const passed = envCount >= 3;
      return {
        passed,
        details: `Envelopes(draft, team ${EXPECTED_TEAM_ID}): ${envCount} (need >= 3)`,
      };
    },
  },
  {
    group: "spike-5-template",
    condition:
      "A template exists for the logged-in user's personal team",
    postCheck: () => {
      const count = psqlQueryCount(
        `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = ${EXPECTED_TEAM_ID} AND "type" = 'TEMPLATE'`,
      );
      const passed = count >= 1;
      return {
        passed,
        details: `Templates(team ${EXPECTED_TEAM_ID}): ${count}`,
      };
    },
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

interface CaseResult {
  group: string;
  condition: string;
  status: "success" | "parse_error" | "sql_error" | "scoping_error" | "timeout" | "crash";
  commands: string[];
  postCheck: { passed: boolean; details: string } | null;
  crossTeamPollution: boolean;
  fkDiscovery: string;
  scopingDetails: string;
  error?: string;
  durationMs: number;
  rawOutputFile: string;
}

async function main() {
  const appIndex = loadAppIndex();
  if (!appIndex) {
    console.error("ERROR: Could not load app.json from", VERIFY_DIR);
    process.exit(1);
  }

  const schemaLines = buildSchemaLines(appIndex);
  const learningsPath = join(VERIFY_DIR, "learnings.md");
  const learnings = existsSync(learningsPath)
    ? readFileSync(learningsPath, "utf-8").trim()
    : "";

  console.log(`\n=== Spike 5: Generic email-based scoping ===\n`);
  console.log(`Auth email:     ${AUTH_EMAIL}`);
  console.log(`Expected team:  ${EXPECTED_TEAM_ID}`);
  console.log(`Output dir:     ${outputDir}`);
  console.log(`Test cases:     ${TEST_CASES.length}\n`);

  // Save cross-team baseline
  const baselineDraftOthers = psqlQueryCount(
    `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" != ${EXPECTED_TEAM_ID} AND status = 'DRAFT'`,
  );
  const baselineTemplateOthers = psqlQueryCount(
    `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" != ${EXPECTED_TEAM_ID} AND "type" = 'TEMPLATE'`,
  );
  console.log(`Baseline: ${baselineDraftOthers} draft envelopes for other teams`);
  console.log(`Baseline: ${baselineTemplateOthers} templates for other teams\n`);

  const results: CaseResult[] = [];

  for (const tc of TEST_CASES) {
    console.log(`--- ${tc.group} ---`);
    console.log(`  Condition: "${tc.condition}"`);

    const prompt = buildPromptWithAuth(tc.group, tc.condition, schemaLines, learnings);
    const promptFile = join(outputDir, `${tc.group}-prompt.txt`);
    writeFileSync(promptFile, prompt);

    const start = Date.now();
    let rawOutput = "";
    const rawFile = join(outputDir, `${tc.group}-raw-output.txt`);

    try {
      // Run claude -p with the prompt
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      rawOutput = execSync(
        `claude -p '${escapedPrompt}' --allowedTools Bash`,
        {
          encoding: "utf-8",
          timeout: 150_000,
          maxBuffer: 10 * 1024 * 1024,
          cwd: PROJECT_DIR,
        },
      );
      writeFileSync(rawFile, rawOutput);
      const durationMs = Date.now() - start;
      console.log(`  LLM completed in ${Math.round(durationMs / 1000)}s`);

      // Parse output
      const parsed = parseJsonOutput(rawOutput);
      if (!parsed || !Array.isArray(parsed.setup_commands)) {
        console.log(`  FAIL: Could not parse JSON from LLM output`);
        results.push({
          group: tc.group,
          condition: tc.condition,
          status: "parse_error",
          commands: [],
          postCheck: null,
          crossTeamPollution: false,
          fkDiscovery: "N/A",
          scopingDetails: "N/A",
          durationMs,
          rawOutputFile: rawFile,
        });
        continue;
      }

      console.log(`  Commands: ${parsed.setup_commands.length}`);
      for (const cmd of parsed.setup_commands) {
        const sqlMatch = cmd.match(/-c\s+"(.+?)"/s) ?? cmd.match(/-c\s+'(.+?)'/s);
        const sql = sqlMatch?.[1] ?? cmd;
        console.log(`    SQL: ${sql.slice(0, 140)}${sql.length > 140 ? "..." : ""}`);
      }

      // ── Scoping analysis ────────────────────────────────────────────────
      // Check if commands reference teamId=7
      const allCmds = parsed.setup_commands.join(" ");
      const refsTeam7 =
        allCmds.includes("= 7") ||
        allCmds.includes("=7") ||
        allCmds.includes("teamId") && allCmds.includes("7");
      // Check if commands reference other team IDs
      const otherTeamIds = [...allCmds.matchAll(/"teamId"\s*=\s*(\d+)/g)]
        .map((m) => parseInt(m[1], 10))
        .filter((id) => id !== EXPECTED_TEAM_ID);
      const scopingDetails = `References team ${EXPECTED_TEAM_ID}: ${refsTeam7}. Other team IDs referenced: ${otherTeamIds.length > 0 ? otherTeamIds.join(", ") : "none"}`;
      console.log(`  Scoping: ${scopingDetails}`);

      // ── FK discovery analysis ───────────────────────────────────────────
      // Look in raw output for what tables/queries the LLM used to find user's team
      const fkPatterns = [
        /SELECT.*FROM.*"User".*WHERE.*email/gi,
        /SELECT.*FROM.*"Team".*WHERE/gi,
        /SELECT.*FROM.*"OrganisationMember"/gi,
        /SELECT.*FROM.*"Organisation"/gi,
        /JOIN.*"Team"/gi,
        /JOIN.*"OrganisationMember"/gi,
      ];
      const fkMatches: string[] = [];
      for (const pat of fkPatterns) {
        const matches = rawOutput.match(pat);
        if (matches) fkMatches.push(...matches.map((m) => m.trim().slice(0, 100)));
      }
      const fkDiscovery =
        fkMatches.length > 0
          ? `Found ${fkMatches.length} FK discovery queries: ${fkMatches.join(" | ")}`
          : "No FK discovery queries detected in raw output";
      console.log(`  FK discovery: ${fkDiscovery}`);

      // ── Execute SQL commands ────────────────────────────────────────────
      let execError: string | undefined;
      for (const cmd of parsed.setup_commands) {
        try {
          execSync(cmd, {
            timeout: 15_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            cwd: PROJECT_DIR,
          });
        } catch (e) {
          const err = e as { stderr?: string; message?: string };
          execError =
            err.stderr?.slice(0, 300) ?? err.message?.slice(0, 300) ?? "unknown error";
          console.log(`  SQL EXEC FAIL: ${execError.slice(0, 150)}`);
          break;
        }
      }

      if (execError) {
        results.push({
          group: tc.group,
          condition: tc.condition,
          status: "sql_error",
          commands: parsed.setup_commands,
          postCheck: null,
          crossTeamPollution: false,
          fkDiscovery,
          scopingDetails,
          error: execError,
          durationMs,
          rawOutputFile: rawFile,
        });
        continue;
      }

      // ── Post-check ──────────────────────────────────────────────────────
      const postCheck = tc.postCheck();
      console.log(`  Post-check: ${postCheck.passed ? "PASS" : "FAIL"} — ${postCheck.details}`);

      // ── Cross-team pollution check ────────────────────────────────────
      const currentDraftOthers = psqlQueryCount(
        `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" != ${EXPECTED_TEAM_ID} AND status = 'DRAFT'`,
      );
      const currentTemplateOthers = psqlQueryCount(
        `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" != ${EXPECTED_TEAM_ID} AND "type" = 'TEMPLATE'`,
      );
      const crossTeamPollution =
        currentDraftOthers !== baselineDraftOthers ||
        currentTemplateOthers !== baselineTemplateOthers;
      if (crossTeamPollution) {
        console.log(
          `  CROSS-TEAM POLLUTION: drafts ${baselineDraftOthers}->${currentDraftOthers}, templates ${baselineTemplateOthers}->${currentTemplateOthers}`,
        );
      } else {
        console.log(`  Cross-team: clean (no pollution)`);
      }

      const status =
        !postCheck.passed
          ? "scoping_error"
          : otherTeamIds.length > 0
            ? "scoping_error"
            : "success";

      results.push({
        group: tc.group,
        condition: tc.condition,
        status,
        commands: parsed.setup_commands,
        postCheck,
        crossTeamPollution,
        fkDiscovery,
        scopingDetails,
        durationMs,
        rawOutputFile: rawFile,
      });
    } catch (e) {
      const durationMs = Date.now() - start;
      const err = e as { killed?: boolean; message?: string };
      const status = err.killed ? "timeout" : "crash";
      console.log(`  ${status.toUpperCase()}: ${err.message?.slice(0, 150)}`);
      writeFileSync(rawFile, rawOutput || `ERROR: ${err.message}`);
      results.push({
        group: tc.group,
        condition: tc.condition,
        status,
        commands: [],
        postCheck: null,
        crossTeamPollution: false,
        fkDiscovery: "N/A",
        scopingDetails: "N/A",
        error: err.message?.slice(0, 300),
        durationMs,
        rawOutputFile: rawFile,
      });
    }

    console.log();
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  SPIKE 5 RESULTS — Generic email scoping`);
  console.log(`${"=".repeat(60)}\n`);

  const successes = results.filter((r) => r.status === "success");
  const sqlErrors = results.filter((r) => r.status === "sql_error");
  const parseErrors = results.filter((r) => r.status === "parse_error");
  const scopingErrors = results.filter((r) => r.status === "scoping_error");
  const timeouts = results.filter((r) => r.status === "timeout");
  const crashes = results.filter((r) => r.status === "crash");

  console.log(`  Success:        ${successes.length}/${results.length}`);
  console.log(`  SQL errors:     ${sqlErrors.length}/${results.length}`);
  console.log(`  Parse errors:   ${parseErrors.length}/${results.length}`);
  console.log(`  Scoping errors: ${scopingErrors.length}/${results.length}`);
  console.log(`  Timeouts:       ${timeouts.length}/${results.length}`);
  console.log(`  Crashes:        ${crashes.length}/${results.length}`);

  const anyPollution = results.some((r) => r.crossTeamPollution);
  console.log(`\n  Cross-team pollution: ${anyPollution ? "YES (BAD)" : "NONE (good)"}`);

  console.log(`\n  Per-case details:`);
  for (const r of results) {
    console.log(`\n    [${r.status.toUpperCase()}] ${r.group} (${Math.round(r.durationMs / 1000)}s)`);
    console.log(`      Condition: ${r.condition}`);
    console.log(`      Scoping: ${r.scopingDetails}`);
    console.log(`      FK discovery: ${r.fkDiscovery}`);
    if (r.postCheck) {
      console.log(`      Post-check: ${r.postCheck.passed ? "PASS" : "FAIL"} — ${r.postCheck.details}`);
    }
    if (r.crossTeamPollution) {
      console.log(`      CROSS-TEAM POLLUTION DETECTED`);
    }
    if (r.error) {
      console.log(`      Error: ${r.error.slice(0, 150)}`);
    }
    console.log(`      Commands: ${r.commands.length}`);
    console.log(`      Raw output: ${r.rawOutputFile}`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  VERDICT`);
  console.log(`${"=".repeat(60)}\n`);

  const successRate = successes.length / results.length;
  if (successRate >= 0.66 && !anyPollution) {
    console.log(
      `  PASS: Generic email scoping works ${Math.round(successRate * 100)}% of the time.`,
    );
    console.log(
      `  The LLM successfully discovers the FK chain and scopes SQL to the correct team.`,
    );
    console.log(`  No hardcoded joins needed — this approach is project-agnostic.`);
  } else if (successes.length + sqlErrors.length >= results.length * 0.66) {
    console.log(
      `  PARTIAL: LLM generates scoped SQL but ${sqlErrors.length} cases have execution errors.`,
    );
    console.log(`  The FK discovery works but SQL details need refinement (learnings).`);
  } else {
    console.log(
      `  FAIL: Generic email scoping works only ${Math.round(successRate * 100)}% of the time.`,
    );
    if (anyPollution) {
      console.log(`  Cross-team pollution detected — scoping is unreliable.`);
    }
  }

  console.log();

  // Write results JSON
  const resultsPath = join(outputDir, "spike-5-results.json");
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  console.log(`Full results: ${resultsPath}`);
  console.log(`Output dir:   ${outputDir}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
