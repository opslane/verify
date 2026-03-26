#!/usr/bin/env npx tsx
/**
 * Spike A: Can DETERMINISTIC SQL TEMPLATES replace the LLM setup-writer?
 *
 * Tests whether we can pattern-match condition strings to parameterised SQL
 * templates, fill them with real FK values from the DB, and execute them
 * without errors.  Uses psql (no npm deps needed).
 *
 * Key question: can a generic condition->template mapping work across BOTH
 * Documenso and Cal.com without repo-specific code?
 *
 * Usage:
 *   cd pipeline && npx tsx src/evals/spike-a-deterministic-templates.ts
 *
 * Requires:
 *   - Documenso DB at postgresql://documenso:password@localhost:54320/documenso
 *   - Cal.com   DB at postgresql://calcom:calcom@localhost:5432/calcom
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TestCase {
  repo: string;
  condition: string;
  dbUrl: string;
  auth: { email: string; userId?: number; teamId?: number };
}

interface TestResult {
  repo: string;
  condition: string;
  matched: boolean;
  matchedKeywords: string[];
  templateLabel: string | null;
  resolvedParams: Record<string, unknown> | null;
  filledSql: string | null;
  executed: boolean;
  error: string | null;
  rightTable: boolean;
}

// ─── psql helper ─────────────────────────────────────────────────────────────

function psqlExec(dbUrl: string, sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -t -A -c ${shellQuote(sql)}`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? err.message : String(err);
    throw new Error(`psql error: ${msg.trim()}`);
  }
}

/** Run multi-statement SQL (BEGIN/ROLLBACK wrapped) via psql stdin */
function psqlMulti(dbUrl: string, sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1`, {
      input: sql,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? err.message : String(err);
    throw new Error(`psql multi error: ${msg.trim()}`);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function psqlQueryRow(dbUrl: string, sql: string): Record<string, string> {
  // Use -F to set field separator, and get column names via \pset
  const raw = execSync(
    `psql "${dbUrl}" -t -A -F $'\\t' -c ${shellQuote(sql)}`,
    { encoding: "utf-8", timeout: 10_000 },
  ).trim();
  if (!raw) return {};
  // Single row, tab-separated values — but we don't have column names from -t
  // Use a second query approach: run with headers
  const withHeaders = execSync(
    `psql "${dbUrl}" -A -F $'\\t' -c ${shellQuote(sql)}`,
    { encoding: "utf-8", timeout: 10_000 },
  ).trim();
  const lines = withHeaders.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return {};
  const headers = lines[0].split("\t");
  const values = lines[1].split("\t");
  const result: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    result[headers[i]] = values[i];
  }
  return result;
}

// ─── Template registry ───────────────────────────────────────────────────────

interface Template {
  patterns: RegExp[];
  label: string;
  templateSql: string;
  resolvers: Record<string, string | null>;
  expectedTable: string;
}

const TEMPLATES: Template[] = [
  // ── draft document (with recipient) ──────────────────────────────────────
  {
    patterns: [/draft\s+document/i, /recipient/i],
    label: "draft document with recipient",
    expectedTable: "Envelope",
    resolvers: { documenso: null, calcom: null },
    templateSql: `
      INSERT INTO "DocumentMeta" (id) VALUES ('spike_meta_{{uid}}');

      INSERT INTO "Envelope" (
        id, "secondaryId", type, source, title, status,
        "internalVersion", "updatedAt", "userId", "teamId", "documentMetaId"
      ) VALUES (
        'spike_env_{{uid}}', 'spike_sec_{{uid}}',
        'DOCUMENT', 'DOCUMENT', 'Spike test draft', 'DRAFT',
        1, NOW(), {{userId}}, {{teamId}}, 'spike_meta_{{uid}}'
      );

      INSERT INTO "Recipient" ("email", "name", "token", "envelopeId")
      VALUES ('recipient@test.com', 'Test Recipient', 'spike_tok_{{uid}}', 'spike_env_{{uid}}');
    `,
  },

  // ── multiple draft documents ─────────────────────────────────────────────
  {
    patterns: [/\d+\s+draft\s+documents?/i],
    label: "multiple draft documents",
    expectedTable: "Envelope",
    resolvers: { documenso: null, calcom: null },
    templateSql: `
      INSERT INTO "DocumentMeta" (id) VALUES ('spike_meta_a_{{uid}}');
      INSERT INTO "DocumentMeta" (id) VALUES ('spike_meta_b_{{uid}}');
      INSERT INTO "DocumentMeta" (id) VALUES ('spike_meta_c_{{uid}}');

      INSERT INTO "Envelope" (
        id, "secondaryId", type, source, title, status,
        "internalVersion", "updatedAt", "userId", "teamId", "documentMetaId"
      ) VALUES
        ('spike_env_a_{{uid}}', 'spike_sec_a_{{uid}}', 'DOCUMENT', 'DOCUMENT', 'Draft 1', 'DRAFT', 1, NOW(), {{userId}}, {{teamId}}, 'spike_meta_a_{{uid}}'),
        ('spike_env_b_{{uid}}', 'spike_sec_b_{{uid}}', 'DOCUMENT', 'DOCUMENT', 'Draft 2', 'DRAFT', 1, NOW(), {{userId}}, {{teamId}}, 'spike_meta_b_{{uid}}'),
        ('spike_env_c_{{uid}}', 'spike_sec_c_{{uid}}', 'DOCUMENT', 'DOCUMENT', 'Draft 3', 'DRAFT', 1, NOW(), {{userId}}, {{teamId}}, 'spike_meta_c_{{uid}}');
    `,
  },

  // ── template (Documenso envelope of type TEMPLATE) ───────────────────────
  {
    patterns: [/template\s+exists/i],
    label: "template exists",
    expectedTable: "Envelope",
    resolvers: { documenso: null, calcom: null },
    templateSql: `
      INSERT INTO "DocumentMeta" (id) VALUES ('spike_tmpl_meta_{{uid}}');

      INSERT INTO "Envelope" (
        id, "secondaryId", type, source, title, status,
        "internalVersion", "updatedAt", "userId", "teamId", "documentMetaId"
      ) VALUES (
        'spike_tmpl_{{uid}}', 'spike_tmpl_sec_{{uid}}',
        'TEMPLATE', 'TEMPLATE', 'Spike test template', 'DRAFT',
        1, NOW(), {{userId}}, {{teamId}}, 'spike_tmpl_meta_{{uid}}'
      );
    `,
  },

  // ── event type ───────────────────────────────────────────────────────────
  {
    patterns: [/event\s*type\s+exists/i],
    label: "event type exists",
    expectedTable: "EventType",
    resolvers: { calcom: null, documenso: null },
    templateSql: `
      INSERT INTO "EventType" (title, slug, length, "userId")
      VALUES ('Spike Event', 'spike-event-{{uid}}', 30, {{userId}});
    `,
  },

  // ── booking ──────────────────────────────────────────────────────────────
  {
    patterns: [/booking\s+exists/i],
    label: "booking exists",
    expectedTable: "Booking",
    resolvers: {
      calcom: `SELECT et.id AS "eventTypeId" FROM "EventType" et WHERE et."userId" = {{userId}} LIMIT 1`,
      documenso: null,
    },
    templateSql: `
      INSERT INTO "Booking" (
        uid, "userId", "eventTypeId", title,
        "startTime", "endTime", status
      ) VALUES (
        'spike_booking_{{uid}}', {{userId}}, {{eventTypeId}},
        'Spike Booking',
        NOW() + INTERVAL '1 day',
        NOW() + INTERVAL '1 day 30 minutes',
        'accepted'
      );
    `,
  },

  // ── webhook ──────────────────────────────────────────────────────────────
  {
    patterns: [/webhook\s+exists/i],
    label: "webhook exists",
    expectedTable: "Webhook",
    resolvers: { calcom: null, documenso: null },
    templateSql: `
      INSERT INTO "Webhook" (
        id, "userId", "subscriberUrl", "eventTriggers", active
      ) VALUES (
        'spike_webhook_{{uid}}', {{userId}},
        'https://spike.test/webhook-{{uid}}',
        ARRAY['BOOKING_CREATED']::"WebhookTriggerEvents"[],
        true
      );
    `,
  },
];

// ─── Matcher ─────────────────────────────────────────────────────────────────

function findTemplate(condition: string): Template | undefined {
  return TEMPLATES.find((t) => t.patterns.every((p) => p.test(condition)));
}

// ─── SQL filler ──────────────────────────────────────────────────────────────

function fillTemplate(sql: string, params: Record<string, unknown>): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const val = params[key];
    if (val === undefined) throw new Error(`Missing param: ${key}`);
    if (typeof val === "number") return String(val);
    return String(val);
  });
}

// ─── Test cases ──────────────────────────────────────────────────────────────

const TEST_CASES: TestCase[] = [
  // Documenso
  {
    repo: "documenso",
    condition:
      "A draft document exists for the logged-in user's personal team, with at least one recipient added",
    dbUrl: "postgresql://documenso:password@localhost:54320/documenso",
    auth: { email: "ac1-test@test.documenso.com", userId: 9, teamId: 7 },
  },
  {
    repo: "documenso",
    condition:
      "At least 3 draft documents exist for the logged-in user's personal team",
    dbUrl: "postgresql://documenso:password@localhost:54320/documenso",
    auth: { email: "ac1-test@test.documenso.com", userId: 9, teamId: 7 },
  },
  {
    repo: "documenso",
    condition:
      "A template exists for the logged-in user's personal team",
    dbUrl: "postgresql://documenso:password@localhost:54320/documenso",
    auth: { email: "ac1-test@test.documenso.com", userId: 9, teamId: 7 },
  },
  // Cal.com
  {
    repo: "calcom",
    condition: "An event type exists for the logged-in user",
    dbUrl: "postgresql://calcom:calcom@localhost:5432/calcom",
    auth: { email: "pro@example.com", userId: 4 },
  },
  {
    repo: "calcom",
    condition: "A booking exists for the logged-in user's event type",
    dbUrl: "postgresql://calcom:calcom@localhost:5432/calcom",
    auth: { email: "pro@example.com", userId: 4 },
  },
  {
    repo: "calcom",
    condition: "A webhook exists for the logged-in user",
    dbUrl: "postgresql://calcom:calcom@localhost:5432/calcom",
    auth: { email: "pro@example.com", userId: 4 },
  },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

function runCase(tc: TestCase): TestResult {
  const uid = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const result: TestResult = {
    repo: tc.repo,
    condition: tc.condition,
    matched: false,
    matchedKeywords: [],
    templateLabel: null,
    resolvedParams: null,
    filledSql: null,
    executed: false,
    error: null,
    rightTable: false,
  };

  // 1. Match
  const tmpl = findTemplate(tc.condition);
  if (!tmpl) {
    result.error = "No template matched";
    return result;
  }
  result.matched = true;
  result.matchedKeywords = tmpl.patterns.map((p) => p.source);
  result.templateLabel = tmpl.label;

  // 2. Build params from auth + resolver
  const params: Record<string, unknown> = { uid, ...tc.auth };

  try {
    // Run resolver if this repo has one
    const resolverSql = tmpl.resolvers[tc.repo];
    if (resolverSql) {
      const filledResolver = fillTemplate(resolverSql, params);
      const row = psqlQueryRow(tc.dbUrl, filledResolver);
      if (Object.keys(row).length === 0) {
        result.error = `Resolver returned 0 rows: ${filledResolver}`;
        return result;
      }
      // Parse numeric values
      for (const [k, v] of Object.entries(row)) {
        params[k] = /^\d+$/.test(v) ? Number(v) : v;
      }
    }
    result.resolvedParams = { ...params };

    // 3. Fill template
    const filledSql = fillTemplate(tmpl.templateSql, params);
    result.filledSql = filledSql.trim();

    // 4. Execute inside BEGIN/ROLLBACK
    const wrappedSql = `BEGIN;\n${filledSql}\nROLLBACK;`;
    psqlMulti(tc.dbUrl, wrappedSql);
    result.executed = true;

    // Check right table
    result.rightTable = filledSql.includes(`"${tmpl.expectedTable}"`);
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const ts = Date.now();
  const outDir = join(
    import.meta.dirname ?? ".",
    "..",
    "..",
    `spike-a-templates-output-${ts}`,
  );
  mkdirSync(outDir, { recursive: true });

  console.log(`\n====================================================`);
  console.log(`  Spike A: Deterministic SQL Templates`);
  console.log(`====================================================\n`);

  const results: TestResult[] = [];

  for (const tc of TEST_CASES) {
    console.log(`> [${tc.repo}] ${tc.condition}`);
    const r = runCase(tc);
    results.push(r);

    if (r.executed) {
      console.log(`  PASS -- matched [${r.matchedKeywords.join(", ")}], executed OK, right table: ${r.rightTable}`);
    } else {
      console.log(`  FAIL -- ${r.error}`);
    }
    console.log();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const total = results.length;
  const matched = results.filter((r) => r.matched).length;
  const executed = results.filter((r) => r.executed).length;
  const rightTable = results.filter((r) => r.rightTable).length;

  console.log(`\n=== Summary ===`);
  console.log(`Total:       ${total}`);
  console.log(`Matched:     ${matched}/${total}`);
  console.log(`Executed OK: ${executed}/${total}`);
  console.log(`Right table: ${rightTable}/${total}`);
  console.log();

  // ── Cross-repo analysis ──────────────────────────────────────────────────
  const docResults = results.filter((r) => r.repo === "documenso");
  const calResults = results.filter((r) => r.repo === "calcom");

  console.log(`=== Cross-repo Analysis ===`);
  console.log(`Documenso: ${docResults.filter((r) => r.executed).length}/${docResults.length} executed`);
  console.log(`Cal.com:   ${calResults.filter((r) => r.executed).length}/${calResults.length} executed`);
  console.log();

  const usedLabels = new Set(
    results.filter((r) => r.matched).map((r) => {
      const t = findTemplate(r.condition);
      return t?.label ?? "unknown";
    }),
  );
  console.log(`Templates used: ${usedLabels.size} distinct`);
  console.log(`Labels: ${[...usedLabels].join(", ")}`);

  // Key finding
  const allPassed =
    docResults.every((r) => r.executed) && calResults.every((r) => r.executed);
  console.log();
  if (allPassed) {
    console.log(
      `KEY FINDING: All templates executed across BOTH repos.`,
    );
    console.log(
      `However: the SQL is inherently repo-specific (Documenso uses "Envelope", Cal uses "EventType").`,
    );
    console.log(
      `The PATTERN-MATCHING dispatch is generic, but each repo needs its own SQL templates.`,
    );
    console.log(
      `Architecture: { condition_regex, repo, template_sql, resolver_sql } registry.`,
    );
  } else {
    console.log(
      `KEY FINDING: Not all templates executed across both repos.`,
    );
    const failedDoc = docResults.filter((r) => !r.executed);
    const failedCal = calResults.filter((r) => !r.executed);
    if (failedDoc.length > 0) {
      console.log(`  Documenso failures:`);
      for (const f of failedDoc) console.log(`    - ${f.condition}: ${f.error}`);
    }
    if (failedCal.length > 0) {
      console.log(`  Cal.com failures:`);
      for (const f of failedCal) console.log(`    - ${f.condition}: ${f.error}`);
    }
    console.log(
      `Each repo NEEDS its own templates -- schemas are too different.`,
    );
    console.log(
      `The pattern-matching dispatch is still generic, but SQL is repo-specific.`,
    );
  }

  // ── Write output ─────────────────────────────────────────────────────────
  const report = {
    timestamp: new Date().toISOString(),
    summary: { total, matched, executed, rightTable },
    crossRepo: {
      documenso: {
        total: docResults.length,
        executed: docResults.filter((r) => r.executed).length,
      },
      calcom: {
        total: calResults.length,
        executed: calResults.filter((r) => r.executed).length,
      },
    },
    results,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport written to: ${outDir}/report.json`);
}

main();
