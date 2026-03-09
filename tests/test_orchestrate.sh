#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p .verify
echo '{"criteria":[{"id":"ac1","description":"T1","url":"/","steps":["s1"],"screenshot_at":["s1"]},{"id":"ac2","description":"T2","url":"/","steps":["s2"],"screenshot_at":["s2"]}],"skipped":[]}' > .verify/plan.json

MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
printf "VERDICT: pass\nREASONING: mock\nSTEPS_COMPLETED: 1/1\n" > ".verify/evidence/$AC_ID/agent.log"
MOCK
chmod +x "$MOCK_AGENT"

unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
AGENT_BIN="$MOCK_AGENT" "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

[ -f ".verify/evidence/ac1/agent.log" ] || { echo "FAIL: ac1 agent.log missing"; exit 1; }
[ -f ".verify/evidence/ac2/agent.log" ] || { echo "FAIL: ac2 agent.log missing"; exit 1; }

echo "PASS: orchestrate tests"
rm -f "$MOCK_AGENT"
