#!/usr/bin/env npx tsx
/**
 * Spike C: URL-pattern heuristic analysis
 *
 * Tests whether a simple regex scan of planned URLs + introspection details
 * can detect entity references and predict missing_data failures — without
 * needing the planner to emit explicit conditions.
 *
 * Usage:
 *   npx tsx src/evals/spike-c-heuristic.ts /path/to/eval-results.jsonl
 */

import { readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── URL pattern rules ──────────────────────────────────────────────────────────

interface HeuristicRule {
  name: string;
  /** Regex applied to the introspection detail + verdict reasoning text */
  pattern: RegExp;
  /** What data prerequisite would be generated */
  condition: string;
}

const RULES: HeuristicRule[] = [
  {
    name: "document-by-id",
    pattern: /\/documents\/[\w-]+\/edit|document.*(?:id|ID)\s*(?:1|[\d]+).*(?:not found|404|does not exist)/i,
    condition: "a draft document must exist for the test user",
  },
  {
    name: "document-404",
    pattern: /Document not found|document.*404|document.*does not exist/i,
    condition: "a document must exist at the navigated URL",
  },
  {
    name: "org-not-found",
    pattern: /Organisation not found|organisation.*404|org.*does not exist|organization.*not found/i,
    condition: "an organisation must exist with the expected slug",
  },
  {
    name: "template-empty",
    pattern: /no templates|templates.*empty|We're all empty|template.*does not exist/i,
    condition: "at least one template must be seeded for the test user",
  },
  {
    name: "documents-table-empty",
    pattern: /0 documents|0 results|Something went wrong.*table|documents.*table.*0|no.*document.*rows/i,
    condition: "at least one document must be seeded for the test user",
  },
  {
    name: "embed-token-missing",
    pattern: /embed.*token|direct_tok|signing token.*not.*exist|embed.*404/i,
    condition: "a direct template with a valid signing token must be seeded",
  },
  {
    name: "invitation-missing",
    pattern: /invitation.*not.*exist|pending.*invitation|no.*invit/i,
    condition: "a pending invitation must exist in the test organisation",
  },
  {
    name: "webhook-missing",
    pattern: /webhook.*not.*exist|no.*webhook/i,
    condition: "at least one webhook must be configured for the test entity",
  },
  {
    name: "hardcoded-id",
    pattern: /hardcod.*id|assumed.*id.*1|ID 1|id of 1/i,
    condition: "use actual seeded entity ID instead of hardcoded value",
  },
  {
    name: "seed-data-missing-generic",
    pattern: /no.*(?:test|seed).*data|test data.*absent|fixture.*missing|never.*(?:created|seeded|inserted)/i,
    condition: "seed data must be created before browse agent runs",
  },
];

// ── Main ───────────────────────────────────────────────────────────────────────

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npx tsx src/evals/spike-c-heuristic.ts <eval-results.jsonl>");
  process.exit(1);
}

const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
const results: EvalResult[] = lines.map(l => JSON.parse(l));

// Filter to only missing_data introspections
interface MissingDataCase {
  pr: number;
  title: string;
  ac_id: string;
  detail: string;
  reasoning: string;
}

const missingDataCases: MissingDataCase[] = [];
for (const r of results) {
  for (const intro of r.introspection) {
    if (intro.root_cause === "missing_data") {
      const verdict = r.verdicts.find(v => v.ac_id === intro.ac_id);
      missingDataCases.push({
        pr: r.pr,
        title: r.title,
        ac_id: intro.ac_id,
        detail: intro.detail,
        reasoning: verdict?.reasoning ?? "",
      });
    }
  }
}

console.log(`\n=== Spike C: URL-pattern heuristic analysis ===\n`);
console.log(`Total missing_data cases: ${missingDataCases.length}`);
console.log(`Total PRs in eval set: ${results.length}\n`);

// Run heuristics
interface MatchResult {
  pr: number;
  title: string;
  ac_id: string;
  matched_rules: string[];
  conditions: string[];
}

const matched: MatchResult[] = [];
const unmatched: MissingDataCase[] = [];

for (const c of missingDataCases) {
  const text = `${c.detail} ${c.reasoning}`;
  const hits: { name: string; condition: string }[] = [];

  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      hits.push({ name: rule.name, condition: rule.condition });
    }
  }

  if (hits.length > 0) {
    matched.push({
      pr: c.pr,
      title: c.title,
      ac_id: c.ac_id,
      matched_rules: hits.map(h => h.name),
      conditions: hits.map(h => h.condition),
    });
  } else {
    unmatched.push(c);
  }
}

// Deduplicate by PR (one PR can have multiple ACs with the same root cause)
const matchedPRs = new Set(matched.map(m => m.pr));
const unmatchedPRs = new Set(unmatched.filter(u => !matchedPRs.has(u.pr)).map(u => u.pr));
const totalAffectedPRs = new Set(missingDataCases.map(c => c.pr));

console.log(`--- Results ---\n`);
console.log(`AC-level:  ${matched.length}/${missingDataCases.length} cases caught (${Math.round(matched.length / missingDataCases.length * 100)}%)`);
console.log(`PR-level:  ${matchedPRs.size}/${totalAffectedPRs.size} PRs caught (${Math.round(matchedPRs.size / totalAffectedPRs.size * 100)}%)\n`);

// Rule hit frequency
console.log(`--- Rule hit frequency ---\n`);
const ruleCounts: Record<string, number> = {};
for (const m of matched) {
  for (const rule of m.matched_rules) {
    ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
  }
}
const sorted = Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]);
for (const [rule, count] of sorted) {
  console.log(`  ${rule}: ${count}`);
}

// Show unmatched cases
if (unmatched.length > 0) {
  console.log(`\n--- Unmatched cases (${unmatched.length}) ---\n`);
  for (const u of unmatched) {
    console.log(`  PR ${u.pr} (${u.title}) ${u.ac_id}:`);
    console.log(`    ${u.detail.slice(0, 150)}...`);
    console.log();
  }
}

// Show matched cases grouped by PR
console.log(`\n--- Matched cases by PR ---\n`);
const byPR = new Map<number, MatchResult[]>();
for (const m of matched) {
  if (!byPR.has(m.pr)) byPR.set(m.pr, []);
  byPR.get(m.pr)!.push(m);
}
for (const [pr, cases] of byPR) {
  console.log(`  PR ${pr} (${cases[0].title}):`);
  const uniqueRules = [...new Set(cases.flatMap(c => c.matched_rules))];
  const uniqueConditions = [...new Set(cases.flatMap(c => c.conditions))];
  console.log(`    Rules: ${uniqueRules.join(", ")}`);
  console.log(`    Conditions: ${uniqueConditions.join("; ")}`);
  console.log();
}

// Summary verdict
console.log(`\n=== VERDICT ===\n`);
const pctCaught = Math.round(matched.length / missingDataCases.length * 100);
if (pctCaught >= 65) {
  console.log(`✓ Heuristic catches ${pctCaught}% of cases — a deterministic URL/text`);
  console.log(`  scanner could handle most missing_data failures WITHOUT planner changes.`);
  console.log(`  Consider: post-planner precondition resolver using these patterns.`);
} else {
  console.log(`✗ Heuristic only catches ${pctCaught}% — too low for a pure pattern approach.`);
  console.log(`  The planner needs to emit explicit data prerequisites (hypothesis #1).`);
}
console.log();
