#!/usr/bin/env npx tsx
/**
 * Planner SDK Eval: Re-run the planner on all 42 eval cases using the SDK path,
 * score the output, and compare against the CLI baseline.
 *
 * For each case:
 * 1. Write acs.json to a temp run dir
 * 2. Run SDK planner (same as VERIFY_PLANNER_SDK=1 in orchestrator)
 * 3. Score the plan with the structural scorer
 * 4. Compare against baseline plan
 *
 * Usage: cd pipeline && npx tsx src/evals/planner-sdk-eval.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runPlannerSDK } from "../stages/planner-sdk.js";
import { validatePlan } from "../stages/plan-validator.js";
import { loadAppIndex } from "../lib/app-index.js";
import type { PlannerOutput, PlannedAC, AppIndex } from "../lib/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const VERIFY_DIR = "/tmp/documenso-verify";
const EVAL_SET_PATH = join(VERIFY_DIR, "evals", "planner-eval-set.json");
const PROJECT_ROOT = join(process.env.HOME ?? "~", "Projects/opslane/evals/documenso");

// ─── Types ───────────────────────────────────────────────────────────────────

interface EvalCase {
  run_id: string;
  groups: number;
  total_acs: number;
  acs: unknown;
  baseline_plan: PlannerOutput;
  verdicts: { verdicts: Array<{ ac_id: string; verdict: string }> };
}

// ─── Scoring (same as planner-eval.ts) ───────────────────────────────────────

function routeToRegex(route: string): RegExp {
  const pattern = route.split(/:[a-zA-Z]+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+");
  return new RegExp(`^${pattern}$`);
}

const LOGIN_RE = /\b(login|sign.?in|log.?in|password)\b/i;
const NAV_RE = /^navigate\b/i;
const SCREENSHOT_RE = /screenshot|take.*screen/i;
const WAIT_RE = /wait.*page.*load|wait.*load/i;

function scoreAC(ac: PlannedAC, appIndex: AppIndex): number {
  const routes = Object.keys(appIndex.routes);
  const routePatterns = routes.map(r => ({ route: r, re: routeToRegex(r) }));
  const exampleUrls = appIndex.example_urls;
  const urlBase = ac.url.split("?")[0];
  const steps = ac.steps;
  const isAuthPage = ac.url.includes("/signin") || ac.url.includes("/login") || ac.url.includes("/signup");

  const route_matched = routePatterns.some(({ re }) => re.test(urlBase));

  let uses_example_url = true;
  if (route_matched) {
    const matched = routePatterns.find(({ re }) => re.test(urlBase));
    if (matched && matched.route.includes(":") && exampleUrls[matched.route]) {
      const exUrl = exampleUrls[matched.route].split("?")[0];
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
  const step_count_ok = steps.length >= 3 && steps.length <= 10;

  const booleans = [validator_clean, route_matched, uses_example_url, starts_with_nav, has_screenshot, has_wait_after_nav, timeout_valid, no_login_steps, step_count_ok];
  return booleans.filter(Boolean).length / booleans.length;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ Planner SDK Eval: Full Re-Plan ═══");
  console.log();

  if (!existsSync(EVAL_SET_PATH)) {
    console.error(`Eval set not found at ${EVAL_SET_PATH}`);
    process.exit(1);
  }

  const appIndex = loadAppIndex(VERIFY_DIR)!;
  const cases: EvalCase[] = JSON.parse(readFileSync(EVAL_SET_PATH, "utf-8"));
  console.log(`Eval set: ${cases.length} cases, ${cases.reduce((s, c) => s + c.total_acs, 0)} ACs`);
  console.log(`Project root: ${PROJECT_ROOT}`);
  console.log();

  const outputDir = join(VERIFY_DIR, "evals", `sdk-eval-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  interface CaseResult {
    run_id: string;
    total_acs: number;
    sdk_acs: number;
    sdk_avg_score: number;
    baseline_avg_score: number;
    sdk_errors: string[];
    url_match_count: number;
    sdk_duration_ms: number;
  }

  const results: CaseResult[] = [];
  let completed = 0;

  for (const tc of cases) {
    completed++;
    console.log(`─── [${completed}/${cases.length}] ${tc.run_id} (${tc.groups}g, ${tc.total_acs}ac) ───`);

    // Set up temp run dir with acs.json
    const runDir = join(outputDir, tc.run_id);
    mkdirSync(join(runDir, "logs"), { recursive: true });
    writeFileSync(join(runDir, "acs.json"), JSON.stringify(tc.acs, null, 2));

    // Run SDK planner
    const sdkResult = await runPlannerSDK({
      acsPath: join(runDir, "acs.json"),
      appIndex,
      timeoutMs: 240_000,
      stage: "planner",
      runDir,
      cwd: PROJECT_ROOT,
    });

    if (!sdkResult.plan) {
      console.log(`  SDK FAILED: ${sdkResult.error ?? "unknown"} (${sdkResult.durationMs}ms)`);
      results.push({
        run_id: tc.run_id, total_acs: tc.total_acs, sdk_acs: 0,
        sdk_avg_score: 0, baseline_avg_score: 0, sdk_errors: [sdkResult.error ?? "unknown"],
        url_match_count: 0, sdk_duration_ms: sdkResult.durationMs,
      });
      continue;
    }

    writeFileSync(join(runDir, "plan.json"), JSON.stringify(sdkResult.plan, null, 2));

    // Score SDK plan
    const sdkScores = sdkResult.plan.criteria.map(ac => scoreAC(ac, appIndex));
    const sdkAvg = sdkScores.length > 0 ? sdkScores.reduce((a, b) => a + b, 0) / sdkScores.length : 0;

    // Score baseline plan
    const baseScores = tc.baseline_plan.criteria.map(ac => scoreAC(ac, appIndex));
    const baseAvg = baseScores.length > 0 ? baseScores.reduce((a, b) => a + b, 0) / baseScores.length : 0;

    // URL match
    const routes = Object.keys(appIndex.routes);
    const routePatterns = routes.map(r => ({ route: r, re: routeToRegex(r) }));
    const baseUrlMap = new Map(tc.baseline_plan.criteria.map(ac => [ac.id, ac.url]));
    let urlMatchCount = 0;
    for (const ac of sdkResult.plan.criteria) {
      const baseUrl = baseUrlMap.get(ac.id);
      if (baseUrl) {
        const u1 = ac.url.split("?")[0];
        const u2 = baseUrl.split("?")[0];
        if (u1 === u2 || routePatterns.some(({ re }) => re.test(u1) && re.test(u2))) {
          urlMatchCount++;
        }
      }
    }

    // Errors
    const sdkErrors: string[] = [];
    const validation = validatePlan(sdkResult.plan, appIndex);
    if (!validation.valid) {
      for (const e of validation.errors) sdkErrors.push(`${e.acId}: ${e.message}`);
    }

    const status = sdkAvg >= baseAvg ? "OK" : "REGRESSED";
    console.log(`  ${status}: SDK=${sdkResult.plan.criteria.length}ac score=${sdkAvg.toFixed(3)} baseline=${baseAvg.toFixed(3)} urls=${urlMatchCount}/${tc.total_acs} ${sdkResult.durationMs}ms`);
    if (sdkErrors.length > 0) {
      for (const e of sdkErrors.slice(0, 2)) console.log(`    ✗ ${e}`);
    }

    results.push({
      run_id: tc.run_id, total_acs: tc.total_acs, sdk_acs: sdkResult.plan.criteria.length,
      sdk_avg_score: sdkAvg, baseline_avg_score: baseAvg, sdk_errors: sdkErrors,
      url_match_count: urlMatchCount, sdk_duration_ms: sdkResult.durationMs,
    });
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log("═══ SDK EVAL RESULTS ═══");
  console.log("═══════════════════════════════════════════════════════");

  const totalCases = results.length;
  const totalAcs = results.reduce((s, r) => s + r.total_acs, 0);
  const totalSdkAcs = results.reduce((s, r) => s + r.sdk_acs, 0);
  const totalUrlMatch = results.reduce((s, r) => s + r.url_match_count, 0);
  const totalDuration = results.reduce((s, r) => s + r.sdk_duration_ms, 0);
  const failures = results.filter(r => r.sdk_acs === 0);
  const regressions = results.filter(r => r.sdk_acs > 0 && r.sdk_avg_score < r.baseline_avg_score);
  const withErrors = results.filter(r => r.sdk_errors.length > 0);

  const sdkAvgAll = results.filter(r => r.sdk_acs > 0).reduce((s, r) => s + r.sdk_avg_score, 0) / results.filter(r => r.sdk_acs > 0).length;
  const baseAvgAll = results.reduce((s, r) => s + r.baseline_avg_score, 0) / totalCases;

  console.log(`Cases: ${totalCases} (${failures.length} failures, ${regressions.length} regressions)`);
  console.log(`ACs: ${totalSdkAcs}/${totalAcs} planned`);
  console.log(`Avg structural: SDK=${sdkAvgAll.toFixed(3)} baseline=${baseAvgAll.toFixed(3)}`);
  console.log(`URL match: ${totalUrlMatch}/${totalAcs}`);
  console.log(`Cases with errors: ${withErrors.length}`);
  console.log(`Total duration: ${Math.round(totalDuration / 1000)}s (avg ${Math.round(totalDuration / totalCases / 1000)}s/case)`);
  console.log();

  if (regressions.length > 0) {
    console.log("REGRESSIONS:");
    for (const r of regressions) {
      console.log(`  ${r.run_id}: SDK=${r.sdk_avg_score.toFixed(3)} < baseline=${r.baseline_avg_score.toFixed(3)}`);
    }
  }

  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const r of failures) {
      console.log(`  ${r.run_id}: ${r.sdk_errors[0]}`);
    }
  }

  // Write results
  writeFileSync(join(outputDir, "results.json"), JSON.stringify({
    summary: { totalCases, totalAcs, totalSdkAcs, sdkAvgAll, baseAvgAll, totalUrlMatch, totalDuration, failures: failures.length, regressions: regressions.length },
    results,
  }, null, 2));
  console.log(`\nResults → ${outputDir}/results.json`);

  if (regressions.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
