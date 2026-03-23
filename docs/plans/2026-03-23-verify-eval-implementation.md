# /verify-eval Implementation Plan (v2)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `/verify-eval` skill backed by a TypeScript CLI command that auto-discovers merged frontend PRs, runs the full verify pipeline against each, classifies failures via LLM introspection, and appends results to a per-repo JSONL file.

**Architecture:** The heavy lifting is a new `eval` CLI command in `pipeline/src/cli.ts` that handles PR discovery, health checks, pipeline invocation, introspection, JSONL serialization, and early-stop logic — all deterministic TypeScript. The SKILL.md is a thin wrapper that invokes `npx tsx pipeline/src/cli.ts eval`. Introspection uses `runClaude()` with the existing prompt template pattern.

**Tech Stack:** TypeScript (Node 22 ESM), `gh` CLI (via `execSync`), existing pipeline orchestrator, `runClaude()` for introspection, vitest for tests

---

### Task 1: Extend VerifyConfig with `repo`, `projectDir`, and `healthCheck` fields

**Files:**
- Modify: `pipeline/src/lib/types.ts:11-21`
- Modify: `pipeline/src/lib/config.ts:22-26`

**Step 1: Add types to VerifyConfig**

In `pipeline/src/lib/types.ts`, add `HealthCheckConfig` before `VerifyConfig` and extend the interface. Replace lines 11-21:

```typescript
export interface HealthCheckConfig {
  readyUrl: string;                     // URL to poll (200 = healthy)
  readyTimeout: number;                 // ms to wait before marking health check failed
  pollInterval: number;                 // ms between polls
}

export interface VerifyConfig {
  baseUrl: string;
  repo?: string;                        // GitHub owner/repo, e.g. "calcom/cal.com"
  projectDir?: string;                  // absolute path to local clone of target repo
  specPath?: string;
  diffBase?: string;
  maxParallelGroups?: number;           // default 5
  healthCheck?: HealthCheckConfig;
  auth?: {
    email: string;
    password: string;
    loginSteps: LoginStep[];
  };
}
```

**Step 2: Add env var override for repo**

In `pipeline/src/lib/config.ts`, after line 25 (`if (process.env.VERIFY_DIFF_BASE)`), add:

```typescript
if (process.env.VERIFY_REPO) envOverrides.repo = process.env.VERIFY_REPO;
if (process.env.VERIFY_PROJECT_DIR) envOverrides.projectDir = process.env.VERIFY_PROJECT_DIR;
```

**Step 3: Typecheck + test**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/lib/config.ts
git commit -m "feat(pipeline): add repo, projectDir, healthCheck to VerifyConfig"
```

---

### Task 2: Add eval result types

**Files:**
- Create: `pipeline/src/lib/eval-types.ts`

**Step 1: Define the types**

Create `pipeline/src/lib/eval-types.ts`:

```typescript
// pipeline/src/lib/eval-types.ts — Types for the eval runner

import type { ACVerdict } from "./types.js";

export interface EvalPR {
  number: number;
  title: string;
  url: string;
  body: string;
  files?: Array<{ path: string }>;
}

export interface IntrospectionResult {
  ac_id: string;
  classification: "real" | "pipeline";
  confidence: "high" | "medium" | "low";
  failed_stage: "ac_generator" | "planner" | "setup_writer" | "browse_agent" | "judge" | null;
  root_cause: string;
  detail: string;
  suggested_fix: string | null;
}

export interface EvalResult {
  pr: number;
  title: string;
  url: string;
  timestamp: string;
  health_check: "pass" | "fail" | "skip";
  pipeline_exit: number | null;
  duration_ms: number;
  spec_source: "pr_description";
  spec_length: number;
  verdicts: ACVerdict[];
  introspection: IntrospectionResult[];
  failure_stage: string | null;
  failure_reason: string | null;
}

export type EarlyStopReason = "auth_expired" | "health_check" | null;

export const FRONTEND_FILE_PATTERNS = /\.(tsx|jsx|ts|css|scss|svelte|vue|astro)$/;
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add pipeline/src/lib/eval-types.ts
git commit -m "feat(pipeline): add eval runner types"
```

---

### Task 3: Create the introspection prompt template

**Files:**
- Create: `pipeline/src/prompts/introspection.txt`

**Step 1: Write the prompt**

Create `pipeline/src/prompts/introspection.txt`:

```text
You are an eval introspector for a frontend verification pipeline. Your job is to classify why an acceptance criterion (AC) failed — was it a real failure (the PR doesn't satisfy the AC) or a pipeline failure (our tooling broke)?

## PR Context

Title: __PR_TITLE__
URL: __PR_URL__

### PR Diff (summary)
__PR_DIFF__

## Failed AC

AC ID: __AC_ID__
Description: __AC_DESCRIPTION__
Verdict: __AC_VERDICT__
Judge reasoning: __AC_REASONING__

## Evidence

### Browse agent result
__BROWSE_RESULT__

### Browse agent log (last 50 lines)
__BROWSE_LOG__

## Your Task

Classify this failure. Output ONLY valid JSON, no markdown fences:

{
  "ac_id": "__AC_ID__",
  "classification": "real | pipeline",
  "confidence": "high | medium | low",
  "failed_stage": "ac_generator | planner | setup_writer | browse_agent | judge | null",
  "root_cause": "<short_snake_case_tag>",
  "detail": "<1-2 sentence explanation>",
  "suggested_fix": "<1 sentence suggestion for improving the pipeline>"
}

### Classification Guide

**real** — The PR genuinely doesn't satisfy this AC. The pipeline worked correctly and caught a real issue. Set `failed_stage` to null.

**pipeline** — Our tooling caused the failure. The PR likely satisfies the AC but we couldn't verify it. Common root causes by stage:

- ac_generator: `ambiguous_ac`, `missed_ac`, `hallucinated_ac`
- planner: `wrong_url`, `wrong_element`, `missing_precondition`, `bad_steps`
- setup_writer: `sql_error`, `missing_data`, `wrong_table`
- browse_agent: `nav_timeout`, `element_not_found`, `auth_redirect`, `wrong_page`, `stale_snapshot`
- judge: `misread_evidence`, `too_strict`, `too_lenient`

### Signals

Pipeline failure signals:
- Browse log shows auth redirect or login page
- Browse agent timed out or couldn't find elements
- Evidence screenshots show wrong page
- Setup SQL errors in logs
- Judge reasoning contradicts what screenshots show

Real failure signals:
- Screenshots clearly show the AC is not satisfied
- Browse agent navigated correctly but the expected UI state is absent
- The PR diff doesn't contain changes that would satisfy the AC
```

**Step 2: Commit**

```bash
git add pipeline/src/prompts/introspection.txt
git commit -m "feat(pipeline): add introspection prompt template for eval failure classification"
```

---

### Task 4: Build the eval runner module

**Files:**
- Create: `pipeline/src/eval-runner.ts`

This is the core module. It exports functions that the CLI command calls.

**Step 1: Write the eval runner**

Create `pipeline/src/eval-runner.ts`:

```typescript
// pipeline/src/eval-runner.ts — Eval runner: discovers PRs, runs pipeline, introspects, records results
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { VerifyConfig, ACVerdict, JudgeOutput, PlannerOutput } from "./lib/types.js";
import type { EvalPR, EvalResult, IntrospectionResult, EarlyStopReason } from "./lib/eval-types.js";
import { FRONTEND_FILE_PATTERNS } from "./lib/eval-types.js";
import { runClaude } from "./run-claude.js";

// ── PR Discovery ─────────────────────────────────────────────────────────────

export function discoverMergedPRs(repo: string, limit: number = 50): EvalPR[] {
  const raw = execSync(
    `gh pr list --repo ${repo} --state merged --limit ${limit} --json number,title,url,body,files`,
    { encoding: "utf-8", timeout: 30_000 },
  );
  const prs: EvalPR[] = JSON.parse(raw);
  return prs.filter(pr =>
    pr.files?.some(f => FRONTEND_FILE_PATTERNS.test(f.path)) ?? false,
  );
}

export function loadProcessedPRs(resultsFile: string): Set<number> {
  if (!existsSync(resultsFile)) return new Set();
  const lines = readFileSync(resultsFile, "utf-8").trim().split("\n").filter(Boolean);
  const numbers = lines.map(line => {
    try { return (JSON.parse(line) as EvalResult).pr; }
    catch { return null; }
  }).filter((n): n is number => n !== null);
  return new Set(numbers);
}

export function filterUnprocessed(prs: EvalPR[], processed: Set<number>): EvalPR[] {
  return prs.filter(pr => !processed.has(pr.number));
}

// ── Health Check ─────────────────────────────────────────────────────────────

export async function healthCheck(config: VerifyConfig): Promise<boolean> {
  const url = config.healthCheck?.readyUrl ?? config.baseUrl;
  const timeout = config.healthCheck?.readyTimeout ?? 120_000;
  const interval = config.healthCheck?.pollInterval ?? 3_000;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      execSync(`curl -sf "${url}" > /dev/null 2>&1`, { timeout: 10_000 });
      return true;
    } catch {
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }
  return false;
}

// ── Git Operations ───────────────────────────────────────────────────────────

export function checkoutPR(prNumber: number, projectDir: string): boolean {
  try {
    // Clean working tree before checkout
    execSync("git checkout -- . && git clean -fd", { cwd: projectDir, encoding: "utf-8", timeout: 30_000 });
    execSync(`gh pr checkout ${prNumber}`, { cwd: projectDir, encoding: "utf-8", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export function checkoutMain(projectDir: string): void {
  try {
    execSync("git checkout -- . && git clean -fd", { cwd: projectDir, encoding: "utf-8", timeout: 30_000 });
    execSync("git checkout main", { cwd: projectDir, encoding: "utf-8", timeout: 30_000 });
  } catch {
    // Best effort — log but don't crash the eval loop
    console.error("[eval] Warning: failed to checkout main");
  }
}

// ── Pipeline Invocation ──────────────────────────────────────────────────────

export interface PipelineRunResult {
  exitCode: number;
  durationMs: number;
  runDir: string | null;
  verdicts: ACVerdict[];
}

export function runVerifyPipeline(specPath: string, verifyDir: string, projectDir: string): PipelineRunResult {
  const start = Date.now();
  let exitCode = 1;
  try {
    execSync(
      `npx tsx ${join(dirname(new URL(import.meta.url).pathname), "cli.ts")} run --spec "${specPath}" --verify-dir "${verifyDir}"`,
      { cwd: projectDir, encoding: "utf-8", timeout: 600_000, stdio: "pipe" },
    );
    exitCode = 0;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      exitCode = (err as { status: number }).status ?? 1;
    }
  }
  const durationMs = Date.now() - start;

  // Find most recent run dir
  const runsDir = join(verifyDir, "runs");
  const runDir = findLatestRunDir(runsDir);

  // Read verdicts
  let verdicts: ACVerdict[] = [];
  if (runDir) {
    const verdictsPath = join(runDir, "verdicts.json");
    if (existsSync(verdictsPath)) {
      try {
        const parsed: JudgeOutput = JSON.parse(readFileSync(verdictsPath, "utf-8"));
        verdicts = parsed.verdicts;
      } catch { /* leave empty */ }
    }
  }

  return { exitCode, durationMs, runDir, verdicts };
}

function findLatestRunDir(runsDir: string): string | null {
  if (!existsSync(runsDir)) return null;
  const entries = readdirSync(runsDir)
    .map(name => { const p = join(runsDir, name); const s = statSync(p); return { path: p, isDir: s.isDirectory(), mtime: s.mtimeMs }; })
    .filter(e => e.isDir)
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.path ?? null;
}

// ── Introspection ────────────────────────────────────────────────────────────

export async function introspectFailure(
  pr: EvalPR,
  verdict: ACVerdict,
  acDescription: string,
  runDir: string,
  projectDir: string,
): Promise<IntrospectionResult> {
  const promptTemplate = readFileSync(
    join(dirname(new URL(import.meta.url).pathname), "prompts", "introspection.txt"),
    "utf-8",
  );

  // Gather evidence
  const browseResultPath = join(runDir, "evidence", verdict.ac_id, "result.json");
  const browseResult = existsSync(browseResultPath)
    ? readFileSync(browseResultPath, "utf-8")
    : "{}";

  const browseLogPath = join(runDir, "logs", `browse-agent-${verdict.ac_id}-stream.jsonl`);
  let browseLog = "no log";
  if (existsSync(browseLogPath)) {
    const lines = readFileSync(browseLogPath, "utf-8").split("\n");
    browseLog = lines.slice(-50).join("\n");
  }

  // PR diff (truncated)
  let prDiff = "";
  try {
    const fullDiff = execSync(`gh pr diff ${pr.number}`, { cwd: projectDir, encoding: "utf-8", timeout: 30_000 });
    prDiff = fullDiff.slice(0, 8_000);
  } catch { prDiff = "(diff unavailable)"; }

  const prompt = promptTemplate
    .replaceAll("__PR_TITLE__", pr.title)
    .replaceAll("__PR_URL__", pr.url)
    .replace("__PR_DIFF__", prDiff)
    .replaceAll("__AC_ID__", verdict.ac_id)
    .replace("__AC_DESCRIPTION__", acDescription)
    .replace("__AC_VERDICT__", verdict.verdict)
    .replace("__AC_REASONING__", verdict.reasoning)
    .replace("__BROWSE_RESULT__", browseResult)
    .replace("__BROWSE_LOG__", browseLog);

  try {
    const result = await runClaude({
      prompt,
      model: "sonnet",
      timeoutMs: 60_000,
      stage: `introspection-${verdict.ac_id}`,
      runDir,
      dangerouslySkipPermissions: true,
    });
    const cleaned = result.stdout.replace(/^```json?\n?|\n?```$/g, "").trim();
    return JSON.parse(cleaned) as IntrospectionResult;
  } catch {
    return {
      ac_id: verdict.ac_id,
      classification: "pipeline",
      confidence: "low",
      failed_stage: null,
      root_cause: "introspection_failed",
      detail: "Introspection LLM call failed to produce valid JSON",
      suggested_fix: null,
    };
  }
}

// ── AC Description Lookup ────────────────────────────────────────────────────

export function loadACDescriptions(runDir: string): Map<string, string> {
  const planPath = join(runDir, "plan.json");
  if (!existsSync(planPath)) return new Map();
  try {
    const plan: PlannerOutput = JSON.parse(readFileSync(planPath, "utf-8"));
    return new Map(plan.criteria.map(c => [c.id, c.description]));
  } catch { return new Map(); }
}

// ── Results I/O ──────────────────────────────────────────────────────────────

export function appendResult(resultsFile: string, result: EvalResult): void {
  mkdirSync(dirname(resultsFile), { recursive: true });
  appendFileSync(resultsFile, JSON.stringify(result) + "\n");
}

export function loadAllResults(resultsFile: string): EvalResult[] {
  if (!existsSync(resultsFile)) return [];
  return readFileSync(resultsFile, "utf-8")
    .trim().split("\n").filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter((r): r is EvalResult => r !== null);
}

// ── Summary ──────────────────────────────────────────────────────────────────

export function printSummary(results: EvalResult[], repo: string): void {
  const allVerdicts = results.flatMap(r => r.verdicts);
  const passCount = allVerdicts.filter(v => v.verdict === "pass").length;
  const failCount = allVerdicts.filter(v => v.verdict === "fail").length;
  const specUnclearCount = allVerdicts.filter(v => v.verdict === "spec_unclear").length;
  const errorCount = allVerdicts.length - passCount - failCount - specUnclearCount;

  const allIntrospections = results.flatMap(r => r.introspection);
  const realCount = allIntrospections.filter(i => i.classification === "real").length;
  const pipelineCount = allIntrospections.filter(i => i.classification === "pipeline").length;

  // Group pipeline failures by stage
  const byStage = new Map<string, Map<string, number>>();
  for (const i of allIntrospections.filter(i => i.classification === "pipeline" && i.failed_stage)) {
    const stage = i.failed_stage!;
    if (!byStage.has(stage)) byStage.set(stage, new Map());
    const causes = byStage.get(stage)!;
    causes.set(i.root_cause, (causes.get(i.root_cause) ?? 0) + 1);
  }

  console.log("");
  console.log("══════════════════════════════════════════");
  console.log(`Eval complete: ${results.length} PRs processed (${repo})`);
  console.log("══════════════════════════════════════════");
  console.log("");
  console.log("Verdicts:");
  console.log(`  pass: ${passCount}   fail: ${failCount}   spec_unclear: ${specUnclearCount}   error: ${errorCount}`);
  console.log("");
  console.log("Failure classification:");
  console.log(`  real:     ${realCount}`);
  console.log(`  pipeline: ${pipelineCount}`);

  if (byStage.size > 0) {
    console.log("");
    console.log("Pipeline failures by stage:");
    for (const [stage, causes] of byStage) {
      const total = [...causes.values()].reduce((a, b) => a + b, 0);
      const detail = [...causes.entries()].map(([c, n]) => `${c}: ${n}`).join(", ");
      console.log(`  ${stage}: ${total}  (${detail})`);
    }
  }
  console.log("");
}

// ── Early Stop Detection ─────────────────────────────────────────────────────

export function checkEarlyStop(recentResults: EvalResult[], windowSize: number = 3): EarlyStopReason {
  if (recentResults.length < windowSize) return null;
  const recent = recentResults.slice(-windowSize);

  // 3 consecutive health check failures
  if (recent.every(r => r.failure_stage === "health_check")) return "health_check";

  // 3 consecutive auth_expired verdicts
  if (recent.every(r => r.verdicts.length > 0 && r.verdicts.every(v => v.verdict === "auth_expired"))) {
    return "auth_expired";
  }

  return null;
}

// ── Single PR Eval ───────────────────────────────────────────────────────────

export async function evalSinglePR(
  pr: EvalPR,
  config: VerifyConfig,
  resultsFile: string,
  verifyDir: string,
): Promise<EvalResult> {
  const projectDir = config.projectDir!;
  const timestamp = new Date().toISOString();

  console.log(`\nPR #${pr.number}: ${pr.title}`);

  // Step 1: Checkout
  if (!checkoutPR(pr.number, projectDir)) {
    const result: EvalResult = {
      pr: pr.number, title: pr.title, url: pr.url, timestamp,
      health_check: "skip", pipeline_exit: null, duration_ms: 0,
      spec_source: "pr_description", spec_length: 0,
      verdicts: [], introspection: [],
      failure_stage: "checkout", failure_reason: `gh pr checkout ${pr.number} failed`,
    };
    appendResult(resultsFile, result);
    checkoutMain(projectDir);
    return result;
  }

  // Step 2: Health check
  const healthy = await healthCheck(config);
  if (!healthy) {
    const result: EvalResult = {
      pr: pr.number, title: pr.title, url: pr.url, timestamp,
      health_check: "fail", pipeline_exit: null, duration_ms: 0,
      spec_source: "pr_description", spec_length: 0,
      verdicts: [], introspection: [],
      failure_stage: "health_check",
      failure_reason: `Server not ready at ${config.healthCheck?.readyUrl ?? config.baseUrl}`,
    };
    appendResult(resultsFile, result);
    checkoutMain(projectDir);
    return result;
  }

  // Step 3: Extract spec from PR description
  const specContent = pr.body?.trim() ?? "";
  if (!specContent) {
    const result: EvalResult = {
      pr: pr.number, title: pr.title, url: pr.url, timestamp,
      health_check: "pass", pipeline_exit: null, duration_ms: 0,
      spec_source: "pr_description", spec_length: 0,
      verdicts: [], introspection: [],
      failure_stage: "spec_extraction", failure_reason: "PR description is empty",
    };
    appendResult(resultsFile, result);
    checkoutMain(projectDir);
    return result;
  }

  const specPath = join(verifyDir, "spec.md");
  writeFileSync(specPath, specContent);

  // Step 4: Run pipeline
  const pipelineResult = runVerifyPipeline(specPath, verifyDir, projectDir);

  // Step 5: Introspect failures
  const introspections: IntrospectionResult[] = [];
  const failedVerdicts = pipelineResult.verdicts.filter(v => v.verdict !== "pass");

  if (failedVerdicts.length > 0 && pipelineResult.runDir) {
    const acDescriptions = loadACDescriptions(pipelineResult.runDir);
    for (const verdict of failedVerdicts) {
      const desc = acDescriptions.get(verdict.ac_id) ?? verdict.reasoning.slice(0, 100);
      const intro = await introspectFailure(pr, verdict, desc, pipelineResult.runDir, projectDir);
      introspections.push(intro);
    }
  }

  // Step 6: Record
  const result: EvalResult = {
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    timestamp,
    health_check: "pass",
    pipeline_exit: pipelineResult.exitCode,
    duration_ms: pipelineResult.durationMs,
    spec_source: "pr_description",
    spec_length: specContent.length,
    verdicts: pipelineResult.verdicts,
    introspection: introspections,
    failure_stage: pipelineResult.verdicts.length === 0 ? "pipeline" : null,
    failure_reason: pipelineResult.verdicts.length === 0
      ? `Pipeline exited ${pipelineResult.exitCode} with no verdicts`
      : null,
  };

  appendResult(resultsFile, result);

  // Print per-PR summary
  for (const v of result.verdicts) {
    const icon = v.verdict === "pass" ? "✓" : "✗";
    const introTag = introspections.find(i => i.ac_id === v.ac_id);
    const suffix = introTag ? ` [${introTag.classification}/${introTag.failed_stage}: ${introTag.root_cause}]` : "";
    console.log(`  ${icon} ${v.ac_id}: ${v.verdict}${suffix}`);
  }

  // Checkout main
  checkoutMain(projectDir);
  return result;
}
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add pipeline/src/eval-runner.ts
git commit -m "feat(pipeline): add eval runner module — PR discovery, health check, introspection, JSONL"
```

---

### Task 5: Add `eval` command to CLI

**Files:**
- Modify: `pipeline/src/cli.ts`

**Step 1: Add the eval command**

In `pipeline/src/cli.ts`, add a new `else if` block after the `run-stage` block (before the final `else` at line 447). Add `pr` to the parseArgs options:

First, add `pr` to the options block (after line 24):

```typescript
    pr: { type: "string" },
```

Add these imports at the top of `cli.ts` (after existing imports):

```typescript
import { execSync } from "node:child_process";
import type { EvalResult } from "./lib/eval-types.js";
```

Then add the command handler before the final `else`:

```typescript
} else if (command === "eval") {
  const { discoverMergedPRs, loadProcessedPRs, filterUnprocessed, evalSinglePR, loadAllResults, printSummary, checkEarlyStop } = await import("./eval-runner.js");
  const verifyDir = values["verify-dir"]!;
  const config = (await import("./lib/config.js")).loadConfig(verifyDir);

  if (!config.repo) {
    console.error('No "repo" in config. Add to .verify/config.json, e.g. "repo": "calcom/cal.com"');
    process.exit(1);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) {
    console.error('Invalid repo format — expected "owner/repo" (e.g. "calcom/cal.com")');
    process.exit(1);
  }
  if (!config.projectDir) {
    console.error('No "projectDir" in config. Add absolute path to target repo clone.');
    process.exit(1);
  }

  const repoId = config.repo.split("/")[1];
  const resultsFile = join("docs", "evals", repoId, "eval-results.jsonl");

  // Single PR mode
  if (values.pr) {
    const prNumber = parseInt(values.pr, 10);
    if (isNaN(prNumber)) { console.error("--pr must be a number"); process.exit(1); }

    // Fetch PR metadata
    const raw = execSync(
      `gh pr view ${prNumber} --repo ${config.repo} --json number,title,url,body`,
      { encoding: "utf-8", timeout: 30_000 },
    );
    const pr = JSON.parse(raw);
    await evalSinglePR(pr, config, resultsFile, verifyDir);
    const results = loadAllResults(resultsFile);
    printSummary(results, config.repo);
    process.exit(0);
  }

  // Batch mode: discover and process all unprocessed PRs
  console.log(`Eval target: ${config.repo}`);
  const processed = loadProcessedPRs(resultsFile);
  console.log(`Already processed: ${processed.size} PRs`);

  const allPRs = discoverMergedPRs(config.repo);
  const todo = filterUnprocessed(allPRs, processed);
  console.log(`Frontend PRs found: ${allPRs.length}, unprocessed: ${todo.length}`);

  if (todo.length === 0) {
    console.log("All discovered PRs processed.");
    const results = loadAllResults(resultsFile);
    printSummary(results, config.repo);
    process.exit(0);
  }

  const batchResults: EvalResult[] = [];
  for (const pr of todo) {
    const result = await evalSinglePR(pr, config, resultsFile, verifyDir);
    batchResults.push(result);

    // Running tally
    const allResults = loadAllResults(resultsFile);
    const passCount = allResults.flatMap(r => r.verdicts).filter(v => v.verdict === "pass").length;
    const failCount = allResults.flatMap(r => r.verdicts).filter(v => v.verdict !== "pass").length;
    console.log(`Progress: ${allResults.length} PRs — ${passCount} pass, ${failCount} fail`);

    // Early stop check
    const earlyStop = checkEarlyStop(batchResults);
    if (earlyStop === "auth_expired") {
      console.error("\n3 consecutive auth_expired — re-run /verify-setup");
      break;
    }
    if (earlyStop === "health_check") {
      console.error("\nDev server unresponsive — check server");
      break;
    }
  }

  const results = loadAllResults(resultsFile);
  printSummary(results, config.repo);
  process.exit(0);
```

Also add `import { execSync } from "node:child_process";` at the top if not already present (it's not — the CLI currently only imports from `node:util`, `node:fs`, `node:path`).

**Step 2: Update the usage text**

In the final `else` block, add:

```
console.error("  npx tsx src/cli.ts eval [--pr <number>] [--verify-dir .verify]");
```

**Step 3: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 4: Run existing tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(pipeline): add eval CLI command for batch PR verification"
```

---

### Task 6: Write tests for the eval runner

**Files:**
- Create: `pipeline/test/eval-runner.test.ts`

**Step 1: Write unit tests**

Create `pipeline/test/eval-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProcessedPRs, filterUnprocessed, appendResult, loadAllResults, checkEarlyStop, printSummary, loadACDescriptions } from "../src/eval-runner.js";
import type { EvalResult, EvalPR } from "../src/lib/eval-types.js";

const TMP = join(import.meta.dirname, ".tmp-eval-test");

function makeResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    pr: 100, title: "test", url: "https://example.com/pr/100", timestamp: "2026-03-23T00:00:00Z",
    health_check: "pass", pipeline_exit: 0, duration_ms: 1000,
    spec_source: "pr_description", spec_length: 100,
    verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "ok" }],
    introspection: [], failure_stage: null, failure_reason: null,
    ...overrides,
  };
}

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("loadProcessedPRs", () => {
  it("returns empty set for missing file", () => {
    expect(loadProcessedPRs(join(TMP, "nope.jsonl")).size).toBe(0);
  });

  it("returns PR numbers from JSONL", () => {
    const file = join(TMP, "results.jsonl");
    writeFileSync(file, [
      JSON.stringify(makeResult({ pr: 101 })),
      JSON.stringify(makeResult({ pr: 102 })),
    ].join("\n") + "\n");
    const prs = loadProcessedPRs(file);
    expect(prs).toEqual(new Set([101, 102]));
  });

  it("skips malformed lines", () => {
    const file = join(TMP, "results.jsonl");
    writeFileSync(file, `${JSON.stringify(makeResult({ pr: 200 }))}\n{bad json\n`);
    expect(loadProcessedPRs(file)).toEqual(new Set([200]));
  });
});

describe("filterUnprocessed", () => {
  it("excludes already-processed PRs", () => {
    const prs: EvalPR[] = [
      { number: 1, title: "a", url: "u", body: "b" },
      { number: 2, title: "b", url: "u", body: "b" },
      { number: 3, title: "c", url: "u", body: "b" },
    ];
    const result = filterUnprocessed(prs, new Set([1, 3]));
    expect(result.map(p => p.number)).toEqual([2]);
  });
});

describe("appendResult + loadAllResults", () => {
  it("round-trips JSONL correctly", () => {
    const file = join(TMP, "sub", "results.jsonl");
    const r1 = makeResult({ pr: 1, title: "PR with \"quotes\" and\nnewlines" });
    const r2 = makeResult({ pr: 2 });
    appendResult(file, r1);
    appendResult(file, r2);
    const loaded = loadAllResults(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].title).toBe("PR with \"quotes\" and\nnewlines");
    expect(loaded[1].pr).toBe(2);
  });
});

describe("checkEarlyStop", () => {
  it("returns null for fewer than 3 results", () => {
    expect(checkEarlyStop([makeResult()])).toBeNull();
  });

  it("detects 3 consecutive health_check failures", () => {
    const results = [
      makeResult({ failure_stage: "health_check" }),
      makeResult({ failure_stage: "health_check" }),
      makeResult({ failure_stage: "health_check" }),
    ];
    expect(checkEarlyStop(results)).toBe("health_check");
  });

  it("detects 3 consecutive auth_expired", () => {
    const results = [
      makeResult({ verdicts: [{ ac_id: "ac1", verdict: "auth_expired", confidence: "high", reasoning: "" }] }),
      makeResult({ verdicts: [{ ac_id: "ac1", verdict: "auth_expired", confidence: "high", reasoning: "" }] }),
      makeResult({ verdicts: [{ ac_id: "ac1", verdict: "auth_expired", confidence: "high", reasoning: "" }] }),
    ];
    expect(checkEarlyStop(results)).toBe("auth_expired");
  });

  it("returns null when not all consecutive", () => {
    const results = [
      makeResult({ failure_stage: "health_check" }),
      makeResult({ failure_stage: null }),
      makeResult({ failure_stage: "health_check" }),
    ];
    expect(checkEarlyStop(results)).toBeNull();
  });
});

describe("loadACDescriptions", () => {
  it("reads descriptions from plan.json", () => {
    const runDir = join(TMP, "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "plan.json"), JSON.stringify({
      criteria: [
        { id: "ac1", group: "group-a", description: "Button should be blue", url: "/", steps: [], screenshot_at: [], timeout_seconds: 60 },
        { id: "ac2", group: "group-a", description: "Text should wrap", url: "/", steps: [], screenshot_at: [], timeout_seconds: 60 },
      ],
    }));
    const map = loadACDescriptions(runDir);
    expect(map.get("ac1")).toBe("Button should be blue");
    expect(map.get("ac2")).toBe("Text should wrap");
  });

  it("returns empty map when plan.json is missing", () => {
    expect(loadACDescriptions(join(TMP, "nonexistent")).size).toBe(0);
  });
});

describe("healthCheck", () => {
  it("returns false when URL is unreachable", async () => {
    const { healthCheck } = await import("../src/eval-runner.js");
    const config = {
      baseUrl: "http://127.0.0.1:19999",  // nothing listening
      healthCheck: { readyUrl: "http://127.0.0.1:19999", readyTimeout: 1_000, pollInterval: 200 },
    } as VerifyConfig;
    const result = await healthCheck(config);
    expect(result).toBe(false);
  }, 10_000);
});
```

Add `import type { VerifyConfig } from "../src/lib/types.js";` to the imports at the top of the test file.

**Step 2: Run tests**

Run: `cd pipeline && npx vitest run test/eval-runner.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add pipeline/test/eval-runner.test.ts
git commit -m "test(pipeline): add eval runner unit tests — JSONL, filtering, early stop, AC descriptions"
```

---

### Task 7: Create the thin SKILL.md wrapper

**Files:**
- Create: `skills/verify-eval/SKILL.md`
- Modify: `.claude/hooks/sync-skill.sh`

**Step 1: Write the skill**

Create `skills/verify-eval/SKILL.md`:

```markdown
---
name: verify-eval
description: Automated eval runner — discovers merged PRs, runs /verify pipeline, classifies failures, collects results to JSONL.
---

# /verify-eval

Automated eval runner for pipeline failure discovery. Runs the full verify pipeline against real merged PRs and classifies failures.

## Prerequisites
- Target repo forked, cloned, and set up locally
- `.verify/config.json` has `baseUrl`, `repo`, `projectDir`, and `healthCheck` fields
- `/verify-setup` already run (app indexed, auth configured)
- Dev server running

## Usage

```
/verify-eval              # run all unprocessed PRs
/verify-eval 28011        # run one specific PR
```

## Config

`.verify/config.json` must include:

```json
{
  "baseUrl": "http://localhost:3000",
  "repo": "calcom/cal.com",
  "projectDir": "/Users/you/Projects/cal.com",
  "healthCheck": {
    "readyUrl": "http://localhost:3000",
    "readyTimeout": 120000,
    "pollInterval": 3000
  }
}
```

## Execution

**If argument is a PR number:**

```bash
cd "$(git rev-parse --show-toplevel)"
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts eval \
  --pr <number> \
  --verify-dir .verify
```

**If no argument (batch mode):**

```bash
cd "$(git rev-parse --show-toplevel)"
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts eval \
  --verify-dir .verify
```

Print the output to the user. The CLI handles everything: PR discovery, health checks, pipeline runs, introspection, JSONL recording, early stop, and summary.

## Results

Results are written to `docs/evals/<repo-id>/eval-results.jsonl`. Each line is one PR.

```bash
cat docs/evals/cal.com/eval-results.jsonl | jq .
```

## Error Handling

| Failure | CLI behavior |
|---------|-------------|
| `repo` missing from config | Exit with error message |
| `projectDir` missing from config | Exit with error message |
| PR checkout fails | Record failure, continue to next PR |
| Health check timeout | Record failure, continue to next PR |
| Empty PR description | Record failure, continue to next PR |
| Pipeline crash | Record failure, continue to next PR |
| Introspection LLM fails | Use low-confidence fallback, continue |
| 3 consecutive auth_expired | Stop loop, print re-run /verify-setup |
| 3 consecutive health_check fails | Stop loop, print check server |

## Known Limitations

- **Stale server after checkout:** After `gh pr checkout`, the dev server may still serve code from the previous branch until hot-reload kicks in. The health check polls for HTTP 200 but cannot distinguish stale vs fresh builds. If the target repo's dev server supports a health endpoint that returns a git SHA, set `healthCheck.readyUrl` to that endpoint.
```

**Step 2: Add sync hook case**

In `.claude/hooks/sync-skill.sh`, add after the `*skills/verify-setup/SKILL.md)` block (after line 16):

```bash
  *skills/verify-eval/SKILL.md)
    mkdir -p ~/.claude/skills/verify-eval
    cp "$FILE_PATH" ~/.claude/skills/verify-eval/SKILL.md
    echo "synced skills/verify-eval/SKILL.md → ~/.claude/skills/verify-eval/SKILL.md" >&2
    ;;
```

**Step 3: Initial sync**

```bash
mkdir -p ~/.claude/skills/verify-eval
cp skills/verify-eval/SKILL.md ~/.claude/skills/verify-eval/SKILL.md
```

**Step 4: Commit**

```bash
git add skills/verify-eval/SKILL.md .claude/hooks/sync-skill.sh
git commit -m "feat: add /verify-eval skill — thin wrapper for eval CLI command"
```

---

### Task 8: Final verification

**Step 1: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 2: Full test suite**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 3: Verify skill is accessible**

```bash
ls ~/.claude/skills/verify-eval/SKILL.md
```

Expected: file exists

**Step 4: Dry-run the CLI help**

```bash
cd pipeline && npx tsx src/cli.ts
```

Expected: usage text includes the `eval` command

---

### Task 9: E2E test on one PR (manual)

**No code changes — manual verification.**

**Step 1:** Pick one of the 3 eval repos already set up. Add `repo`, `projectDir`, `healthCheck` to its `.verify/config.json`.

**Step 2:** Start the target repo's dev server.

**Step 3:** Run single PR mode:
```bash
cd pipeline && npx tsx src/cli.ts eval --pr <known-merged-pr> --verify-dir <target-repo>/.verify
```

**Step 4:** Verify:
- JSONL entry appended to `docs/evals/<repo-id>/eval-results.jsonl`
- Verdicts populated
- Introspection entries for any failed ACs
- Duration reasonable
- Health check "pass"

**Step 5:** Run batch mode (2-3 PRs):
```bash
cd pipeline && npx tsx src/cli.ts eval --verify-dir <target-repo>/.verify
```

**Step 6:** Verify:
- Discovers unprocessed PRs
- Skips already-processed PR from Step 3
- Running tally prints
- Summary prints at end
