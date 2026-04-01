// pipeline/src/evals/judge-eval-types.ts

/**
 * Verdicts the judge prompt itself is allowed to produce (judge.txt).
 * The broader Verdict union (timeout, setup_failed, etc.) is pipeline-injected — the judge LLM
 * should only ever output these four. The eval scorer flags anything else as non-prompt-legal.
 */
export const PROMPT_LEGAL_VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "error", "spec_unclear"]);
export type PromptLegalVerdict = "pass" | "fail" | "error" | "spec_unclear";

/** Numeric confidence ordering for floor comparison. */
export const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export interface JudgeEvalExpectedVerdict {
  ac_id: string;
  expected_verdict: PromptLegalVerdict;
  expected_confidence_min?: "high" | "medium" | "low";
  required_reasoning_substrings?: string[];
  forbidden_reasoning_substrings?: string[];
}

export interface JudgeEvalExpectation {
  case_id: string;
  description: string;
  expected_verdicts: JudgeEvalExpectedVerdict[];
}

export interface JudgeEvalResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  verdictAccuracy: number;
  durationMs: number;
}
