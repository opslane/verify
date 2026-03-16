#!/usr/bin/env bash
# No set -e: individual agent failures must not kill the loop — each agent
# writes its own verdict (pass/fail/timeout/error) and the judge evaluates them.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_BIN="${AGENT_BIN:-$SCRIPT_DIR/agent.sh}"

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

# ── Run global setup commands ─────────────────────────────────────────────────
SETUP_COUNT=$(jq '.setup // [] | length' .verify/plan.json 2>/dev/null || echo 0)
if [ "$SETUP_COUNT" -gt 0 ]; then
  echo "→ Running $SETUP_COUNT global setup command(s)..."
  jq -r '.setup[]' .verify/plan.json | while IFS= read -r cmd; do
    echo "  → $cmd"
    echo "  ⚡ Running: $cmd"
    eval "$cmd" 2>&1 | sed 's/^/    /' || echo "  ⚠ Setup command failed (continuing)"
  done
fi

echo "→ Running $COUNT browser agent(s)..."

# Default sequential: avoids Playwright MCP port/video contention on shared machines
if [ "${VERIFY_SEQUENTIAL:-1}" = "1" ]; then
  echo "  Mode: sequential"
  BROWSE_BIN="${BROWSE_BIN:-$HOME/.cache/verify/browse}"
  DONE=0
  for AC_ID in "${AC_IDS[@]}"; do
    DONE=$((DONE + 1))
    # Reset page state between ACs (navigate to blank page) — preserves cookies
    if [ "${VERIFY_ENGINE:-browse}" = "browse" ] && [ "$DONE" -gt 1 ]; then
      "$BROWSE_BIN" goto "about:blank" >/dev/null 2>&1 || true
    fi
    # Per-AC timeout from plan.json, fallback to AGENT_TIMEOUT or 120s
    # Minimum 90s — Claude startup + prompt processing + browse overhead needs headroom
    AC_TIMEOUT=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .timeout_seconds // empty' .verify/plan.json 2>/dev/null)
    AC_TIMEOUT="${AC_TIMEOUT:-${AGENT_TIMEOUT:-120}}"
    [ "$AC_TIMEOUT" -lt 90 ] 2>/dev/null && AC_TIMEOUT=90
    echo "  [$DONE/$COUNT] Starting $AC_ID (timeout: ${AC_TIMEOUT}s)..."
    "$AGENT_BIN" "$AC_ID" "$AC_TIMEOUT" || echo "  ⚠ $AC_ID: agent exited with error (continuing)"
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
