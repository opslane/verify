// pipeline/src/evals/judge-eval-score.ts
import type { JudgeOutput } from "../lib/types.js";
import { parseJudgeOutput } from "../stages/judge.js";
import {
  CONFIDENCE_RANK,
  PROMPT_LEGAL_VERDICTS,
  type JudgeEvalExpectation,
  type JudgeEvalResult,
} from "./judge-eval-types.js";

export interface JudgeEvalArtifacts {
  caseId: string;
  expected: JudgeEvalExpectation;
  judgeRaw: string;
  durationMs: number;
}

export function scoreJudgeEvalCase(input: JudgeEvalArtifacts): JudgeEvalResult {
  const { caseId, expected, judgeRaw, durationMs } = input;
  const failures: string[] = [];

  // Parse judge output
  const parsed: JudgeOutput | null = judgeRaw.trim()
    ? parseJudgeOutput(judgeRaw)
    : null;

  if (!parsed) {
    return {
      caseId,
      passed: false,
      failures: ["judge output not parseable"],
      verdictAccuracy: 0,
      durationMs,
    };
  }

  const verdicts = parsed.verdicts;

  // Check for duplicate ac_ids
  const seenIds = new Set<string>();
  for (const v of verdicts) {
    if (seenIds.has(v.ac_id)) {
      failures.push(`duplicate verdict for ${v.ac_id}`);
    }
    seenIds.add(v.ac_id);
  }

  // Check for extra verdicts (AC not in expectations)
  const expectedIds = new Set(expected.expected_verdicts.map((e) => e.ac_id));
  for (const v of verdicts) {
    if (!expectedIds.has(v.ac_id)) {
      failures.push(`unexpected verdict for ${v.ac_id} (not in expectations)`);
    }
  }

  // Build lookup from actual verdicts (use first occurrence if duplicates)
  const actualMap = new Map<string, (typeof verdicts)[number]>();
  for (const v of verdicts) {
    if (!actualMap.has(v.ac_id)) {
      actualMap.set(v.ac_id, v);
    }
  }

  // Score each expected verdict
  let correctCount = 0;
  for (const exp of expected.expected_verdicts) {
    const actual = actualMap.get(exp.ac_id);

    if (!actual) {
      failures.push(`missing verdict for ${exp.ac_id}`);
      continue;
    }

    // Prompt-legal verdict check
    if (!PROMPT_LEGAL_VERDICTS.has(actual.verdict)) {
      failures.push(
        `${exp.ac_id}: verdict "${actual.verdict}" is not prompt-legal (expected one of: pass, fail, error, spec_unclear)`,
      );
      continue;
    }

    // Verdict accuracy
    if (actual.verdict === exp.expected_verdict) {
      correctCount++;
    } else {
      failures.push(
        `${exp.ac_id}: expected verdict "${exp.expected_verdict}", got "${actual.verdict}"`,
      );
    }

    // Confidence floor (numeric ordering)
    if (exp.expected_confidence_min) {
      const actualRank = CONFIDENCE_RANK[actual.confidence] ?? 0;
      const minRank = CONFIDENCE_RANK[exp.expected_confidence_min] ?? 0;
      if (actualRank < minRank) {
        failures.push(
          `${exp.ac_id}: confidence "${actual.confidence}" below minimum "${exp.expected_confidence_min}"`,
        );
      }
    }

    // Reasoning substring checks
    const reasoningLower = (actual.reasoning ?? "").toLowerCase();
    for (const required of exp.required_reasoning_substrings ?? []) {
      if (!reasoningLower.includes(required.toLowerCase())) {
        failures.push(
          `${exp.ac_id}: reasoning missing required substring: "${required}"`,
        );
      }
    }
    for (const forbidden of exp.forbidden_reasoning_substrings ?? []) {
      if (reasoningLower.includes(forbidden.toLowerCase())) {
        failures.push(
          `${exp.ac_id}: reasoning contains forbidden substring: "${forbidden}"`,
        );
      }
    }
  }

  const total = expected.expected_verdicts.length;
  const verdictAccuracy = total === 0 ? 1 : correctCount / total;

  return {
    caseId,
    passed: failures.length === 0,
    failures,
    verdictAccuracy,
    durationMs,
  };
}
