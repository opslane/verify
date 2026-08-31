#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p bin .verify
cat > bin/curl << 'MOCK'
#!/usr/bin/env bash
echo "<html>ok</html>"
exit 0
MOCK
chmod +x bin/curl
cat > bin/psql << 'MOCK'
#!/usr/bin/env bash
# echo back the marker variable (-v m=verify-t) like a successful select
for a in "$@"; do case "$a" in m=*) echo "${a#m=}";; esac; done
MOCK
chmod +x bin/psql
export PATH="$TMP/bin:$PATH"
export TESTDB_URL="postgres://mock"

cat > .verify/setup.json << 'JSON'
{"mode":"none","compose_file":null,"boot":"","teardown":"","seed":[],
 "seed_data_files":[],"health_url":"","base_url":"http://localhost:9","env_file":"",
 "observe":{"db_url_env":"TESTDB_URL"},"probes":{"sink":"false","worker":""}}
JSON
echo '{"run_id":"t","project":"verify-t","marker":"verify-t","pgid":null}' > .verify/run-env.json
cat > .verify/plan.json << 'JSON'
{"criteria":[
 {"id":"ac1","description":"api+db thing","depends_on":["api","db"]},
 {"id":"ac2","description":"sink thing","depends_on":["api","sink"]},
 {"id":"ac3","description":"worker thing","depends_on":["worker"]},
 {"id":"ac4","description":"ui thing","depends_on":["browser"]}
],"skipped":[],"seed_plan":[]}
JSON

"$SCRIPTS_DIR/precheck.sh" || { echo "FAIL: precheck exited non-zero"; exit 1; }
[ "$(jq -r '.parts.api' .verify/precheck.json)" = "ok" ] || { echo "FAIL: api should be ok"; exit 1; }
[ "$(jq -r '.parts.browser' .verify/precheck.json)" = "ok" ] || { echo "FAIL: browser should be ok"; exit 1; }
[ "$(jq -r '.parts.db' .verify/precheck.json)" = "ok" ] || { echo "FAIL: db should be ok (marker echoed)"; exit 1; }
[ "$(jq -r '.parts.sink' .verify/precheck.json)" = "down" ] || { echo "FAIL: sink should be down"; exit 1; }
[ "$(jq -r '.parts.worker' .verify/precheck.json)" = "unknown" ] || { echo "FAIL: worker should be unknown"; exit 1; }
[ "$(jq -r '.tainted.ac2' .verify/precheck.json)" = "sink" ] || { echo "FAIL: ac2 must be tainted by sink"; exit 1; }
jq -e '.tainted | has("ac1") | not' .verify/precheck.json > /dev/null || { echo "FAIL: ac1 must not be tainted"; exit 1; }
jq -e '.tainted | has("ac3") | not' .verify/precheck.json > /dev/null || { echo "FAIL: unknown must not taint"; exit 1; }
jq -e '.unchecked | index("worker") != null' .verify/precheck.json > /dev/null || { echo "FAIL: worker must be listed unchecked"; exit 1; }
[ -f .verify/evidence/prechecks/sink.log ] || { echo "FAIL: down part must leave an evidence log"; exit 1; }
echo "PASS: precheck tests"
