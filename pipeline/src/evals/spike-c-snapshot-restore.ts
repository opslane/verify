#!/usr/bin/env npx tsx
/**
 * Spike C: Can SNAPSHOT/RESTORE replace the LLM setup-writer?
 *
 * Tests the hypothesis that seeded DB data is sufficient for most AC checks,
 * making the setup-writer stage unnecessary. For each repo:
 *   1. Discovers the schema
 *   2. Checks 6 realistic conditions against seeded data
 *   3. Classifies each as SATISFIED or NOT_SATISFIED
 *   4. Tests pg_dump snapshot/restore mechanism
 *
 * Key question: What percentage of realistic conditions are already satisfied
 * by seed data? If <50%, snapshot/restore alone is too limited. If >70%, we
 * might not need a setup-writer at all.
 *
 * Usage:
 *   npx tsx src/evals/spike-c-snapshot-restore.ts
 *
 * Requires:
 *   - Documenso DB running at postgresql://documenso:password@localhost:54320/documenso
 *   - Cal.com DB running at postgresql://calcom:calcom@localhost:5432/calcom
 */

import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ── Types ───────────────────────────────────────────────────────────────────

interface Condition {
  id: string;
  description: string;
  /** SQL that returns a single integer count; >0 means SATISFIED */
  checkSql: string;
  /** Table to test snapshot/restore on */
  snapshotTable: string;
}

interface RepoConfig {
  name: string;
  dbUrl: string;
  /** psql connection flags */
  psqlArgs: string[];
  password: string;
  conditions: Condition[];
}

interface ConditionResult {
  id: string;
  description: string;
  status: "SATISFIED" | "NOT_SATISFIED" | "ERROR";
  count: number;
  error?: string;
}

interface SnapshotResult {
  table: string;
  dumpOk: boolean;
  dumpSizeBytes: number;
  restoreOk: boolean;
  error?: string;
}

interface RepoResult {
  repo: string;
  dbUrl: string;
  conditions: ConditionResult[];
  snapshots: SnapshotResult[];
  satisfiedCount: number;
  totalCount: number;
  satisfiedPct: number;
}

// ── Repo definitions ────────────────────────────────────────────────────────

const repos: RepoConfig[] = [
  {
    name: "documenso",
    dbUrl: "postgresql://documenso:password@localhost:54320/documenso",
    psqlArgs: ["-h", "localhost", "-p", "54320", "-U", "documenso", "-d", "documenso"],
    password: "password",
    conditions: [
      {
        id: "doc-1",
        description:
          "A draft document exists for the logged-in user's personal team (teamId=7)",
        checkSql: `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = 7 AND "status" = 'DRAFT'`,
        snapshotTable: "Envelope",
      },
      {
        id: "doc-2",
        description:
          "At least 3 draft documents exist for the logged-in user's personal team",
        checkSql: `SELECT CASE WHEN COUNT(*) >= 3 THEN COUNT(*) ELSE 0 END FROM "Envelope" WHERE "teamId" = 7 AND "status" = 'DRAFT'`,
        snapshotTable: "Envelope",
      },
      {
        id: "doc-3",
        description: "A template exists for the logged-in user's personal team",
        checkSql: `SELECT COUNT(*) FROM "Envelope" WHERE "teamId" = 7 AND "type" = 'TEMPLATE'`,
        snapshotTable: "Envelope",
      },
      {
        id: "doc-4",
        description: "An organisation exists with a manager-role member (userId=9)",
        checkSql: `SELECT COUNT(*) FROM "OrganisationGroupMember" ogm JOIN "OrganisationGroup" og ON og.id = ogm."groupId" JOIN "OrganisationMember" om ON om.id = ogm."organisationMemberId" WHERE om."userId" = 9 AND og."organisationRole" = 'MANAGER'`,
        snapshotTable: "OrganisationMember",
      },
      {
        id: "doc-5",
        description: "A completed document exists with a signed recipient",
        checkSql: `SELECT COUNT(*) FROM "Envelope" e JOIN "Recipient" r ON r."envelopeId" = e."id" WHERE e."status" = 'COMPLETED' AND r."signingStatus" = 'SIGNED'`,
        snapshotTable: "Recipient",
      },
      {
        id: "doc-6",
        description: "A webhook exists for the logged-in user's team (teamId=7)",
        checkSql: `SELECT COUNT(*) FROM "Webhook" WHERE "teamId" = 7`,
        snapshotTable: "Webhook",
      },
    ],
  },
  {
    name: "calcom",
    dbUrl: "postgresql://calcom:calcom@localhost:5432/calcom",
    psqlArgs: ["-h", "localhost", "-p", "5432", "-U", "calcom", "-d", "calcom"],
    password: "calcom",
    conditions: [
      {
        id: "cal-1",
        description: "An event type exists for the logged-in user (pro@example.com)",
        checkSql: `SELECT COUNT(*) FROM "EventType" WHERE "userId" = (SELECT id FROM users WHERE email = 'pro@example.com')`,
        snapshotTable: "EventType",
      },
      {
        id: "cal-2",
        description: "A booking exists for the logged-in user",
        checkSql: `SELECT COUNT(*) FROM "Booking" WHERE "userId" = (SELECT id FROM users WHERE email = 'pro@example.com')`,
        snapshotTable: "Booking",
      },
      {
        id: "cal-3",
        description: "A webhook exists for the logged-in user",
        checkSql: `SELECT COUNT(*) FROM "Webhook" WHERE "userId" = (SELECT id FROM users WHERE email = 'pro@example.com')`,
        snapshotTable: "Webhook",
      },
      {
        id: "cal-4",
        description: "A team exists that the logged-in user is a member of",
        checkSql: `SELECT COUNT(*) FROM "Membership" WHERE "userId" = (SELECT id FROM users WHERE email = 'pro@example.com')`,
        snapshotTable: "Membership",
      },
      {
        id: "cal-5",
        description: "An availability schedule exists for the logged-in user",
        checkSql: `SELECT COUNT(*) FROM "Schedule" WHERE "userId" = (SELECT id FROM users WHERE email = 'pro@example.com')`,
        snapshotTable: "Schedule",
      },
      {
        id: "cal-6",
        description: "A payment exists for a booking",
        checkSql: `SELECT COUNT(*) FROM "Payment" LIMIT 1`,
        snapshotTable: "Payment",
      },
    ],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runPsql(repo: RepoConfig, sql: string): string {
  const env = { ...process.env, PGPASSWORD: repo.password };
  const cmd = `psql ${repo.psqlArgs.join(" ")} -t -A -c ${shellEscape(sql)}`;
  return execSync(cmd, { encoding: "utf-8", env, timeout: 15_000 }).trim();
}

function checkCondition(repo: RepoConfig, condition: Condition): ConditionResult {
  try {
    const raw = runPsql(repo, condition.checkSql);
    const count = parseInt(raw, 10);
    return {
      id: condition.id,
      description: condition.description,
      status: count > 0 ? "SATISFIED" : "NOT_SATISFIED",
      count: isNaN(count) ? 0 : count,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: condition.id,
      description: condition.description,
      status: "ERROR",
      count: 0,
      error: msg.slice(0, 500),
    };
  }
}

function testSnapshot(
  repo: RepoConfig,
  table: string,
  snapshotDir: string,
): SnapshotResult {
  const dumpFile = join(snapshotDir, `snapshot-${table}.sql`);
  const env = { ...process.env, PGPASSWORD: repo.password };
  const pgDumpArgs = repo.psqlArgs.join(" ");

  // Step 1: pg_dump the table (data only, as INSERT statements)
  let dumpOk = false;
  let dumpSizeBytes = 0;
  try {
    const dumpCmd = `pg_dump ${pgDumpArgs} -t '"${table}"' --data-only --inserts > ${shellEscape(dumpFile)}`;
    execSync(dumpCmd, { encoding: "utf-8", env, timeout: 30_000 });
    dumpSizeBytes = statSync(dumpFile).size;
    dumpOk = dumpSizeBytes > 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      table,
      dumpOk: false,
      dumpSizeBytes: 0,
      restoreOk: false,
      error: `dump failed: ${msg.slice(0, 300)}`,
    };
  }

  // Step 2: Verify the dump is restorable inside a rolled-back transaction
  let restoreOk = false;
  try {
    const restoreScript = join(snapshotDir, `restore-test-${table}.sql`);
    writeFileSync(
      restoreScript,
      `BEGIN;\n\\i ${dumpFile}\nROLLBACK;\n`,
    );
    execSync(`psql ${repo.psqlArgs.join(" ")} -f ${shellEscape(restoreScript)}`, {
      encoding: "utf-8",
      env,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    restoreOk = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      table,
      dumpOk,
      dumpSizeBytes,
      restoreOk: false,
      error: `restore failed: ${msg.slice(0, 300)}`,
    };
  }

  return { table, dumpOk, dumpSizeBytes, restoreOk };
}

function discoverTables(repo: RepoConfig): string[] {
  try {
    const sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    const raw = runPsql(repo, sql);
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function discoverSchema(repo: RepoConfig): string {
  try {
    const sql = `
      SELECT table_name || '|' || column_name || '|' || data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `;
    return runPsql(repo, sql);
  } catch (err: unknown) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const timestamp = Date.now();
  const outputDir = join(process.cwd(), `spike-c-snapshot-output-${timestamp}`);
  mkdirSync(outputDir, { recursive: true });

  console.log(`\n${"=".repeat(70)}`);
  console.log("Spike C: SNAPSHOT/RESTORE — Can seed data replace setup-writer?");
  console.log(`Output: ${outputDir}`);
  console.log(`${"=".repeat(70)}\n`);

  const allResults: RepoResult[] = [];

  for (const repo of repos) {
    console.log(`${"─".repeat(60)}`);
    console.log(`Repo: ${repo.name}`);
    console.log(`DB:   ${repo.dbUrl}`);
    console.log(`${"─".repeat(60)}`);

    // Connectivity check
    try {
      runPsql(repo, "SELECT 1");
      console.log("  DB connection: OK\n");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  DB connection: FAILED — ${msg.slice(0, 200)}\n`);
      allResults.push({
        repo: repo.name,
        dbUrl: repo.dbUrl,
        conditions: repo.conditions.map((c) => ({
          id: c.id,
          description: c.description,
          status: "ERROR" as const,
          count: 0,
          error: "DB connection failed",
        })),
        snapshots: [],
        satisfiedCount: 0,
        totalCount: repo.conditions.length,
        satisfiedPct: 0,
      });
      continue;
    }

    // Schema discovery
    const tables = discoverTables(repo);
    console.log(`  Schema: ${tables.length} tables discovered`);
    const schema = discoverSchema(repo);
    writeFileSync(join(outputDir, `${repo.name}-schema.txt`), schema);

    // ── Condition checks ──────────────────────────────────────────────────
    console.log("\n  Condition checks:");
    const conditionResults: ConditionResult[] = [];

    for (const condition of repo.conditions) {
      const result = checkCondition(repo, condition);
      conditionResults.push(result);

      const icon =
        result.status === "SATISFIED"
          ? "[SATISFIED]"
          : result.status === "ERROR"
            ? "[ERROR]   "
            : "[NOT_SAT] ";
      const countStr =
        result.status === "SATISFIED" ? ` (count=${result.count})` : "";
      const errStr = result.error
        ? ` — ${result.error.slice(0, 80)}`
        : "";
      console.log(`    ${icon} ${result.id}: ${result.description}${countStr}${errStr}`);
    }

    // ── Snapshot/restore tests ────────────────────────────────────────────
    const uniqueTables = [...new Set(repo.conditions.map((c) => c.snapshotTable))];
    const repoSnapshotDir = join(outputDir, repo.name);
    mkdirSync(repoSnapshotDir, { recursive: true });

    console.log(`\n  Snapshot/restore tests (${uniqueTables.length} tables):`);
    const snapshotResults: SnapshotResult[] = [];

    for (const table of uniqueTables) {
      const result = testSnapshot(repo, table, repoSnapshotDir);
      snapshotResults.push(result);

      const icon = result.dumpOk && result.restoreOk ? "[OK]   " : "[FAIL] ";
      const sizeStr = result.dumpOk ? ` (${result.dumpSizeBytes} bytes)` : "";
      const errStr = result.error ? ` — ${result.error.slice(0, 80)}` : "";
      console.log(`    ${icon} ${table}: dump=${result.dumpOk}, restore=${result.restoreOk}${sizeStr}${errStr}`);
    }

    const satisfiedCount = conditionResults.filter(
      (r) => r.status === "SATISFIED",
    ).length;
    allResults.push({
      repo: repo.name,
      dbUrl: repo.dbUrl,
      conditions: conditionResults,
      snapshots: snapshotResults,
      satisfiedCount,
      totalCount: conditionResults.length,
      satisfiedPct: Math.round((satisfiedCount / conditionResults.length) * 100),
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(70)}\n`);

  let totalSatisfied = 0;
  let totalConditions = 0;
  let totalSnapshotOk = 0;
  let totalSnapshots = 0;

  for (const r of allResults) {
    totalSatisfied += r.satisfiedCount;
    totalConditions += r.totalCount;
    totalSnapshotOk += r.snapshots.filter((s) => s.dumpOk && s.restoreOk).length;
    totalSnapshots += r.snapshots.length;

    const snapOk = r.snapshots.filter((s) => s.dumpOk && s.restoreOk).length;
    console.log(`  ${r.repo}:`);
    console.log(
      `    Conditions: ${r.satisfiedCount}/${r.totalCount} satisfied (${r.satisfiedPct}%)`,
    );
    console.log(
      `    Snapshots:  ${snapOk}/${r.snapshots.length} tables dump+restore OK`,
    );

    // List gaps
    const gaps = r.conditions.filter((c) => c.status !== "SATISFIED");
    if (gaps.length > 0) {
      console.log(`    Gaps:`);
      for (const g of gaps) {
        console.log(`      - ${g.id}: ${g.description} [${g.status}]`);
      }
    }
    console.log();
  }

  const overallPct =
    totalConditions > 0
      ? Math.round((totalSatisfied / totalConditions) * 100)
      : 0;
  const snapshotPct =
    totalSnapshots > 0
      ? Math.round((totalSnapshotOk / totalSnapshots) * 100)
      : 0;

  console.log(
    `  OVERALL: ${totalSatisfied}/${totalConditions} conditions satisfied (${overallPct}%)`,
  );
  console.log(
    `  SNAPSHOT MECHANISM: ${totalSnapshotOk}/${totalSnapshots} tables dump+restore OK (${snapshotPct}%)`,
  );
  console.log();

  if (overallPct >= 70) {
    console.log(
      "  CONCLUSION: Seed data covers >=70% of conditions.",
    );
    console.log(
      "  -> SNAPSHOT/RESTORE is viable as a standalone strategy.",
    );
    console.log(
      "  -> Setup-writer stage can likely be removed.",
    );
  } else if (overallPct >= 50) {
    console.log(
      "  CONCLUSION: Seed data covers 50-69% of conditions.",
    );
    console.log(
      "  -> SNAPSHOT/RESTORE needs supplemental data creation for gaps.",
    );
    console.log(
      "  -> A lightweight setup-writer for gap-filling may still be needed.",
    );
  } else {
    console.log(
      "  CONCLUSION: Seed data covers <50% of conditions.",
    );
    console.log(
      "  -> SNAPSHOT/RESTORE alone is too limited.",
    );
    console.log(
      "  -> Setup-writer stage is still required.",
    );
  }

  // Write structured results
  const resultsFile = join(outputDir, "results.json");
  writeFileSync(
    resultsFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        results: allResults,
        summary: {
          totalSatisfied,
          totalConditions,
          overallPct,
          totalSnapshotOk,
          totalSnapshots,
          snapshotPct,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n  Results: ${resultsFile}\n`);
}

main();
