#!/usr/bin/env bash
# Second-opinion review of the criteria. Codex when installed (different
# vendor, different blind spots); otherwise a fresh `claude -p` call that
# receives ONLY the spec and the plan — nothing from the drafting session.
# Fallback chain: codex -> fresh claude -> unavailable (loud, never fatal).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs claude with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi
CODEX="${CODEX_BIN:-codex}"
CLAUDE="${CLAUDE_BIN:-claude}"
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi
[ -f .verify/plan.json ] || { echo "✗ .verify/plan.json not found"; exit 1; }
SPEC_PATH=$(cat .verify/.spec_path 2>/dev/null || echo "")

PROMPT_FILE=".verify/reviewer-prompt.txt"
{
  cat "$SCRIPT_DIR/prompts/reviewer.txt"
  printf "\n\nTHE SPEC:\n"
  [ -f "$SPEC_PATH" ] && cat "$SPEC_PATH" || echo "(no spec file)"
  printf "\n\nTHE CRITERIA:\n"
  cat .verify/plan.json
} > "$PROMPT_FILE"

valid_review() { # $1 = json string; every plan id covered, enums correct
  echo "$1" | jq -e --slurpfile plan .verify/plan.json '
    (.criteria | type == "array") and (.missing | type == "array") and
    (($plan[0].criteria | map(.id) | sort) == (.criteria | map(.id) | sort)) and
    ([.criteria[] | .keep | IN("load-bearing","redundant","unreachable")] | all) and
    ([.criteria[] | .codify | type == "boolean"] | all)' > /dev/null 2>&1
}

accept() { # $1 = name, $2 = raw output
  local clean
  clean=$(echo "$2" | sed '/^```/d' | tr -d '\r')
  valid_review "$clean" || return 1
  echo "$clean" | jq --arg r "$1" '. + {reviewer: $r}' > .verify/review.json
}

RAW=""
DONE=0
if command -v "$CODEX" > /dev/null 2>&1; then
  # codex exec reads the prompt from stdin when given "-"
  RAW=$("$TIMEOUT_CMD" 300 "$CODEX" exec -s read-only - < "$PROMPT_FILE" 2>/dev/null) || RAW=""
  [ -n "$RAW" ] && accept "codex" "$RAW" && DONE=1
fi
if [ "$DONE" = "0" ]; then
  RAW=$("$TIMEOUT_CMD" 300 "$CLAUDE" -p --model opus --dangerously-skip-permissions < "$PROMPT_FILE" 2>/dev/null) || RAW=""
  [ -n "$RAW" ] && accept "fresh-claude" "$RAW" && DONE=1
fi
if [ "$DONE" = "0" ]; then
  echo "⚠ NO SECOND OPINION AVAILABLE — criteria were reviewed only by the model that wrote them."
  jq -n '{reviewer: "unavailable", criteria: [], missing: []}' > .verify/review.json
  exit 0
fi

echo "✓ Second opinion ($(jq -r '.reviewer' .verify/review.json)) → .verify/review.json"
jq -r '.criteria[] | "  \(.id): \(.keep) — \(.why)"' .verify/review.json
jq -r '.missing[]? | "  missing: \(.)"' .verify/review.json
