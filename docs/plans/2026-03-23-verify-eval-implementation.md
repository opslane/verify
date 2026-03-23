# /verify-eval Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `/verify-eval` skill that auto-discovers merged frontend PRs, runs the full verify pipeline against each, classifies failures via LLM introspection, and appends results to a per-repo JSONL file.

**Architecture:** The skill is a SKILL.md that orchestrates bash commands and the existing pipeline CLI. No new TypeScript code — the skill uses `gh`, `curl`, `jq`, and `npx tsx pipeline/src/cli.ts run` directly. The introspection step is a separate `claude -p` call that reads evidence + PR diff and classifies failures.

**Tech Stack:** SKILL.md (Claude Code skill), `gh` CLI, `jq`, existing pipeline CLI, `claude -p` for introspection

---

### Task 1: Extend VerifyConfig with `repo` and `healthCheck` fields

**Files:**
- Modify: `pipeline/src/lib/types.ts:11-21`
- Modify: `pipeline/src/lib/config.ts`
- Test: `pipeline/test/config.test.ts` (create if absent, or add to existing)

**Step 1: Add types to VerifyConfig**

In `pipeline/src/lib/types.ts`, replace the `VerifyConfig` interface (lines 11-21) with:

```typescript
export interface HealthCheckConfig {
  readyUrl: string;
  readyTimeout: number;           // ms to wait before marking health check failed
  pollInterval: number;           // ms between curl polls
}

export interface VerifyConfig {
  baseUrl: string;
  repo?: string;                  // GitHub owner/repo, e.g. "calcom/cal.com"
  specPath?: string;
  diffBase?: string;
  maxParallelGroups?: number;     // default 5
  healthCheck?: HealthCheckConfig;
  auth?: {
    email: string;
    password: string;
    loginSteps: LoginStep[];
  };
}
```

**Step 2: Update config loader to handle new fields**

In `pipeline/src/lib/config.ts`, add env var overrides for the new fields. After the existing `envOverrides` block (around line 22-26), add:

```typescript
if (process.env.VERIFY_REPO) envOverrides.repo = process.env.VERIFY_REPO;
```

No env override needed for `healthCheck` — it's only set via config.json.

**Step 3: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS (new fields are optional, no downstream breakage)

**Step 4: Run existing tests to verify no regressions**

Run: `cd pipeline && npx vitest run`
Expected: PASS

**Step 5: Commit**

```bash
git add pipeline/src/lib/types.ts pipeline/src/lib/config.ts
git commit -m "feat(pipeline): add repo and healthCheck fields to VerifyConfig"
```

---

### Task 2: Create the introspection prompt template

**Files:**
- Create: `pipeline/src/prompts/introspection.txt`

**Step 1: Write the prompt**

Create `pipeline/src/prompts/introspection.txt` with:

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
  "classification": "real" | "pipeline",
  "confidence": "high" | "medium" | "low",
  "failed_stage": "ac_generator" | "planner" | "setup_writer" | "browse_agent" | "judge" | null,
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

### Task 3: Create the eval results directory structure

**Files:**
- Create: `docs/evals/calcom/eval-results.jsonl` (empty file)
- Create: `docs/evals/formbricks/eval-results.jsonl` (empty file)
- Create: `docs/evals/documenso/eval-results.jsonl` (empty file)
- Modify: `.gitignore` (ensure eval results are tracked, NOT ignored)

**Step 1: Create empty result files**

```bash
touch docs/evals/calcom/eval-results.jsonl
touch docs/evals/formbricks/eval-results.jsonl
touch docs/evals/documenso/eval-results.jsonl
```

**Step 2: Verify .gitignore doesn't exclude these**

Check `.gitignore` for any pattern that might match `docs/evals/**/*.jsonl`. If found, add an exception:

```
!docs/evals/**/*.jsonl
```

**Step 3: Commit**

```bash
git add docs/evals/calcom/eval-results.jsonl docs/evals/formbricks/eval-results.jsonl docs/evals/documenso/eval-results.jsonl
git commit -m "chore: add empty eval-results.jsonl files for each eval repo"
```

---

### Task 4: Create the `/verify-eval` skill

**Files:**
- Create: `skills/verify-eval/SKILL.md`

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
- `.verify/config.json` has `baseUrl`, `repo`, and `healthCheck` fields
- `/verify-setup` already run (app indexed, auth configured)
- Dev server running

## Usage

```
/verify-eval              # run all unprocessed PRs in a loop
/verify-eval <pr-number>  # run one specific PR
```

---

## Turn 1: Load Config + Discover PRs

**Trigger:** User invokes `/verify-eval` with or without a PR number argument.

**Step 1: Read config**

```bash
cat .verify/config.json | jq -r '.repo // empty'
```

If `repo` is empty, stop: "Add `repo` field to `.verify/config.json` (e.g. `calcom/cal.com`)"

Extract the repo-id (part after `/`) for the results file path:

```bash
REPO=$(jq -r '.repo' .verify/config.json)
REPO_ID=$(echo "$REPO" | cut -d/ -f2)
```

**Step 2: Load existing results**

```bash
RESULTS_FILE="docs/evals/${REPO_ID}/eval-results.jsonl"
mkdir -p "docs/evals/${REPO_ID}"
touch "$RESULTS_FILE"
PROCESSED=$(jq -r '.pr' "$RESULTS_FILE" 2>/dev/null | sort -u)
PROCESSED_COUNT=$(echo "$PROCESSED" | grep -c '[0-9]' || echo 0)
```

**Step 3: Discover or select PRs**

If argument is a PR number:
```bash
PR_NUMBER=<argument>
gh pr view "$PR_NUMBER" --repo "$REPO" --json number,title,url,body > /tmp/verify-eval-pr.json
```

If no argument — discover unprocessed PRs:
```bash
gh pr list --repo "$REPO" --state merged --limit 50 \
  --json number,title,url,body,files \
  | jq '[.[] | select(.files | map(.path) | any(test("\\.(tsx|jsx|css|scss)$")))]' \
  > /tmp/verify-eval-candidates.json
```

Filter out already-processed PRs:
```bash
jq --argjson processed "$(echo "$PROCESSED" | jq -R . | jq -s .)" \
  '[.[] | select(.number as $n | $processed | map(tonumber) | index($n) | not)]' \
  /tmp/verify-eval-candidates.json > /tmp/verify-eval-todo.json

TODO_COUNT=$(jq length /tmp/verify-eval-todo.json)
```

Print status:
```
Eval target: $REPO
Processed: $PROCESSED_COUNT PRs
Remaining: $TODO_COUNT PRs
```

If `TODO_COUNT` is 0 and no argument: "All discovered PRs processed." — stop.

Proceed to Turn 2 (loop mode) or Turn 3 (single PR mode).

---

## Turn 2: Batch Loop

**Trigger:** No PR number argument — running all unprocessed PRs.

For each PR in `/tmp/verify-eval-todo.json` (oldest first):

1. Extract PR number, title, URL, body
2. Run Turn 3 (single PR flow) for this PR
3. Print running tally after each PR
4. **Early stop:** If 3 consecutive PRs fail with `auth_expired` verdicts, stop and print:
   "3 consecutive auth_expired — re-run /verify-setup"
5. **Early stop:** If 3 consecutive health check failures, stop and print:
   "Dev server unresponsive — check server"

After all PRs processed, run Turn 6 (summary).

---

## Turn 3: Single PR Flow

**Trigger:** Processing one PR (from loop or direct argument).

**Step 1: Checkout the PR**

```bash
PR_NUMBER=<current PR number>
echo "PR #${PR_NUMBER}: $(jq -r '.title' /tmp/verify-eval-current.json)"
gh pr checkout "$PR_NUMBER" --repo "$REPO"
```

If checkout fails, record result with `failure_stage: "checkout"` and continue to next PR.

**Step 2: Health check**

```bash
READY_URL=$(jq -r '.healthCheck.readyUrl // .baseUrl' .verify/config.json)
READY_TIMEOUT=$(jq -r '.healthCheck.readyTimeout // 120000' .verify/config.json)
POLL_INTERVAL=$(jq -r '.healthCheck.pollInterval // 3000' .verify/config.json)

TIMEOUT_S=$((READY_TIMEOUT / 1000))
ELAPSED=0
POLL_S=$((POLL_INTERVAL / 1000))

while [ $ELAPSED -lt $TIMEOUT_S ]; do
  if curl -sf "$READY_URL" > /dev/null 2>&1; then
    echo "Health check passed"
    break
  fi
  sleep $POLL_S
  ELAPSED=$((ELAPSED + POLL_S))
done

if [ $ELAPSED -ge $TIMEOUT_S ]; then
  echo "Health check FAILED — server not ready at $READY_URL"
fi
```

If health check fails, record result with `failure_stage: "health_check"`, `failure_reason: "server not ready at $READY_URL after ${TIMEOUT_S}s"`, then checkout main and continue to next PR.

**Step 3: Extract spec from PR description**

```bash
PR_BODY=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json body -q .body)
echo "$PR_BODY" > .verify/spec.md
SPEC_LENGTH=$(wc -c < .verify/spec.md | tr -d ' ')
```

If `SPEC_LENGTH` is 0 or body is empty, record with `failure_stage: "spec_extraction"`, `failure_reason: "PR description is empty"`, checkout main and continue.

**Step 4: Run the pipeline**

```bash
START_MS=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")

cd "$(git rev-parse --show-toplevel)"
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run \
  --spec .verify/spec.md \
  --verify-dir .verify
PIPELINE_EXIT=$?

END_MS=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
DURATION_MS=$((END_MS - START_MS))
```

**Step 5: Read verdicts**

```bash
RUN_DIR=$(ls -td .verify/runs/*/ 2>/dev/null | head -1)
VERDICTS_FILE="${RUN_DIR}verdicts.json"

if [ -f "$VERDICTS_FILE" ]; then
  cat "$VERDICTS_FILE"
fi
```

If no verdicts file exists, record with `failure_stage: "pipeline"`, `failure_reason: "pipeline exited $PIPELINE_EXIT with no verdicts"`.

Proceed to Turn 4 if any verdicts have non-pass results.

---

## Turn 4: Introspection

**Trigger:** Pipeline produced verdicts and at least one AC is not `pass`.

For each non-pass verdict:

**Step 1: Gather evidence**

```bash
AC_ID=<ac_id from verdict>
RUN_DIR=$(ls -td .verify/runs/*/ 2>/dev/null | head -1)

# Browse result
BROWSE_RESULT=$(cat "${RUN_DIR}evidence/${AC_ID}/result.json" 2>/dev/null || echo "{}")

# Browse log (last 50 lines)
BROWSE_LOG=$(tail -50 "${RUN_DIR}logs/browse-agent-${AC_ID}-stream.jsonl" 2>/dev/null || echo "no log")

# PR diff (truncated to 4000 chars)
PR_DIFF=$(gh pr diff "$PR_NUMBER" --repo "$REPO" | head -200)
```

**Step 2: Build introspection prompt**

Read the template from `~/.claude/tools/verify/pipeline/src/prompts/introspection.txt` and substitute:
- `__PR_TITLE__` → PR title
- `__PR_URL__` → PR URL
- `__PR_DIFF__` → truncated diff
- `__AC_ID__` → AC ID
- `__AC_DESCRIPTION__` → AC description from verdicts
- `__AC_VERDICT__` → verdict value
- `__AC_REASONING__` → judge reasoning
- `__BROWSE_RESULT__` → browse result JSON
- `__BROWSE_LOG__` → last 50 lines of browse log

**Step 3: Run introspection**

```bash
claude -p "<substituted prompt>" --model sonnet --output-format json 2>/dev/null
```

Parse the JSON output. If parsing fails, use a fallback:
```json
{
  "ac_id": "<ac_id>",
  "classification": "pipeline",
  "confidence": "low",
  "failed_stage": null,
  "root_cause": "introspection_failed",
  "detail": "Introspection LLM call failed to produce valid JSON",
  "suggested_fix": null
}
```

Collect all introspection results into an array.

---

## Turn 5: Record Results

**Trigger:** Pipeline run complete (with or without verdicts).

**Step 1: Build the JSONL entry**

Construct a JSON object:

```json
{
  "pr": <number>,
  "title": "<title>",
  "url": "<url>",
  "timestamp": "<ISO 8601>",
  "health_check": "pass|fail",
  "pipeline_exit": <exit code>,
  "duration_ms": <ms>,
  "spec_source": "pr_description",
  "spec_length": <bytes>,
  "verdicts": [<from verdicts.json>],
  "introspection": [<from Turn 4>],
  "failure_stage": <null or string>,
  "failure_reason": <null or string>
}
```

**Step 2: Append to results file**

```bash
echo '<json>' >> "docs/evals/${REPO_ID}/eval-results.jsonl"
```

**Step 3: Print per-PR result**

```
PR #28011: fix: inconsistent hover width on Settings nav
  ✓ ac1: pass
  ✗ ac2: fail [pipeline/browse_agent: nav_timeout]
Progress: 8/20 — 5 pass, 2 fail, 1 error
```

**Step 4: Checkout main**

```bash
git checkout main
```

---

## Turn 6: Summary

**Trigger:** All PRs processed (or early stop).

Read the results file and compute:

```bash
RESULTS_FILE="docs/evals/${REPO_ID}/eval-results.jsonl"

TOTAL_PRS=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
TOTAL_VERDICTS=$(jq -r '.verdicts[]?.verdict' "$RESULTS_FILE" | wc -l | tr -d ' ')
PASS_COUNT=$(jq -r '.verdicts[]?.verdict' "$RESULTS_FILE" | grep -c '^pass$' || echo 0)
FAIL_COUNT=$(jq -r '.verdicts[]?.verdict' "$RESULTS_FILE" | grep -c '^fail$' || echo 0)
ERROR_COUNT=$(jq -r '.verdicts[]?.verdict' "$RESULTS_FILE" | grep -cv '^pass$\|^fail$' || echo 0)

REAL_COUNT=$(jq -r '.introspection[]?.classification' "$RESULTS_FILE" | grep -c '^real$' || echo 0)
PIPELINE_COUNT=$(jq -r '.introspection[]?.classification' "$RESULTS_FILE" | grep -c '^pipeline$' || echo 0)
```

Print:

```
══════════════════════════════════════════
Eval complete: ${TOTAL_PRS} PRs processed
══════════════════════════════════════════

Verdicts:
  pass: $PASS_COUNT   fail: $FAIL_COUNT   error: $ERROR_COUNT

Failure classification:
  real:     $REAL_COUNT
  pipeline: $PIPELINE_COUNT

Pipeline failures by stage:
  <aggregate from introspection entries>

Results: $RESULTS_FILE
```

---

## Error Handling

| Failure | Action |
|---------|--------|
| `repo` missing from config | Stop, tell user to add it |
| `gh` not installed | Stop, tell user to install GitHub CLI |
| PR checkout fails | Record failure, continue to next PR |
| Health check timeout | Record failure, continue to next PR |
| Empty PR description | Record failure, continue to next PR |
| Pipeline crash (non-zero, no verdicts) | Record failure, continue to next PR |
| Introspection LLM fails | Use low-confidence fallback, continue |
| 3 consecutive auth_expired | Stop loop, suggest /verify-setup |
| 3 consecutive health_check fails | Stop loop, suggest checking server |
```

**Step 2: Commit**

```bash
git add skills/verify-eval/SKILL.md
git commit -m "feat: add /verify-eval skill — automated eval runner with introspection"
```

---

### Task 5: Add sync hook for the new skill

**Files:**
- Modify: `.claude/hooks/sync-skill.sh:8-37`

**Step 1: Add case for verify-eval**

In `.claude/hooks/sync-skill.sh`, add a new case after the `*skills/verify-setup/SKILL.md)` block (after line 16):

```bash
  *skills/verify-eval/SKILL.md)
    mkdir -p ~/.claude/skills/verify-eval
    cp "$FILE_PATH" ~/.claude/skills/verify-eval/SKILL.md
    echo "synced skills/verify-eval/SKILL.md → ~/.claude/skills/verify-eval/SKILL.md" >&2
    ;;
```

**Step 2: Do the initial sync manually**

```bash
mkdir -p ~/.claude/skills/verify-eval
cp skills/verify-eval/SKILL.md ~/.claude/skills/verify-eval/SKILL.md
```

**Step 3: Commit**

```bash
git add .claude/hooks/sync-skill.sh
git commit -m "chore: add sync hook for verify-eval skill"
```

---

### Task 6: Typecheck and test the full pipeline

**Step 1: Typecheck**

Run: `cd pipeline && npx tsc --noEmit`
Expected: PASS

**Step 2: Run all pipeline tests**

Run: `cd pipeline && npx vitest run`
Expected: PASS (no regressions from the VerifyConfig change)

**Step 3: Verify skill is accessible**

```bash
ls ~/.claude/skills/verify-eval/SKILL.md
```

Expected: file exists

**Step 4: Commit if any fixes were needed**

---

### Task 7: Test the skill end-to-end on one PR

**No code changes — manual verification.**

**Step 1: Pick a repo with existing setup**

Choose one of the 3 eval repos that's already cloned, set up, and has `.verify/config.json`.

**Step 2: Add the new config fields**

Edit `.verify/config.json` in the target repo to add `repo` and `healthCheck`:

```json
{
  "baseUrl": "http://localhost:3000",
  "repo": "calcom/cal.com",
  "healthCheck": {
    "readyUrl": "http://localhost:3000",
    "readyTimeout": 120000,
    "pollInterval": 3000
  }
}
```

**Step 3: Start the dev server**

Start the target repo's dev server.

**Step 4: Run the skill on one PR**

```
/verify-eval <pick a known merged PR number>
```

**Step 5: Verify results file**

```bash
cat docs/evals/cal.com/eval-results.jsonl | jq .
```

Verify:
- JSONL entry was appended
- `verdicts` array is populated
- `introspection` array has entries for any failed ACs
- `duration_ms` is reasonable
- `health_check` is "pass"

**Step 6: Run the skill in batch mode (2-3 PRs)**

```
/verify-eval
```

Verify:
- Discovers unprocessed PRs
- Skips the PR from Step 4
- Processes 2-3 new PRs
- Running tally prints correctly
- Results file grows
