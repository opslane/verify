#!/usr/bin/env bash
# Tests for pipeline robustness fixes:
#   1. Global setup env vars persist (no pipe-subshell)
#   2. Per-AC setup failure → VERDICT: setup_failed (skip agent)
#   3. External-dependency ACs auto-skipped by orchestrator
#   4. Full URLs in plan.json sanitized to relative paths
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
PASS=0; FAIL=0

_setup() {
  # Clean evidence and plan without rm -rf
  find .verify/evidence -mindepth 1 -delete 2>/dev/null || true
  rm -f .verify/plan.json .verify/plan.json.tmp 2>/dev/null || true
  mkdir -p .verify/evidence
}

_assert() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    echo "  PASS: $name"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"; FAIL=$((FAIL + 1))
  fi
}

# ── Test 1: Global setup exports persist to agent env ────────────────────────
echo "Test 1: global setup env vars visible to agents"
_setup

# Plan with global setup that exports a var, and an AC
cat > .verify/plan.json << 'EOF'
{
  "setup": ["export VERIFY_TEST_VAR=hello_from_setup"],
  "criteria": [{"id":"ac1","description":"check var","url":"/test","steps":["s1"],"screenshot_at":["s1"],"timeout_seconds":90}],
  "skipped": []
}
EOF

# Mock agent that checks if VERIFY_TEST_VAR is set
MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
if [ "$VERIFY_TEST_VAR" = "hello_from_setup" ]; then
  printf "VERDICT: pass\nREASONING: var was set\n" > ".verify/evidence/$AC_ID/agent.log"
else
  printf "VERDICT: fail\nREASONING: VERIFY_TEST_VAR not set (got: '%s')\n" "$VERIFY_TEST_VAR" > ".verify/evidence/$AC_ID/agent.log"
fi
MOCK
chmod +x "$MOCK_AGENT"

VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=none AGENT_BIN="$MOCK_AGENT" \
  "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

VERDICT=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log 2>/dev/null | awk '{print $2}')
_assert "global setup export visible to agent" '[ "$VERDICT" = "pass" ]'
rm -f "$MOCK_AGENT"

# ── Test 2: Per-AC setup failure → setup_failed verdict, agent not launched ──
echo "Test 2: per-AC setup failure skips agent"
_setup

cat > .verify/plan.json << 'EOF'
{
  "criteria": [{"id":"ac1","description":"needs setup","url":"/","setup":["exit 1"],"steps":["s1"],"screenshot_at":["s1"],"timeout_seconds":90}],
  "skipped": []
}
EOF

# Mock agent that should NOT be called — writes a marker if it is
MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
printf "VERDICT: pass\nREASONING: agent ran\n" > ".verify/evidence/$AC_ID/agent.log"
touch ".verify/evidence/$AC_ID/.agent_was_called"
MOCK
chmod +x "$MOCK_AGENT"

VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=none VERIFY_BASE_URL="http://localhost:3000" CLAUDE_BIN="$MOCK_AGENT" \
  "$SCRIPT_DIR/agent.sh" "ac1" 120 2>/dev/null || true

VERDICT=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log 2>/dev/null | awk '{print $2}')
_assert "setup failure produces setup_failed verdict" '[ "$VERDICT" = "setup_failed" ]'
_assert "agent was NOT launched after setup failure" '[ ! -f ".verify/evidence/ac1/.agent_was_called" ]'
rm -f "$MOCK_AGENT"

# ── Test 3: External-dependency ACs auto-skipped ─────────────────────────────
echo "Test 3: external-dependency ACs auto-skipped"
_setup

cat > .verify/plan.json << 'EOF'
{
  "criteria": [
    {"id":"ac1","description":"Click Add payment method button → Stripe checkout redirect","url":"/billing","steps":["click stripe button"],"screenshot_at":["s1"],"timeout_seconds":90},
    {"id":"ac2","description":"Sidebar shows trial days","url":"/","steps":["check sidebar"],"screenshot_at":["s2"],"timeout_seconds":90}
  ],
  "skipped": []
}
EOF

MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
printf "VERDICT: pass\nREASONING: mock\n" > ".verify/evidence/$AC_ID/agent.log"
MOCK
chmod +x "$MOCK_AGENT"

VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=none AGENT_BIN="$MOCK_AGENT" \
  "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

VERDICT_AC1=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log 2>/dev/null | awk '{print $2}')
VERDICT_AC2=$(grep "^VERDICT:" .verify/evidence/ac2/agent.log 2>/dev/null | awk '{print $2}')
_assert "stripe AC auto-skipped" '[ "$VERDICT_AC1" = "skipped" ]'
_assert "normal AC still runs" '[ "$VERDICT_AC2" = "pass" ]'
rm -f "$MOCK_AGENT"

# ── Test 4: Full URLs in plan.json sanitized to relative paths ───────────────
echo "Test 4: full URLs sanitized to relative paths"
_setup

cat > .verify/plan.json << 'EOF'
{
  "criteria": [{"id":"ac1","description":"test page","url":"http://localhost:3001/event-types","steps":["check page"],"screenshot_at":["s1"],"timeout_seconds":90}],
  "skipped": []
}
EOF

# Mock agent that captures the URL it was given (reads from plan.json)
MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
AC_URL=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .url' .verify/plan.json)
printf "VERDICT: pass\nREASONING: url=%s\n" "$AC_URL" > ".verify/evidence/$AC_ID/agent.log"
MOCK
chmod +x "$MOCK_AGENT"

VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=none AGENT_BIN="$MOCK_AGENT" \
  "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

# After sanitization, the url in plan.json should be /event-types
PLAN_URL=$(jq -r '.criteria[0].url' .verify/plan.json)
_assert "url sanitized to relative path" '[ "$PLAN_URL" = "/event-types" ]'
rm -f "$MOCK_AGENT"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
