#!/usr/bin/env npx tsx
/**
 * PR Evaluation Runner
 *
 * Fetches merged PR descriptions from GitHub, generates specs, and runs
 * the verify pipeline against the running app to measure accuracy.
 *
 * Usage:
 *   npx tsx pipeline/evals/run-pr-evals.ts
 *
 * Prerequisites:
 *   - gh CLI authenticated
 *   - Documenso running on :3003 with /verify-setup done
 *   - Cal.com running on :3000 with /verify-setup done
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

interface EvalTarget {
  repo: string;         // "documenso/documenso" or "calcom/cal.com"
  projectDir: string;   // local path to the project
  verifyDir: string;    // .verify directory
  prs: number[];        // PR numbers to test
}

const PIPELINE_CLI = join(import.meta.dirname, "..", "src", "cli.ts");

const TARGETS: EvalTarget[] = [
  {
    repo: "documenso/documenso",
    projectDir: process.env.HOME + "/Projects/opslane/evals/documenso",
    verifyDir: process.env.HOME + "/Projects/opslane/evals/documenso/.verify",
    prs: [
      2626,  // fix(ui): scroll in date format dropdown (has testing steps, 4 ACs, proven pass)
      2595,  // feat: document rename feature (has test steps, 4 ACs)
      2611,  // feat: organisation template type (rich summary)
      2609,  // feat: disable "Document created from template" email
      2658,  // feat: display field id in dev mode (has screenshots)
    ],
  },
  {
    repo: "calcom/cal.com",
    projectDir: process.env.HOME + "/Projects/opslane/evals/calcom",
    verifyDir: process.env.HOME + "/Projects/opslane/evals/calcom/.verify",
    prs: [
      27983, // fix: dropdown toggle indicator sync in workflow form (proven pass)
      28053, // fix: Billings page reorganised (has before/after screenshots)
      28534, // fix: pointer cursor on enabled date buttons (clear description)
      27965, // fix: hide bookings opt-in banner on mobile (has test steps)
      27924, // fix: icon size + download button alignment (has test steps)
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fetchPRSpec(repo: string, prNumber: number): string | null {
  try {
    const raw = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json title,body --jq '
        "## Context\\n" +
        .title + " (PR #" + (.number|tostring) + ")\\n\\n" +
        (if .body != "" and .body != null then .body else "No description provided." end)
      '`,
      { encoding: "utf-8", timeout: 15000 }
    ).trim();
    return raw;
  } catch {
    return null;
  }
}

interface EvalResult {
  repo: string;
  pr: number;
  title: string;
  acsGenerated: number;
  acsSkipped: number;
  pass: number;
  fail: number;
  blocked: number;
  unclear: number;
  error: number;
  timeout: number;
  totalTime: number;
  runDir: string;
  pipelineError?: string;
}

function runPipeline(specPath: string, verifyDir: string): { verdicts: Array<{ ac_id: string; verdict: string }>; runDir: string; acCount: number; skippedCount: number; totalTime: number } | { error: string } {
  try {
    const output = execSync(
      `npx tsx ${PIPELINE_CLI} run --spec "${specPath}" --verify-dir "${verifyDir}"`,
      { encoding: "utf-8", timeout: 720_000, cwd: join(import.meta.dirname, "..") }
    );

    // Find the run directory
    const runDirMatch = output.match(/Run: (.+)/);
    const runId = runDirMatch?.[1] ?? "unknown";
    const runDir = join(verifyDir, "runs", runId);

    // Read verdicts
    const verdictsPath = join(runDir, "verdicts.json");
    if (!existsSync(verdictsPath)) {
      return { error: "No verdicts.json produced" };
    }
    const verdicts = JSON.parse(readFileSync(verdictsPath, "utf-8")).verdicts as Array<{ ac_id: string; verdict: string }>;

    // Read ACs for count
    const acsPath = join(runDir, "acs.json");
    let acCount = verdicts.length;
    let skippedCount = 0;
    if (existsSync(acsPath)) {
      const acs = JSON.parse(readFileSync(acsPath, "utf-8"));
      acCount = acs.groups?.reduce((n: number, g: { acs: unknown[] }) => n + g.acs.length, 0) ?? verdicts.length;
      skippedCount = acs.skipped?.length ?? 0;
    }

    // Read timing
    const reportPath = join(runDir, "report.json");
    let totalTime = 0;
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
      totalTime = report.total_duration_ms ?? 0;
    }

    return { verdicts, runDir, acCount, skippedCount, totalTime };
  } catch (err: unknown) {
    // Pipeline exits non-zero on failures — still read verdicts if they exist
    const msg = err instanceof Error ? err.message : String(err);

    // Try to extract run dir from stderr/stdout
    const runMatch = msg.match(/Run: (.+)/);
    if (runMatch) {
      const runId = runMatch[1];
      const runDir = join(verifyDir, "runs", runId);
      const verdictsPath = join(runDir, "verdicts.json");
      if (existsSync(verdictsPath)) {
        const verdicts = JSON.parse(readFileSync(verdictsPath, "utf-8")).verdicts;
        const acsPath = join(runDir, "acs.json");
        let acCount = verdicts.length;
        let skippedCount = 0;
        if (existsSync(acsPath)) {
          const acs = JSON.parse(readFileSync(acsPath, "utf-8"));
          acCount = acs.groups?.reduce((n: number, g: { acs: unknown[] }) => n + g.acs.length, 0) ?? verdicts.length;
          skippedCount = acs.skipped?.length ?? 0;
        }
        const reportPath = join(runDir, "report.json");
        let totalTime = 0;
        if (existsSync(reportPath)) {
          const report = JSON.parse(readFileSync(reportPath, "utf-8"));
          totalTime = report.total_duration_ms ?? 0;
        }
        return { verdicts, runDir, acCount, skippedCount, totalTime };
      }
    }

    return { error: msg.slice(0, 200) };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const results: EvalResult[] = [];
const evalDir = join(import.meta.dirname, "..", "evals", "pr-eval-results");
mkdirSync(evalDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

console.log(`\n${"=".repeat(70)}`);
console.log(`  VERIFY PIPELINE PR EVAL — ${timestamp}`);
console.log(`${"=".repeat(70)}\n`);

for (const target of TARGETS) {
  console.log(`\n── ${target.repo} (${target.prs.length} PRs) ──────────────────────────\n`);

  // Check server is up
  const baseUrl = JSON.parse(readFileSync(join(target.verifyDir, "config.json"), "utf-8")).baseUrl;
  try {
    execSync(`curl -sf "${baseUrl}" > /dev/null 2>&1`, { timeout: 5000 });
  } catch {
    console.log(`  SKIP: Server not running at ${baseUrl}`);
    continue;
  }

  for (const pr of target.prs) {
    console.log(`  PR #${pr}...`);

    // Fetch PR description as spec
    const spec = fetchPRSpec(target.repo, pr);
    if (!spec) {
      console.log(`    SKIP: Could not fetch PR description`);
      results.push({
        repo: target.repo, pr, title: "?", acsGenerated: 0, acsSkipped: 0,
        pass: 0, fail: 0, blocked: 0, unclear: 0, error: 0, timeout: 0,
        totalTime: 0, runDir: "", pipelineError: "Could not fetch PR",
      });
      continue;
    }

    // Extract title
    const titleMatch = spec.match(/## Context\n(.+?)(?:\n|$)/);
    const title = titleMatch?.[1]?.slice(0, 60) ?? `PR #${pr}`;

    // Write spec file
    const specPath = join(target.verifyDir, `eval-pr-${pr}.md`);
    writeFileSync(specPath, spec);

    // Run pipeline
    const startMs = Date.now();
    const pipelineResult = runPipeline(specPath, target.verifyDir);
    const wallMs = Date.now() - startMs;

    if ("error" in pipelineResult) {
      console.log(`    ERROR: ${pipelineResult.error.slice(0, 80)}`);
      results.push({
        repo: target.repo, pr, title, acsGenerated: 0, acsSkipped: 0,
        pass: 0, fail: 0, blocked: 0, unclear: 0, error: 0, timeout: 0,
        totalTime: wallMs, runDir: "", pipelineError: pipelineResult.error.slice(0, 200),
      });
      continue;
    }

    const { verdicts, runDir, acCount, skippedCount, totalTime } = pipelineResult;
    const counts = { pass: 0, fail: 0, blocked: 0, unclear: 0, error: 0, timeout: 0 };
    for (const v of verdicts) {
      const key = v.verdict as keyof typeof counts;
      if (key in counts) counts[key]++;
      else counts.error++;
    }

    const resultLine = `${counts.pass}P ${counts.fail}F ${counts.blocked}B ${counts.unclear}U ${counts.error}E`;
    console.log(`    ${resultLine} (${verdicts.length} ACs, ${skippedCount} skipped, ${Math.round(totalTime / 1000)}s)`);

    results.push({
      repo: target.repo, pr, title, acsGenerated: acCount, acsSkipped: skippedCount,
      ...counts, totalTime, runDir,
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(70)}`);
console.log(`  EVAL RESULTS SUMMARY`);
console.log(`${"=".repeat(70)}\n`);

// Per-PR table
console.log("| Repo | PR | ACs | Pass | Fail | Blocked | Unclear | Error | Time |");
console.log("|------|-----|-----|------|------|---------|---------|-------|------|");
for (const r of results) {
  const repo = r.repo.split("/")[1]?.slice(0, 10) ?? r.repo;
  const time = r.totalTime > 0 ? `${Math.round(r.totalTime / 1000)}s` : "—";
  const status = r.pipelineError ? "ERR" : `${r.pass}/${r.acsGenerated}`;
  console.log(
    `| ${repo.padEnd(10)} | #${String(r.pr).padEnd(5)} | ${String(r.acsGenerated).padStart(3)} | ${String(r.pass).padStart(4)} | ${String(r.fail).padStart(4)} | ${String(r.blocked).padStart(7)} | ${String(r.unclear).padStart(7)} | ${String(r.error).padStart(5)} | ${time.padStart(4)} |`
  );
}

// Aggregates
const total = results.filter(r => !r.pipelineError);
const totalACs = total.reduce((n, r) => n + r.acsGenerated, 0);
const totalPass = total.reduce((n, r) => n + r.pass, 0);
const totalFail = total.reduce((n, r) => n + r.fail, 0);
const totalBlocked = total.reduce((n, r) => n + r.blocked, 0);
const totalUnclear = total.reduce((n, r) => n + r.unclear, 0);
const totalError = total.reduce((n, r) => n + r.error, 0);
const totalTime = total.reduce((n, r) => n + r.totalTime, 0);
const pipelineErrors = results.filter(r => r.pipelineError).length;

console.log("");
console.log(`Total PRs evaluated: ${results.length} (${pipelineErrors} pipeline errors)`);
console.log(`Total ACs: ${totalACs}`);
console.log(`Pass rate: ${totalPass}/${totalACs} (${totalACs > 0 ? Math.round(totalPass / totalACs * 100) : 0}%)`);
console.log(`Fail: ${totalFail}, Blocked: ${totalBlocked}, Unclear: ${totalUnclear}, Error: ${totalError}`);
console.log(`Total time: ${Math.round(totalTime / 1000)}s (avg ${total.length > 0 ? Math.round(totalTime / total.length / 1000) : 0}s per PR)`);

// Write results to disk
const outputPath = join(evalDir, `${timestamp}.json`);
writeFileSync(outputPath, JSON.stringify({ timestamp, results, summary: {
  totalPRs: results.length, pipelineErrors, totalACs, totalPass, totalFail,
  totalBlocked, totalUnclear, totalError, totalTimeMs: totalTime,
  passRate: totalACs > 0 ? totalPass / totalACs : 0,
}}, null, 2));
console.log(`\nResults saved: ${outputPath}`);
