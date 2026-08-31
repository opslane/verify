#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify/evidence/{ac1,ac2,ac3,ac4}
cat > .verify/plan.json << 'JSON'
{"criteria":[
 {"id":"ac1","description":"Header sticky","proof":{"kind":"marker-in-data","detail":"row"}},
 {"id":"ac2","description":"Mobile nav","proof":{"kind":"live-read","detail":"visibility"}},
 {"id":"ac3","description":"Sink delivery","proof":{"kind":"marker-in-data","detail":"message"}},
 {"id":"ac4","description":"Worker result","proof":{"kind":"marker-in-data","detail":"job"}}
],"skipped":[],"seed_plan":[]}
JSON
echo '{"run_id":"r1","project":"verify-r1","marker":"verify-r1","pgid":null}' > .verify/run-env.json
printf "VERDICT: pass\nREASONING: verify-r1 row seen\n" > .verify/evidence/ac1/agent.log
printf "VERDICT: fail\nREASONING: Hamburger missing\n" > .verify/evidence/ac2/agent.log
printf "COULD_NOT_VERIFY: dependent part 'sink' failed its pipeline check\n" > .verify/evidence/ac3/agent.log

MOCK_CLAUDE="$TMP/mock-claude"
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat > /dev/null
cat << 'JSON'
{"verdict":"pass","summary":"wrong","criteria":[
 {"ac_id":"ac1","status":"pass","proof_seen":true,"did":"posted event","observed":"verify-r1 row","reasoning":"marker seen","evidence":".verify/evidence/ac1/agent.log"},
 {"ac_id":"ac2","status":"fail","proof_seen":false,"did":"opened page","observed":"hamburger missing","reasoning":"not visible","evidence":".verify/evidence/ac2/agent.log"},
 {"ac_id":"ac3","status":"could_not_verify","proof_seen":false,"did":"","observed":"","reasoning":"sink down","evidence":".verify/evidence/prechecks/sink.log"}
]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/judge.sh" 2>/dev/null
[ "$(jq -r '.criteria[] | select(.ac_id=="ac3") | .status' .verify/report.json)" = "could_not_verify" ] \
  || { echo "FAIL: tainted AC must be could_not_verify"; exit 1; }
[ "$(jq -r '.criteria[] | select(.ac_id=="ac4") | .status' .verify/report.json)" = "not_proven" ] \
  || { echo "FAIL: judge-omitted AC must be synthesized not_proven"; exit 1; }
[ "$(jq '.criteria | length' .verify/report.json)" = "4" ] || { echo "FAIL: count must come from plan"; exit 1; }
[ "$(jq -r '.verdict' .verify/report.json)" != "pass" ] || { echo "FAIL: verdict must be recomputed, not trusted"; exit 1; }
[ "$(jq -r '.summary' .verify/report.json)" = "1/4 proven" ] || { echo "FAIL: summary must be recomputed"; exit 1; }
grep -q 'RUN MARKER: verify-r1' .verify/judge-prompt.txt || { echo "FAIL: judge prompt lacks marker"; exit 1; }

# Mechanical taint override: judge says pass for a tainted AC; reconciliation must refuse
echo '{"parts":{"sink":"down"},"tainted":{"ac1":"sink"},"unchecked":[]}' > .verify/precheck.json
VERIFY_ALLOW_DANGEROUS=1 CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/judge.sh" 2>/dev/null
[ "$(jq -r '.criteria[] | select(.ac_id=="ac1") | .status' .verify/report.json)" = "could_not_verify" ] \
  || { echo "FAIL: tainted AC must be could_not_verify even when the judge says pass"; exit 1; }
rm -f .verify/precheck.json
echo "PASS: judge tests"
