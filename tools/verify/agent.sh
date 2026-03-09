#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

AC_ID="$1"
TIMEOUT_SECS="${2:-90}"

[ -n "$AC_ID" ] || { echo "Usage: $0 <ac_id> [timeout_secs]"; exit 1; }
[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

# Detect timeout command (macOS: gtimeout from coreutils; Linux: timeout)
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  echo "✗ timeout not found. Install: brew install coreutils"
  exit 1
fi

VERIFY_BASE_URL="${VERIFY_BASE_URL:-$(jq -r '.baseUrl // "http://localhost:3000"' .verify/config.json 2>/dev/null)}"

# Extract AC data
AC_JSON=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id == $id)' .verify/plan.json)
[ -n "$AC_JSON" ] || { echo "✗ AC '$AC_ID' not found in plan.json"; exit 1; }

AC_DESC=$(echo "$AC_JSON" | jq -r '.description')
AC_URL=$(echo "$AC_JSON" | jq -r '.url')
STEPS=$(echo "$AC_JSON" | jq -r '.steps[]' | nl -ba)
SCREENSHOTS=$(echo "$AC_JSON" | jq -r '.screenshot_at | join(", ")')

# Build agent prompt inline (no separate build_agent_prompt.sh)
# Use sed with global replacement so all REPLACE_AC_ID occurrences are substituted
PROMPT=$(sed \
  -e "s|REPLACE_AC_DESCRIPTION|$AC_DESC|g" \
  -e "s|REPLACE_AC_ID|$AC_ID|g" \
  -e "s|REPLACE_BASE_URL|${VERIFY_BASE_URL}${AC_URL}|g" \
  -e "s|REPLACE_SCREENSHOT_AT|$SCREENSHOTS|g" \
  "$SCRIPT_DIR/prompts/agent.txt")
# Steps may be multi-line — pass via env var to avoid shell injection
PROMPT=$(echo "$PROMPT" | REPLACE_STEPS_VAL="$STEPS" python3 -c "
import sys, os
content = sys.stdin.read()
steps = os.environ['REPLACE_STEPS_VAL']
print(content.replace('REPLACE_STEPS', steps))
")

mkdir -p ".verify/evidence/$AC_ID" ".verify/prompts"
echo "$PROMPT" > ".verify/prompts/${AC_ID}-agent.txt"

# Playwright MCP config — write to temp file (--mcp-config expects a path)
MCP_CONFIG_FILE=$(mktemp /tmp/verify-mcp-XXXXXX.json)
jq -n '{
  mcpServers: {
    playwright: {
      command: "npx",
      args: [
        "@playwright/mcp@latest",
        "--save-video=1280x720",
        "--caps", "vision",
        "--storage-state", ".verify/auth.json",
        "--save-trace"
      ]
    }
  }
}' > "$MCP_CONFIG_FILE"
# shellcheck disable=SC2064
trap "rm -f '$MCP_CONFIG_FILE'" EXIT

echo "  → Agent $AC_ID (timeout: ${TIMEOUT_SECS}s)..."

set +e
$TIMEOUT_CMD "$TIMEOUT_SECS" "$CLAUDE" -p \
  --model sonnet \
  --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG_FILE" \
  "$PROMPT" > ".verify/evidence/$AC_ID/claude.log" 2>&1
EXIT_CODE=$?
set -e

LOG_FILE=".verify/evidence/$AC_ID/agent.log"

if [ $EXIT_CODE -eq 124 ]; then
  printf "VERDICT: timeout\nREASONING: Agent exceeded ${TIMEOUT_SECS}s\nSTEPS_COMPLETED: unknown\n" > "$LOG_FILE"
  echo "  ⏱ $AC_ID: timeout"
elif [ $EXIT_CODE -ne 0 ]; then
  printf "VERDICT: error\nREASONING: Agent exited with code $EXIT_CODE\nSTEPS_COMPLETED: 0/unknown\n" > "$LOG_FILE"
  echo "  ✗ $AC_ID: error (exit $EXIT_CODE)"
else
  if [ ! -f "$LOG_FILE" ]; then
    grep -A2 "^VERDICT:" ".verify/evidence/$AC_ID/claude.log" > "$LOG_FILE" 2>/dev/null || \
      printf "VERDICT: error\nREASONING: Agent did not write agent.log\nSTEPS_COMPLETED: unknown\n" > "$LOG_FILE"
  fi
  VERDICT=$(grep "^VERDICT:" "$LOG_FILE" | awk '{print $2}')
  echo "  ✓ $AC_ID: done (verdict: $VERDICT)"
fi
