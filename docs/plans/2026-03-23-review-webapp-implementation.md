# Review Webapp Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `/review` Claude Code skill that analyzes code changes against a spec file and opens an HTML report in the browser showing AC verdicts + change explanation.

**Architecture:** Single `claude -p` call with Bash/Read tools analyzes the diff and spec, outputs structured JSON. A TypeScript CLI command generates a self-contained HTML report from the JSON and opens it in the browser.

**Tech Stack:** TypeScript, Node 22 ESM, `claude -p` via existing `runClaude()`, vitest for tests.

---

### Task 1: Add `review` CLI command skeleton

**Files:**
- Modify: `pipeline/src/cli.ts` — add `review` command
- Create: `pipeline/src/review.ts` — review orchestration module
- Test: `pipeline/test/review.test.ts`

**Step 1: Write the failing test**

```typescript
// pipeline/test/review.test.ts
import { describe, it, expect } from "vitest";
import { generateReviewHtml, type ReviewOutput } from "../src/review.js";

describe("generateReviewHtml", () => {
  it("produces valid HTML with verdict table and explanation", () => {
    const input: ReviewOutput = {
      criteria: [
        { id: 1, description: "Rate limiting on uploads", verdict: "pass", reasoning: "middleware added" },
        { id: 2, description: "Billing shows total", verdict: "fail", reasoning: "tax calc missing" },
      ],
      explanation: {
        summary: "Two changes: rate limiting and billing",
        concerns: [
          {
            title: "Rate limiting",
            description: "New middleware using sliding window",
            files_involved: ["src/middleware/rateLimit.ts"],
          },
        ],
      },
    };

    const html = generateReviewHtml(input);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Rate limiting on uploads");
    expect(html).toContain("pass");
    expect(html).toContain("fail");
    expect(html).toContain("tax calc missing");
    expect(html).toContain("Two changes: rate limiting and billing");
    expect(html).toContain("New middleware using sliding window");
  });

  it("sorts failed/unclear verdicts to top", () => {
    const input: ReviewOutput = {
      criteria: [
        { id: 1, description: "First (pass)", verdict: "pass", reasoning: "ok" },
        { id: 2, description: "Second (fail)", verdict: "fail", reasoning: "broken" },
        { id: 3, description: "Third (unclear)", verdict: "spec_unclear", reasoning: "ambiguous" },
      ],
      explanation: { summary: "test", concerns: [] },
    };

    const html = generateReviewHtml(input);
    const failIdx = html.indexOf("Second (fail)");
    const unclearIdx = html.indexOf("Third (unclear)");
    const passIdx = html.indexOf("First (pass)");

    expect(failIdx).toBeLessThan(passIdx);
    expect(unclearIdx).toBeLessThan(passIdx);
  });

  it("handles zero criteria gracefully", () => {
    const input: ReviewOutput = {
      criteria: [],
      explanation: { summary: "No testable criteria found", concerns: [] },
    };

    const html = generateReviewHtml(input);
    expect(html).toContain("No testable criteria found");
    expect(html).toContain("0 pass");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd pipeline && npx vitest run test/review.test.ts`
Expected: FAIL — `generateReviewHtml` does not exist

**Step 3: Write the review module with types and HTML generator**

```typescript
// pipeline/src/review.ts
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { runClaude } from "./run-claude.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ReviewVerdict = "pass" | "fail" | "spec_unclear";

export interface ReviewCriterion {
  id: number;
  description: string;
  verdict: ReviewVerdict;
  reasoning: string;
}

export interface ReviewConcern {
  title: string;
  description: string;
  files_involved: string[];
}

export interface ReviewOutput {
  criteria: ReviewCriterion[];
  explanation: {
    summary: string;
    concerns: ReviewConcern[];
  };
}

// ── HTML Generator ─────────────────────────────────────────────────────────

export function generateReviewHtml(data: ReviewOutput): string {
  const sorted = [...data.criteria].sort((a, b) => {
    const order: Record<ReviewVerdict, number> = { fail: 0, spec_unclear: 1, pass: 2 };
    return order[a.verdict] - order[b.verdict];
  });

  const passCount = data.criteria.filter(c => c.verdict === "pass").length;
  const failCount = data.criteria.filter(c => c.verdict === "fail").length;
  const unclearCount = data.criteria.filter(c => c.verdict === "spec_unclear").length;

  const verdictBadge = (v: ReviewVerdict): string => {
    const colors: Record<ReviewVerdict, { bg: string; text: string; label: string }> = {
      pass: { bg: "#dcfce7", text: "#166534", label: "pass" },
      fail: { bg: "#fee2e2", text: "#991b1b", label: "fail" },
      spec_unclear: { bg: "#fef9c3", text: "#854d0e", label: "unclear" },
    };
    const c = colors[v];
    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:${c.bg};color:${c.text}">${c.label}</span>`;
  };

  const criteriaRows = sorted.map(c => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${escapeHtml(c.description)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${verdictBadge(c.verdict)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px">${escapeHtml(c.reasoning)}</td>
    </tr>`).join("");

  const concernBlocks = data.explanation.concerns.map(c => `
    <div style="margin-bottom:24px">
      <h3 style="margin:0 0 8px;font-size:16px;font-weight:600">${escapeHtml(c.title)}</h3>
      <p style="margin:0 0 8px;color:#374151;line-height:1.6">${escapeHtml(c.description)}</p>
      <div style="font-size:13px;color:#6b7280">
        ${c.files_involved.map(f => `<code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;margin-right:4px">${escapeHtml(f)}</code>`).join("")}
      </div>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Code Review — ${passCount} pass, ${failCount} fail, ${unclearCount} unclear</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 32px 24px; color: #111827; background: #fafafa; }
  </style>
</head>
<body>
  <h1 style="font-size:24px;font-weight:700;margin-bottom:16px">Code Review</h1>

  <div style="display:flex;gap:12px;margin-bottom:24px">
    <div style="padding:8px 16px;border-radius:6px;background:#dcfce7;color:#166534;font-weight:600">${passCount} pass</div>
    <div style="padding:8px 16px;border-radius:6px;background:${failCount > 0 ? '#fee2e2' : '#f3f4f6'};color:${failCount > 0 ? '#991b1b' : '#6b7280'};font-weight:600">${failCount} fail</div>
    <div style="padding:8px 16px;border-radius:6px;background:${unclearCount > 0 ? '#fef9c3' : '#f3f4f6'};color:${unclearCount > 0 ? '#854d0e' : '#6b7280'};font-weight:600">${unclearCount} unclear</div>
  </div>

  <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);margin-bottom:40px">
    <thead>
      <tr style="background:#f9fafb">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;font-weight:600">Criterion</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;font-weight:600;width:80px">Verdict</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;font-weight:600">Reasoning</th>
      </tr>
    </thead>
    <tbody>${criteriaRows}</tbody>
  </table>

  <h2 style="font-size:20px;font-weight:700;margin-bottom:8px">What Changed</h2>
  <p style="color:#374151;margin-bottom:24px;line-height:1.6">${escapeHtml(data.explanation.summary)}</p>

  ${concernBlocks}

  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
    Generated by /review — static code analysis, not runtime verification. Use /verify for runtime checks.
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── JSON Parser ────────────────────────────────────────────────────────────

export function parseReviewOutput(raw: string): ReviewOutput | null {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```json?\n?|\n?```$/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "criteria" in parsed &&
      "explanation" in parsed &&
      Array.isArray((parsed as ReviewOutput).criteria)
    ) {
      return parsed as ReviewOutput;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Base Branch Detection ──────────────────────────────────────────────────

function detectBaseBranch(): string {
  try {
    // Try: does a PR exist for this branch?
    const prBase = execSync("gh pr view --json baseRefName -q .baseRefName", { encoding: "utf-8" }).trim();
    if (prBase) return prBase;
  } catch { /* no PR */ }
  try {
    // Fallback: repo default branch
    const defaultBranch = execSync("gh repo view --json defaultBranchRef -q .defaultBranchRef.name", { encoding: "utf-8" }).trim();
    if (defaultBranch) return defaultBranch;
  } catch { /* gh not available */ }
  return "main";
}

// ── Review Runner ──────────────────────────────────────────────────────────

export async function runReview(specPath: string, verifyDir: string): Promise<{
  htmlPath: string;
  jsonPath: string;
  output: ReviewOutput;
}> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reviewDir = join(verifyDir, "reviews");
  const runDir = join(verifyDir, "runs", `review-${timestamp}`);
  mkdirSync(reviewDir, { recursive: true });
  mkdirSync(join(runDir, "logs"), { recursive: true });

  // Read spec file
  const specContents = readFileSync(specPath, "utf-8");

  // Detect base branch
  const baseBranch = detectBaseBranch();

  // Read prompt template
  const promptDir = dirname(new URL(import.meta.url).pathname);
  const promptTemplate = readFileSync(
    join(promptDir, "prompts", "review.txt"),
    "utf-8"
  );
  const prompt = promptTemplate
    .replace("{{SPEC}}", specContents)
    .replace("{{BASE_BRANCH}}", baseBranch);

  // Run claude -p with specific tools — Bash for git diff, Read/Grep/Glob for codebase exploration
  const result = await runClaude({
    prompt,
    model: "opus",
    timeoutMs: 180_000,
    stage: "review",
    runDir,
    allowedTools: ["Bash", "Read", "Grep", "Glob"],
    settingSources: "",
  });

  if (result.exitCode !== 0 && !result.stdout) {
    throw new Error(`claude -p failed with exit code ${result.exitCode}. Check logs: ${runDir}/logs/`);
  }

  const output = parseReviewOutput(result.stdout);
  if (!output) {
    // Write raw output for debugging
    const errorHtmlPath = join(reviewDir, `${timestamp}-error.html`);
    writeFileSync(errorHtmlPath, generateErrorHtml(result.stdout));
    throw new Error(`Failed to parse review output. Raw output saved to: ${errorHtmlPath}`);
  }

  // Write JSON
  const jsonPath = join(reviewDir, `${timestamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  // Write HTML
  const htmlPath = join(reviewDir, `${timestamp}.html`);
  writeFileSync(htmlPath, generateReviewHtml(output));

  return { htmlPath, jsonPath, output };
}

function generateErrorHtml(rawOutput: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Review Error</title></head>
<body style="font-family:monospace;max-width:900px;margin:0 auto;padding:32px">
  <h1 style="color:#991b1b">Review Analysis Failed</h1>
  <p>Could not parse structured output from claude -p. Raw output below:</p>
  <pre style="background:#f3f4f6;padding:16px;border-radius:8px;overflow-x:auto;white-space:pre-wrap">${escapeHtml(rawOutput || "(empty output)")}</pre>
  <p style="margin-top:16px;color:#6b7280">Check Claude Code terminal for details.</p>
</body>
</html>`;
}
```

**Step 4: Run test to verify it passes**

Run: `cd pipeline && npx vitest run test/review.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/review.ts pipeline/test/review.test.ts
git commit -m "feat: add review module with HTML generator and JSON parser"
```

---

### Task 2: Write the review prompt template

**Files:**
- Create: `pipeline/src/prompts/review.txt`

**Step 1: Create the prompt**

```text
You are a code review agent. Your job is to analyze code changes against a specification and produce a structured review.

## Spec

The user provided this spec/plan file:

<spec>
{{SPEC}}
</spec>

## Instructions

1. Run `git diff origin/{{BASE_BRANCH}}` to see all changes on this branch against the base. Read the diff carefully.
2. Read the diff carefully. If you need more context on specific files, use the Read tool to read them.
3. Extract testable acceptance criteria from the spec. The spec may be a formal AC list, a design doc, a plan, or rough notes — extract whatever is testable regardless of format.
4. For each criterion, evaluate whether the code changes implement it:
   - `pass` — the diff clearly implements this criterion
   - `fail` — the diff does not implement this, or implements it incorrectly
   - `spec_unclear` — the spec is ambiguous and you cannot determine pass/fail from the code alone
5. Group the changes by logical concern (NOT by file). Explain what was built and why.

## Output

You MUST output valid JSON and nothing else. No markdown, no explanation outside the JSON. Use this exact schema:

```json
{
  "criteria": [
    {
      "id": 1,
      "description": "human-readable description of the criterion",
      "verdict": "pass | fail | spec_unclear",
      "reasoning": "one-line explanation of why this verdict"
    }
  ],
  "explanation": {
    "summary": "1-2 sentence summary of all changes",
    "concerns": [
      {
        "title": "Name of the logical concern",
        "description": "What changed and why, written conversationally",
        "files_involved": ["path/to/file1.ts", "path/to/file2.ts"]
      }
    ]
  }
}
```

Be precise. A "pass" means the code clearly implements the criterion. When in doubt, use "spec_unclear" with an explanation of what's ambiguous.
```

**Step 2: No test needed for a prompt template — this is a text file.**

**Step 3: Commit**

```bash
git add pipeline/src/prompts/review.txt
git commit -m "feat: add review prompt template"
```

---

### Task 3: Add `review` command to CLI

**Files:**
- Modify: `pipeline/src/cli.ts` — add `review` command that calls `runReview` and opens browser

**Step 1: Write the failing test**

```typescript
// Add to pipeline/test/review.test.ts (below existing imports)
import { parseReviewOutput } from "../src/review.js";

describe("parseReviewOutput", () => {
  it("parses valid JSON", () => {
    const raw = JSON.stringify({
      criteria: [{ id: 1, description: "test", verdict: "pass", reasoning: "ok" }],
      explanation: { summary: "test", concerns: [] },
    });
    const result = parseReviewOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.criteria).toHaveLength(1);
  });

  it("handles markdown code fences", () => {
    const raw = '```json\n{"criteria":[],"explanation":{"summary":"x","concerns":[]}}\n```';
    const result = parseReviewOutput(raw);
    expect(result).not.toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseReviewOutput("not json")).toBeNull();
    expect(parseReviewOutput("{}")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails (the new tests)**

Run: `cd pipeline && npx vitest run test/review.test.ts`
Expected: new `parseReviewOutput` tests should PASS since the function exists from Task 1

**Step 3: Add the `review` command to cli.ts**

In `pipeline/src/cli.ts`, add a new `review` case after the existing `run` command. Add `spec` to the existing `parseArgs` options (it's already there). Add this block before the `else if (command === "index-app")` block:

```typescript
} else if (command === "review") {
  const specPath = values.spec;
  if (!specPath) {
    console.error("Usage: npx tsx src/cli.ts review --spec <path-to-spec>");
    process.exit(1);
  }

  const verifyDir = values["verify-dir"]!;
  const { runReview } = await import("./review.js");

  try {
    console.log("Analyzing changes against spec...");
    const { htmlPath, output } = await runReview(specPath, verifyDir);

    // Print summary to terminal
    const passCount = output.criteria.filter(c => c.verdict === "pass").length;
    const failCount = output.criteria.filter(c => c.verdict === "fail").length;
    const unclearCount = output.criteria.filter(c => c.verdict === "spec_unclear").length;
    console.log(`\nResults: ${passCount} pass, ${failCount} fail, ${unclearCount} unclear`);

    // Open in browser
    const { execSync } = await import("node:child_process");
    const platform = process.platform;
    const openCmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
    execSync(`${openCmd} "${htmlPath}"`);
    console.log(`\nReport opened: ${htmlPath}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

} else if (command === "index-app") {
```

Also add `review` to the usage/help text at the bottom of cli.ts.

**Step 4: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS — no type errors

**Step 5: Run all tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add pipeline/src/cli.ts pipeline/test/review.test.ts
git commit -m "feat: add review command to CLI"
```

---

### Task 4: Write the SKILL.md for /review

**Files:**
- Create: `skills/review-code/SKILL.md` — the Claude Code skill (using `review-code` to avoid conflict with gstack's `/review`)

**Step 1: Write the skill**

```markdown
---
name: review-code
description: Review code changes against a spec/plan file. Opens an HTML report showing AC verdicts and change explanation.
---

# /review-code

Review your code changes against a spec or plan.

## Turn 1: Spec Intake

**Trigger:** User invokes `/review-code`.

**Check for arguments first.** If the user passed a file path as an argument (e.g. `/review-code docs/plans/my-feature.md`), skip to Turn 2 using that path.

**Otherwise**, check recent conversation for referenced spec/plan files. If found, ask:

> "I see you recently referenced `[path]`. Review changes against this spec?"

If no spec found in conversation:

> "What spec or plan should I review against? Give a file path."

Do not call any tools. End your response and wait for the user to reply.

---

## Turn 2: Run Review

**Trigger:** User has provided a spec path.

1. Verify the spec file exists:

```bash
[ -f "<spec-path>" ] && echo "OK" || echo "NOT FOUND"
```

If not found, tell the user and stop.

2. Run the review pipeline:

```bash
cd pipeline && npx tsx src/cli.ts review --spec <spec-path> --verify-dir ../.verify
```

3. The command will:
   - Call `claude -p` to analyze the diff against the spec
   - Generate an HTML report at `.verify/reviews/{timestamp}.html`
   - Open it in the browser
   - Print a summary to the terminal

4. Report the terminal summary to the user:

> "Review complete: X pass, Y fail, Z unclear. Report opened in browser."

If there are failures or unclear verdicts, briefly note the top issues.
```

**Step 2: No automated test for a skill file. Manual verification: invoke `/review-code` in Claude Code.**

**Step 3: Commit**

```bash
git add skills/review-code/SKILL.md
git commit -m "feat: add /review-code skill"
```

---

### Task 5: End-to-end manual test

**No code changes. This is a verification task.**

**Step 1:** Make sure you have uncommitted or recent changes on a branch.

**Step 2:** Create a test spec file:

```bash
cat > /tmp/test-spec.md << 'EOF'
## Requirements

1. The review module should generate HTML from structured JSON
2. The HTML should include a verdict table with pass/fail/unclear badges
3. Failed verdicts should sort to the top of the table
4. The explanation section should group changes by concern, not by file
EOF
```

**Step 3:** Run the review CLI directly:

```bash
cd pipeline && npx tsx src/cli.ts review --spec /tmp/test-spec.md --verify-dir ../.verify
```

**Step 4:** Verify:
- [ ] HTML report opens in browser
- [ ] Verdict table shows criteria with colored badges
- [ ] Summary bar shows pass/fail/unclear counts
- [ ] Explanation section shows changes grouped by concern
- [ ] JSON file saved alongside HTML in `.verify/reviews/`

**Step 5:** If everything works, commit any fixes from testing.

---

## Summary

| Task | What | Files | Estimated Time (CC) |
|------|------|-------|-------------------|
| 1 | Review module + HTML generator + tests | `review.ts`, `review.test.ts` | ~10 min |
| 2 | Prompt template | `prompts/review.txt` | ~5 min |
| 3 | CLI command | `cli.ts` | ~5 min |
| 4 | Skill file | `skills/review-code/SKILL.md` | ~5 min |
| 5 | E2E manual test | — | ~10 min |

**Total: ~35 minutes with CC**

## Dependencies

- Existing `runClaude()` in `pipeline/src/run-claude.ts` — no changes needed
- Existing `STAGE_PERMISSIONS` in `pipeline/src/lib/types.ts` — no changes needed (review uses explicit `allowedTools`)
- `.verify/` directory is already gitignored
