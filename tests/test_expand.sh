#!/usr/bin/env bash
# expand.sh --load-env must read the contract's env file exactly the way
# env.sh and precheck.sh do, or the seed script and login capture resolve a
# different base_url than the stack was booted and probed with.
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q
mkdir -p .verify
unset APP_PORT APP_HOST 2>/dev/null || true

cat > .verify/setup.json << 'JSON'
{"mode":"none","base_url":"http://${APP_HOST:-localhost}:${APP_PORT:-3000}","env_file":".env.test"}
JSON
expand() { jq -r '.base_url' .verify/setup.json | bash "$SCRIPTS_DIR/expand.sh" --load-env .verify/setup.json; }

printf 'APP_PORT=4000\n' > .env.test
[ "$(expand)" = "http://localhost:4000" ] || { echo "FAIL: plain value, got $(expand)"; exit 1; }

# env.sh strips paired double quotes; a quoted value must expand the same.
printf 'APP_PORT="4000"\nAPP_HOST="127.0.0.1"\n' > .env.test
[ "$(expand)" = "http://127.0.0.1:4000" ] || { echo "FAIL: quoted values must be unquoted like env.sh, got $(expand)"; exit 1; }

# Lines env.sh skips must not break or change the expansion.
printf 'APP_PORT=4000\n1BAD=x\nAPP_HOST\n' > .env.test
[ "$(expand)" = "http://localhost:4000" ] || { echo "FAIL: lines env.sh skips must be skipped, got $(expand)"; exit 1; }

echo "PASS: expand tests"
