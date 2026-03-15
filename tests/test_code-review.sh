#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p .verify

echo '{"criteria":[{"id":"ac1","description":"Header sticky on scroll","url":"/","steps":[],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav hamburger","url":"/","steps":[],"screenshot_at":["initial"]}],"skipped":[]}' > .verify/plan.json

# Mock claude binary — returns valid code review JSON
MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"findings":[{"ac_id":"ac1","severity":"should_fix","category":"edge_case","file":"src/Header.tsx","line":15,"finding":"Scroll handler missing throttle","suggestion":"Add requestAnimationFrame throttle"},{"ac_id":"general","severity":"consider","category":"simplicity","file":"src/Nav.tsx","line":42,"finding":"Redundant null check","suggestion":"Remove — value is always defined here"}],"ac_coverage":[{"ac_id":"ac1","implemented":true,"gaps":[]},{"ac_id":"ac2","implemented":true,"gaps":["Only checks window.innerWidth < 768, spec says 'mobile' which could include tablets"]}]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

# ── Test: valid run ───────────────────────────────────────────────────────────
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 "$SCRIPT_DIR/code-review.sh" 2>/dev/null

[ -f ".verify/code-review.json" ] || { echo "FAIL: code-review.json not created"; exit 1; }

FINDING_COUNT=$(jq '.findings | length' .verify/code-review.json)
[ "$FINDING_COUNT" = "2" ] || { echo "FAIL: expected 2 findings, got $FINDING_COUNT"; exit 1; }

COVERAGE_COUNT=$(jq '.ac_coverage | length' .verify/code-review.json)
[ "$COVERAGE_COUNT" = "2" ] || { echo "FAIL: expected 2 ac_coverage entries, got $COVERAGE_COUNT"; exit 1; }

# ── Test: empty diff produces empty result ────────────────────────────────────
# Override VERIFY_DIFF_BASE to a ref that has no diff against HEAD
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 VERIFY_DIFF_BASE="HEAD" "$SCRIPT_DIR/code-review.sh" 2>/dev/null

EMPTY_FINDINGS=$(jq '.findings | length' .verify/code-review.json)
[ "$EMPTY_FINDINGS" = "0" ] || { echo "FAIL: expected 0 findings for empty diff, got $EMPTY_FINDINGS"; exit 1; }

echo "PASS: code-review tests"
rm -f "$MOCK_CLAUDE"
