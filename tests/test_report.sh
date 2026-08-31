#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify/runs/r1/evidence/ac1
ln -sfn "runs/r1/evidence" .verify/evidence
echo '{"run_id":"r1","project":"verify-r1","marker":"verify-r1","pgid":null}' > .verify/run-env.json
printf 'fake-png' > .verify/evidence/ac1/screenshot-1.png
cat > .verify/plan.json << 'JSON'
{"criteria":[
 {"id":"ac1","description":"new thing works <b>bold</b>","guards":"new-behavior","depends_on":["api"],"proof":{"kind":"marker-in-data","detail":"row"}},
 {"id":"ac2","description":"old guard holds","guards":"existing-behavior","depends_on":["sink"],"proof":{"kind":"marked-request-rejected","detail":"401"}},
 {"id":"ac3","description":"worker path","guards":"new-behavior","depends_on":["worker"],"proof":{"kind":"marker-in-data","detail":"job row"}}
],"skipped":[],"seed_plan":[]}
JSON
cat > .verify/report.json << 'JSON'
{"verdict":"partial","summary":"1/3","criteria":[
 {"ac_id":"ac1","status":"pass","proof_seen":true,"did":"posted event","observed":"marker row","reasoning":"marker row seen","evidence":".verify/evidence/ac1/agent.log"},
 {"ac_id":"ac2","status":"could_not_verify","proof_seen":false,"did":"","observed":"","reasoning":"sink down","evidence":""},
 {"ac_id":"ac3","status":"fail","proof_seen":false,"did":"queued job","observed":"nothing arrived","reasoning":"no job row","evidence":""}]}
JSON
echo '{"parts":{"api":"ok","sink":"down","worker":"unknown"},"tainted":{"ac2":"sink"},"unchecked":["worker"]}' > .verify/precheck.json

"$SCRIPT_DIR/report.sh" > /dev/null || { echo "FAIL: report.sh exited non-zero"; exit 1; }
HTML=".verify/runs/r1/report.html"
[ -f "$HTML" ] || { echo "FAIL: report.html not in run folder"; exit 1; }
grep -q "1 of 3 proven" "$HTML" || { echo "FAIL: headline missing or wrong"; exit 1; }
grep -qi "couldn't run\|could not run" "$HTML" || { echo "FAIL: could-not-run absent"; exit 1; }
grep -q 'src="evidence/ac1/screenshot-1.png"' "$HTML" || { echo "FAIL: screenshot must be relative, not inlined"; exit 1; }
grep -q "data:image" "$HTML" && { echo "FAIL: no base64 inlining"; exit 1; }
grep -q "proves the new behavior" "$HTML" || { echo "FAIL: plain-English guard label missing"; exit 1; }
grep -q "may be environmental" "$HTML" || { echo "FAIL: unchecked-part flag on fail missing"; exit 1; }
grep -q "&lt;b&gt;" "$HTML" || { echo "FAIL: description must be HTML-escaped"; exit 1; }
grep -qE '<h1[^>]*>PASS' "$HTML" && { echo "FAIL: partial run must not headline PASS"; exit 1; }
grep -q "codify-block-begin" "$HTML" || { echo "FAIL: codify markers missing"; exit 1; }
grep -qi "modified your working tree" "$HTML" && { echo "FAIL: banner must not render without flag"; exit 1; }

# Canonical set drives everything: duplicate + ghost entries must not change counts.
jq '.criteria += [.criteria[0], {"ac_id":"ghost","status":"pass","proof_seen":true,"did":"","observed":"","reasoning":"","evidence":""}]' \
  .verify/report.json > .verify/report.tmp && mv .verify/report.tmp .verify/report.json
"$SCRIPT_DIR/report.sh" > /dev/null
grep -q "1 of 3 proven" "$HTML" || { echo "FAIL: duplicate/ghost entries must not change counts"; exit 1; }
[ -f .verify/runs/r1/canonical.json ] || { echo "FAIL: canonical.json not written"; exit 1; }

# Violation flag renders the red banner
touch .verify/runs/r1/clean-repo-violation
"$SCRIPT_DIR/report.sh" > /dev/null
grep -qi "modified your working tree" "$HTML" || { echo "FAIL: violation banner missing"; exit 1; }
grep -q "CANNOT TRUST THIS RUN" "$HTML" || { echo "FAIL: violation must poison the headline"; exit 1; }

# All-proven run with a video: relative src, PASS headline allowed
rm .verify/runs/r1/clean-repo-violation
touch .verify/evidence/ac1/session.webm
cat > .verify/report.json << 'JSON'
{"verdict":"pass","summary":"3/3","criteria":[
 {"ac_id":"ac1","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""},
 {"ac_id":"ac2","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""},
 {"ac_id":"ac3","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""}]}
JSON
echo '{"parts":{"api":"ok","sink":"ok","worker":"ok"},"tainted":{},"unchecked":[]}' > .verify/precheck.json
"$SCRIPT_DIR/report.sh" > /dev/null
grep -q "PASS — 3 of 3 proven" "$HTML" || { echo "FAIL: all-proven headline must say PASS"; exit 1; }
grep -q '<video controls src="evidence/ac1/session.webm"' "$HTML" || { echo "FAIL: video must be relative"; exit 1; }
# Proofless pass: judge says pass but proof_seen=false -> normalized to not_proven
cat > .verify/report.json << 'JSON'
{"verdict":"pass","summary":"","criteria":[
 {"ac_id":"ac1","status":"pass","proof_seen":false,"did":"d","observed":"o","reasoning":"no marker quoted","evidence":""},
 {"ac_id":"ac2","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""},
 {"ac_id":"ac3","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""}]}
JSON
"$SCRIPT_DIR/report.sh" > /dev/null
grep -q "2 of 3 proven" "$HTML" || { echo "FAIL: proofless pass must not count as proven"; exit 1; }
[ "$(jq -r '.[] | select(.ac_id=="ac1") | .status' .verify/runs/r1/canonical.json)" = "not_proven" ] \
  || { echo "FAIL: proofless pass must normalize to not_proven in canonical"; exit 1; }
echo "PASS: report tests"
