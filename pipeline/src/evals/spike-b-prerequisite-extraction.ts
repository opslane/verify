#!/usr/bin/env npx tsx
/**
 * Spike B: Can an LLM reliably extract data prerequisites from a plan?
 *
 * Takes the introspection data from failed missing_data cases, simulates what
 * a planner *would have seen* (the AC descriptions and URLs), and asks an LLM
 * to infer what data prerequisites should have been emitted.
 *
 * Compares LLM-extracted prerequisites against the ground truth from introspection.
 *
 * Usage:
 *   npx tsx src/evals/spike-b-prerequisite-extraction.ts /path/to/eval-results.jsonl
 *
 * Requires:
 *   - claude CLI available (uses `claude -p`)
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

interface Verdict {
  ac_id: string;
  verdict: string;
  reasoning: string;
}

interface Introspection {
  ac_id: string;
  failed_stage: string | null;
  root_cause: string;
  detail: string;
  suggested_fix: string | null;
}

interface EvalResult {
  pr: number;
  title: string;
  verdicts: Verdict[];
  introspection: Introspection[];
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx src/evals/spike-b-prerequisite-extraction.ts <eval-results.jsonl>");
  process.exit(1);
}

const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
const results: EvalResult[] = lines.map(l => JSON.parse(l));

// Collect PRs with missing_data failures, deduplicated by PR
const prMap = new Map<number, { title: string; acs: { ac_id: string; reasoning: string; detail: string; suggested_fix: string | null }[] }>();

for (const r of results) {
  for (const intro of r.introspection) {
    if (intro.root_cause === "missing_data") {
      if (!prMap.has(r.pr)) prMap.set(r.pr, { title: r.title, acs: [] });
      const verdict = r.verdicts.find(v => v.ac_id === intro.ac_id);
      prMap.get(r.pr)!.acs.push({
        ac_id: intro.ac_id,
        reasoning: verdict?.reasoning ?? "",
        detail: intro.detail,
        suggested_fix: intro.suggested_fix,
      });
    }
  }
}

console.log(`\n=== Spike B: LLM prerequisite extraction ===\n`);
console.log(`PRs with missing_data failures: ${prMap.size}\n`);

const outputDir = join(import.meta.dirname ?? ".", "..", "..", "spike-b-output-" + Date.now());
mkdirSync(outputDir, { recursive: true });

// Build the prompt for each PR — give the LLM ONLY what the planner would have:
// the AC descriptions and URLs (from verdict reasoning), NOT the introspection diagnosis

interface ExtractionResult {
  pr: number;
  title: string;
  ground_truth: string[];
  llm_prerequisites: string[];
  match: "full" | "partial" | "miss";
}

const extractionResults: ExtractionResult[] = [];

// Process up to 6 PRs to keep cost/time reasonable
const prsToTest = [...prMap.entries()].slice(0, 6);

for (const [pr, data] of prsToTest) {
  console.log(`--- PR ${pr}: ${data.title} ---`);

  // Ground truth: what SHOULD have been created (from introspection)
  const groundTruth = [...new Set(data.acs.map(a => a.suggested_fix).filter(Boolean))] as string[];

  // Build a simulated "planner output" — just ACs + the evidence of failure
  // (what the browse agent SAW, not what the introspection DIAGNOSED)
  const acSummaries = data.acs.map(a =>
    `AC ${a.ac_id}: ${a.reasoning.slice(0, 200)}`
  ).join("\n");

  const prompt = `You are analyzing a test plan for a web application. The following ACs were planned
but ALL failed because browse agents hit errors (404s, empty tables, missing entities).

Your job: from the AC descriptions and error evidence below, infer what DATA PREREQUISITES
should have been set up in the database BEFORE the browse agents ran.

Output a JSON array of prerequisite condition strings. Each string should be a plain English
description of what data needs to exist. Be specific about entity types, relationships, and
any required field values.

ACs and their failure evidence:
${acSummaries}

PR title for context: ${data.title}

Output ONLY a JSON array of strings. No explanation.`;

  try {
    const result = execSync(
      `claude -p --model haiku "${prompt.replace(/"/g, '\\"')}"`,
      { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );

    const cleaned = result.replace(/^```json?\n?|\n?```$/g, "").trim();
    let prerequisites: string[] = [];
    try {
      prerequisites = JSON.parse(cleaned);
      if (!Array.isArray(prerequisites)) prerequisites = [String(prerequisites)];
    } catch {
      console.log(`  ✗ Failed to parse LLM output: ${cleaned.slice(0, 100)}`);
      extractionResults.push({ pr, title: data.title, ground_truth: groundTruth, llm_prerequisites: [], match: "miss" });
      continue;
    }

    console.log(`  Ground truth (${groundTruth.length}):`);
    for (const gt of groundTruth) console.log(`    - ${gt.slice(0, 100)}`);
    console.log(`  LLM extracted (${prerequisites.length}):`);
    for (const p of prerequisites) console.log(`    - ${p.slice(0, 100)}`);

    // Simple match: does the LLM mention the same entity types?
    const gtText = groundTruth.join(" ").toLowerCase();
    const llmText = prerequisites.join(" ").toLowerCase();

    const entityKeywords = ["document", "template", "organisation", "organization", "invitation", "webhook", "token", "envelope", "member", "recipient"];
    const gtEntities = entityKeywords.filter(k => gtText.includes(k));
    const llmEntities = entityKeywords.filter(k => llmText.includes(k));
    const overlap = gtEntities.filter(e => llmEntities.includes(e));

    const match = overlap.length === gtEntities.length ? "full"
      : overlap.length > 0 ? "partial"
      : "miss";

    console.log(`  Entity match: ${match} (GT: [${gtEntities}], LLM: [${llmEntities}], overlap: [${overlap}])\n`);

    extractionResults.push({ pr, title: data.title, ground_truth: groundTruth, llm_prerequisites: prerequisites, match });

  } catch (e) {
    const err = e as { message?: string };
    console.log(`  ✗ LLM call failed: ${err.message?.slice(0, 100)}\n`);
    extractionResults.push({ pr, title: data.title, ground_truth: groundTruth, llm_prerequisites: [], match: "miss" });
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n=== RESULTS ===\n`);

const full = extractionResults.filter(r => r.match === "full").length;
const partial = extractionResults.filter(r => r.match === "partial").length;
const miss = extractionResults.filter(r => r.match === "miss").length;

console.log(`  Full match:    ${full}/${extractionResults.length}`);
console.log(`  Partial match: ${partial}/${extractionResults.length}`);
console.log(`  Miss:          ${miss}/${extractionResults.length}`);

writeFileSync(join(outputDir, "spike-b-results.json"), JSON.stringify(extractionResults, null, 2));
console.log(`\n  Full results: ${join(outputDir, "spike-b-results.json")}`);

console.log(`\n=== VERDICT ===\n`);
const goodRate = (full + partial) / extractionResults.length;
if (goodRate >= 0.75) {
  console.log(`✓ LLM correctly identifies prerequisites ${Math.round(goodRate * 100)}% of the time.`);
  console.log(`  → Planner CAN reliably extract data prerequisites from AC descriptions.`);
} else {
  console.log(`✗ LLM only identifies prerequisites ${Math.round(goodRate * 100)}% of the time.`);
  console.log(`  → Need a more structured approach than free-form LLM extraction.`);
}
console.log();
