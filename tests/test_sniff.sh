#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

cat > compose.yaml << 'YML'
services:
  app: {image: x, healthcheck: {test: ["CMD", "true"]}}
  postgres: {image: postgres}
YML
mkdir -p scripts && echo "select 1;" > scripts/seed-e2e.sql
echo "DATABASE_URL=postgres://localhost:5432/app" > .env.example
echo '{"scripts":{"dev":"vite"}}' > package.json

OUT=$("$SCRIPTS_DIR/sniff.sh")
echo "$OUT" | jq . > /dev/null || { echo "FAIL: not JSON"; exit 1; }
[ "$(echo "$OUT" | jq -r '.has_stack')" = "true" ] || { echo "FAIL: has_stack"; exit 1; }
echo "$OUT" | jq -e '.boot[] | select(.mode=="compose" and .compose_file=="compose.yaml")' > /dev/null \
  || { echo "FAIL: compose candidate missing mode/compose_file"; exit 1; }
echo "$OUT" | jq -e '.boot[] | select(.cmd=="npm run dev" and .mode=="process")' > /dev/null \
  || { echo "FAIL: npm candidate missing or wrong mode"; exit 1; }
echo "$OUT" | jq -r '.seed[]' | grep -q "scripts/seed-e2e.sql" || { echo "FAIL: seed not found"; exit 1; }
echo "$OUT" | jq -r '.env_files[]' | grep -q ".env.example" || { echo "FAIL: env file not found"; exit 1; }

cd "$(mktemp -d)"
OUT=$("$SCRIPTS_DIR/sniff.sh")
[ "$(echo "$OUT" | jq -r '.has_stack')" = "false" ] || { echo "FAIL: bare repo should be has_stack=false"; exit 1; }

echo "PASS: sniff tests"
