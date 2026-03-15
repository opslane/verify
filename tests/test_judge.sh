#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

mkdir -p .verify/evidence/ac1 .verify/evidence/ac2
echo '{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":[],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav","url":"/","steps":[],"screenshot_at":["initial"]}],"skipped":[]}' > .verify/plan.json
printf "VERDICT: pass\nREASONING: Header fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
printf "VERDICT: fail\nREASONING: Hamburger missing\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac2/agent.log

# Code review fixture
echo '{"findings":[{"ac_id":"ac2","severity":"blocker","category":"coverage_gap","file":"src/Nav.tsx","line":10,"finding":"Missing tablet breakpoint","suggestion":"Add 1024px check"}],"ac_coverage":[{"ac_id":"ac1","implemented":true,"gaps":[]},{"ac_id":"ac2","implemented":true,"gaps":["No tablet breakpoint"]}]}' > .verify/code-review.json

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"verdict":"partial_pass","summary":"1/2 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header confirmed fixed","evidence":".verify/evidence/ac1/agent.log","code_review":{"status":"clean","findings":[],"coverage":"full"}},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger not visible","evidence":".verify/evidence/ac2/agent.log","code_review":{"status":"has_findings","findings":["Missing tablet breakpoint — blocker"],"coverage":"partial"}}],"skipped":[]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

# ── Test: with code review ────────────────────────────────────────────────────
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 "$SCRIPT_DIR/judge.sh" 2>/dev/null

[ -f ".verify/report.json" ] || { echo "FAIL: report.json not created"; exit 1; }
VERDICT=$(jq -r '.verdict' .verify/report.json)
[ "$VERDICT" = "partial_pass" ] || { echo "FAIL: expected partial_pass, got $VERDICT"; exit 1; }

# Check code_review field exists
CR_STATUS=$(jq -r '.criteria[0].code_review.status' .verify/report.json)
[ "$CR_STATUS" = "clean" ] || { echo "FAIL: expected clean code_review for ac1, got $CR_STATUS"; exit 1; }

# ── Test: without code review file ────────────────────────────────────────────
rm -f .verify/code-review.json
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 "$SCRIPT_DIR/judge.sh" 2>/dev/null
[ -f ".verify/report.json" ] || { echo "FAIL: report.json not created (no code review)"; exit 1; }

echo "PASS: judge tests"
rm -f "$MOCK_CLAUDE"
