#!/usr/bin/env npx tsx
/**
 * Planner Eval: Score plan quality against downstream verdicts.
 *
 * Loads the eval set (42 runs, 174 ACs with known verdicts), scores each
 * planned AC on structural quality metrics, and correlates with downstream
 * pass/fail to establish the baseline.
 *
 * This eval does NOT re-run the planner — it scores existing plans.
 * To A/B test a new planner, use spike-planner-e2e.ts.
 *
 * Usage: cd pipeline && npx tsx src/evals/planner-eval.ts
 *        cd pipeline && npx tsx src/evals/planner-eval.ts --run-dir <path>  # score a single run
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validatePlan } from "../stages/plan-validator.js";
import { loadAppIndex } from "../lib/app-index.js";
import type { PlannerOutput, PlannedAC, AppIndex } from "../lib/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const VERIFY_DIR = "/tmp/documenso-verify";
const EVAL_SET_PATH = join(VERIFY_DIR, "evals", "planner-eval-set.json");

// ─── Types ───────────────────────────────────────────────────────────────────

interface EvalCase {
  run_id: string;
  groups: number;
  total_acs: number;
  acs: { groups: Array<{ id: string; condition: string; acs: Array<{ id: string; description: string }> }>; skipped: unknown[] };
  baseline_plan: PlannerOutput;
  verdicts: { verdicts: Array<{ ac_id: string; verdict: string; confidence: string; reasoning: string }> };
  browsed_acs: number;
  pass_count: number;
}

interface ACScore {
  ac_id: string;
  run_id: string;
  verdict: string;

  // Structural quality (plan-only, no downstream)
  validator_clean: boolean;
  route_matched: boolean;
  uses_example_url: boolean;
  starts_with_nav: boolean;
  has_screenshot: boolean;
  has_wait_after_nav: boolean;
  timeout_valid: boolean;
  no_login_steps: boolean;
  step_count: number;
  step_count_ok: boolean;  // 3-10

  // Composite
  structural_score: number;  // 0-1, average of boolean features
}

interface EvalResult {
  total_cases: number;
  total_acs: number;
  structural_baseline: {
    avg_score: number;
    validator_clean_pct: number;
    route_matched_pct: number;
    uses_example_url_pct: number;
    starts_with_nav_pct: number;
    has_screenshot_pct: number;
    has_wait_pct: number;
    no_login_pct: number;
    step_count_ok_pct: number;
    timeout_valid_pct: number;
  };
  verdict_correlation: Record<string, { count: number; avg_structural: number }>;
  per_ac: ACScore[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function routeToRegex(route: string): RegExp {
  const pattern = route.split(/:[a-zA-Z]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${pattern}$`);
}

const LOGIN_RE = /\b(login|sign.?in|log.?in|password)\b/i;
const NAV_RE = /^navigate\b/i;
const SCREENSHOT_RE = /screenshot|take.*screen/i;
const WAIT_RE = /wait.*page.*load|wait.*load/i;

function scoreAC(ac: PlannedAC, runId: string, verdict: string, appIndex: AppIndex): ACScore {
  const routes = Object.keys(appIndex.routes);
  const routePatterns = routes.map(r => ({ route: r, re: routeToRegex(r) }));
  const exampleUrls = appIndex.example_urls;
  const urlBase = ac.url.split("?")[0];
  const steps = ac.steps;
  const isAuthPage = ac.url.includes("/signin") || ac.url.includes("/login") || ac.url.includes("/signup");

  // Structural features
  const route_matched = routePatterns.some(({ re }) => re.test(urlBase));

  // Check if URL uses example_urls values (not invented params)
  let uses_example_url = true;
  if (route_matched) {
    const matched = routePatterns.find(({ re }) => re.test(urlBase));
    if (matched && matched.route.includes(":") && exampleUrls[matched.route]) {
      const exUrl = exampleUrls[matched.route].split("?")[0];
      // Compare param segments
      const routeParts = matched.route.split("/");
      const urlParts = urlBase.split("/");
      const exParts = exUrl.split("/");
      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i]?.startsWith(":") && urlParts[i] && exParts[i]) {
          if (urlParts[i] !== exParts[i]) uses_example_url = false;
        }
      }
    }
  }

  const validation = validatePlan({ criteria: [ac] }, appIndex);
  const validator_clean = validation.valid;
  const starts_with_nav = steps.length > 0 && NAV_RE.test(steps[0]);
  const has_screenshot = steps.some(s => SCREENSHOT_RE.test(s));
  const has_wait_after_nav = steps.length > 1 && WAIT_RE.test(steps[1]);
  const timeout_valid = ac.timeout_seconds >= 60 && ac.timeout_seconds <= 300;
  const no_login_steps = isAuthPage || !steps.some(s => LOGIN_RE.test(s));
  const step_count = steps.length;
  const step_count_ok = step_count >= 3 && step_count <= 10;

  const booleans = [validator_clean, route_matched, uses_example_url, starts_with_nav, has_screenshot, has_wait_after_nav, timeout_valid, no_login_steps, step_count_ok];
  const structural_score = booleans.filter(Boolean).length / booleans.length;

  return {
    ac_id: ac.id, run_id: runId, verdict,
    validator_clean, route_matched, uses_example_url,
    starts_with_nav, has_screenshot, has_wait_after_nav,
    timeout_valid, no_login_steps, step_count, step_count_ok,
    structural_score,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("═══ Planner Eval: Baseline Scoring ═══");
  console.log();

  const appIndex = loadAppIndex(VERIFY_DIR)!;

  // Single run mode
  const runDirArg = process.argv.indexOf("--run-dir");
  if (runDirArg !== -1 && process.argv[runDirArg + 1]) {
    const runDir = process.argv[runDirArg + 1];
    const plan: PlannerOutput = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf-8"));
    const verdicts = existsSync(join(runDir, "verdicts.json"))
      ? JSON.parse(readFileSync(join(runDir, "verdicts.json"), "utf-8"))
      : { verdicts: [] };
    const vMap = new Map(verdicts.verdicts.map((v: { ac_id: string; verdict: string }) => [v.ac_id, v.verdict]));

    console.log(`Scoring run: ${runDir}`);
    console.log(`Plan: ${plan.criteria.length} ACs`);
    console.log();

    for (const ac of plan.criteria) {
      const verdict = (vMap.get(ac.id) as string) ?? "no_verdict";
      const score = scoreAC(ac, "single", verdict, appIndex);
      const icon = score.structural_score === 1.0 ? "✓" : "!";
      console.log(`  ${icon} ${ac.id}: structural=${score.structural_score.toFixed(2)} verdict=${verdict} steps=${score.step_count} url=${ac.url}`);
      if (!score.validator_clean) console.log(`    ✗ validator errors`);
      if (!score.route_matched) console.log(`    ✗ URL doesn't match known route`);
      if (!score.uses_example_url) console.log(`    ✗ URL uses invented param values`);
      if (!score.no_login_steps) console.log(`    ✗ has login/auth steps`);
      if (!score.step_count_ok) console.log(`    ✗ step count ${score.step_count} outside [3,10]`);
    }
    return;
  }

  // Full eval set mode
  if (!existsSync(EVAL_SET_PATH)) {
    console.error(`Eval set not found at ${EVAL_SET_PATH}`);
    process.exit(1);
  }

  const cases: EvalCase[] = JSON.parse(readFileSync(EVAL_SET_PATH, "utf-8"));
  console.log(`Eval set: ${cases.length} cases, ${cases.reduce((s, c) => s + c.total_acs, 0)} ACs`);
  console.log();

  const allScores: ACScore[] = [];

  for (const tc of cases) {
    const vMap = new Map(tc.verdicts.verdicts.map(v => [v.ac_id, v.verdict]));
    for (const ac of tc.baseline_plan.criteria) {
      const verdict = vMap.get(ac.id) ?? "missing";
      allScores.push(scoreAC(ac, tc.run_id, verdict, appIndex));
    }
  }

  const total = allScores.length;
  const pct = (n: number) => `${Math.round(n * 100 / total)}%`;

  console.log("═══ STRUCTURAL BASELINE ═══");
  console.log(`Total planned ACs: ${total}`);
  console.log();
  console.log(`  validator_clean:   ${pct(allScores.filter(s => s.validator_clean).length)} (${allScores.filter(s => s.validator_clean).length}/${total})`);
  console.log(`  route_matched:     ${pct(allScores.filter(s => s.route_matched).length)} (${allScores.filter(s => s.route_matched).length}/${total})`);
  console.log(`  uses_example_url:  ${pct(allScores.filter(s => s.uses_example_url).length)} (${allScores.filter(s => s.uses_example_url).length}/${total})`);
  console.log(`  starts_with_nav:   ${pct(allScores.filter(s => s.starts_with_nav).length)} (${allScores.filter(s => s.starts_with_nav).length}/${total})`);
  console.log(`  has_screenshot:    ${pct(allScores.filter(s => s.has_screenshot).length)} (${allScores.filter(s => s.has_screenshot).length}/${total})`);
  console.log(`  has_wait_after_nav:${pct(allScores.filter(s => s.has_wait_after_nav).length)} (${allScores.filter(s => s.has_wait_after_nav).length}/${total})`);
  console.log(`  no_login_steps:    ${pct(allScores.filter(s => s.no_login_steps).length)} (${allScores.filter(s => s.no_login_steps).length}/${total})`);
  console.log(`  step_count_ok:     ${pct(allScores.filter(s => s.step_count_ok).length)} (${allScores.filter(s => s.step_count_ok).length}/${total})`);
  console.log(`  timeout_valid:     ${pct(allScores.filter(s => s.timeout_valid).length)} (${allScores.filter(s => s.timeout_valid).length}/${total})`);
  console.log();

  const avgStructural = allScores.reduce((s, a) => s + a.structural_score, 0) / total;
  console.log(`  Avg structural score: ${avgStructural.toFixed(3)}`);
  console.log(`  Steps: avg=${(allScores.reduce((s, a) => s + a.step_count, 0) / total).toFixed(1)}`);
  console.log();

  // Verdict correlation
  console.log("═══ VERDICT CORRELATION ═══");
  const byVerdict: Record<string, ACScore[]> = {};
  for (const s of allScores) {
    if (!byVerdict[s.verdict]) byVerdict[s.verdict] = [];
    byVerdict[s.verdict].push(s);
  }
  for (const [verdict, scores] of Object.entries(byVerdict).sort((a, b) => b[1].length - a[1].length)) {
    const avg = scores.reduce((s, a) => s + a.structural_score, 0) / scores.length;
    const avgSteps = scores.reduce((s, a) => s + a.step_count, 0) / scores.length;
    console.log(`  ${verdict}: n=${scores.length} avg_structural=${avg.toFixed(3)} avg_steps=${avgSteps.toFixed(1)}`);
  }
  console.log();

  // Defects: ACs with structural issues
  const defects = allScores.filter(s => s.structural_score < 1.0);
  if (defects.length > 0) {
    console.log("═══ DEFECTS (structural_score < 1.0) ═══");
    for (const d of defects) {
      const issues: string[] = [];
      if (!d.validator_clean) issues.push("validator");
      if (!d.route_matched) issues.push("route");
      if (!d.uses_example_url) issues.push("url_params");
      if (!d.no_login_steps) issues.push("login_steps");
      if (!d.step_count_ok) issues.push(`steps=${d.step_count}`);
      if (!d.has_wait_after_nav) issues.push("no_wait");
      console.log(`  ${d.run_id} ${d.ac_id}: ${d.structural_score.toFixed(2)} [${issues.join(", ")}] verdict=${d.verdict}`);
    }
  } else {
    console.log("No structural defects.");
  }

  // Write results
  const result: EvalResult = {
    total_cases: cases.length,
    total_acs: total,
    structural_baseline: {
      avg_score: avgStructural,
      validator_clean_pct: allScores.filter(s => s.validator_clean).length / total,
      route_matched_pct: allScores.filter(s => s.route_matched).length / total,
      uses_example_url_pct: allScores.filter(s => s.uses_example_url).length / total,
      starts_with_nav_pct: allScores.filter(s => s.starts_with_nav).length / total,
      has_screenshot_pct: allScores.filter(s => s.has_screenshot).length / total,
      has_wait_pct: allScores.filter(s => s.has_wait_after_nav).length / total,
      no_login_pct: allScores.filter(s => s.no_login_steps).length / total,
      step_count_ok_pct: allScores.filter(s => s.step_count_ok).length / total,
      timeout_valid_pct: allScores.filter(s => s.timeout_valid).length / total,
    },
    verdict_correlation: Object.fromEntries(
      Object.entries(byVerdict).map(([v, scores]) => [v, {
        count: scores.length,
        avg_structural: scores.reduce((s, a) => s + a.structural_score, 0) / scores.length,
      }]),
    ),
    per_ac: allScores,
  };

  const outPath = join(VERIFY_DIR, "evals", "planner-baseline.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nBaseline → ${outPath}`);
}

main();
