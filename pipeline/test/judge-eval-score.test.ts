// pipeline/test/judge-eval-score.test.ts
import { describe, it, expect } from "vitest";
import { scoreJudgeEvalCase, type JudgeEvalArtifacts } from "../src/evals/judge-eval-score.js";
import type { JudgeEvalExpectation } from "../src/evals/judge-eval-types.js";

function makeArtifacts(
  judgeOutput: unknown,
  expected: JudgeEvalExpectation,
  caseId = "test-case",
): JudgeEvalArtifacts {
  return {
    caseId,
    expected,
    judgeRaw: typeof judgeOutput === "string" ? judgeOutput : JSON.stringify(judgeOutput),
    durationMs: 100,
  };
}

describe("scoreJudgeEvalCase", () => {
  it("passes when all verdicts match", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "looks good" }] },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass" }] },
      ),
    );
    expect(result.passed).toBe(true);
    expect(result.verdictAccuracy).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it("fails when verdict does not match", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: "nope" }] },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass" }] },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.verdictAccuracy).toBe(0);
    expect(result.failures).toContainEqual(expect.stringContaining('expected verdict "pass", got "fail"'));
  });

  it("enforces confidence floor with numeric ordering", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "low", reasoning: "ok" }] },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass", expected_confidence_min: "medium" }] },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('confidence "low" below minimum "medium"'));
  });

  it("passes confidence floor when actual >= min", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "ok" }] },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass", expected_confidence_min: "medium" }] },
      ),
    );
    expect(result.passed).toBe(true);
  });

  it("checks required reasoning substrings", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "fail", confidence: "high", reasoning: "page showed error" }] },
        {
          case_id: "t", description: "t",
          expected_verdicts: [{
            ac_id: "ac1", expected_verdict: "fail",
            required_reasoning_substrings: ["auth"],
          }],
        },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('missing required substring: "auth"'));
  });

  it("checks forbidden reasoning substrings", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "passed with screenshot evidence" }] },
        {
          case_id: "t", description: "t",
          expected_verdicts: [{
            ac_id: "ac1", expected_verdict: "pass",
            forbidden_reasoning_substrings: ["screenshot"],
          }],
        },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('forbidden substring: "screenshot"'));
  });

  it("detects missing verdict (judge skipped an AC)", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "ok" }] },
        {
          case_id: "t", description: "t",
          expected_verdicts: [
            { ac_id: "ac1", expected_verdict: "pass" },
            { ac_id: "ac2", expected_verdict: "fail" },
          ],
        },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining("missing verdict for ac2"));
    expect(result.verdictAccuracy).toBe(0.5);
  });

  it("detects duplicate ac_id in judge output", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        {
          verdicts: [
            { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "ok" },
            { ac_id: "ac1", verdict: "fail", confidence: "low", reasoning: "nope" },
          ],
        },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass" }] },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining("duplicate verdict for ac1"));
  });

  it("detects extra verdict for AC not in expectations", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        {
          verdicts: [
            { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "ok" },
            { ac_id: "ac99", verdict: "fail", confidence: "low", reasoning: "bonus" },
          ],
        },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass" }] },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining("unexpected verdict for ac99"));
  });

  it("flags non-prompt-legal verdict", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [{ ac_id: "ac1", verdict: "timeout", confidence: "high", reasoning: "timed out" }] },
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "error" }] },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining("not prompt-legal"));
    expect(result.verdictAccuracy).toBe(0);
  });

  it("calculates verdictAccuracy correctly: 2/4 = 0.5", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        {
          verdicts: [
            { ac_id: "ac1", verdict: "pass", confidence: "high", reasoning: "ok" },
            { ac_id: "ac2", verdict: "fail", confidence: "high", reasoning: "bad" },
            { ac_id: "ac3", verdict: "pass", confidence: "high", reasoning: "ok" },
            { ac_id: "ac4", verdict: "error", confidence: "low", reasoning: "?" },
          ],
        },
        {
          case_id: "t", description: "t",
          expected_verdicts: [
            { ac_id: "ac1", expected_verdict: "pass" },
            { ac_id: "ac2", expected_verdict: "pass" },
            { ac_id: "ac3", expected_verdict: "pass" },
            { ac_id: "ac4", expected_verdict: "pass" },
          ],
        },
      ),
    );
    expect(result.verdictAccuracy).toBe(0.5);
  });

  it("returns verdictAccuracy 1.0 for empty expectations (vacuously true)", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        { verdicts: [] },
        { case_id: "t", description: "t", expected_verdicts: [] },
      ),
    );
    expect(result.passed).toBe(true);
    expect(result.verdictAccuracy).toBe(1);
  });

  it("returns failed result for unparseable judge output", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts(
        "this is not json at all",
        { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass" }] },
      ),
    );
    expect(result.passed).toBe(false);
    expect(result.verdictAccuracy).toBe(0);
    expect(result.failures).toContainEqual("judge output not parseable");
  });

  it("returns failed result for empty judge output", () => {
    const result = scoreJudgeEvalCase(
      makeArtifacts("", { case_id: "t", description: "t", expected_verdicts: [{ ac_id: "ac1", expected_verdict: "pass" }] }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual("judge output not parseable");
  });
});
