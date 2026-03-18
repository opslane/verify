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

# Validate and enforce minimum timeout (90s). Claude startup + prompt processing
# + browse overhead needs headroom; planners often underestimate.
_safe_timeout() {
  local val="$1"
  local fallback="${2:-120}"
  case "$val" in
    ''|*[!0-9]*) val="$fallback" ;;  # non-numeric → fallback
  esac
  [ "$val" -lt 90 ] && val=90
  echo "$val"
}

# Read all AC IDs (compatible with bash 3 on macOS — no mapfile)
AC_IDS=()
while IFS= read -r line; do
  AC_IDS+=("$line")
done < <(jq -r '.criteria[].id' .verify/plan.json)
COUNT=${#AC_IDS[@]}

# ── Sanitize plan.json URLs ───────────────────────────────────────────────────
# Planners sometimes write full URLs (http://host:port/path) in the url field.
# agent.sh prepends $VERIFY_BASE_URL, producing doubled URLs. Strip to relative.
if jq -e '.criteria[]? | select(.url | test("^https?://"))' .verify/plan.json >/dev/null 2>&1; then
  echo "→ Sanitizing absolute URLs in plan.json to relative paths..."
  jq '(.criteria[]?.url) |= sub("^https?://[^/]+";"")' .verify/plan.json > .verify/plan.json.tmp \
    && mv .verify/plan.json.tmp .verify/plan.json
fi

# ── Auto-skip ACs that require external services ─────────────────────────────
# Defense in depth: planners should put these in "skipped", but sometimes don't.
_EXTERNAL_PATTERN="stripe|paypal|payment.gateway|external.oauth|email.delivery|sendgrid|mailgun|twilio"
SKIP_IDS=()
while IFS= read -r line; do
  ac_id=$(echo "$line" | jq -r '.id')
  ac_desc=$(echo "$line" | jq -r '.description')
  ac_steps=$(echo "$line" | jq -r '.steps[]' 2>/dev/null | tr '\n' ' ')
  combined="$ac_desc $ac_steps"
  if echo "$combined" | grep -qiE "$_EXTERNAL_PATTERN"; then
    echo "→ Auto-skipping $ac_id: requires external service"
    mkdir -p ".verify/evidence/$ac_id"
    printf "VERDICT: skipped\nREASONING: Auto-skipped — requires external service (matched: %s)\nSTEPS_COMPLETED: 0\n" \
      "$(echo "$combined" | grep -oiE "$_EXTERNAL_PATTERN" | head -1)" > ".verify/evidence/$ac_id/agent.log"
    SKIP_IDS+=("$ac_id")
  fi
done < <(jq -c '.criteria[]' .verify/plan.json)

# ── Run global setup commands ─────────────────────────────────────────────────
# Process substitution (not pipe) so source/export persist in current shell.
SETUP_COUNT=$(jq '.setup // [] | length' .verify/plan.json 2>/dev/null || echo 0)
if [ "$SETUP_COUNT" -gt 0 ]; then
  echo "→ Running $SETUP_COUNT global setup command(s)..."
  while IFS= read -r cmd; do
    echo "  → $cmd"
    echo "  ⚡ Running: $cmd"
    # eval directly in current shell — no pipe, no $(), so source/export persist.
    # Redirect output to a temp file to avoid subshell.
    _setup_log=$(mktemp "${TMPDIR:-/tmp}/verify-setup-XXXXXX")
    eval "$cmd" > "$_setup_log" 2>&1 || echo "  ⚠ Setup command failed (continuing)"
    [ -s "$_setup_log" ] && sed 's/^/    /' "$_setup_log"
    rm -f "$_setup_log"
  done < <(jq -r '.setup[]' .verify/plan.json)
fi

echo "→ Running $COUNT browser agent(s)..."

# Default sequential: avoids Playwright MCP port/video contention on shared machines
if [ "${VERIFY_SEQUENTIAL:-1}" = "1" ]; then
  echo "  Mode: sequential"
  BROWSE_BIN="${BROWSE_BIN:-$HOME/.cache/verify/browse}"
  DONE=0
  for AC_ID in "${AC_IDS[@]}"; do
    DONE=$((DONE + 1))
    # Skip ACs already marked (external-service auto-skip)
    _is_skipped=false
    for _sid in "${SKIP_IDS[@]}"; do [ "$_sid" = "$AC_ID" ] && _is_skipped=true; done
    if [ "$_is_skipped" = true ]; then
      echo "  [$DONE/$COUNT] Skipping $AC_ID (external service)"
      continue
    fi
    # Reset page state between ACs (navigate to blank page) — preserves cookies
    if [ "${VERIFY_ENGINE:-browse}" = "browse" ] && [ "$DONE" -gt 1 ]; then
      "$BROWSE_BIN" goto "about:blank" >/dev/null 2>&1 || true
    fi
    # Per-AC timeout from plan.json, fallback to AGENT_TIMEOUT or 120s, minimum 90s
    AC_TIMEOUT=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .timeout_seconds // empty' .verify/plan.json 2>/dev/null)
    AC_TIMEOUT=$(_safe_timeout "${AC_TIMEOUT:-${AGENT_TIMEOUT:-120}}")
    echo "  [$DONE/$COUNT] Starting $AC_ID (timeout: ${AC_TIMEOUT}s)..."
    "$AGENT_BIN" "$AC_ID" "$AC_TIMEOUT" || echo "  ⚠ $AC_ID: agent exited with error (continuing)"
  done
else
  # Parallel background jobs — each agent gets its own claude -p + Playwright server + video
  echo "  Mode: parallel (background jobs)"
  PIDS=()
  for AC_ID in "${AC_IDS[@]}"; do
    # Skip ACs already marked (external-service auto-skip)
    _is_skipped=false
    for _sid in "${SKIP_IDS[@]}"; do [ "$_sid" = "$AC_ID" ] && _is_skipped=true; done
    if [ "$_is_skipped" = true ]; then
      echo "  → skipped $AC_ID (external service)"
      continue
    fi
    mkdir -p ".verify/evidence/$AC_ID"
    AC_TIMEOUT=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .timeout_seconds // empty' .verify/plan.json 2>/dev/null)
    AC_TIMEOUT=$(_safe_timeout "${AC_TIMEOUT:-${AGENT_TIMEOUT:-240}}")
    "$AGENT_BIN" "$AC_ID" "$AC_TIMEOUT" > ".verify/evidence/$AC_ID/orchestrate.log" 2>&1 &
    PIDS+=($!)
    echo "  → spawned $AC_ID (pid $!, timeout: ${AC_TIMEOUT}s)"
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
