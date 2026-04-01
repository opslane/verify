// pipeline/src/evals/run-judge-evals.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvidencePaths, buildJudgePrompt } from "../stages/judge.js";
import { runClaude } from "../run-claude.js";
import { STAGE_PERMISSIONS } from "../lib/types.js";
import { scoreJudgeEvalCase } from "./judge-eval-score.js";
import type { JudgeEvalExpectation, JudgeEvalResult } from "./judge-eval-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = resolve(__dirname, "..", "..");
const CASES_DIR = join(PIPELINE_DIR, "evals", "judge", "cases");

export function discoverCaseDirs(root = CASES_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

export function formatJudgeEvalSummary(results: JudgeEvalResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const medianMs =
    durations.length === 0
      ? 0
      : durations.length % 2 === 1
        ? durations[Math.floor(durations.length / 2)]
        : Math.round(
            (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2,
          );
  const avgAccuracy =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + r.verdictAccuracy, 0) / results.length;

  return [
    `Summary: ${passed}/${results.length} passed`,
    `Median duration: ${(medianMs / 1000).toFixed(1)}s`,
    `Avg verdict accuracy: ${(avgAccuracy * 100).toFixed(0)}%`,
  ].join("\n");
}

export async function runJudgeEvalCase(caseDir: string): Promise<JudgeEvalResult> {
  const caseId = basename(caseDir);
  const expectedPath = join(caseDir, "expected.json");
  if (!existsSync(expectedPath)) {
    return { caseId, passed: false, failures: ["missing expected.json"], verdictAccuracy: 0, durationMs: 0 };
  }
  let expected: JudgeEvalExpectation;
  try {
    expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as JudgeEvalExpectation;
  } catch {
    return { caseId, passed: false, failures: ["malformed expected.json"], verdictAccuracy: 0, durationMs: 0 };
  }
  if (!Array.isArray(expected.expected_verdicts) || expected.expected_verdicts.length === 0) {
    return { caseId, passed: false, failures: ["expected.json has no expected_verdicts"], verdictAccuracy: 0, durationMs: 0 };
  }

  // Use case directory directly as runDir (judge only reads evidence files)
  const evidenceRefs = collectEvidencePaths(caseDir);
  if (evidenceRefs.length === 0) {
    return {
      caseId,
      passed: false,
      failures: ["no evidence files found in case directory"],
      verdictAccuracy: 0,
      durationMs: 0,
    };
  }

  const prompt = buildJudgePrompt(evidenceRefs);
  const startMs = Date.now();
  let judgeRaw = "";

  try {
    const result = await runClaude({
      prompt,
      model: "opus",
      timeoutMs: 300_000,
      stage: `judge-eval-${caseId}`,
      runDir: caseDir,
      settingSources: "",
      ...STAGE_PERMISSIONS["judge"],
    });
    judgeRaw = result.stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      caseId,
      passed: false,
      failures: [`judge LLM call failed: ${msg}`],
      verdictAccuracy: 0,
      durationMs: Date.now() - startMs,
    };
  }

  const durationMs = Date.now() - startMs;

  return scoreJudgeEvalCase({
    caseId,
    expected,
    judgeRaw,
    durationMs,
  });
}

export async function runJudgeEvals(
  caseDirs = discoverCaseDirs(),
  caseFilter?: string,
): Promise<JudgeEvalResult[]> {
  const selected = caseFilter
    ? caseDirs.filter((d) => basename(d) === caseFilter)
    : caseDirs;
  const results: JudgeEvalResult[] = [];
  for (const caseDir of selected) {
    results.push(await runJudgeEvalCase(caseDir));
  }
  return results;
}

