# Code Review in /verify Pipeline

**Date:** 2026-03-15
**Status:** Design complete, ready for implementation

## Problem

/verify currently only checks *behavior* — browser agents interact with the UI, take screenshots, and a judge rules pass/fail against ACs. It does not review the actual code changes. This means:

- An AC can "pass" in the browser but have a race condition, null pointer, or missing edge case in code
- Coverage gaps (AC says "editor role can see this" but code only checks `isAdmin`) are invisible
- Security issues in new code are not surfaced

## Solution

Add a code review stage that reviews the git diff through the lens of the ACs. It produces:
1. **Findings** — concrete code issues tagged by AC + severity
2. **AC coverage analysis** — does the diff fully implement each AC, or are there gaps?

The judge receives code review findings as a **separate track** alongside browser evidence. No override logic — browser verdict and code review are independent signals.

## Pipeline Flow

### Before
```
preflight → planner → orchestrate (browser agents) → judge → report
```

### After
```
preflight → planner → orchestrate (browser agents)  ─┐
                    → code-review.sh                  ─┤→ judge → report
```

Code review runs **parallel** to browser agents. It will likely finish faster (no Playwright overhead), but this is not guaranteed for large diffs with Opus.

## New Files

### `scripts/code-review.sh`

Captures the git diff, reads ACs from `.verify/plan.json`, sends both to `claude -p` with the code review prompt. Writes output to `.verify/code-review.json`.

Same pattern as other stages: bash 3 compatible, uses `VERIFY_ALLOW_DANGEROUS` guard, `jq` for JSON processing.

**Diff base detection:**
1. `VERIFY_DIFF_BASE` env var (if set, use it)
2. `diffBase` field in `.verify/config.json` (if present)
3. Auto-detect: `git rev-parse --verify main 2>/dev/null || git rev-parse --verify master 2>/dev/null || git rev-parse HEAD~1`

**Diff size handling:**
- Exclude binary files: `git diff --no-ext-diff --diff-filter=d <base>...HEAD -- . ':!*.png' ':!*.jpg' ':!*.webm' ':!*.woff' ':!*.woff2' ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml'`
- Check size: if diff exceeds 8000 lines, truncate with a warning appended to the prompt ("Diff truncated at 8000 lines — large files omitted. Review may be incomplete.")
- Include `git diff --stat` summary at the top so the model knows what it's not seeing

**Model:** `VERIFY_CODE_REVIEW_MODEL` env var, defaults to `opus`.

**Graceful degradation:** If code-review.sh fails (non-zero exit, invalid JSON, no diff available), the pipeline continues without code review. The judge proceeds with browser evidence only. Report shows "code review: unavailable" for all ACs.

### `scripts/prompts/code-review.txt`

Prompt template that instructs the model to:
1. Review only code in the diff (not pre-existing issues)
2. Tag each finding with the AC it relates to (or "general")
3. Classify severity: `blocker | should_fix | consider`
4. Classify category: `correctness | security | edge_case | coverage_gap | simplicity`
5. Assess AC coverage — fully implemented, partial, or missing
6. Return structured JSON

## Output Schema

### `.verify/code-review.json`

```json
{
  "findings": [
    {
      "ac_id": "ac1",
      "severity": "blocker",
      "category": "correctness",
      "file": "src/components/DocumentCard.tsx",
      "line": 42,
      "finding": "Hover handler doesn't check for null expiry date",
      "suggestion": "Add null guard before formatting date"
    },
    {
      "ac_id": "general",
      "severity": "should_fix",
      "category": "security",
      "file": "src/api/documents.ts",
      "line": 18,
      "finding": "No auth check on the new endpoint",
      "suggestion": "Add requireAuth middleware"
    }
  ],
  "ac_coverage": [
    {
      "ac_id": "ac1",
      "implemented": true,
      "gaps": []
    },
    {
      "ac_id": "ac3",
      "implemented": true,
      "gaps": ["Only checks isAdmin, spec says editor role should also see this"]
    }
  ]
}
```

## Modified Files

### `scripts/judge.sh`

Reads `.verify/code-review.json` (if it exists) and appends its full contents as a single block after all browser evidence sections in the judge prompt. If the file does not exist, the judge prompt proceeds without it (graceful degradation).

### `scripts/prompts/judge.txt`

Extended to instruct the judge to include a `code_review` field per AC in its output. The judge summarizes relevant findings from the code review per AC but does **not** let code review override browser verdict.

Code review findings are appended as a **single block at the end** of the prompt (not interleaved per-AC). This is simpler to implement given the current `judge.sh` structure of iterating over AC IDs.

New per-AC schema:

```json
{
  "ac_id": "ac1",
  "status": "pass|fail|error|timeout",
  "reasoning": "what the browser showed",
  "evidence": "screenshot-path",
  "code_review": {
    "status": "clean|has_findings|unavailable",
    "findings": ["Null check missing on expiry date — blocker"],
    "coverage": "full|partial|none|unknown"
  }
}
```

### `scripts/report.sh`

Terminal output adds code review status per AC:
```
  ✓ ac1: Dialog renders correctly
     code: clean
  ✓ ac2: Submit saves to database
     code: ⚠ 1 finding (should_fix)
  ⏱ ac3: Role-based visibility
     code: unavailable
```

HTML report gets a new **Code Review** column with:
- Badge: `clean` (green), finding count + max severity (amber/red), or `unavailable` (gray)
- Expandable detail: findings with file:line references and coverage status

### `skills/verify/SKILL.md`

Stage 2 updated to launch `code-review.sh` in parallel with `orchestrate.sh`:
```bash
VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/code-review.sh &
CR_PID=$!
VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/orchestrate.sh &
ORCH_PID=$!
wait $ORCH_PID
wait $CR_PID || true  # graceful degradation — don't fail pipeline if code review fails
```

### `.claude/hooks/sync-skill.sh`

Must be updated to include `code-review.sh` in the list of files synced to `~/.claude/tools/verify/`.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Reviewer model | Single model via `claude -p` (default Opus) | AC-awareness requires custom prompt; same infra as rest of pipeline |
| Diff scoping | Full diff, findings tagged by AC | Simpler than per-AC file mapping; avoids extra mapping stage |
| Verdict interaction | Separate tracks, no override | Browser is ground truth for behavior; code review is additive signal |
| Timing | Parallel with browser agents | Minimizes added wall-clock time |
| Scoring rubric | None — severity + category only | code-review-scale handles numeric scoring; verify's value is AC-awareness |
| Diff base | Auto-detect with env var override | Works across repos with different trunk names |
| Failure mode | Graceful degradation | Code review failure should not block browser verification |

## Testing

- `tests/test_code-review.sh` — test with a known diff and ACs, verify JSON output schema
- Integration: run full `/verify` pipeline on a real PR, confirm code review findings appear in report
- Edge case: no diff (clean tree) — should produce empty findings, `"coverage": "unknown"` (not "full" — no changes to review)
- Edge case: diff with no AC-related changes — all findings tagged "general"
- Edge case: large diff (>8000 lines) — verify truncation works and warning is included
- Edge case: binary files in diff — verify they're excluded
- Edge case: code-review.sh fails — verify pipeline continues, report shows "unavailable"
- Edge case: repo has no `main` or `master` branch — verify auto-detection fallback to `HEAD~1`
