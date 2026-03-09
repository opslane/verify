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

# Write prompt to file — avoids ARG_MAX limits
PROMPT_FILE=".verify/planner-prompt.txt"
{
  cat "$SCRIPT_DIR/prompts/planner.txt"
  printf "\n\n---\nBASE URL: %s\n\nSPEC DOC (%s):\n" "${VERIFY_BASE_URL}" "${SPEC_PATH}"
  cat "$SPEC_PATH"
} > "$PROMPT_FILE"

# Call Opus — read prompt from file
RAW=$("$CLAUDE" -p --model opus --dangerously-skip-permissions < "$PROMPT_FILE")

# Strip markdown fences if model ignores the instruction
PLAN_JSON=$(echo "$RAW" | sed '/^```/d' | sed '/^$/d' | tr -d '\r')

# Validate JSON
if ! echo "$PLAN_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Planner returned invalid JSON:"
  echo "$PLAN_JSON" | head -20
  exit 1
fi

echo "$PLAN_JSON" | jq '.' > .verify/plan.json

# Print skipped
SKIPPED_COUNT=$(jq '.skipped | length' .verify/plan.json)
if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  jq -r '.skipped[]' .verify/plan.json | while IFS= read -r msg; do
    echo "  ⚠ Skipped: $msg"
  done
fi

CRITERIA_COUNT=$(jq '.criteria | length' .verify/plan.json)
echo "✓ Planner complete: $CRITERIA_COUNT criteria, $SKIPPED_COUNT skipped → .verify/plan.json"
