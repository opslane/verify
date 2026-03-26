# Review Webapp Design

## Problem

After AI writes code, the human bottleneck is verifying the changes actually match what was asked and understanding what was built. Terminal diffs don't help — you need a higher-level view.

Inspired by Chirag Agrawal's insight: "The AI will produce a view of what it built. The underlying code will be an implementation detail."

## What it is

A Claude Code skill (`/review`) that analyzes your code changes against a spec/plan file and opens an HTML report in your browser. The report:

1. Checks your code changes against a spec/plan file — did the AI build what you asked?
2. Explains the changes by concern (not by file) — what was built and why?

Verdicts are based on static code analysis of the diff, not runtime verification. A "pass" means "the code appears to implement this AC." For runtime verification, use `/verify`.

Read-only. When you're done reviewing, go back to Claude Code to act on feedback.

## How it's triggered

```
/review --spec docs/plans/my-feature.md
```

- `--spec` is required. Accepts any local file (markdown plan, design doc, rough spec). AI extracts testable criteria from whatever format you give it.
- If `--spec` is omitted, the skill checks session history for recently referenced plan/spec files and asks the user to confirm.

## Architecture

**Simple: `claude -p` → JSON → HTML → open in browser.**

```
/review skill (Claude Code)
  → reads spec file
  → calls claude -p with spec contents + prompt
    → agent runs git diff itself (Bash tool)
    → agent reads specific files if needed (Read tool)
    → extracts testable criteria from spec
    → evaluates each AC against the code changes
    → generates concern-grouped explanation of changes
    → outputs structured JSON
  → generates HTML report from JSON
  → writes to .verify/reviews/{timestamp}.html
  → opens in browser
```

No Agent SDK. No server. No WebSocket. One `claude -p` call, one HTML file.

### claude -p invocation

The skill passes:
- Spec file contents
- Prompt template requesting structured JSON output

The agent has Bash and Read tool access. It runs `git diff` itself and reads specific files when it needs more context beyond the diff. This avoids bloating the prompt with a huge diff upfront — the agent explores the codebase as needed.

The prompt asks Claude to:
1. Run `git diff` against the base branch to understand what changed
2. Extract testable acceptance criteria from the spec (flexible format)
3. For each AC, evaluate whether the code changes implement it (pass/fail/unclear + one-line reasoning) — reading source files as needed for deeper context
4. Group the changes by concern (not by file) and explain what was built and why

### Output JSON schema

```json
{
  "criteria": [
    {
      "id": 1,
      "description": "Rate limiting on upload endpoint",
      "verdict": "pass",
      "reasoning": "middleware added with 10 req/min limit"
    }
  ],
  "explanation": {
    "summary": "Two things changed: rate limiting and billing calculation",
    "concerns": [
      {
        "title": "Rate limiting on upload endpoint",
        "description": "New middleware using sliding window...",
        "files_involved": ["src/middleware/rateLimit.ts", "src/routes/upload.ts"]
      }
    ]
  }
}
```

### HTML generation

Self-contained HTML file with inline CSS. No external dependencies, no build step. Polished but simple — clean typography, color-coded verdict badges (green pass, red fail, yellow unclear), readable at a glance. Looks intentional, not generated.

The HTML template is embedded in the skill or in `pipeline/src/templates/`.

### Error handling

- `claude -p` returns malformed JSON → show error page with raw output for debugging
- `claude -p` extracts zero ACs from spec → show warning: "No testable criteria found in spec. The file may not contain acceptance criteria."
- `claude -p` subprocess fails/times out → show error page linking to Claude Code terminal for details

## Webapp UI

### Layout: stacked, two sections

```
+--------------------------------------+
| Summary: 7 pass | 2 fail | 1 unclear |
+--------------------------------------+
| AC  | Description             | Verdict |
|-----|-------------------------|---------|
| 1   | Rate limiting on uploads | pass    |
|     |   middleware added, 10/m |         |
| 2   | Billing shows total      | fail    |
|     |   tax calc missing       |         |
| 3   | Trial banner after 7d    | ???     |
|     |   spec says 7, code 14   |         |
+--------------------------------------+
|                                      |
| Explanation                          |
| (grouped by concern, not by file)    |
|                                      |
+--------------------------------------+
```

### Verdict table (top)
- Summary bar with pass/fail/unclear counts
- Each row: AC description + verdict badge + one-line reasoning
- Failed/unclear items sort to top

### Explanation (bottom)
- Changes grouped by logical concern, not by file
- Each concern: title, what changed and why, files involved
- Conversational tone — like a colleague at a whiteboard

### Error states

- **No git diff:** "No changes found against base branch."
- **Bad spec file:** "Could not read spec file at [path]."
- **claude -p failure:** "Analysis failed. Check Claude Code for errors."
- **Huge diff (>1000 lines):** Warn in the report that analysis may be incomplete.

## Output

- HTML report: `.verify/reviews/{timestamp}.html`
- Raw JSON: `.verify/reviews/{timestamp}.json` (for future tooling)
- Both are gitignored (`.verify/` is already in `.gitignore`)

## What this is NOT

- Not a code editor — no code changes from the report
- Not a replacement for /verify — no runtime verification (browse agent, screenshots, DB setup)
- Not a PR review tool — no structural code review (SQL safety, race conditions)
- Not a visual architecture diagram — explanation is textual, grouped by concern

## Future (v2+)

- **Socratic quiz:** Agent SDK-powered chat (rubber-duck style) asking questions about the changes
- **Runtime + static merge:** Combine /review (static code analysis) with /verify (runtime browser verification) into one unified report
- **Feedback loop:** Click something in the report, send feedback to Claude Code to fix it
- **Architecture view:** Visual component graph alongside the explanation
