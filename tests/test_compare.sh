#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q && git -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m base
mkdir -p .verify
echo '{"criteria":[{"id":"ac1","description":"x","depends_on":["api"]},{"id":"ac2","description":"y","depends_on":["api"]}],"skipped":[],"seed_plan":[]}' > .verify/plan.json
cat > .verify/report.json << 'JSON'
{"verdict":"partial","summary":"1/2","criteria":[
 {"ac_id":"ac1","status":"fail","proof_seen":false,"reasoning":"nope","evidence":"e"},
 {"ac_id":"ac2","status":"pass","proof_seen":true,"reasoning":"ok","evidence":"e"}]}
JSON

# Gate: refuses without VERIFY_ALLOW_DANGEROUS=1
"$SCRIPTS_DIR/compare.sh" HEAD ac1 2>/dev/null && { echo "FAIL: must gate on VERIFY_ALLOW_DANGEROUS"; exit 1; }

# Unknown AC id: refuse
VERIFY_ALLOW_DANGEROUS=1 BASE_RUNNER=/bin/true "$SCRIPTS_DIR/compare.sh" HEAD nope 2>/dev/null \
  && { echo "FAIL: unknown AC id must be rejected"; exit 1; }

# Base runner fails -> could_not_run
cat > mock-base-fail.sh << 'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
chmod +x mock-base-fail.sh
VERIFY_ALLOW_DANGEROUS=1 BASE_RUNNER=./mock-base-fail.sh "$SCRIPTS_DIR/compare.sh" HEAD ac1 \
  || { echo "FAIL: compare must not die on base failure"; exit 1; }
[ "$(jq -r '.results[0].base' .verify/compare.json)" = "could_not_run" ] || { echo "FAIL: expected could_not_run"; exit 1; }
jq -r '.results[0].reading' .verify/compare.json | grep -q "no conclusion" || { echo "FAIL: reading"; exit 1; }

# Base fails identically; pass/pass free-pass wording; base reasoning preserved
cat > mock-base-same.sh << 'MOCK'
#!/usr/bin/env bash
echo '{"criteria":[{"ac_id":"ac1","status":"fail","reasoning":"same break"},{"ac_id":"ac2","status":"pass","reasoning":"also fine"}]}' > "$1"
MOCK
chmod +x mock-base-same.sh
VERIFY_ALLOW_DANGEROUS=1 BASE_RUNNER=./mock-base-same.sh "$SCRIPTS_DIR/compare.sh" HEAD ac1 ac2
jq -r '.results[0].reading' .verify/compare.json | grep -q "not this change" || { echo "FAIL: same-fail reading"; exit 1; }
jq -r '.results[1].reading' .verify/compare.json | grep -q "would have passed before" || { echo "FAIL: free-pass reading"; exit 1; }
[ "$(jq -r '.results[0].base_reasoning' .verify/compare.json)" = "same break" ] || { echo "FAIL: base reasoning lost"; exit 1; }
echo "PASS: compare tests"
