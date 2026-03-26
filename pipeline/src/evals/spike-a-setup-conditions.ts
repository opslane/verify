#!/usr/bin/env npx tsx
/**
 * Spike A: Can the setup-writer produce correct SQL when given a good condition?
 *
 * Takes failed missing_data PRs, crafts explicit condition strings, and runs
 * setup-writer in isolation to see if it generates valid SQL. Validates that
 * the downstream (setup-writer) works — the problem is just that it never gets invoked.
 *
 * Usage:
 *   npx tsx src/evals/spike-a-setup-conditions.ts --project-dir /path/to/documenso
 *
 * Requires:
 *   - A documenso checkout with .verify/app.json already indexed
 *   - The documenso DB running and seeded
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "project-dir": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const projectDir = values["project-dir"];
if (!projectDir) {
  console.error("Usage: npx tsx src/evals/spike-a-setup-conditions.ts --project-dir /path/to/documenso");
  process.exit(1);
}

const dryRun = values["dry-run"] ?? false;
const verifyDir = join(resolve(projectDir), ".verify");

// ── Test cases: PRs that failed with missing_data ──────────────────────────────

interface TestCase {
  pr: number;
  title: string;
  group_id: string;
  condition: string;
  /** What we expect: a description of what the SQL should create */
  expected_outcome: string;
  /** Difficulty: simple (UPDATE/single INSERT), medium (multi-INSERT), hard (FK graph) */
  difficulty: "simple" | "medium" | "hard";
}

const TEST_CASES: TestCase[] = [
  {
    pr: 2626,
    title: "fix(ui): add scroll to date format dropdown",
    group_id: "spike-a-doc",
    condition: "A draft document exists for the logged-in user's personal team, with at least one recipient added",
    expected_outcome: "INSERT into Envelope + related tables to create a viewable document",
    difficulty: "hard",
  },
  {
    pr: 2636,
    title: "fix: prevent managers from deleting admin invitations",
    group_id: "spike-a-org",
    condition: "An organisation named 'verifyorg' exists with a manager-role member (the logged-in user) and a pending admin-role invitation",
    expected_outcome: "INSERT into Team (as org), TeamMember (manager role), TeamMemberInvite (admin role)",
    difficulty: "medium",
  },
  {
    pr: 2605,
    title: "fix: template description overflow",
    group_id: "spike-a-template",
    condition: "A template exists for the logged-in user with a publicDescription longer than 100 characters containing no spaces",
    expected_outcome: "INSERT into Template with a long unbroken description string",
    difficulty: "simple",
  },
  {
    pr: 2585,
    title: "fix: opt findDocumentsInternal query out of batch fetching",
    group_id: "spike-a-envelope",
    condition: "At least 3 draft documents exist for the logged-in user's personal team so the documents list is non-empty",
    expected_outcome: "INSERT into Envelope + DocumentMeta (required FK) for 3 documents",
    difficulty: "hard",
  },
];

// ── Run setup-writer for each test case ────────────────────────────────────────

const pipelineDir = resolve(import.meta.dirname ?? ".", "../..");
const runDir = join(verifyDir, "runs", `spike-a-${Date.now()}`);
mkdirSync(join(runDir, "logs"), { recursive: true });

console.log(`\n=== Spike A: Setup-writer capability test ===\n`);
console.log(`Project dir:  ${projectDir}`);
console.log(`Verify dir:   ${verifyDir}`);
console.log(`Run dir:      ${runDir}`);
console.log(`Dry run:      ${dryRun}`);
console.log(`Test cases:   ${TEST_CASES.length}\n`);

interface CaseResult {
  pr: number;
  title: string;
  difficulty: string;
  condition: string;
  status: "success" | "parse_error" | "sql_error" | "timeout" | "crash";
  commands: string[];
  error?: string;
  duration_ms: number;
}

const caseResults: CaseResult[] = [];

for (const tc of TEST_CASES) {
  console.log(`--- PR ${tc.pr}: ${tc.title} (${tc.difficulty}) ---`);
  console.log(`  Condition: "${tc.condition}"`);
  console.log(`  Expected:  ${tc.expected_outcome}`);

  const start = Date.now();
  const caseRunDir = join(runDir, `pr-${tc.pr}`);
  mkdirSync(join(caseRunDir, "logs"), { recursive: true });

  try {
    // Run setup-writer via CLI — use execFileSync to avoid shell quoting issues
    const args = [
      "tsx", "src/cli.ts", "run-stage", "setup-writer",
      "--verify-dir", verifyDir,
      "--run-dir", caseRunDir,
      "--group", tc.group_id,
      "--condition", tc.condition,
      "--timeout", "120",
    ];

    console.log(`  Running: npx tsx src/cli.ts run-stage setup-writer --condition "${tc.condition.slice(0, 60)}..."...`);

    if (dryRun) {
      console.log(`  [DRY RUN] Would run setup-writer\n`);
      caseResults.push({
        pr: tc.pr, title: tc.title, difficulty: tc.difficulty,
        condition: tc.condition, status: "success", commands: [],
        duration_ms: 0,
      });
      continue;
    }

    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("npx", args, {
      cwd: pipelineDir,
      timeout: 150_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const duration = Date.now() - start;

    // Read the generated setup.json
    const setupPath = join(caseRunDir, "setup.json");
    let commands: string[] = [];
    try {
      const setup = JSON.parse(readFileSync(setupPath, "utf-8"));
      commands = setup.setup_commands ?? [];
    } catch {
      console.log(`  ✗ Parse error — setup.json not found or invalid`);
      caseResults.push({
        pr: tc.pr, title: tc.title, difficulty: tc.difficulty,
        condition: tc.condition, status: "parse_error", commands: [],
        duration_ms: duration,
      });
      continue;
    }

    console.log(`  ✓ Generated ${commands.length} SQL commands in ${Math.round(duration / 1000)}s`);
    for (const cmd of commands) {
      // Print just the SQL part (strip psql wrapper)
      const sqlMatch = cmd.match(/-c\s+"(.+)"/s);
      const sql = sqlMatch?.[1] ?? cmd;
      console.log(`    SQL: ${sql.slice(0, 120)}${sql.length > 120 ? "..." : ""}`);
    }

    // Try executing the commands against the DB
    let execError: string | undefined;
    for (const sqlCmd of commands) {
      try {
        execSync(sqlCmd, {
          cwd: projectDir,
          timeout: 10_000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        execError = err.stderr?.slice(0, 200) ?? err.message ?? "unknown error";
        console.log(`  ✗ SQL execution failed: ${execError.slice(0, 100)}`);
        break;
      }
    }

    caseResults.push({
      pr: tc.pr, title: tc.title, difficulty: tc.difficulty,
      condition: tc.condition,
      status: execError ? "sql_error" : "success",
      commands,
      error: execError,
      duration_ms: duration,
    });

  } catch (e) {
    const duration = Date.now() - start;
    const err = e as { message?: string; killed?: boolean };
    const status = err.killed ? "timeout" : "crash";
    console.log(`  ✗ ${status}: ${err.message?.slice(0, 100)}`);
    caseResults.push({
      pr: tc.pr, title: tc.title, difficulty: tc.difficulty,
      condition: tc.condition, status, commands: [],
      error: err.message?.slice(0, 200),
      duration_ms: duration,
    });
  }

  console.log();
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n=== RESULTS ===\n`);

const successes = caseResults.filter(r => r.status === "success");
const sqlErrors = caseResults.filter(r => r.status === "sql_error");
const parseErrors = caseResults.filter(r => r.status === "parse_error");
const timeouts = caseResults.filter(r => r.status === "timeout");
const crashes = caseResults.filter(r => r.status === "crash");

console.log(`  Success:     ${successes.length}/${caseResults.length}`);
console.log(`  SQL errors:  ${sqlErrors.length}/${caseResults.length}`);
console.log(`  Parse errors:${parseErrors.length}/${caseResults.length}`);
console.log(`  Timeouts:    ${timeouts.length}/${caseResults.length}`);
console.log(`  Crashes:     ${crashes.length}/${caseResults.length}`);

if (sqlErrors.length > 0) {
  console.log(`\n  SQL error details:`);
  for (const r of sqlErrors) {
    console.log(`    PR ${r.pr} (${r.difficulty}): ${r.error?.slice(0, 100)}`);
  }
}

// By difficulty
console.log(`\n  By difficulty:`);
for (const diff of ["simple", "medium", "hard"] as const) {
  const cases = caseResults.filter(r => r.difficulty === diff);
  const ok = cases.filter(r => r.status === "success").length;
  console.log(`    ${diff}: ${ok}/${cases.length} success`);
}

// Write full results
const resultsPath = join(runDir, "spike-a-results.json");
writeFileSync(resultsPath, JSON.stringify(caseResults, null, 2));
console.log(`\n  Full results: ${resultsPath}`);

// Verdict
console.log(`\n=== VERDICT ===\n`);
const successRate = successes.length / caseResults.length;
if (successRate >= 0.75) {
  console.log(`✓ Setup-writer succeeds ${Math.round(successRate * 100)}% when given good conditions.`);
  console.log(`  The bottleneck is NOT the setup-writer — it's that conditions are never emitted.`);
  console.log(`  → Hypothesis #1 (expand planner to emit prerequisites) is validated.`);
} else if (successes.length + sqlErrors.length >= caseResults.length * 0.75) {
  console.log(`△ Setup-writer generates SQL ${Math.round((successes.length + sqlErrors.length) / caseResults.length * 100)}% of the time,`);
  console.log(`  but ${sqlErrors.length} cases have SQL errors (likely FK/constraint issues).`);
  console.log(`  → Hypothesis #1 is partially validated — also need better schema awareness.`);
} else {
  console.log(`✗ Setup-writer fails ${Math.round((1 - successRate) * 100)}% even with good conditions.`);
  console.log(`  → The problem is deeper than just missing conditions.`);
}
console.log();
