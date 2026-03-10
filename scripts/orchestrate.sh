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

if [ "${VERIFY_SEQUENTIAL:-0}" = "1" ]; then
  echo "  Mode: sequential"
  for AC_ID in "${AC_IDS[@]}"; do
    "$AGENT_BIN" "$AC_ID" "${AGENT_TIMEOUT:-90}"
  done
else
  # Parallel background jobs — each agent gets its own claude -p + Playwright server + video
  echo "  Mode: parallel (background jobs)"
  PIDS=()
  for AC_ID in "${AC_IDS[@]}"; do
    mkdir -p ".verify/evidence/$AC_ID"
    "$AGENT_BIN" "$AC_ID" "${AGENT_TIMEOUT:-90}" > ".verify/evidence/$AC_ID/orchestrate.log" 2>&1 &
    PIDS+=($!)
    echo "  → spawned $AC_ID (pid $!)"
  done

  # Kill all agents if orchestrate.sh is interrupted
  trap 'echo "→ interrupted, stopping agents..."; kill "${PIDS[@]}" 2>/dev/null; wait; exit 130' INT TERM

  # Wait for all agents and stream their logs
  FAILED=0
  for i in "${!PIDS[@]}"; do
    AC_ID="${AC_IDS[$i]}"
    wait "${PIDS[$i]}" || FAILED=$((FAILED + 1))
    cat ".verify/evidence/$AC_ID/orchestrate.log"
  done
  [ "$FAILED" -gt 0 ] && echo "  ⚠ $FAILED agent(s) exited with errors"
fi

echo "✓ All agents complete"
