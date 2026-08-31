#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify
echo "spec text" > spec.md && echo "spec.md" > .verify/.spec_path
echo '{"criteria":[{"id":"ac1","description":"x","depends_on":["api"],"proof":{"kind":"live-read","detail":"d"},"guards":"new-behavior"}],"skipped":[],"seed_plan":[]}' > .verify/plan.json

GOOD=$(mktemp)
cat > "$GOOD" << 'M'
#!/usr/bin/env bash
# consume stdin like a real model call, then answer
cat > /dev/null
echo '{"criteria":[{"id":"ac1","keep":"load-bearing","why":"only end-to-end check","codify":true}],"missing":["a valid key still works"]}'
M
chmod +x "$GOOD"
BAD=$(mktemp)
printf '#!/usr/bin/env bash\ncat > /dev/null\necho not-json\n' > "$BAD" && chmod +x "$BAD"

CODEX_BIN="$GOOD" CLAUDE_BIN=/bin/false "$SCRIPTS_DIR/review.sh" || { echo "FAIL: review with codex"; exit 1; }
[ "$(jq -r '.reviewer' .verify/review.json)" = "codex" ] || { echo "FAIL: reviewer should be codex"; exit 1; }

CODEX_BIN="$BAD" CLAUDE_BIN="$GOOD" "$SCRIPTS_DIR/review.sh" || { echo "FAIL: fallback"; exit 1; }
[ "$(jq -r '.reviewer' .verify/review.json)" = "fresh-claude" ] || { echo "FAIL: should fall back to fresh-claude"; exit 1; }

CODEX_BIN="$BAD" CLAUDE_BIN="$BAD" "$SCRIPTS_DIR/review.sh" || { echo "FAIL: unavailable path must not crash"; exit 1; }
[ "$(jq -r '.reviewer' .verify/review.json)" = "unavailable" ] || { echo "FAIL: reviewer should be unavailable"; exit 1; }
echo "PASS: review tests"
