/**
 * Live integration test — bypasses Trigger.dev and runs the review pipeline directly.
 *
 * Usage:
 *   npx tsx scripts/test-live.ts <owner> <repo> <prNumber>
 *
 * Example:
 *   npx tsx scripts/test-live.ts abhishekray opslane-review-test 1
 *
 * Requires server/.env to be populated.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env manually (tsx doesn't auto-load it)
const envPath = resolve(import.meta.dirname, "../.env");
for (const line of readFileSync(envPath, "utf-8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  // Strip surrounding quotes (handles multiline PEM keys via env file)
  if (val.startsWith('"')) {
    // Multi-line: read raw value from file properly
    const match = readFileSync(envPath, "utf-8").match(
      new RegExp(`${key}="([\\s\\S]*?)"`, "m")
    );
    if (match) val = match[1];
  }
  if (!process.env[key]) process.env[key] = val;
}

import { runReviewPipeline } from "../src/review/pipeline.js";

function log(step: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${ts}] [${step}]${extra} ${msg}`);
}

async function run() {
  const [owner, repo, prNumberStr] = process.argv.slice(2);
  if (!owner || !repo || !prNumberStr) {
    console.error("Usage: npx tsx scripts/test-live.ts <owner> <repo> <prNumber>");
    process.exit(1);
  }
  const prNumber = Number(prNumberStr);

  console.log(`\n🔍 Testing review pipeline for ${owner}/${repo}#${prNumber}\n`);

  const result = await runReviewPipeline(
    { owner, repo, prNumber },
    {
      log,
      onOutputLine: () => process.stdout.write("."),
    }
  );

  if (!result.reviewText) {
    console.error("\n❌ No review text extracted from claude output");
    process.exit(1);
  }

  console.log("\n--- REVIEW PREVIEW (first 500 chars) ---");
  console.log(result.reviewText.slice(0, 500));
  console.log("---\n");

  console.log(`\n✅ Done! Review posted: ${result.reviewUrl}\n`);
}

run().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
