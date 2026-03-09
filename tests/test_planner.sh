#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$SCRIPT_DIR/tests/fixtures"
mkdir -p "$FIXTURES"

cat > "$FIXTURES/test-spec.md" << 'SPEC'
## Acceptance Criteria
- Header must be sticky on scroll
- Mobile nav collapses below 768px viewport width
- The button looks nice
SPEC

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"criteria":[{"id":"ac1","description":"Header sticky on scroll","url":"/","steps":["scroll down 300px","assert header position fixed"],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav collapses below 768px","url":"/","steps":["set viewport 375x812","assert hamburger visible"],"screenshot_at":["viewport_set"]}],"skipped":["ac3: 'button looks nice' is too vague"]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

mkdir -p .verify
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_BASE_URL="http://localhost:3000" \
  "$SCRIPT_DIR/planner.sh" "$FIXTURES/test-spec.md" 2>/dev/null

[ -f ".verify/plan.json" ] || { echo "FAIL: plan.json not created"; exit 1; }
COUNT=$(jq '.criteria | length' .verify/plan.json)
[ "$COUNT" = "2" ] || { echo "FAIL: expected 2 criteria, got $COUNT"; exit 1; }
SKIPPED=$(jq -r '.skipped[0]' .verify/plan.json)
echo "$SKIPPED" | grep -q "vague" || { echo "FAIL: skipped should mention vague. Got: $SKIPPED"; exit 1; }

echo "PASS: planner tests"
rm -f "$MOCK_CLAUDE"
