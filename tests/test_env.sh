#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p bin .verify scripts
cat > bin/docker << 'MOCK'
#!/usr/bin/env bash
echo "docker $*" >> docker-calls.log
MOCK
chmod +x bin/docker
cat > bin/psql << 'MOCK'
#!/usr/bin/env bash
echo "psql $*" >> psql-calls.log
MOCK
chmod +x bin/psql
export PATH="$TMP/bin:$PATH"

echo "select 1;" > scripts/seed.sql
echo "DATABASE_URL=postgres://x" > .env.test
cat > .verify/setup.json << 'JSON'
{"mode":"compose","compose_file":"compose.yaml",
 "boot":"docker compose -f compose.yaml up -d --wait",
 "teardown":"docker compose -f compose.yaml down -v",
 "seed":["scripts/seed.sql"],"seed_data_files":[],"health_url":"",
 "base_url":"http://localhost:3000","env_file":".env.test",
 "observe":{"db_url_env":"DATABASE_URL"},"probes":{}}
JSON

mkdir -p .verify/runs/old-{1,2,3,4,5,6}/evidence
"$SCRIPTS_DIR/env.sh" up || { echo "FAIL: up exited non-zero"; exit 1; }
MARKER=$(jq -r '.marker' .verify/run-env.json)
echo "$MARKER" | grep -q "^verify-" || { echo "FAIL: marker shape"; exit 1; }
grep -q -- "-p verify-" docker-calls.log || { echo "FAIL: no unique compose project"; exit 1; }
[ -f psql-calls.log ] && { echo "FAIL: up must not seed"; exit 1; }
RUN_ID=$(jq -r '.run_id' .verify/run-env.json)
[ -d ".verify/runs/$RUN_ID/evidence" ] || { echo "FAIL: run folder missing"; exit 1; }
[ "$(readlink .verify/evidence)" = "runs/$RUN_ID/evidence" ] || { echo "FAIL: evidence symlink wrong"; exit 1; }
[ "$(ls -1d .verify/runs/*/ | wc -l)" -le 5 ] || { echo "FAIL: rotation must keep at most 5 runs"; exit 1; }

"$SCRIPTS_DIR/env.sh" seed || { echo "FAIL: seed exited non-zero"; exit 1; }
grep -q "ON_ERROR_STOP" psql-calls.log || { echo "FAIL: sql seed not run via psql"; exit 1; }

"$SCRIPTS_DIR/env.sh" down || { echo "FAIL: down exited non-zero"; exit 1; }
grep -q "down -v" docker-calls.log || { echo "FAIL: teardown must remove volumes"; exit 1; }

# Missing configured env file fails loudly
rm .env.test
"$SCRIPTS_DIR/env.sh" up 2>/dev/null && { echo "FAIL: missing env file must fail"; exit 1; }
echo "DATABASE_URL=postgres://x" > .env.test

# Process mode requires health_url
cat > .verify/setup.json << 'JSON'
{"mode":"process","compose_file":null,"boot":"sleep 300","teardown":"",
 "seed":[],"seed_data_files":[],"health_url":"","base_url":"","env_file":"",
 "observe":{},"probes":{}}
JSON
"$SCRIPTS_DIR/env.sh" up 2>/dev/null && { echo "FAIL: process mode without health_url must fail"; exit 1; }

# Process mode with health_url: mock curl always healthy; group killed on down
cat > bin/curl << 'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x bin/curl
cat > .verify/setup.json << 'JSON'
{"mode":"process","compose_file":null,"boot":"sleep 300","teardown":"",
 "seed":[],"seed_data_files":[],"health_url":"http://localhost:1/health",
 "base_url":"","env_file":"","observe":{},"probes":{}}
JSON
"$SCRIPTS_DIR/env.sh" up || { echo "FAIL: process mode up failed"; exit 1; }
PGID=$(jq -r '.pgid' .verify/run-env.json)
kill -0 -- "-$PGID" 2>/dev/null || { echo "FAIL: process group not running"; exit 1; }
"$SCRIPTS_DIR/env.sh" down
sleep 0.2
kill -0 -- "-$PGID" 2>/dev/null && { echo "FAIL: process group not killed on down"; exit 1; }
[ -f .verify/run-env.json ] && { echo "FAIL: down must remove run-env.json"; exit 1; }

# Plain mode (none): no docker, still writes a marker
rm -f docker-calls.log
cat > .verify/setup.json << 'JSON'
{"mode":"none","compose_file":null,"boot":"","teardown":"","seed":[],
 "seed_data_files":[],"health_url":"","base_url":"","env_file":"","observe":{},"probes":{}}
JSON
"$SCRIPTS_DIR/env.sh" up || { echo "FAIL: plain mode up failed"; exit 1; }
[ -f docker-calls.log ] && { echo "FAIL: plain mode must not call docker"; exit 1; }
jq -e '.marker' .verify/run-env.json > /dev/null || { echo "FAIL: plain mode marker"; exit 1; }

echo "PASS: env tests"
