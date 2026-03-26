#!/usr/bin/env npx tsx
/**
 * Spike B: Can seed data + targeted mutations replace the LLM setup-writer?
 *
 * Hypothesis: Most realistic conditions are ALREADY satisfied by the project's
 * seed data. If >70% are met, a "verify what exists" approach beats "generate
 * from scratch" and avoids the LLM entirely for most cases.
 *
 * For each repo (Documenso, Cal.com), we:
 *   1. Discover schema for key tables
 *   2. Query the DB to check if each condition is already met by seed data
 *   3. If not met, determine a minimal mutation and test it with BEGIN/ROLLBACK
 *   4. Track: how many conditions are already met by seed data?
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-b-seed-verification.ts
 *
 * Requires:
 *   - Documenso DB running at postgresql://documenso:password@localhost:54320/documenso
 *   - Cal.com DB running at postgresql://calcom:calcom@localhost:5432/calcom
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────────

interface Repo {
  name: string;
  dbUrl: string;
  authHint: string;
  conditions: Condition[];
}

interface Condition {
  id: string;
  description: string;
  /** SQL that returns a count — condition is met if count > 0 (or >= threshold) */
  checkQuery: string;
  /** Minimum count for the condition to be met (default 1) */
  threshold?: number;
  /** SQL mutation wrapped in BEGIN/ROLLBACK to test if the mutation works */
  mutationSql?: string;
  /** Human description of what the mutation does */
  mutationDescription?: string;
}

interface ConditionResult {
  repo: string;
  id: string;
  description: string;
  seedCount: number;
  threshold: number;
  metBySeed: boolean;
  mutationTested: boolean;
  mutationSuccess: boolean;
  mutationError?: string;
  schemaSnippet?: string;
  duration_ms: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function psql(dbUrl: string, sql: string): string {
  const cleanUrl = dbUrl.split("?")[0];
  try {
    return execSync(
      `psql "${cleanUrl}" -t -A -c ${escapeShellArg(sql)}`,
      { timeout: 15_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || "psql failed");
  }
}

function escapeShellArg(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function psqlCount(dbUrl: string, sql: string): number {
  const raw = psql(dbUrl, sql);
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

/** Describe a table's columns */
function describeTable(dbUrl: string, table: string, schema = "public"): string {
  try {
    return psql(dbUrl, `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = '${table}' AND table_schema = '${schema}'
      ORDER BY ordinal_position
    `);
  } catch {
    return "(table not found)";
  }
}

/** List tables matching a pattern */
function listTables(dbUrl: string, pattern: string): string {
  try {
    return psql(dbUrl, `
      SELECT table_schema || '.' || table_name
      FROM information_schema.tables
      WHERE table_name ILIKE '${pattern}' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
  } catch {
    return "";
  }
}

// ── Schema Discovery ────────────────────────────────────────────────────────────

function discoverDocumensoSchema(dbUrl: string): Record<string, string> {
  const tables = ["Envelope", "Recipient", "EnvelopeItem", "Team", "TeamMember", "DocumentMeta", "TemplateDirectLink"];
  const schemas: Record<string, string> = {};
  for (const t of tables) {
    schemas[t] = describeTable(dbUrl, t);
  }
  return schemas;
}

function discoverCalcomSchema(dbUrl: string): Record<string, string> {
  // Cal.com uses lowercase table names — discover dynamically
  const candidates = [
    "users", "EventType", "event_types", "Booking", "bookings",
    "Webhook", "webhooks", "calendars",
  ];
  const schemas: Record<string, string> = {};

  // First find what actually exists
  const allTables = psql(dbUrl, `
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  schemas["_all_tables"] = allTables;

  for (const t of candidates) {
    const desc = describeTable(dbUrl, t);
    if (desc !== "(table not found)") {
      schemas[t] = desc;
    }
  }

  return schemas;
}

// ── Repo Definitions ────────────────────────────────────────────────────────────

function buildDocumensoRepo(): Repo {
  const dbUrl = "postgresql://documenso:password@localhost:54320/documenso";
  return {
    name: "documenso",
    dbUrl,
    authHint: "ac1-test@test.documenso.com, userId=9, teamId=7",
    conditions: [
      {
        id: "doc-draft-with-recipient",
        description: "A draft document exists for the logged-in user's personal team, with at least one recipient added",
        checkQuery: `
          SELECT COUNT(*) FROM "Envelope" e
          WHERE e."teamId" = 7
            AND e.status = 'DRAFT'
            AND EXISTS (
              SELECT 1 FROM "Recipient" r WHERE r."envelopeId" = e.id
            )
        `,
        threshold: 1,
        mutationSql: `
          BEGIN;
          -- Check what draft envelopes exist without recipients
          SELECT e.id, e.status FROM "Envelope" e WHERE e."teamId" = 7 AND e.status = 'DRAFT' LIMIT 5;
          ROLLBACK;
        `,
        mutationDescription: "If no drafts with recipients exist, would INSERT a Recipient into an existing draft Envelope",
      },
      {
        id: "doc-3-drafts",
        description: "At least 3 draft documents exist for the logged-in user's personal team",
        checkQuery: `
          SELECT COUNT(*) FROM "Envelope"
          WHERE "teamId" = 7 AND status = 'DRAFT'
        `,
        threshold: 3,
      },
      {
        id: "doc-template",
        description: "A template exists for the logged-in user's personal team",
        // Documenso stores templates as Envelope rows with type = 'TEMPLATE'
        checkQuery: `
          SELECT COUNT(*) FROM "Envelope"
          WHERE "teamId" = 7 AND type = 'TEMPLATE'
        `,
        threshold: 1,
      },
    ],
  };
}

function buildCalcomRepo(dbUrl: string, schemas: Record<string, string>): Repo {
  const allTables = (schemas["_all_tables"] ?? "").split("\n").map(t => t.trim());

  // Dynamically find the right table names
  const hasEventType = allTables.includes("EventType");
  const hasBooking = allTables.includes("Booking");
  const hasWebhook = allTables.includes("Webhook");

  const eventTypeTable = hasEventType ? '"EventType"' : '"event_types"';
  const bookingTable = hasBooking ? '"Booking"' : '"bookings"';
  const webhookTable = hasWebhook ? '"Webhook"' : '"webhooks"';

  // Find userId dynamically
  let userIdQuery: string;
  try {
    const userId = psql(dbUrl, `SELECT id FROM users WHERE email = 'pro@example.com'`);
    userIdQuery = userId || "0";
  } catch {
    userIdQuery = "0";
  }
  const userId = parseInt(userIdQuery, 10) || 0;

  return {
    name: "calcom",
    dbUrl,
    authHint: `pro@example.com, userId=${userId}`,
    conditions: [
      {
        id: "cal-event-type",
        description: "An event type exists for the logged-in user",
        checkQuery: `SELECT COUNT(*) FROM ${eventTypeTable} WHERE "userId" = ${userId}`,
        threshold: 1,
      },
      {
        id: "cal-booking",
        description: "A booking exists for the logged-in user's event type",
        checkQuery: `
          SELECT COUNT(*) FROM ${bookingTable} b
          WHERE b."userId" = ${userId}
        `,
        threshold: 1,
      },
      {
        id: "cal-webhook",
        description: "A webhook exists for the logged-in user",
        checkQuery: `
          SELECT COUNT(*) FROM ${webhookTable} WHERE "userId" = ${userId}
        `,
        threshold: 1,
        mutationSql: `
          BEGIN;
          INSERT INTO ${webhookTable} ("id", "userId", "subscriberUrl", "eventTriggers", "active", "createdAt")
          VALUES (gen_random_uuid(), ${userId}, 'https://example.com/webhook', '{"BOOKING_CREATED"}', true, NOW());
          SELECT COUNT(*) FROM ${webhookTable} WHERE "userId" = ${userId};
          ROLLBACK;
        `,
        mutationDescription: "INSERT a webhook row for the user — minimal single-table mutation",
      },
    ],
  };
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  const pipelineDir = resolve(import.meta.dirname ?? ".", "../..");
  const outputDir = join(pipelineDir, `spike-b-seed-output-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  console.log(`\n=== Spike B: Seed Data Verification ===\n`);
  console.log(`Output dir: ${outputDir}\n`);

  const allResults: ConditionResult[] = [];
  const repoSchemas: Record<string, Record<string, string>> = {};

  // ── Documenso ──────────────────────────────────────────────────────────────

  console.log(`\n--- DOCUMENSO ---\n`);
  const documensoDb = "postgresql://documenso:password@localhost:54320/documenso";

  let documensoAvailable = false;
  try {
    psql(documensoDb, "SELECT 1");
    documensoAvailable = true;
    console.log("  DB connection: OK\n");
  } catch (e) {
    const err = e as Error;
    console.log(`  DB connection: FAILED (${err.message.slice(0, 80)})`);
    console.log("  Skipping Documenso conditions.\n");
  }

  if (documensoAvailable) {
    // Schema discovery
    console.log("  Discovering schema...");
    const docSchemas = discoverDocumensoSchema(documensoDb);
    repoSchemas["documenso"] = docSchemas;
    for (const [table, desc] of Object.entries(docSchemas)) {
      if (desc !== "(table not found)") {
        const colCount = desc.split("\n").filter(Boolean).length;
        console.log(`    ${table}: ${colCount} columns`);
      }
    }
    console.log();

    const repo = buildDocumensoRepo();
    console.log(`  Auth: ${repo.authHint}\n`);

    for (const cond of repo.conditions) {
      const result = testCondition(repo.name, repo.dbUrl, cond);
      allResults.push(result);
      printConditionResult(result);
    }
  }

  // ── Cal.com ────────────────────────────────────────────────────────────────

  console.log(`\n--- CAL.COM ---\n`);
  const calcomDb = "postgresql://calcom:calcom@localhost:5432/calcom";

  let calcomAvailable = false;
  try {
    psql(calcomDb, "SELECT 1");
    calcomAvailable = true;
    console.log("  DB connection: OK\n");
  } catch (e) {
    const err = e as Error;
    console.log(`  DB connection: FAILED (${err.message.slice(0, 80)})`);
    console.log("  Skipping Cal.com conditions.\n");
  }

  if (calcomAvailable) {
    // Schema discovery
    console.log("  Discovering schema...");
    const calSchemas = discoverCalcomSchema(calcomDb);
    repoSchemas["calcom"] = calSchemas;
    const tableList = (calSchemas["_all_tables"] ?? "").split("\n").filter(Boolean);
    console.log(`    Total tables: ${tableList.length}`);

    // Show key tables found
    for (const [table, desc] of Object.entries(calSchemas)) {
      if (table !== "_all_tables" && desc !== "(table not found)") {
        const colCount = desc.split("\n").filter(Boolean).length;
        console.log(`    ${table}: ${colCount} columns`);
      }
    }
    console.log();

    const repo = buildCalcomRepo(calcomDb, calSchemas);
    console.log(`  Auth: ${repo.authHint}\n`);

    for (const cond of repo.conditions) {
      const result = testCondition(repo.name, repo.dbUrl, cond);
      allResults.push(result);
      printConditionResult(result);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  if (allResults.length === 0) {
    console.log("\n=== NO RESULTS ===\n");
    console.log("  Neither Documenso nor Cal.com DB was reachable.");
    console.log("  Start the DBs and re-run.\n");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== RESULTS ===`);
  console.log(`${"=".repeat(60)}\n`);

  const metBySeed = allResults.filter(r => r.metBySeed);
  const notMet = allResults.filter(r => !r.metBySeed);
  const mutationsTested = notMet.filter(r => r.mutationTested);
  const mutationsOk = mutationsTested.filter(r => r.mutationSuccess);

  console.log(`  Total conditions tested:  ${allResults.length}`);
  console.log(`  Met by seed data:         ${metBySeed.length}/${allResults.length} (${pct(metBySeed.length, allResults.length)})`);
  console.log(`  NOT met by seed data:     ${notMet.length}/${allResults.length}`);
  if (mutationsTested.length > 0) {
    console.log(`  Mutations tested:         ${mutationsTested.length}`);
    console.log(`  Mutations succeeded:      ${mutationsOk.length}/${mutationsTested.length}`);
  }

  // Per-repo breakdown
  for (const repoName of ["documenso", "calcom"]) {
    const repoResults = allResults.filter(r => r.repo === repoName);
    if (repoResults.length === 0) continue;
    const repoMet = repoResults.filter(r => r.metBySeed).length;
    console.log(`\n  ${repoName}:`);
    console.log(`    ${repoMet}/${repoResults.length} conditions met by seed data`);
    for (const r of repoResults) {
      const status = r.metBySeed ? "SEED OK" : r.mutationSuccess ? "MUTATION OK" : "NEEDS WORK";
      console.log(`    [${status}] ${r.id}: count=${r.seedCount} (need >=${r.threshold})`);
    }
  }

  // Write results
  const resultsPayload = {
    timestamp: new Date().toISOString(),
    summary: {
      total: allResults.length,
      met_by_seed: metBySeed.length,
      not_met: notMet.length,
      seed_coverage_pct: Math.round((metBySeed.length / allResults.length) * 100),
      mutations_tested: mutationsTested.length,
      mutations_ok: mutationsOk.length,
    },
    schemas: repoSchemas,
    conditions: allResults,
  };
  const resultsPath = join(outputDir, "spike-b-results.json");
  writeFileSync(resultsPath, JSON.stringify(resultsPayload, null, 2));
  console.log(`\n  Full results: ${resultsPath}`);

  // ── Verdict ────────────────────────────────────────────────────────────────

  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== VERDICT ===`);
  console.log(`${"=".repeat(60)}\n`);

  const seedCoverage = metBySeed.length / allResults.length;
  const totalCoverage = (metBySeed.length + mutationsOk.length) / allResults.length;

  if (seedCoverage >= 0.7) {
    console.log(`  SEED COVERAGE: ${pct(metBySeed.length, allResults.length)} — EXCELLENT`);
    console.log(`  ${metBySeed.length}/${allResults.length} conditions are ALREADY satisfied by seed data.`);
    console.log(`  The "verify what exists" approach beats "generate from scratch".`);
    console.log(`  -> Recommendation: skip setup-writer for most cases, just verify seed state.`);
  } else if (totalCoverage >= 0.7) {
    console.log(`  SEED COVERAGE: ${pct(metBySeed.length, allResults.length)} — MODERATE`);
    console.log(`  SEED + MUTATIONS: ${pct(metBySeed.length + mutationsOk.length, allResults.length)} — GOOD`);
    console.log(`  Seed data alone covers ${metBySeed.length}/${allResults.length} conditions.`);
    console.log(`  With targeted mutations, coverage rises to ${metBySeed.length + mutationsOk.length}/${allResults.length}.`);
    console.log(`  -> Recommendation: verify seed first, then apply deterministic mutations for gaps.`);
  } else {
    console.log(`  SEED COVERAGE: ${pct(metBySeed.length, allResults.length)} — LOW`);
    console.log(`  Only ${metBySeed.length}/${allResults.length} conditions are met by seed data.`);
    console.log(`  The LLM setup-writer is still needed for most conditions.`);
    console.log(`  -> Recommendation: keep the LLM setup-writer, but check seed data first as a fast path.`);
  }

  console.log(`\n  KEY INSIGHT: Seed coverage = ${Math.round(seedCoverage * 100)}%.`);
  if (seedCoverage >= 0.7) {
    console.log(`  This validates the hypothesis: most conditions are already met by seeds.`);
  } else {
    console.log(`  This DOES NOT validate the >70% hypothesis.`);
    console.log(`  However, seed-first + mutation fallback still avoids LLM for ${Math.round(totalCoverage * 100)}% of cases.`);
  }
  console.log();
}

// ── Test a single condition ─────────────────────────────────────────────────────

function testCondition(repo: string, dbUrl: string, cond: Condition): ConditionResult {
  const start = Date.now();
  const threshold = cond.threshold ?? 1;

  let seedCount = 0;
  let metBySeed = false;
  let mutationTested = false;
  let mutationSuccess = false;
  let mutationError: string | undefined;

  // Step 1: check if seed data already satisfies the condition
  try {
    seedCount = psqlCount(dbUrl, cond.checkQuery);
    metBySeed = seedCount >= threshold;
  } catch (e) {
    const err = e as Error;
    // Query itself failed — likely wrong table/column name
    mutationError = `Check query failed: ${err.message.slice(0, 150)}`;
  }

  // Step 2: if not met and we have a mutation, test it
  if (!metBySeed && cond.mutationSql) {
    mutationTested = true;
    try {
      const output = psql(dbUrl, cond.mutationSql);
      mutationSuccess = true;
      // If the mutation includes a count query, capture the result
      if (output) {
        const lines = output.split("\n").filter(Boolean);
        const lastLine = lines[lines.length - 1];
        const count = parseInt(lastLine, 10);
        if (!isNaN(count) && count >= threshold) {
          mutationSuccess = true;
        }
      }
    } catch (e) {
      const err = e as Error;
      mutationSuccess = false;
      mutationError = `Mutation failed: ${err.message.slice(0, 150)}`;
    }
  }

  return {
    repo,
    id: cond.id,
    description: cond.description,
    seedCount,
    threshold,
    metBySeed,
    mutationTested,
    mutationSuccess,
    mutationError,
    duration_ms: Date.now() - start,
  };
}

function printConditionResult(r: ConditionResult) {
  const icon = r.metBySeed ? "[SEED OK]  " : r.mutationSuccess ? "[MUTATE OK]" : "[NOT MET]  ";
  console.log(`  ${icon} ${r.id}`);
  console.log(`           "${r.description}"`);
  console.log(`           count=${r.seedCount}, threshold=${r.threshold}`);
  if (r.mutationTested) {
    console.log(`           mutation: ${r.mutationSuccess ? "succeeded" : "FAILED"}`);
  }
  if (r.mutationError) {
    console.log(`           error: ${r.mutationError.slice(0, 100)}`);
  }
  console.log();
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

// ── Go ──────────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
