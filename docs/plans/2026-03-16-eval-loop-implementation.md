# Eval Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an eval framework that runs the verify pipeline against a set of known PRs, scores results, classifies failures, and tracks prompt quality over time.

**Architecture:** Four new scripts (`eval-runner.sh`, `eval-loop.sh`, `eval-gen-spec.sh`, spec generation prompt) plus an upgrade to the existing judge prompt and report. The eval-runner handles one PR end-to-end (worktree, DB, pipeline, artifacts). The eval-loop orchestrates sequentially across repos. The judge classifies failures inline (single pass).

**Tech Stack:** Bash 3 (no mapfile), jq, PostgreSQL (createdb/dropdb), git worktrees, `claude -p` (non-interactive), `gh` CLI

**Design doc:** `docs/plans/2026-03-16-eval-loop-design.md`

---

### Task 1: Judge prompt upgrade — add failure_class and confidence

**Files:**
- Modify: `scripts/prompts/judge-browse.txt`

**Step 1: Read the current judge prompt for context**

The current prompt is at `scripts/prompts/judge-browse.txt`. It returns a JSON schema with `status`, `reasoning`, `evidence`, `agent_claimed`, `judge_override`. We're adding `confidence` and `failure_class` fields — additive only, no existing fields removed.

**Step 2: Edit the judge prompt**

Replace the full contents of `scripts/prompts/judge-browse.txt` with:

```
You are a quality judge reviewing frontend verification results.

For each acceptance criterion, you have structured evidence: a result.json from the agent, plus screenshots.

Return ONLY a valid JSON object. No markdown fences, no explanation. Raw JSON only.

Schema:
{
  "verdict": "pass|fail|partial",
  "summary": "<N>/<total> ACs passed",
  "criteria": [
    {
      "ac_id": "<id>",
      "status": "pass|fail|error|timeout",
      "confidence": "high|medium|low",
      "failure_class": "app_bug|pipeline_noise|insufficient_evidence",
      "reasoning": "<one sentence: what the evidence shows>",
      "evidence": "<screenshot path>",
      "agent_claimed": "<what the agent said>",
      "judge_override": false
    }
  ],
  "skipped": []
}

Rules:
1. The agent's result.json is the starting point. Check if the evidence supports its claim.
2. The "observed" field in result.json contains snapshot diffs — use these as primary evidence.
3. Screenshots are secondary evidence — confirm what the diffs describe.
4. pass = evidence clearly confirms the criterion is met.
5. fail = evidence clearly shows the criterion is NOT met.
6. error = agent crashed, hit login redirect, or result.json is missing/malformed.
7. timeout = agent timed out before completing.
8. Set judge_override=true ONLY when you disagree with the agent's claimed result.
9. Be strict: if evidence is ambiguous, mark as fail.
10. If result.json is missing, fall back to agent.log content.

Confidence:
11. high = evidence is clear and unambiguous (screenshots match, diffs confirm).
12. medium = evidence exists but has gaps (partial screenshots, some steps incomplete).
13. low = evidence is thin (timeout, crash, only agent.log with no screenshots).

Failure classification (ONLY for status=fail, error, or timeout — omit for pass):
14. app_bug = agent completed steps, evidence clearly shows a real UI defect. The element exists but behaves incorrectly, displays wrong content, or has wrong styling. This is a genuine bug in the application.
15. pipeline_noise = the pipeline misfired. Signals: login redirect, blank page, wrong URL navigated, agent tested the wrong element, timeout with few steps completed, evidence contradicts the verdict. The app may be fine but the pipeline couldn't verify it.
16. insufficient_evidence = agent crashed before collecting meaningful evidence. result.json is missing or malformed. Cannot determine if the AC passes or fails.

Note: code review findings may be appended below by the pipeline. Factor them into your assessment if present.
```

**Step 3: Verify the prompt file is valid**

Run: `cat scripts/prompts/judge-browse.txt | head -5`
Expected: `You are a quality judge reviewing frontend verification results.`

**Step 4: Commit**

```bash
git add scripts/prompts/judge-browse.txt
git commit -m "feat(eval): add failure_class and confidence to judge prompt"
```

---

### Task 2: Add migrate_cmd to eval set repos

**Files:**
- Modify: `docs/evals/eval-set-v2.json`

**Step 1: Add migrate_cmd field to each repo**

Update the `repos` array in `docs/evals/eval-set-v2.json`. Add a `migrate_cmd` field to each repo object:

- calcom: `"migrate_cmd": "npx prisma db push --skip-generate"`
- formbricks: `"migrate_cmd": "npx prisma db push --skip-generate"`
- documenso: `"migrate_cmd": "npx prisma db push --skip-generate"`
- dub: `"migrate_cmd": "npx prisma db push --skip-generate"`
- karakeep: `"migrate_cmd": "npx drizzle-kit push"`

**Step 2: Verify JSON is valid**

Run: `jq '.repos[] | {id, migrate_cmd}' docs/evals/eval-set-v2.json`
Expected: 5 objects, each with an `id` and `migrate_cmd`.

**Step 3: Commit**

```bash
git add docs/evals/eval-set-v2.json
git commit -m "feat(eval): add migrate_cmd per repo in eval set"
```

---

### Task 3: Fix gitignore — be specific, not blanket

**Files:**
- Modify: `.gitignore`

**Step 1: Read current .gitignore**

Check if `docs/evals/` is currently gitignored (it is — this blocks committing specs).

**Step 2: Replace blanket docs/evals/ with specific entries**

If `.gitignore` contains `docs/evals/`, replace it with:

```
# Eval loop artifacts (large — screenshots, videos, logs)
docs/evals/runs/
docs/evals/results.jsonl
```

This allows `docs/evals/eval-set-v2.json`, `docs/evals/specs/`, and `docs/evals/README.md` to be committed while keeping run artifacts gitignored.

**Step 3: Verify the eval set is now trackable**

Run: `git check-ignore docs/evals/eval-set-v2.json; echo "exit: $?"`
Expected: exit code 1 (not ignored)

Run: `git check-ignore docs/evals/runs/test; echo "exit: $?"`
Expected: exit code 0 (ignored)

**Step 4: Commit**

```bash
git add .gitignore
git commit -m "fix: make gitignore specific for evals — allow specs and eval set, ignore runs"
```

---

### Task 4: Spec generation script and prompt

**Files:**
- Create: `scripts/prompts/eval-spec-gen.txt`
- Create: `scripts/eval-gen-spec.sh`

**Step 1: Create the spec generation prompt**

Write `scripts/prompts/eval-spec-gen.txt`:

```
Generate a concise frontend acceptance criteria spec for this PR.

Return ONLY a markdown document with:
1. A ## Context section (2-3 sentences: what changed and why)
2. A ## Acceptance Criteria section with 2-5 bullet points
   - Each bullet is a concrete, testable assertion about the UI
   - Focus on what a user would see/interact with, not implementation details
   - Reference specific UI elements, pages, or states
   - Be specific enough that a browser agent can verify each criterion

No preamble, no markdown fences around the document, no explanation. Just the spec.
```

**Step 2: Create eval-gen-spec.sh**

Write `scripts/eval-gen-spec.sh`:

```bash
#!/usr/bin/env bash
# Generate a spec for one eval item from its PR diff.
# Usage: eval-gen-spec.sh <eval-id> [eval-set.json]
# Writes to: docs/evals/specs/<repo>/pr-<N>-spec.md
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

EVAL_ID="$1"
EVAL_SET="${2:-docs/evals/eval-set-v2.json}"

[ -n "$EVAL_ID" ] || { echo "Usage: $0 <eval-id> [eval-set.json]"; exit 1; }
[ -f "$EVAL_SET" ] || { echo "✗ Eval set not found: $EVAL_SET"; exit 1; }

# Parse eval item
EVAL_JSON=$(jq -r --arg id "$EVAL_ID" '.evals[] | select(.id == $id)' "$EVAL_SET")
[ -n "$EVAL_JSON" ] || { echo "✗ Eval '$EVAL_ID' not found in $EVAL_SET"; exit 1; }

REPO_ID=$(echo "$EVAL_JSON" | jq -r '.repo')
PR_NUM=$(echo "$EVAL_JSON" | jq -r '.pr')
PR_TITLE=$(echo "$EVAL_JSON" | jq -r '.title')
PR_URL=$(echo "$EVAL_JSON" | jq -r '.url')

REPO_JSON=$(jq -r --arg id "$REPO_ID" '.repos[] | select(.id == $id)' "$EVAL_SET")
REPO_FULL=$(echo "$REPO_JSON" | jq -r '.repo')

SPEC_DIR="docs/evals/specs/$REPO_ID"
SPEC_FILE="$SPEC_DIR/pr-${PR_NUM}-spec.md"

# Check if spec already exists
if [ -f "$SPEC_FILE" ]; then
  echo "→ Spec already exists: $SPEC_FILE (skipping)"
  exit 0
fi

# Get merge commit via gh CLI (authoritative, works on macOS)
echo "→ Looking up merge commit for $REPO_FULL#$PR_NUM..."
MERGE_COMMIT=$(gh pr view "$PR_NUM" --repo "$REPO_FULL" --json mergeCommit -q '.mergeCommit.oid' 2>/dev/null)
if [ -z "$MERGE_COMMIT" ]; then
  echo "✗ Could not find merge commit for PR #$PR_NUM. Is gh authenticated?"
  exit 1
fi

# Get diff
REPO_DIR="${EVAL_REPOS_DIR:-$HOME/Projects/opslane/evals}/$REPO_ID"
if [ -d "$REPO_DIR/.git" ]; then
  DIFF=$(cd "$REPO_DIR" && git show "$MERGE_COMMIT" 2>/dev/null | head -500)
else
  # Fall back to gh API
  DIFF=$(gh api "repos/$REPO_FULL/commits/$MERGE_COMMIT" --jq '.files[].patch' 2>/dev/null | head -500)
fi

if [ -z "$DIFF" ]; then
  echo "✗ Could not get diff for commit $MERGE_COMMIT"
  exit 1
fi

# Build prompt
PROMPT_FILE=$(mktemp /tmp/eval-spec-XXXXXX.txt)
trap "rm -f '$PROMPT_FILE'" EXIT

{
  cat "$SCRIPT_DIR/prompts/eval-spec-gen.txt"
  printf "\n\nPR: %s#%s — %s\nURL: %s\n\nCode diff (first 500 lines):\n\`\`\`diff\n%s\n\`\`\`\n" \
    "$REPO_FULL" "$PR_NUM" "$PR_TITLE" "$PR_URL" "$DIFF"
} > "$PROMPT_FILE"

# Generate spec
echo "→ Generating spec for $EVAL_ID ($REPO_ID PR #$PR_NUM)..."
mkdir -p "$SPEC_DIR"
"$CLAUDE" -p --model sonnet < "$PROMPT_FILE" 2>/dev/null > "$SPEC_FILE"

LINES=$(wc -l < "$SPEC_FILE" | tr -d ' ')
echo "✓ Spec written to $SPEC_FILE ($LINES lines)"
```

**Step 3: Make executable and syntax check**

Run: `chmod +x scripts/eval-gen-spec.sh && bash -n scripts/eval-gen-spec.sh && echo "OK"`
Expected: `OK`

**Step 4: Commit**

```bash
git add scripts/prompts/eval-spec-gen.txt scripts/eval-gen-spec.sh
git commit -m "feat(eval): add spec generation script and prompt template"
```

---

### Task 5: Create specs directory with existing v1 specs

**Files:**
- Create: `docs/evals/specs/` directory structure
- Move: existing v1 specs

**Step 1: Create directory structure and copy existing specs**

```bash
mkdir -p docs/evals/specs/calcom
mkdir -p docs/evals/specs/formbricks
mkdir -p docs/evals/specs/documenso
mkdir -p docs/evals/specs/dub
mkdir -p docs/evals/specs/karakeep

# Copy existing v1 specs
cp docs/evals/calcom/*.md docs/evals/specs/calcom/ 2>/dev/null || true
cp docs/evals/formbricks/*.md docs/evals/specs/formbricks/ 2>/dev/null || true
cp docs/evals/documenso/*.md docs/evals/specs/documenso/ 2>/dev/null || true
```

**Step 2: Verify specs are committable (not gitignored)**

Run: `git check-ignore docs/evals/specs/calcom/pr-28011-spec.md 2>/dev/null; echo "exit: $?"`
Expected: exit code 1 (not ignored). If this fails, Task 3 (gitignore fix) was not done correctly.

**Step 3: Commit**

```bash
git add docs/evals/specs/
git commit -m "feat(eval): create specs directory with existing v1 specs"
```

---

### Task 6: eval-runner.sh — run one eval item end-to-end

**Files:**
- Create: `scripts/eval-runner.sh`

**Step 1: Create eval-runner.sh**

Write `scripts/eval-runner.sh`:

```bash
#!/usr/bin/env bash
# Run a single eval item: worktree checkout → pipeline → collect artifacts
# Usage: eval-runner.sh <eval-id> [eval-set-json] [--skip-existing]
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORIG_DIR="$(pwd)"

EVAL_ID="$1"
EVAL_SET="${2:-docs/evals/eval-set-v2.json}"
SKIP_EXISTING=false
for arg in "$@"; do
  [ "$arg" = "--skip-existing" ] && SKIP_EXISTING=true
done

[ -n "$EVAL_ID" ] || { echo "Usage: $0 <eval-id> [eval-set.json] [--skip-existing]"; exit 1; }
[ -f "$EVAL_SET" ] || { echo "✗ Eval set not found: $EVAL_SET"; exit 1; }

# ── Parse eval item ──────────────────────────────────────────────────────────
EVAL_JSON=$(jq -r --arg id "$EVAL_ID" '.evals[] | select(.id == $id)' "$EVAL_SET")
[ -n "$EVAL_JSON" ] || { echo "✗ Eval '$EVAL_ID' not found in $EVAL_SET"; exit 1; }

REPO_ID=$(echo "$EVAL_JSON" | jq -r '.repo')
PR_NUM=$(echo "$EVAL_JSON" | jq -r '.pr')
EXPECTED=$(echo "$EVAL_JSON" | jq -r '.expected_verdict')

REPO_JSON=$(jq -r --arg id "$REPO_ID" '.repos[] | select(.id == $id)' "$EVAL_SET")
REPO_FULL=$(echo "$REPO_JSON" | jq -r '.repo')
BASE_URL=$(echo "$REPO_JSON" | jq -r '.base_url')
MIGRATE_CMD=$(echo "$REPO_JSON" | jq -r '.migrate_cmd // empty')

# ── Paths (all absolute) ─────────────────────────────────────────────────────
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")-$$"
EVALS_DIR="$(cd "$(dirname "$EVAL_SET")" && pwd)"
ARTIFACT_DIR="$EVALS_DIR/runs/$EVAL_ID/$RUN_ID"
REPO_DIR="${EVAL_REPOS_DIR:-$HOME/Projects/opslane/evals}/$REPO_ID"
WORKTREE_DIR="/tmp/eval-${REPO_ID}-pr-${PR_NUM}"
DB_NAME="eval_${REPO_ID}_pr_${PR_NUM}"
PROMPT_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "═══════════════════════════════════════════"
echo " Eval: $EVAL_ID | $REPO_ID PR #$PR_NUM"
echo " Run:  $RUN_ID"
echo "═══════════════════════════════════════════"

# ── Resume check ──────────────────────────────────────────────────────────────
if [ "$SKIP_EXISTING" = true ]; then
  EXISTING=$(find "$EVALS_DIR/runs/$EVAL_ID" -name "summary.json" 2>/dev/null | head -1)
  if [ -n "$EXISTING" ]; then
    echo "→ Skipping $EVAL_ID (already has results at $EXISTING)"
    exit 0
  fi
fi

# ── Validate repo exists ─────────────────────────────────────────────────────
[ -d "$REPO_DIR/.git" ] || { echo "✗ Repo not found at $REPO_DIR. Clone it first."; exit 1; }

# ── Find merge commit via gh CLI ─────────────────────────────────────────────
echo "→ Finding merge commit for PR #$PR_NUM..."
MERGE_COMMIT=$(gh pr view "$PR_NUM" --repo "$REPO_FULL" --json mergeCommit -q '.mergeCommit.oid' 2>/dev/null)
if [ -z "$MERGE_COMMIT" ]; then
  # Fallback: search git log
  MERGE_COMMIT=$(cd "$REPO_DIR" && git log --all --format="%H %s" 2>/dev/null | grep -E "#${PR_NUM}[^0-9]" | head -1 | awk '{print $1}')
fi
if [ -z "$MERGE_COMMIT" ]; then
  echo "✗ No merge commit found for PR #$PR_NUM"
  echo "  Try: gh pr view $PR_NUM --repo $REPO_FULL --json mergeCommit"
  exit 1
fi
SHORT_COMMIT=$(echo "$MERGE_COMMIT" | cut -c1-12)
echo "  Commit: $SHORT_COMMIT"

# ── Require spec to pre-exist ────────────────────────────────────────────────
SPEC_FILE="$EVALS_DIR/specs/$REPO_ID/pr-${PR_NUM}-spec.md"
if [ ! -f "$SPEC_FILE" ]; then
  echo "✗ Spec not found: $SPEC_FILE"
  echo "  Generate it first: bash scripts/eval-gen-spec.sh $EVAL_ID"
  exit 1
fi

# ── Create worktree ──────────────────────────────────────────────────────────
echo "→ Creating worktree at $WORKTREE_DIR..."
cd "$REPO_DIR"
rm -rf "$WORKTREE_DIR" 2>/dev/null || true
git worktree add "$WORKTREE_DIR" "$MERGE_COMMIT" --detach 2>/dev/null
cd "$WORKTREE_DIR"

# ── Install deps ─────────────────────────────────────────────────────────────
echo "→ Installing dependencies..."
pnpm install --frozen-lockfile 2>&1 | tail -3

# ── DB isolation ─────────────────────────────────────────────────────────────
echo "→ Creating fresh database: $DB_NAME..."
dropdb "$DB_NAME" 2>/dev/null || true
createdb "$DB_NAME"
export DATABASE_URL="postgresql://localhost:5432/$DB_NAME"

if [ -n "$MIGRATE_CMD" ]; then
  echo "  Running: $MIGRATE_CMD"
  eval "$MIGRATE_CMD" 2>&1 | tail -3 || echo "  ⚠ Migration failed (continuing)"
fi

# ── Set up .verify/ ──────────────────────────────────────────────────────────
VERIFY_DIR="$WORKTREE_DIR/.verify"
mkdir -p "$VERIFY_DIR"
cp "$SPEC_FILE" "$VERIFY_DIR/spec.md"
git show "$MERGE_COMMIT" > "$VERIFY_DIR/diff.patch" 2>/dev/null || true

cat > "$VERIFY_DIR/config.json" <<CONF
{"baseUrl":"$BASE_URL","specPath":".verify/spec.md"}
CONF
echo "$VERIFY_DIR/spec.md" > "$VERIFY_DIR/.spec_path"

# ── Run pipeline ─────────────────────────────────────────────────────────────
echo "→ Running verify pipeline..."
START_TIME=$(date +%s)

export VERIFY_BASE_URL="$BASE_URL"
export VERIFY_ALLOW_DANGEROUS=1
export VERIFY_SPEC_PATH=".verify/spec.md"

PIPELINE_OK=true

# Preflight (skip auth + spec detection — we handle those above)
bash "$SCRIPT_DIR/preflight.sh" --skip-auth --skip-spec || PIPELINE_OK=false

if [ "$PIPELINE_OK" = true ]; then
  bash "$SCRIPT_DIR/planner.sh" ".verify/spec.md" || PIPELINE_OK=false
fi

if [ "$PIPELINE_OK" = true ]; then
  bash "$SCRIPT_DIR/orchestrate.sh" || PIPELINE_OK=false
fi

if [ "$PIPELINE_OK" = true ]; then
  bash "$SCRIPT_DIR/judge.sh" || PIPELINE_OK=false
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# ── Collect artifacts ────────────────────────────────────────────────────────
echo "→ Collecting artifacts to $ARTIFACT_DIR..."
mkdir -p "$ARTIFACT_DIR"

if [ -d "$WORKTREE_DIR/.verify" ]; then
  cp -r "$WORKTREE_DIR/.verify" "$ARTIFACT_DIR/.verify"
fi
[ -f "$SPEC_FILE" ] && cp "$SPEC_FILE" "$ARTIFACT_DIR/spec.md"
[ -f "$WORKTREE_DIR/.verify/diff.patch" ] && cp "$WORKTREE_DIR/.verify/diff.patch" "$ARTIFACT_DIR/diff.patch"

# ── Score ────────────────────────────────────────────────────────────────────
SCORE="0"
ACTUAL_VERDICT="error"
if [ -f "$ARTIFACT_DIR/.verify/report.json" ]; then
  ACTUAL_VERDICT=$(jq -r '.verdict // "error"' "$ARTIFACT_DIR/.verify/report.json")
  TOTAL_ACS=$(jq '.criteria | length' "$ARTIFACT_DIR/.verify/report.json")
  PASS_ACS=$(jq '[.criteria[] | select(.status == "pass")] | length' "$ARTIFACT_DIR/.verify/report.json")
  if [ "$TOTAL_ACS" -gt 0 ]; then
    SCORE=$(awk "BEGIN {printf \"%.2f\", $PASS_ACS / $TOTAL_ACS}")
  fi
fi

# ── Write summary ────────────────────────────────────────────────────────────
cat > "$ARTIFACT_DIR/summary.json" <<SUMM
{
  "eval_id": "$EVAL_ID",
  "run_id": "$RUN_ID",
  "repo": "$REPO_ID",
  "pr": $PR_NUM,
  "prompt_version": "$PROMPT_VERSION",
  "expected_verdict": "$EXPECTED",
  "actual_verdict": "$ACTUAL_VERDICT",
  "score": $SCORE,
  "duration_seconds": $DURATION,
  "pipeline_ok": $PIPELINE_OK
}
SUMM

# ── Append to results.jsonl ──────────────────────────────────────────────────
RESULTS_FILE="$EVALS_DIR/results.jsonl"
jq -c '.' "$ARTIFACT_DIR/summary.json" >> "$RESULTS_FILE"

# ── Cleanup ──────────────────────────────────────────────────────────────────
echo "→ Cleaning up..."
cd "$REPO_DIR"
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || rm -rf "$WORKTREE_DIR"
dropdb "$DB_NAME" 2>/dev/null || true

echo "═══════════════════════════════════════════"
echo " $EVAL_ID complete: verdict=$ACTUAL_VERDICT score=$SCORE (${DURATION}s)"
echo " Artifacts: $ARTIFACT_DIR"
echo "═══════════════════════════════════════════"
```

**Step 2: Make executable and syntax check**

Run: `chmod +x scripts/eval-runner.sh && bash -n scripts/eval-runner.sh && echo "OK"`
Expected: `OK`

**Step 3: Commit**

```bash
git add scripts/eval-runner.sh
git commit -m "feat(eval): add eval-runner.sh — single PR eval execution"
```

---

### Task 7: eval-loop.sh — orchestrate across repos

**Files:**
- Create: `scripts/eval-loop.sh`

**Step 1: Create eval-loop.sh**

Sequential across repos for v1 (browse daemon can't be shared across parallel runs). Simple and matches existing patterns.

Write `scripts/eval-loop.sh`:

```bash
#!/usr/bin/env bash
# Run eval items across repos. Sequential for v1.
# Usage: eval-loop.sh [--repo calcom] [--limit 5] [--skip-existing]
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

EVAL_SET="${EVAL_SET:-docs/evals/eval-set-v2.json}"
FILTER_REPO=""
LIMIT=""
SKIP_FLAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) FILTER_REPO="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --skip-existing) SKIP_FLAG="--skip-existing"; shift ;;
    *) shift ;;
  esac
done

[ -f "$EVAL_SET" ] || { echo "✗ Eval set not found: $EVAL_SET"; exit 1; }

echo "═══════════════════════════════════════════"
echo " Eval Loop"
echo " Set:   $EVAL_SET"
[ -n "$FILTER_REPO" ] && echo " Filter: $FILTER_REPO"
[ -n "$LIMIT" ] && echo " Limit:  $LIMIT per repo"
echo "═══════════════════════════════════════════"

# ── Get repos to run ─────────────────────────────────────────────────────────
if [ -n "$FILTER_REPO" ]; then
  REPOS="$FILTER_REPO"
else
  REPOS=$(jq -r '.repos[].id' "$EVAL_SET")
fi

# ── Run sequentially ─────────────────────────────────────────────────────────
TOTAL_RUN=0
TOTAL_PASS=0

while IFS= read -r REPO; do
  [ -z "$REPO" ] && continue
  echo ""
  echo "════════════════════════════════════════"
  echo " Repo: $REPO"
  echo "════════════════════════════════════════"

  EVAL_IDS=$(jq -r --arg repo "$REPO" '[.evals[] | select(.repo == $repo) | .id] | .[]' "$EVAL_SET")
  COUNT=0

  while IFS= read -r EVAL_ID; do
    [ -z "$EVAL_ID" ] && continue
    if [ -n "$LIMIT" ] && [ "$COUNT" -ge "$LIMIT" ]; then
      break
    fi
    COUNT=$((COUNT + 1))
    TOTAL_RUN=$((TOTAL_RUN + 1))

    echo ""
    echo "[$REPO] Running $EVAL_ID ($COUNT$([ -n "$LIMIT" ] && echo "/$LIMIT"))..."
    if bash "$SCRIPT_DIR/eval-runner.sh" "$EVAL_ID" "$EVAL_SET" $SKIP_FLAG; then
      # Check if it was a pass
      LAST_VERDICT=$(tail -1 "${EVALS_DIR:-docs/evals}/results.jsonl" 2>/dev/null | jq -r '.actual_verdict // "error"' 2>/dev/null)
      [ "$LAST_VERDICT" = "pass" ] && TOTAL_PASS=$((TOTAL_PASS + 1))
    else
      echo "  ⚠ $EVAL_ID failed (continuing)"
    fi
  done <<< "$EVAL_IDS"

  echo "[$REPO] Complete."
done <<< "$REPOS"

# ── Summary ──────────────────────────────────────────────────────────────────
RESULTS_FILE="${EVALS_DIR:-docs/evals}/results.jsonl"
echo ""
echo "═══════════════════════════════════════════"
echo " Eval Loop Complete"
if [ -f "$RESULTS_FILE" ]; then
  TOTAL_ENTRIES=$(wc -l < "$RESULTS_FILE" | tr -d ' ')
  echo " Results: $RESULTS_FILE ($TOTAL_ENTRIES total entries)"
fi
echo " This run: $TOTAL_PASS / $TOTAL_RUN passed"
echo "═══════════════════════════════════════════"
```

**Step 2: Make executable and syntax check**

Run: `chmod +x scripts/eval-loop.sh && bash -n scripts/eval-loop.sh && echo "OK"`
Expected: `OK`

**Step 3: Commit**

```bash
git add scripts/eval-loop.sh
git commit -m "feat(eval): add eval-loop.sh — sequential eval orchestrator"
```

---

### Task 8: Update report.sh to display failure classifications

**Files:**
- Modify: `scripts/report.sh`

**Step 1: Add failure classification to terminal output**

In `scripts/report.sh`, find the block (around lines 15-21):

```bash
  case "$STATUS" in
    pass)    echo "  ✓ $AC_ID: $REASON" ;;
    fail)    echo "  ✗ $AC_ID: $REASON" ;;
    timeout) echo "  ⏱ $AC_ID: timed out" ;;
    error)   echo "  ⚠ $AC_ID: $REASON" ;;
    *)       echo "  ? $AC_ID: $STATUS — $REASON" ;;
  esac
```

Replace with:

```bash
  case "$STATUS" in
    pass)    echo "  ✓ $AC_ID: $REASON" ;;
    fail)    echo "  ✗ $AC_ID: $REASON" ;;
    timeout) echo "  ⏱ $AC_ID: timed out" ;;
    error)   echo "  ⚠ $AC_ID: $REASON" ;;
    *)       echo "  ? $AC_ID: $STATUS — $REASON" ;;
  esac
  # Failure classification (from judge prompt)
  FAIL_CLASS=$(echo "$criterion" | jq -r '.failure_class // empty')
  FAIL_CONFIDENCE=$(echo "$criterion" | jq -r '.confidence // empty')
  if [ -n "$FAIL_CLASS" ]; then
    echo "     class: $FAIL_CLASS ($FAIL_CONFIDENCE)"
  fi
```

**Step 2: Add failure class column to HTML report**

In the Python HTML generator section, after the `cr_cell` variable definition (around line 124), add:

```python
    # Failure classification
    fc = c.get("failure_class", "")
    fc_conf = c.get("confidence", "")
    if fc == "app_bug":
        fc_badge = f'<span style="color:#ef4444;font-weight:600">app_bug</span>'
    elif fc == "pipeline_noise":
        fc_badge = f'<span style="color:#f59e0b;font-weight:600">pipeline_noise</span>'
    elif fc == "insufficient_evidence":
        fc_badge = f'<span style="color:#64748b;font-weight:600">insufficient</span>'
    elif fc:
        fc_badge = f'<span style="color:#94a3b8">{_html.escape(fc)}</span>'
    else:
        fc_badge = '<span style="color:#334155">&mdash;</span>'
    if fc_conf:
        fc_badge += f'<div style="font-size:0.75em;color:#64748b;margin-top:2px">{_html.escape(fc_conf)}</div>'
    fc_cell = f'<td style="padding:12px 16px">{fc_badge}</td>'
```

In the row template (`rows += f"""...`), add `{fc_cell}` after `{cr_cell}`.

In the `<thead>` section, add `<th>Failure Class</th>` after `<th>Code Review</th>`.

Update the skipped_rows `colspan` from `"6"` to `"7"`.

**Step 3: Verify syntax**

Run: `bash -n scripts/report.sh && echo "syntax OK"`
Expected: `syntax OK`

**Step 4: Commit**

```bash
git add scripts/report.sh
git commit -m "feat(eval): display failure classifications in terminal and HTML report"
```

---

### Task 9: Smoke test — run eval-runner on one eval item

**Step 1: Verify prerequisites**

```bash
# Repo cloned?
test -d ~/Projects/opslane/evals/calcom/.git && echo "repo OK"

# Dev server running on port 3001?
curl -sf --max-time 5 http://localhost:3001 > /dev/null && echo "server OK"

# gh CLI authenticated?
gh auth status 2>&1 | head -1

# Eval set valid?
jq '.evals[0].id' docs/evals/eval-set-v2.json
```

**Step 2: Generate a spec for one eval item**

```bash
bash scripts/eval-gen-spec.sh eval-004 docs/evals/eval-set-v2.json
cat docs/evals/specs/calcom/pr-28080-spec.md
```

Review the generated spec. If it looks reasonable, proceed.

**Step 3: Run eval-runner for one item**

```bash
VERIFY_ALLOW_DANGEROUS=1 bash scripts/eval-runner.sh eval-004 docs/evals/eval-set-v2.json
```

**Step 4: Verify artifacts were collected**

```bash
# Artifact directory exists?
ls docs/evals/runs/eval-004/*/

# Summary has score?
cat docs/evals/runs/eval-004/*/summary.json | jq '{verdict: .actual_verdict, score, duration: .duration_seconds}'

# Results JSONL has an entry?
cat docs/evals/results.jsonl

# Report has failure_class?
jq '.criteria[] | {ac_id, status, failure_class, confidence}' docs/evals/runs/eval-004/*/.verify/report.json
```

**Step 5: If it works, commit any fixes made during smoke test**

```bash
git add -A
git commit -m "fix(eval): fixes from smoke test run"
```

---

## Execution Order

| Task | Description | Dependencies | Est. time |
|------|-------------|-------------|-----------|
| 1 | Judge prompt upgrade | None | 2 min |
| 2 | Add migrate_cmd to eval set | None | 2 min |
| 3 | Fix gitignore | None | 2 min |
| 4 | Spec generation script + prompt | None | 3 min |
| 5 | Specs directory with v1 specs | Task 3 | 2 min |
| 6 | eval-runner.sh | Tasks 1, 2, 3, 4, 5 | 5 min |
| 7 | eval-loop.sh | Task 6 | 3 min |
| 8 | report.sh update | Task 1 | 5 min |
| 9 | Smoke test | All above | 10 min |

Tasks 1, 2, 3, 4 can run in parallel. Task 5 depends on 3. Tasks 6-7 are sequential. Task 8 is independent of 6-7. Task 9 is the integration test.
