#!/usr/bin/env npx tsx
/**
 * Spike: Can Prisma @unique columns predict URL lookup columns?
 *
 * Hypothesis: When a table has a @unique column besides the PK,
 * route params like :id map to that column, not the PK.
 *
 * Test: For Documenso's parameterized routes, check if the @unique
 * column from the Prisma schema matches what the app actually uses
 * for URL resolution. Verify by querying the DB: does the route URL
 * that works in the app use the @unique column value?
 *
 * Usage: cd pipeline && npx tsx src/evals/spike-unique-col-resolver.ts
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/Users/abhishekray/Projects/opslane/evals/documenso";
const DB_URL_ENV = "NEXT_PRIVATE_DATABASE_URL";

function getDbUrl(): string {
  // Load from .env
  try {
    const envContent = readFileSync(`${PROJECT_DIR}/.env`, "utf-8");
    for (const line of envContent.split("\n")) {
      if (line.startsWith(`${DB_URL_ENV}=`)) {
        return line.slice(DB_URL_ENV.length + 1).replace(/["']/g, "").trim();
      }
    }
  } catch { /* ignore */ }
  return process.env[DB_URL_ENV] ?? "";
}

function psql(dbUrl: string, sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -F'\t' -c ${JSON.stringify(sql)}`,
      { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "";
  }
}

// ─── Step 1: Parse Prisma schema for @unique columns ─────────────────────────

interface UniqueColumn {
  model: string;
  column: string;
  type: string;
  hasDefault: boolean;
  defaultFn: string | null;  // cuid, uuid, etc.
}

function parseUniqueColumns(schemaPath: string): UniqueColumn[] {
  const content = readFileSync(schemaPath, "utf-8");
  const results: UniqueColumn[] = [];
  let currentModel = "";

  for (const line of content.split("\n")) {
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      currentModel = modelMatch[1];
      continue;
    }
    if (line.trim() === "}") {
      currentModel = "";
      continue;
    }
    if (!currentModel) continue;

    // Look for @unique columns that are NOT @id
    if (line.includes("@unique") && !line.includes("@id")) {
      const fieldMatch = line.trim().match(/^(\w+)\s+(\w+)/);
      if (fieldMatch) {
        const [, colName, colType] = fieldMatch;
        const hasDefault = line.includes("@default");
        const defaultMatch = line.match(/@default\((\w+)\(\)/);
        results.push({
          model: currentModel,
          column: colName,
          type: colType,
          hasDefault,
          defaultFn: defaultMatch ? defaultMatch[1] : null,
        });
      }
    }
  }

  return results;
}

// ─── Step 2: Find which @unique columns are URL-candidate columns ────────────

function isUrlCandidate(col: UniqueColumn): boolean {
  // Heuristic: a @unique String/text column with cuid/uuid default
  // or a column named like slug, url, handle, uid, secondaryId, publicId
  const urlNames = ["secondaryId", "slug", "url", "uid", "publicId", "handle", "uuid", "externalId"];
  if (urlNames.includes(col.column)) return true;
  if (col.type === "String" && col.defaultFn && ["cuid", "uuid"].includes(col.defaultFn)) return true;
  return false;
}

// ─── Step 3: Verify against actual DB — do routes use these columns? ─────────

interface VerifyResult {
  model: string;
  pkColumn: string;
  pkValue: string;
  uniqueColumn: string;
  uniqueValue: string;
  routePattern: string;
  routeUsesUnique: boolean | "unknown";
  evidence: string;
}

function verifyAgainstDb(dbUrl: string, model: string, uniqueCol: string): VerifyResult | null {
  // Get the table name (Prisma model name = table name unless @@map)
  const tableName = model;

  // Get a sample row with both PK and unique column
  const row = psql(dbUrl, `SELECT "id", "${uniqueCol}" FROM "${tableName}" LIMIT 1`);
  if (!row) return null;

  const [pkValue, uniqueValue] = row.split("\t");
  if (!pkValue || !uniqueValue) return null;

  // Check: is the PK value URL-friendly?
  const pkIsUrlFriendly = /^[a-zA-Z0-9_-]+$/.test(pkValue) && pkValue.length < 100;
  const uniqueIsUrlFriendly = /^[a-zA-Z0-9_-]+$/.test(uniqueValue) && uniqueValue.length < 100;

  // If PK is a number or long string, and unique is a short slug/UUID, route likely uses unique
  const pkIsNumeric = /^\d+$/.test(pkValue);

  let routeUsesUnique: boolean | "unknown" = "unknown";
  let evidence = "";

  if (pkIsNumeric && uniqueIsUrlFriendly) {
    routeUsesUnique = true;
    evidence = `PK is numeric (${pkValue}), unique col is URL-friendly (${uniqueValue.slice(0, 30)}...)`;
  } else if (!pkIsUrlFriendly && uniqueIsUrlFriendly) {
    routeUsesUnique = true;
    evidence = `PK not URL-friendly (${pkValue.slice(0, 30)}...), unique col is (${uniqueValue.slice(0, 30)}...)`;
  } else if (pkIsUrlFriendly && !uniqueIsUrlFriendly) {
    routeUsesUnique = false;
    evidence = `PK is URL-friendly (${pkValue.slice(0, 30)}...), unique col is not`;
  } else {
    evidence = `Both look URL-friendly: PK=${pkValue.slice(0, 30)}, unique=${uniqueValue.slice(0, 30)}`;
  }

  return {
    model,
    pkColumn: "id",
    pkValue: pkValue.slice(0, 50),
    uniqueColumn: uniqueCol,
    uniqueValue: uniqueValue.slice(0, 50),
    routePattern: `/.../:id`,
    routeUsesUnique,
    evidence,
  };
}

// ─── Step 4: Ground truth — what do we KNOW the app uses? ────────────────────

const GROUND_TRUTH: Record<string, string> = {
  // model → which column the route :id param actually maps to
  "Envelope": "secondaryId",  // confirmed: routes use secondaryId (UUID), not id (text PK)
  "Team": "url",              // confirmed: routes use /t/:teamUrl where teamUrl = Team.url
};

// ─── Main ────────────────────────────────────────────────────────────────────

console.log("=".repeat(70));
console.log("Spike: @unique Column → URL Lookup Column");
console.log("=".repeat(70));

// Step 1: Parse Prisma schema
const schemaPath = `${PROJECT_DIR}/packages/prisma/schema.prisma`;
console.log(`\nParsing: ${schemaPath}`);
const uniqueCols = parseUniqueColumns(schemaPath);
console.log(`Found ${uniqueCols.length} @unique columns (non-PK)`);

// Step 2: Filter to URL candidates
const candidates = uniqueCols.filter(isUrlCandidate);
console.log(`URL candidates: ${candidates.length}`);

console.log("\nAll @unique columns:");
for (const col of uniqueCols) {
  const isCandidate = isUrlCandidate(col);
  console.log(`  ${col.model}.${col.column} (${col.type}${col.defaultFn ? `, @default(${col.defaultFn}())` : ""}) ${isCandidate ? "← URL CANDIDATE" : ""}`);
}

// Step 3: Verify candidates against DB
const dbUrl = getDbUrl();
if (!dbUrl) {
  console.error("\nERROR: No DB URL found. Set NEXT_PRIVATE_DATABASE_URL in .env");
  process.exit(1);
}

console.log("\n" + "-".repeat(70));
console.log("Verification against DB:");
console.log("-".repeat(70));

let correct = 0;
let incorrect = 0;
let unknown = 0;
let totalVerified = 0;

for (const col of candidates) {
  const result = verifyAgainstDb(dbUrl, col.model, col.column);
  if (!result) {
    console.log(`  ${col.model}.${col.column}: NO DATA (table empty or column missing)`);
    continue;
  }

  totalVerified++;
  const groundTruth = GROUND_TRUTH[col.model];
  const prediction = col.column;  // We predict the route uses this @unique column

  let status: string;
  if (groundTruth) {
    if (prediction === groundTruth) {
      status = "✓ CORRECT";
      correct++;
    } else {
      status = `✗ WRONG (expected ${groundTruth})`;
      incorrect++;
    }
  } else {
    status = `? (no ground truth, heuristic says: ${result.routeUsesUnique})`;
    unknown++;
  }

  console.log(`  ${col.model}.${col.column}:`);
  console.log(`    PK: ${result.pkValue}`);
  console.log(`    @unique: ${result.uniqueValue}`);
  console.log(`    Evidence: ${result.evidence}`);
  console.log(`    Prediction: route uses ${prediction} → ${status}`);
}

// Step 4: Also check models WITHOUT @unique candidates — do they use PK?
console.log("\n" + "-".repeat(70));
console.log("Models WITHOUT URL-candidate @unique columns (should use PK):");
console.log("-".repeat(70));

const modelsWithCandidates = new Set(candidates.map(c => c.model));
const modelsInGroundTruth = Object.keys(GROUND_TRUTH);
for (const model of modelsInGroundTruth) {
  if (!modelsWithCandidates.has(model)) {
    console.log(`  ${model}: no @unique URL candidate → predict PK (id)`);
    if (GROUND_TRUTH[model] === "id") {
      console.log(`    ✓ CORRECT`);
      correct++;
    } else {
      console.log(`    ✗ WRONG (actually uses ${GROUND_TRUTH[model]})`);
      incorrect++;
    }
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log("RESULTS");
console.log("=".repeat(70));
console.log(`\nVerified against ground truth: ${correct + incorrect}/${correct + incorrect + unknown}`);
console.log(`  Correct: ${correct}`);
console.log(`  Incorrect: ${incorrect}`);
console.log(`  Unknown (no ground truth): ${unknown}`);

if (correct > 0 && incorrect === 0) {
  console.log(`\nVERDICT: @unique heuristic is ${correct}/${correct} — works for all verified cases.`);
  console.log("The approach: at index-app time, parse @unique columns from Prisma schema.");
  console.log("Store url_lookup_columns in app.json. Planner/setup-writer use these instead of PK.");
} else if (incorrect > 0) {
  console.log(`\nVERDICT: @unique heuristic is ${correct}/${correct + incorrect} — has false positives/negatives.`);
  console.log("Need additional signals (column name, type, default) to disambiguate.");
} else {
  console.log(`\nVERDICT: No ground truth data to verify. Add more entries to GROUND_TRUTH.`);
}

// Step 5: Show what the pipeline would store in app.json
console.log("\n" + "-".repeat(70));
console.log("Proposed app.json addition (url_lookup_columns):");
console.log("-".repeat(70));
const urlLookup: Record<string, string> = {};
for (const col of candidates) {
  // If a model has multiple candidates, prefer the one named secondaryId/slug/url
  const existing = urlLookup[col.model];
  if (!existing || ["secondaryId", "slug", "url", "uid"].includes(col.column)) {
    urlLookup[col.model] = col.column;
  }
}
console.log(JSON.stringify({ url_lookup_columns: urlLookup }, null, 2));
