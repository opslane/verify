#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify/evidence/ac1
cat > .verify/plan.json << 'JSON'
{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":["scroll down 300px","assert header fixed"],"screenshot_at":["after_scroll"],"depends_on":["browser"],"proof":{"kind":"live-read","detail":"computed position"},"guards":"new-behavior"}],"skipped":[],"seed_plan":[]}
JSON
echo '{"mode":"none","base_url":"http://localhost:3000"}' > .verify/setup.json
echo '{"run_id":"r1","project":"verify-r1","marker":"verify-r1","pgid":null}' > .verify/run-env.json
echo '{"tainted":{}}' > .verify/precheck.json
echo '{"cookies":[],"origins":[]}' > .verify/auth.json

MOCK_CLAUDE="$TMP/mock-claude"
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat > /dev/null
echo called >> mock-calls.log
mkdir -p .verify/evidence/ac1
printf "VERDICT: pass\nREASONING: verify-r1 header remained fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
MOCK
chmod +x "$MOCK_CLAUDE"

# No legacy config.json exists: setup.json must be enough under set -e.
VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/agent.sh" ac1 2>/dev/null
[ "$(grep -c '^called$' mock-calls.log)" = "1" ] || { echo "FAIL: agent model not invoked"; exit 1; }
grep -q 'VERIFY_MARKER: verify-r1' .verify/prompts/ac1-agent.txt || { echo "FAIL: marker absent from prompt"; exit 1; }
grep -q 'DECLARED PROOF' .verify/prompts/ac1-agent.txt || { echo "FAIL: proof absent from prompt"; exit 1; }

# A tainted criterion exits successfully without invoking the model.
echo '{"tainted":{"ac1":"sink"}}' > .verify/precheck.json
VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/agent.sh" ac1 2>/dev/null
[ "$(grep -c '^called$' mock-calls.log)" = "1" ] || { echo "FAIL: tainted AC invoked claude"; exit 1; }
grep -q '^COULD_NOT_VERIFY:' .verify/evidence/ac1/agent.log || { echo "FAIL: tainted log missing"; exit 1; }

echo "PASS: agent tests"
