#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs claude with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

SPEC_PATH="${1:-$(cat .verify/.spec_path 2>/dev/null)}"
[ -n "$SPEC_PATH" ] && [ -f "$SPEC_PATH" ] || { echo "✗ Spec doc not found: $SPEC_PATH"; exit 1; }

VERIFY_BASE_URL="${VERIFY_BASE_URL:-$(jq -r '.baseUrl // "http://localhost:3000"' .verify/config.json 2>/dev/null)}"

echo "→ Running Planner (Opus)..."
echo "  Spec: $SPEC_PATH"

mkdir -p .verify

# ── Code context gathering ────────────────────────────────────────────────────
# Try to find the PR number from the spec and pull the git diff + changed files.
# This gives the LLM ground truth about what actually changed.

CODE_CONTEXT=""

# Extract PR number from spec (looks for #NNNNN or /pull/NNNNN)
PR_NUM=$(grep -oE '#[0-9]{4,6}|/pull/[0-9]{4,6}' "$SPEC_PATH" 2>/dev/null | grep -oE '[0-9]{4,6}' | head -1)

if [ -n "$PR_NUM" ]; then
  echo "  Found PR #$PR_NUM — searching git log for merge commit..."
  COMMIT=$(git log --all --format="%H %s" 2>/dev/null | grep -i "#${PR_NUM}\b" | head -1 | awk '{print $1}')

  if [ -n "$COMMIT" ]; then
    echo "  Commit: ${COMMIT:0:12}"
    DIFF=$(git show "$COMMIT" 2>/dev/null | head -300)
    CHANGED_FILES=$(git show --name-only --format="" "$COMMIT" 2>/dev/null | grep -E '\.(tsx?|jsx?|css|scss)$' | head -10)

    CODE_CONTEXT="$(printf '\n\n---\nCODE CHANGE (git diff for PR #%s, commit %s):\n```diff\n%s\n```' "$PR_NUM" "${COMMIT:0:12}" "$DIFF")"

    # Read changed component files (up to 3, capped at 150 lines each)
    FILE_CONTENT=""
    COUNT=0
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      [ $COUNT -ge 3 ] && break
      FILE_CONTENT="${FILE_CONTENT}$(printf '\n\n--- FILE: %s ---\n' "$f")$(head -150 "$f")"
      COUNT=$((COUNT + 1))
    done <<< "$CHANGED_FILES"

    if [ -n "$FILE_CONTENT" ]; then
      CODE_CONTEXT="${CODE_CONTEXT}$(printf '\n\nCHANGED COMPONENT FILES (current state):%s' "$FILE_CONTENT")"
    fi
  else
    echo "  No commit found for PR #$PR_NUM — proceeding with spec only"
  fi
else
  echo "  No PR number found in spec — proceeding with spec only"
fi

# ── Build prompt ──────────────────────────────────────────────────────────────
PROMPT_FILE=".verify/planner-prompt.txt"
{
  cat "$SCRIPT_DIR/prompts/planner.txt"
  printf "\n\n---\nBASE URL: %s\n\nSPEC DOC (%s):\n" "${VERIFY_BASE_URL}" "${SPEC_PATH}"
  cat "$SPEC_PATH"
  printf "%s" "$CODE_CONTEXT"
} > "$PROMPT_FILE"

# ── Call Opus ─────────────────────────────────────────────────────────────────
RAW=$("$CLAUDE" -p --model opus --dangerously-skip-permissions < "$PROMPT_FILE")

# Strip markdown fences if model ignores the instruction
PLAN_JSON=$(echo "$RAW" | sed '/^```/d' | tr -d '\r')

# Validate JSON
if ! echo "$PLAN_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Planner returned invalid JSON:"
  echo "$PLAN_JSON" | head -20
  exit 1
fi

echo "$PLAN_JSON" | jq '.' > .verify/plan.json

# ── Print results ─────────────────────────────────────────────────────────────
SKIPPED_COUNT=$(jq '.skipped | length' .verify/plan.json)
CONDITIONAL_COUNT=$(jq '[.criteria[] | select(.testability == "conditional")] | length' .verify/plan.json 2>/dev/null || echo 0)
CRITERIA_COUNT=$(jq '.criteria | length' .verify/plan.json)

if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  jq -r '.skipped[]' .verify/plan.json | while IFS= read -r msg; do
    echo "  ⚠ Skipped: $msg"
  done
fi

echo "✓ Planner complete: $CRITERIA_COUNT criteria ($CONDITIONAL_COUNT conditional), $SKIPPED_COUNT skipped → .verify/plan.json"
