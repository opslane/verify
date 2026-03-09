#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p .verify/evidence/ac1 .verify/evidence/ac2
echo '{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":[],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav","url":"/","steps":[],"screenshot_at":["initial"]}],"skipped":[]}' > .verify/plan.json
printf "VERDICT: pass\nREASONING: Header fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
printf "VERDICT: fail\nREASONING: Hamburger missing\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac2/agent.log

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"verdict":"partial","summary":"1/2 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header confirmed fixed","evidence":".verify/evidence/ac1/agent.log"},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger not visible","evidence":".verify/evidence/ac2/agent.log"}],"skipped":[]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/judge.sh" 2>/dev/null

[ -f ".verify/report.json" ] || { echo "FAIL: report.json not created"; exit 1; }
VERDICT=$(jq -r '.verdict' .verify/report.json)
[ "$VERDICT" = "partial" ] || { echo "FAIL: expected partial, got $VERDICT"; exit 1; }

echo "PASS: judge tests"
rm -f "$MOCK_CLAUDE"
