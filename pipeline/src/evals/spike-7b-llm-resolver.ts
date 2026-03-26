#!/usr/bin/env npx tsx
/**
 * Spike 7b: LLM-based route resolver using Sonnet + DB access
 *
 * Tests whether upgrading from Haiku (with truncated seed data) to Sonnet
 * (with direct DB access via psql) improves parameterized route resolution.
 *
 * Current baseline: 3/65 routes resolved.
 * Target: 30+ routes resolved.
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-7b-llm-resolver.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const APP_JSON_PATH = "/tmp/documenso-verify/app.json";
const DB_URL = "postgresql://documenso:password@localhost:54320/documenso";
const AUTH_EMAIL = "ac1-test@test.documenso.com";
const USER_ID = 9;
const TEAM_ID = 7;
const TEAM_URL = "personal_mwiasvikdmkwinfh";
const OUTPUT_DIR = "/tmp/spike-7b-output";
const TIMEOUT_MS = 600_000; // 10 minutes for claude -p (many DB queries)

// ── Load app.json ──────────────────────────────────────────────────────
const appIndex = JSON.parse(readFileSync(APP_JSON_PATH, "utf-8")) as {
  routes: Record<string, unknown>;
  data_model: Record<
    string,
    {
      table_name: string;
      columns: Record<string, string>;
      manual_id_columns: string[];
    }
  >;
};

// Extract parameterized routes
const paramRoutes = Object.keys(appIndex.routes)
  .filter((r) => r.includes(":"))
  .sort();

console.log(`Found ${paramRoutes.length} parameterized routes\n`);

// Build data model summary
const dataModelLines: string[] = [];
for (const [model, info] of Object.entries(appIndex.data_model)) {
  const cols = Object.entries(info.columns)
    .map(([prisma, pg]) => (prisma === pg ? pg : `${prisma} -> "${pg}"`))
    .join(", ");
  const manualIds =
    info.manual_id_columns.length > 0
      ? ` [manual IDs: ${info.manual_id_columns.join(", ")}]`
      : "";
  dataModelLines.push(
    `  ${model} (table "${info.table_name}"): ${cols}${manualIds}`,
  );
}

// ── Build the prompt ───────────────────────────────────────────────────
const prompt = `You are a route parameter resolver with direct database access.

GOAL: For each parameterized route below, query the database to find REAL values for every :param placeholder, then produce concrete example URLs.

DATABASE ACCESS:
  psql "${DB_URL}" -c "SELECT ..."
  psql "${DB_URL}" -t -A -c "SELECT ..."   (for raw values, no headers)

AUTH CONTEXT:
  The test user is ${AUTH_EMAIL} (userId=${USER_ID}).
  Their personal team URL is "${TEAM_URL}" (teamId=${TEAM_ID}).
  Prefer values from this user's data when possible.

PARAMETERIZED ROUTES (${paramRoutes.length} total):
${paramRoutes.map((r) => `  ${r}`).join("\n")}

DATA MODEL (${Object.keys(appIndex.data_model).length} tables):
${dataModelLines.join("\n")}

STRATEGY:
1. For :teamUrl params -> query Team table: SELECT url FROM "Team" WHERE id = ${TEAM_ID}
2. For :orgUrl params -> query Organisation table: SELECT url FROM "Organisation" o JOIN "Team" t ON t."organisationId" = o.id WHERE t.id = ${TEAM_ID}
3. For :id params in /t/:teamUrl/documents/:id -> query Envelope: SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} LIMIT 1
4. For :id params in /t/:teamUrl/templates/:id -> query Envelope: SELECT id FROM "Envelope" WHERE "teamId" = ${TEAM_ID} AND type = 'TEMPLATE' LIMIT 1
5. For :folderId -> query Folder: SELECT id FROM "Folder" WHERE "teamId" = ${TEAM_ID} LIMIT 1
6. For :token params in /sign/:token -> query Recipient: SELECT token FROM "Recipient" r JOIN "Envelope" e ON r."envelopeId" = e.id WHERE e."teamId" = ${TEAM_ID} LIMIT 1
7. For :token params in /d/:token -> query TemplateDirectLink: SELECT token FROM "TemplateDirectLink" LIMIT 1
8. For :slug -> query DocumentShareLink: SELECT slug FROM "DocumentShareLink" LIMIT 1
9. For :url in /p/:url -> query Team: SELECT url FROM "Team" WHERE id = ${TEAM_ID} (public profile URL)
10. For /admin/* routes with :id -> query the corresponding table for any valid id
11. For /settings/webhooks/:id -> query Webhook: SELECT id FROM "Webhook" WHERE "userId" = ${USER_ID} OR "teamId" = ${TEAM_ID} LIMIT 1
12. For various :token routes -> query the relevant token table (PasswordResetToken, VerificationToken, OrganisationMemberInvite, TeamEmailVerification, etc.)
13. For :orgUrl routes -> also try: SELECT url FROM "Organisation" LIMIT 1

RULES:
- You MUST resolve at least 30 routes. Try hard to find values.
- For :id params, query the relevant table filtered by teamId=${TEAM_ID} first, then fall back to any row.
- For :token params, query the relevant table for token columns.
- If a table is empty, note it but still try other routes.
- Run as many queries as needed. Be thorough.
- If you can't find a value for an :orgUrl param, create a test org or use any existing one.

OUTPUT FORMAT:
After querying, output ONLY valid JSON (no markdown fences, no explanation) with this schema:
{
  "example_urls": {
    "/t/:teamUrl/settings/document": "/t/personal_mwiasvikdmkwinfh/settings/document",
    "/admin/documents/:id": "/admin/documents/42"
  },
  "unresolved": ["/route/that/could/not/be/resolved"],
  "stats": {
    "resolved": 50,
    "unresolved": 15,
    "total": 65
  }
}

Include ALL ${paramRoutes.length} routes -- either in example_urls (resolved) or unresolved.
Output ONLY the JSON object. No other text.`;

// ── Run claude -p ──────────────────────────────────────────────────────
console.log("Running claude -p with Bash tool access...");
console.log(`Prompt length: ${prompt.length} chars\n`);

const startTime = Date.now();

mkdirSync(OUTPUT_DIR, { recursive: true });

// Use stream-json to capture actual text content from assistant messages
let streamOutput: string;
try {
  streamOutput = execSync(
    `claude -p --allowedTools Bash --output-format stream-json --verbose --max-turns 30`,
    {
      input: prompt,
      encoding: "utf-8",
      timeout: TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
} catch (err: unknown) {
  const error = err as { status?: number; stderr?: string; stdout?: string };
  console.error("claude -p failed:");
  console.error("  status:", error.status);
  console.error("  stderr:", error.stderr?.slice(0, 500));
  if (error.stdout) {
    writeFileSync(join(OUTPUT_DIR, "raw-stream.jsonl"), error.stdout);
    console.error(`Partial output saved to ${OUTPUT_DIR}/raw-stream.jsonl`);
  }
  process.exit(1);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`claude -p completed in ${elapsed}s\n`);

// Save raw stream for debugging
writeFileSync(join(OUTPUT_DIR, "raw-stream.jsonl"), streamOutput);

// Parse NDJSON stream to extract text from the LAST assistant message
interface ContentBlock {
  type: string;
  text?: string;
}
interface StreamEvent {
  type: string;
  message?: {
    content?: ContentBlock[];
  };
  total_cost_usd?: number;
}

let lastAssistantText = "";
let costUsd = 0;

for (const line of streamOutput.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const event = JSON.parse(trimmed) as StreamEvent;
    if (event.type === "assistant" && event.message?.content) {
      const textParts = event.message.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
      if (textParts) {
        lastAssistantText = textParts; // keep overwriting to get the LAST one
      }
    }
    if (event.type === "result" && event.total_cost_usd) {
      costUsd = event.total_cost_usd;
    }
  } catch {
    // skip unparseable lines
  }
}

if (costUsd > 0) {
  console.log(`Cost: $${costUsd.toFixed(4)}`);
}

const rawOutput = lastAssistantText;
writeFileSync(join(OUTPUT_DIR, "raw-output.txt"), rawOutput);

if (!rawOutput.trim()) {
  console.error("No text content found in assistant messages.");
  console.error(`Raw stream saved to ${OUTPUT_DIR}/raw-stream.jsonl`);
  process.exit(1);
}

// ── Parse JSON output ──────────────────────────────────────────────────
// The LLM might include text before/after the JSON. Extract the JSON object.
let result: {
  example_urls: Record<string, string>;
  unresolved: string[];
  stats: { resolved: number; unresolved: number; total: number };
} = { example_urls: {}, unresolved: [], stats: { resolved: 0, unresolved: 0, total: 0 } };

// Try to find and parse JSON from the output.
// The LLM may output multiple JSON blocks (formatted + compact). Find all
// top-level JSON objects by scanning for balanced braces.
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

const jsonCandidates = extractJsonObjects(rawOutput);
let parsed = false;

// Try candidates in reverse order (last one is usually the cleanest)
for (let i = jsonCandidates.length - 1; i >= 0; i--) {
  try {
    const candidate = JSON.parse(jsonCandidates[i]) as Record<string, unknown>;
    if (candidate.example_urls && typeof candidate.example_urls === "object") {
      result = candidate as typeof result;
      parsed = true;
      break;
    }
  } catch {
    // try next candidate
  }
}

if (!parsed) {
  console.error(
    `Could not find valid JSON with example_urls in output. Found ${jsonCandidates.length} JSON candidates.`,
  );
  console.error("Raw output (first 2000 chars):");
  console.error(rawOutput.slice(0, 2000));
  process.exit(1);
}

// ── Report ─────────────────────────────────────────────────────────────
const resolvedCount = Object.keys(result.example_urls).length;
const unresolvedCount = result.unresolved?.length ?? 0;

console.log("===================================================");
console.log("  SPIKE 7b: LLM Route Resolver Results");
console.log("===================================================");
console.log(`  Resolved:   ${resolvedCount} / ${paramRoutes.length}`);
console.log(`  Unresolved: ${unresolvedCount}`);
console.log(`  Time:       ${elapsed}s`);
console.log(`  Cost:       $${costUsd.toFixed(4)}`);
console.log(`  Target:     30+ routes`);
console.log(`  Result:     ${resolvedCount >= 30 ? "PASS" : "FAIL"}`);
console.log("===================================================\n");

if (resolvedCount > 0) {
  console.log("-- Resolved routes (sample) --");
  const entries = Object.entries(result.example_urls);
  for (const [route, url] of entries.slice(0, 15)) {
    console.log(`  ${route}`);
    console.log(`    -> ${url}`);
  }
  if (entries.length > 15) {
    console.log(`  ... and ${entries.length - 15} more`);
  }
  console.log();
}

if (unresolvedCount > 0) {
  console.log("-- Unresolved routes --");
  for (const route of result.unresolved) {
    console.log(`  ${route}`);
  }
  console.log();
}

// Save full results
const outputData = {
  timestamp: new Date().toISOString(),
  elapsed_seconds: parseFloat(elapsed),
  resolved_count: resolvedCount,
  unresolved_count: unresolvedCount,
  total_parameterized_routes: paramRoutes.length,
  cost_usd: costUsd,
  target: 30,
  passed: resolvedCount >= 30,
  example_urls: result.example_urls,
  unresolved: result.unresolved,
};

writeFileSync(
  join(OUTPUT_DIR, "results.json"),
  JSON.stringify(outputData, null, 2),
);

console.log(`Full results saved to ${OUTPUT_DIR}/results.json`);
console.log(`Raw LLM output saved to ${OUTPUT_DIR}/raw-output.txt`);
console.log(`Raw stream saved to ${OUTPUT_DIR}/raw-stream.jsonl`);
