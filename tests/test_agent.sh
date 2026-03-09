#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p .verify/evidence/ac1
echo '{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":["scroll down 300px","assert header fixed"],"screenshot_at":["after_scroll"]}],"skipped":[]}' > .verify/plan.json
echo '{"cookies":[],"origins":[]}' > .verify/auth.json

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
mkdir -p .verify/evidence/ac1
printf "VERDICT: pass\nREASONING: Header remained fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
echo "Agent completed ac1"
MOCK
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_BASE_URL="http://localhost:3000" \
  "$SCRIPT_DIR/agent.sh" "ac1" 2>/dev/null

[ -f ".verify/evidence/ac1/agent.log" ] || { echo "FAIL: agent.log not created"; exit 1; }
VERDICT=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log | awk '{print $2}')
[ "$VERDICT" = "pass" ] || { echo "FAIL: expected pass, got: $VERDICT"; exit 1; }

echo "PASS: agent tests"
rm -f "$MOCK_CLAUDE"
