#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_BIN="${AGENT_BIN:-$SCRIPT_DIR/agent.sh}"
CLAUDE="${CLAUDE_BIN:-claude}"

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs agents with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

# Read all AC IDs (compatible with bash 3 on macOS — no mapfile)
AC_IDS=()
while IFS= read -r line; do
  AC_IDS+=("$line")
done < <(jq -r '.criteria[].id' .verify/plan.json)
COUNT=${#AC_IDS[@]}
echo "→ Running $COUNT browser agent(s)..."

# Default sequential: avoids Playwright MCP port/video contention on shared machines
if [ "${VERIFY_SEQUENTIAL:-1}" = "1" ]; then
  echo "  Mode: sequential"
  for AC_ID in "${AC_IDS[@]}"; do
    "$AGENT_BIN" "$AC_ID" "${AGENT_TIMEOUT:-240}"
  done
else
  # Parallel background jobs — each agent gets its own claude -p + Playwright server + video
  echo "  Mode: parallel (background jobs)"
  PIDS=()
  for AC_ID in "${AC_IDS[@]}"; do
    mkdir -p ".verify/evidence/$AC_ID"
    "$AGENT_BIN" "$AC_ID" "${AGENT_TIMEOUT:-240}" > ".verify/evidence/$AC_ID/orchestrate.log" 2>&1 &
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
