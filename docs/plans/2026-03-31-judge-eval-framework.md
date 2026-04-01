# Judge Eval Framework Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a judge eval framework that measures verdict accuracy against golden test cases extracted from real runs.

**Architecture:** Types define expectations, a pure-function scorer compares judge output against expectations, a runner discovers case directories and orchestrates LLM calls. Case directories contain real evidence from production runs with hand-curated expected verdicts. No temp dirs needed since the judge only reads files.

**Tech Stack:** TypeScript 5, Node 22 ESM, vitest, `claude -p` (opus model)

---

### Task 1: Judge Eval Types

**Files:**
- Create: `pipeline/src/evals/judge-eval-types.ts`

**Step 1: Create the types file**

```typescript
// pipeline/src/evals/judge-eval-types.ts

/** Verdicts the judge prompt is allowed to produce (judge.txt line 23). */
export const PROMPT_LEGAL_VERDICTS = new Set(["pass", "fail", "error", "spec_unclear"] as const);
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
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add pipeline/src/evals/judge-eval-types.ts
git commit -m "feat(evals): add judge eval types with prompt-legal verdict validation"
```

---

### Task 2: Judge Eval Scorer

**Files:**
- Create: `pipeline/src/evals/judge-eval-score.ts`
- Reference: `pipeline/src/stages/judge.ts` (for `parseJudgeOutput`)
- Reference: `pipeline/src/evals/browse-eval-score.ts` (pattern reference)

**Step 1: Create the scorer**

```typescript
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
    if (!PROMPT_LEGAL_VERDICTS.has(actual.verdict as never)) {
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
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add pipeline/src/evals/judge-eval-score.ts
git commit -m "feat(evals): add judge eval scorer with prompt-legal validation and confidence ordering"
```

---

### Task 3: Judge Eval Scorer Tests

**Files:**
- Create: `pipeline/test/judge-eval-score.test.ts`
- Reference: `pipeline/src/evals/judge-eval-score.ts`

**Step 1: Write all scorer tests**

```typescript
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
```

**Step 2: Run tests to verify they fail**

Run: `cd pipeline && npx vitest run test/judge-eval-score.test.ts`
Expected: All tests PASS (the scorer code is already written in Task 2)

**Step 3: Commit**

```bash
git add pipeline/test/judge-eval-score.test.ts
git commit -m "test(evals): add judge eval scorer unit tests with 13 cases"
```

---

### Task 4: Extract Golden Test Cases

**Files:**
- Create: `pipeline/evals/judge/cases/clear-pass/evidence/ac1/result.json` (+ ac2, ac3, ac4)
- Create: `pipeline/evals/judge/cases/clear-pass/expected.json`
- Create: `pipeline/evals/judge/cases/setup-404/evidence/*/result.json`
- Create: `pipeline/evals/judge/cases/setup-404/expected.json`
- Create: `pipeline/evals/judge/cases/skeleton-loading/evidence/*/result.json`
- Create: `pipeline/evals/judge/cases/skeleton-loading/expected.json`
- Create: `pipeline/evals/judge/cases/spec-wrong-disabled/evidence/*/result.json`
- Create: `pipeline/evals/judge/cases/spec-wrong-disabled/expected.json`
- Create: `pipeline/evals/judge/cases/unicode-input/evidence/*/result.json`
- Create: `pipeline/evals/judge/cases/unicode-input/expected.json`

**Step 1: Create case directories and copy evidence from real runs**

```bash
cd pipeline

# clear-pass: 2026-03-28-0104-spec (4 ACs, ac1+ac3 are pass)
mkdir -p evals/judge/cases/clear-pass/evidence
for ac in ac1 ac2 ac3 ac4; do
  cp -r /tmp/documenso-verify/runs/2026-03-28-0104-spec/evidence/$ac evals/judge/cases/clear-pass/evidence/
done

# setup-404: 2026-03-27-1648-spec (4 ACs, all show "Token Not Found")
mkdir -p evals/judge/cases/setup-404/evidence
for ac in ac1 ac2 ac3 ac4; do
  cp -r /tmp/documenso-verify/runs/2026-03-27-1648-spec/evidence/$ac evals/judge/cases/setup-404/evidence/
done

# skeleton-loading: 2026-03-27-1639-spec (5 ACs, multi-AC pattern)
mkdir -p evals/judge/cases/skeleton-loading/evidence
for ac in ac1 ac2 ac3 ac4 ac5; do
  cp -r /tmp/documenso-verify/runs/2026-03-27-1639-spec/evidence/$ac evals/judge/cases/skeleton-loading/evidence/
done

# spec-wrong-disabled: 2026-03-28-0438-spec (5 ACs, multi-AC cross-pattern)
mkdir -p evals/judge/cases/spec-wrong-disabled/evidence
for ac in ac1 ac2 ac3 ac4 ac5; do
  cp -r /tmp/documenso-verify/runs/2026-03-28-0438-spec/evidence/$ac evals/judge/cases/spec-wrong-disabled/evidence/
done

# unicode-input: 2026-03-28-0506-spec (unicode form fields)
mkdir -p evals/judge/cases/unicode-input/evidence
for ac in $(ls /tmp/documenso-verify/runs/2026-03-28-0506-spec/evidence/); do
  cp -r /tmp/documenso-verify/runs/2026-03-28-0506-spec/evidence/$ac evals/judge/cases/unicode-input/evidence/
done
```

**Step 2: Read each case's report.json to determine correct expected verdicts**

For each case, read the report.json from the source run AND the evidence result.json files. Then write `expected.json` based on what the correct verdict should be (not what the judge actually said, since the judge may have been wrong).

Consult the evidence `observed` text and the report `reasoning` to determine the ground-truth verdict. This step requires human judgment. The implementer should:

1. Read each `evidence/{acId}/result.json` observed text
2. Read the original `report.json` verdicts and reasoning
3. Decide the correct verdict based on the evidence
4. Write `expected.json`

Example `expected.json` for `clear-pass`:

```json
{
  "case_id": "clear-pass",
  "description": "High-confidence pass case: Document Settings dialog with date format dropdown opens correctly",
  "expected_verdicts": [
    {
      "ac_id": "ac1",
      "expected_verdict": "pass",
      "expected_confidence_min": "high"
    },
    {
      "ac_id": "ac3",
      "expected_verdict": "pass",
      "expected_confidence_min": "high"
    }
  ]
}
```

Note: Only include ACs that have evidence. Some ACs in the source run may have been filtered by the orchestrator before reaching the judge.

Example `expected.json` for `spec-wrong-disabled` (multi-AC cross-pattern):

```json
{
  "case_id": "spec-wrong-disabled",
  "description": "Multi-AC cross-pattern: 5 ACs where 4 show disabled combobox elements. Judge should recognize the cross-AC pattern and return spec_unclear for disabled elements.",
  "expected_verdicts": [
    {
      "ac_id": "ac1",
      "expected_verdict": "pass",
      "expected_confidence_min": "high"
    },
    {
      "ac_id": "ac2",
      "expected_verdict": "spec_unclear",
      "expected_confidence_min": "high",
      "required_reasoning_substrings": ["disabled"]
    },
    {
      "ac_id": "ac3",
      "expected_verdict": "spec_unclear",
      "expected_confidence_min": "high",
      "required_reasoning_substrings": ["disabled"]
    },
    {
      "ac_id": "ac4",
      "expected_verdict": "spec_unclear",
      "expected_confidence_min": "high",
      "required_reasoning_substrings": ["disabled"]
    },
    {
      "ac_id": "ac5",
      "expected_verdict": "spec_unclear",
      "expected_confidence_min": "high",
      "required_reasoning_substrings": ["disabled"]
    }
  ]
}
```

**Step 3: Remove screenshot files from evidence (text-only Phase 1)**

Screenshots are binary files that inflate the repo and can't be passed to `claude -p` text mode. Remove them from the copied evidence. The `result.json` files still reference screenshot filenames (in the `screenshots` array) which is fine. The judge prompt tells the agent to read screenshots from the evidence directory, but if the files don't exist, the judge will rely on text-only evidence.

```bash
find evals/judge/cases/ -name "*.png" -delete
```

**Step 4: Verify evidence structure**

```bash
# Each case should have evidence/{acId}/result.json files
for case_dir in evals/judge/cases/*/; do
  ac_count=$(ls "$case_dir/evidence/" 2>/dev/null | wc -l | tr -d ' ')
  has_expected=$([ -f "$case_dir/expected.json" ] && echo "yes" || echo "NO")
  echo "$(basename $case_dir): ${ac_count} ACs, expected.json: $has_expected"
done
```

Expected output:
```
clear-pass: 4 ACs, expected.json: yes
setup-404: 4 ACs, expected.json: yes
skeleton-loading: 5 ACs, expected.json: yes
spec-wrong-disabled: 5 ACs, expected.json: yes
unicode-input: N ACs, expected.json: yes
```

**Step 5: Commit**

```bash
git add pipeline/evals/judge/
git commit -m "feat(evals): add 5 golden judge eval cases from real Documenso runs"
```

---

### Task 5: Judge Eval Runner

**Files:**
- Create: `pipeline/src/evals/run-judge-evals.ts`
- Reference: `pipeline/src/stages/judge.ts` (collectEvidencePaths, buildJudgePrompt, parseJudgeOutput)
- Reference: `pipeline/src/run-claude.ts` (runClaude)
- Reference: `pipeline/src/lib/types.ts` (STAGE_PERMISSIONS)
- Reference: `pipeline/src/evals/run-browse-evals.ts` (pattern reference for summary formatting)

**Step 1: Create the runner**

```typescript
// pipeline/src/evals/run-judge-evals.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvidencePaths, buildJudgePrompt, parseJudgeOutput } from "../stages/judge.js";
import { runClaude } from "../run-claude.js";
import { STAGE_PERMISSIONS } from "../lib/types.js";
import { scoreJudgeEvalCase, type JudgeEvalArtifacts } from "./judge-eval-score.js";
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
  const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as JudgeEvalExpectation;

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
      timeoutMs: 120_000,
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

async function main(): Promise<void> {
  const caseFilter = process.argv.includes("--case")
    ? process.argv[process.argv.indexOf("--case") + 1]
    : undefined;
  const results = await runJudgeEvals(discoverCaseDirs(), caseFilter);
  for (const result of results) {
    if (result.passed) {
      console.log(`PASS ${result.caseId}  ${(result.durationMs / 1000).toFixed(1)}s  accuracy=${(result.verdictAccuracy * 100).toFixed(0)}%`);
      continue;
    }
    console.log(`FAIL ${result.caseId}  ${result.failures.join("; ")}`);
  }
  console.log(formatJudgeEvalSummary(results));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add pipeline/src/evals/run-judge-evals.ts
git commit -m "feat(evals): add judge eval runner with direct evidence dir reading"
```

---

### Task 6: CLI Integration

**Files:**
- Modify: `pipeline/src/cli.ts`

**Step 1: Add eval-judge command**

Find the `eval-setup` command block in `cli.ts` (line ~275). Add the `eval-judge` command after it, before the `run-stage` block.

Add this block after the `} else if (command === "eval-setup") { ... }` block:

```typescript
} else if (command === "eval-judge") {
  const { runJudgeEvals, discoverCaseDirs, formatJudgeEvalSummary } = await import("./evals/run-judge-evals.js");
  const caseFilter = values["case"] as string | undefined;
  const caseDirs = discoverCaseDirs();
  if (caseDirs.length === 0) { console.error("No judge eval cases found"); process.exit(1); }

  const results = await runJudgeEvals(caseDirs, caseFilter);
  for (const result of results) {
    if (result.passed) {
      console.log(`PASS ${result.caseId}  ${(result.durationMs / 1000).toFixed(1)}s  accuracy=${(result.verdictAccuracy * 100).toFixed(0)}%`);
      continue;
    }
    console.log(`FAIL ${result.caseId}  ${result.failures.join("; ")}`);
  }
  console.log(formatJudgeEvalSummary(results));

  const failCount = results.filter(r => !r.passed).length;
  process.exit(failCount > 0 ? 1 : 0);
```

Also add `case` to the `parseArgs` options object (near line 11-29):

```typescript
case: { type: "string" },
```

Also update the usage string (near end of file) to include the new command:

```
  eval-judge     [--case <caseId>]  Run judge eval cases
```

**Step 2: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

**Step 3: Run existing tests to make sure nothing broke**

Run: `cd pipeline && npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add pipeline/src/cli.ts
git commit -m "feat(cli): add eval-judge command for judge eval framework"
```

---

### Task 7: End-to-End Verification

**Step 1: Run the full test suite**

Run: `cd pipeline && npx tsc --noEmit`
Expected: No errors

Run: `cd pipeline && npx vitest run`
Expected: All tests pass (including new judge-eval-score tests)

**Step 2: Run a single judge eval case**

Run: `cd pipeline && npx tsx src/cli.ts eval-judge --case clear-pass`
Expected: Output like `PASS clear-pass  45.2s  accuracy=100%` (or FAIL with specific failures)

Note: This requires `claude` CLI to be available and authenticated. If not available, the runner will fail with "judge LLM call failed" which is expected.

**Step 3: Run all judge eval cases (if time permits)**

Run: `cd pipeline && npx tsx src/cli.ts eval-judge`
Expected: Summary output showing pass/fail per case and aggregate accuracy

**Step 4: Commit any fixes**

If any tests fail, fix and commit before proceeding.

---

## Summary of Files

| File | Action |
|------|--------|
| `pipeline/src/evals/judge-eval-types.ts` | Create |
| `pipeline/src/evals/judge-eval-score.ts` | Create |
| `pipeline/src/evals/run-judge-evals.ts` | Create |
| `pipeline/test/judge-eval-score.test.ts` | Create |
| `pipeline/evals/judge/cases/*/` | Create (5 case directories) |
| `pipeline/src/cli.ts` | Modify (add eval-judge command + case option) |

## Verification Commands

```bash
cd pipeline
npx tsc --noEmit                                    # typecheck
npx vitest run                                       # all tests
npx vitest run test/judge-eval-score.test.ts         # scorer tests only
npx tsx src/cli.ts eval-judge --case clear-pass      # single eval case
npx tsx src/cli.ts eval-judge                         # all eval cases
```
