#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify
echo '{"base_url":"http://localhost:4111"}' > .verify/setup.json
cat > spec.md << 'SPEC'
## Acceptance Criteria
- Header must be sticky on scroll
- Mobile nav collapses below 768px viewport width
- The button looks nice
SPEC

GOOD="$TMP/good-claude"
cat > "$GOOD" << 'MOCK'
#!/usr/bin/env bash
cat > /dev/null
cat << 'JSON'
{"slug":"sticky-header","criteria":[{"id":"ac1","testability":"direct","description":"Header sticky on scroll","url":"/","steps":["scroll down 300px","assert header position fixed"],"screenshot_at":["after_scroll"],"depends_on":["browser"],"proof":{"kind":"live-read","detail":"computed header position"},"guards":"new-behavior"},{"id":"ac2","testability":"direct","description":"Mobile nav collapses below 768px","url":"/","steps":["set viewport 375x812","assert hamburger visible"],"screenshot_at":["viewport_set"],"depends_on":["browser"],"proof":{"kind":"live-read","detail":"hamburger visibility"},"guards":"existing-behavior"}],"skipped":["ac3: 'button looks nice' is too vague"],"seed_plan":[]}
JSON
MOCK
chmod +x "$GOOD"

VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$GOOD" \
  "$SCRIPTS_DIR/planner.sh" spec.md 2>/dev/null

[ -f .verify/plan.json ] || { echo "FAIL: plan.json not created"; exit 1; }
[ "$(jq '.criteria | length' .verify/plan.json)" = "2" ] || { echo "FAIL: criterion count"; exit 1; }
jq -e '.criteria[0].depends_on and .criteria[0].proof.kind and .criteria[0].guards' .verify/plan.json > /dev/null \
  || { echo "FAIL: criterion schema missing"; exit 1; }
jq -e '.seed_plan | type == "array"' .verify/plan.json > /dev/null || { echo "FAIL: seed_plan missing"; exit 1; }
jq -r '.skipped[0]' .verify/plan.json | grep -q vague || { echo "FAIL: skipped should mention vague"; exit 1; }

BAD="$TMP/bad-claude"
cat > "$BAD" << 'MOCK'
#!/usr/bin/env bash
cat > /dev/null
echo '{"criteria":[{"id":"ac1","description":"missing fields"}],"skipped":[],"seed_plan":[]}'
MOCK
chmod +x "$BAD"
VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$BAD" VERIFY_BASE_URL="http://localhost:3000" \
  "$SCRIPTS_DIR/planner.sh" spec.md >/dev/null 2>&1 \
  && { echo "FAIL: invalid schema must fail after retry"; exit 1; }

BAD_ID="$TMP/bad-id-claude"
cat > "$BAD_ID" << 'MOCK'
#!/usr/bin/env bash
cat > /dev/null
echo '{"criteria":[{"id":"ac/1","description":"bad id","depends_on":["api"],"proof":{"kind":"live-read","detail":"response"},"guards":"new-behavior"}],"skipped":[],"seed_plan":[]}'
MOCK
chmod +x "$BAD_ID"
VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$BAD_ID" VERIFY_BASE_URL="http://localhost:3000" \
  "$SCRIPTS_DIR/planner.sh" spec.md >/dev/null 2>&1 \
  && { echo "FAIL: unsafe AC id must fail"; exit 1; }

echo "PASS: planner tests"
