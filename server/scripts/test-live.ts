/**
 * Live integration test — bypasses Trigger.dev and runs pipelines directly.
 *
 * Usage:
 *   npx tsx scripts/test-live.ts <owner> <repo> <prNumber>
 *   npx tsx scripts/test-live.ts --mention <owner> <repo> <prNumber> [message]
 *
 * Examples:
 *   npx tsx scripts/test-live.ts abhishekray opslane-review-test 1
 *   npx tsx scripts/test-live.ts --mention abhishekray opslane-review-test 1 "is this safe?"
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
import { runMentionPipeline } from "../src/review/mention-pipeline.js";

function log(step: string, msg: string, data?: unknown) {
  const ts = new Date().toISOString().slice(11, 23);
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${ts}] [${step}]${extra} ${msg}`);
}

async function runReview(owner: string, repo: string, prNumber: number) {
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

async function runMention(owner: string, repo: string, prNumber: number, message: string) {
  console.log(`\n💬 Testing mention pipeline for ${owner}/${repo}#${prNumber}`);
  console.log(`   Message: "${message || "(empty — full review)"}"\n`);

  const result = await runMentionPipeline(
    { owner, repo, prNumber, mentionComment: message },
    {
      log,
      onOutputLine: () => process.stdout.write("."),
    }
  );

  if (!result.responseText) {
    console.error("\n❌ No response text extracted from claude output");
    process.exit(1);
  }

  console.log("\n--- MENTION RESPONSE PREVIEW (first 500 chars) ---");
  console.log(result.responseText.slice(0, 500));
  console.log("---\n");

  console.log(`\n✅ Done! Comment posted: ${result.commentUrl}\n`);
}

async function run() {
  const args = process.argv.slice(2);
  const isMention = args[0] === "--mention";

  if (isMention) {
    const [, owner, repo, prNumberStr, ...messageParts] = args;
    if (!owner || !repo || !prNumberStr) {
      console.error("Usage: npx tsx scripts/test-live.ts --mention <owner> <repo> <prNumber> [message]");
      process.exit(1);
    }
    const message = messageParts.join(" ") || "";
    await runMention(owner, repo, Number(prNumberStr), message);
  } else {
    const [owner, repo, prNumberStr] = args;
    if (!owner || !repo || !prNumberStr) {
      console.error("Usage: npx tsx scripts/test-live.ts <owner> <repo> <prNumber>");
      process.exit(1);
    }
    await runReview(owner, repo, Number(prNumberStr));
  }
}

run().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
