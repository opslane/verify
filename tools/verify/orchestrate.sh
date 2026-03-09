#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_BIN="${AGENT_BIN:-$SCRIPT_DIR/agent.sh}"
CLAUDE="${CLAUDE_BIN:-claude}"

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

# Read all AC IDs (compatible with bash 3 on macOS — no mapfile)
AC_IDS=()
while IFS= read -r line; do
  AC_IDS+=("$line")
done < <(jq -r '.criteria[].id' .verify/plan.json)
COUNT=${#AC_IDS[@]}
echo "→ Running $COUNT browser agent(s)..."

if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" = "1" ]; then
  echo "  Mode: parallel (agent teams)"

  # Build --agents JSON safely using jq (not string concatenation)
  # Start with empty object, add each agent
  AGENTS_JSON='{}'
  for AC_ID in "${AC_IDS[@]}"; do
    AC_DESC=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .description' .verify/plan.json)
    # Pre-build the prompt file
    mkdir -p ".verify/prompts"
    # Run agent in dry-run to get the prompt without executing
    PROMPT_FILE=".verify/prompts/${AC_ID}-agent.txt"
    # Build prompt directly (same logic as agent.sh)
    AC_JSON=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id == $id)' .verify/plan.json)
    AC_URL=$(echo "$AC_JSON" | jq -r '.url')
    VERIFY_BASE_URL=$(jq -r '.baseUrl // "http://localhost:3000"' .verify/config.json 2>/dev/null)
    STEPS=$(echo "$AC_JSON" | jq -r '.steps[]' | nl -ba)
    SCREENSHOTS=$(echo "$AC_JSON" | jq -r '.screenshot_at | join(", ")')

    sed \
      -e "s|REPLACE_AC_DESCRIPTION|$AC_DESC|g" \
      -e "s|REPLACE_AC_ID|$AC_ID|g" \
      -e "s|REPLACE_BASE_URL|${VERIFY_BASE_URL}${AC_URL}|g" \
      -e "s|REPLACE_SCREENSHOT_AT|$SCREENSHOTS|g" \
      "$SCRIPT_DIR/prompts/agent.txt" | REPLACE_STEPS_VAL="$STEPS" python3 -c "
import sys, os
content = sys.stdin.read()
steps = os.environ['REPLACE_STEPS_VAL']
print(content.replace('REPLACE_STEPS', steps))
" > "$PROMPT_FILE"

    # Add to agents JSON using jq to ensure valid JSON encoding
    AGENTS_JSON=$(jq \
      --arg key "${AC_ID}_agent" \
      --arg desc "Verify: $AC_DESC" \
      --arg prompt "$(cat "$PROMPT_FILE")" \
      '.[$key] = {"description": $desc, "prompt": $prompt}' \
      <<< "$AGENTS_JSON")
  done

  # Write MCP config to temp file (--mcp-config expects a path)
  # Use PID-based name — avoids mktemp suffix randomization issues on macOS
  MCP_CONFIG_FILE="/tmp/verify-mcp-$$.json"
  rm -f "$MCP_CONFIG_FILE"
  echo '{"mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest","--save-video=1280x720","--caps","vision","--storage-state",".verify/auth.json","--save-trace"]}}}' > "$MCP_CONFIG_FILE"
  # shellcheck disable=SC2064
  trap "rm -f '$MCP_CONFIG_FILE'" EXIT

  "$CLAUDE" -p \
    --model sonnet \
    --dangerously-skip-permissions \
    --mcp-config "$MCP_CONFIG_FILE" \
    --agents "$AGENTS_JSON" \
    "Run all browser verification agents. Each agent verifies one acceptance criterion and writes its verdict to .verify/evidence/<ac_id>/agent.log" \
    2>&1 | tee .verify/orchestrate.log

else
  echo "  Mode: sequential"
  for AC_ID in "${AC_IDS[@]}"; do
    "$AGENT_BIN" "$AC_ID" "${AGENT_TIMEOUT:-90}"
  done
fi

echo "✓ All agents complete"
