#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs claude with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

MODEL="${VERIFY_CODE_REVIEW_MODEL:-opus}"
echo "→ Running Code Review ($MODEL)..."

# ── Diff base detection ───────────────────────────────────────────────────────
# Priority: env var > config.json > auto-detect
DIFF_BASE="${VERIFY_DIFF_BASE:-$(jq -r '.diffBase // empty' .verify/config.json 2>/dev/null || echo "")}"

if [ -z "$DIFF_BASE" ]; then
  if git rev-parse --verify main >/dev/null 2>&1; then
    DIFF_BASE="main"
  elif git rev-parse --verify master >/dev/null 2>&1; then
    DIFF_BASE="master"
  else
    DIFF_BASE="HEAD~1"
  fi
fi
echo "  Diff base: $DIFF_BASE"

# ── Capture diff ──────────────────────────────────────────────────────────────
# Exclude binary files, lockfiles, and common non-code assets
DIFF_EXCLUDES=(-- . ':!*.png' ':!*.jpg' ':!*.jpeg' ':!*.gif' ':!*.webm' ':!*.webp' ':!*.ico' ':!*.woff' ':!*.woff2' ':!*.ttf' ':!*.eot' ':!*.svg' ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml')

# Try branch diff first, then fall back to staged+unstaged changes
FULL_DIFF=$(git diff --no-ext-diff "$DIFF_BASE"...HEAD "${DIFF_EXCLUDES[@]}" 2>/dev/null || echo "")

# If branch diff is empty (e.g. running on main), try uncommitted changes
if [ -z "$FULL_DIFF" ]; then
  echo "  No branch diff — checking uncommitted changes..."
  FULL_DIFF=$(git diff --no-ext-diff HEAD "${DIFF_EXCLUDES[@]}" 2>/dev/null || echo "")
fi

# If still empty, try the PR commit from the spec (planner already extracted it)
if [ -z "$FULL_DIFF" ]; then
  PR_COMMIT=$(jq -r '.pr_commit // empty' .verify/plan.json 2>/dev/null || echo "")
  if [ -n "$PR_COMMIT" ]; then
    echo "  No local diff — using PR commit $PR_COMMIT..."
    FULL_DIFF=$(git show --no-ext-diff "$PR_COMMIT" "${DIFF_EXCLUDES[@]}" 2>/dev/null || echo "")
  fi
fi

DIFF_STAT=$(git diff --stat "$DIFF_BASE"...HEAD "${DIFF_EXCLUDES[@]}" 2>/dev/null || \
  git diff --stat HEAD "${DIFF_EXCLUDES[@]}" 2>/dev/null || echo "No diff stats available")

if [ -z "$FULL_DIFF" ]; then
  echo "  No code changes found against $DIFF_BASE"
  # Write empty result — not an error, just nothing to review
  echo '{"findings":[],"ac_coverage":[]}' | jq '.' > .verify/code-review.json
  echo "✓ Code review complete: no changes to review"
  exit 0
fi

# ── Diff size check ───────────────────────────────────────────────────────────
MAX_LINES="${VERIFY_DIFF_MAX_LINES:-8000}"
LINE_COUNT=$(echo "$FULL_DIFF" | wc -l | tr -d ' ')
TRUNCATED=""

if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
  echo "  ⚠ Diff is $LINE_COUNT lines — truncating to $MAX_LINES"
  FULL_DIFF=$(echo "$FULL_DIFF" | head -"$MAX_LINES")
  TRUNCATED="NOTE: Diff truncated at $MAX_LINES lines (original: $LINE_COUNT lines). Coverage assessment may be incomplete for files not shown."
fi

echo "  Diff size: $LINE_COUNT lines"

# ── Extract ACs ───────────────────────────────────────────────────────────────
ACS=$(jq -r '.criteria[] | "- \(.id): \(.description)"' .verify/plan.json)

# ── Build prompt ──────────────────────────────────────────────────────────────
PROMPT_FILE=".verify/code-review-prompt.txt"
{
  cat "$SCRIPT_DIR/prompts/code-review.txt"
  printf "\n\n---\nACCEPTANCE CRITERIA:\n%s\n" "$ACS"
  printf "\nGIT DIFF STAT:\n%s\n" "$DIFF_STAT"
  printf "\nGIT DIFF:\n\`\`\`diff\n%s\n\`\`\`\n" "$FULL_DIFF"
  if [ -n "$TRUNCATED" ]; then
    printf "\n%s\n" "$TRUNCATED"
  fi
} > "$PROMPT_FILE"

# ── Call Claude ───────────────────────────────────────────────────────────────
RAW=$("$CLAUDE" -p \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  < "$PROMPT_FILE" 2>/dev/null)

# Strip markdown fences if model ignores the instruction
REVIEW_JSON=$(echo "$RAW" | sed '/^```/d' | tr -d '\r')

# Validate JSON
if ! echo "$REVIEW_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Code review returned invalid JSON:"
  echo "$REVIEW_JSON" | head -20
  exit 1
fi

echo "$REVIEW_JSON" | jq '.' > .verify/code-review.json

FINDING_COUNT=$(jq '.findings | length' .verify/code-review.json)
BLOCKER_COUNT=$(jq '[.findings[] | select(.severity == "blocker")] | length' .verify/code-review.json)
echo "✓ Code review complete: $FINDING_COUNT findings ($BLOCKER_COUNT blockers)"
