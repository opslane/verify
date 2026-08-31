#!/usr/bin/env bash
# Detect how this repo boots, seeds, and reports health. Pure read-only.
# Output: one JSON object on stdout. Never asks questions; the setup
# interview in the verify-setup skill turns these candidates into choices.
set -e

BOOT="[]"
SEED=()
HEALTH=()
ENVF=()
HAS_STACK=false

add_boot() { # cmd mode compose_file
  BOOT=$(echo "$BOOT" | jq --arg c "$1" --arg m "$2" --arg f "${3:-}" \
    '. + [{cmd: $c, mode: $m, compose_file: (if $f == "" then null else $f end)}]')
}

for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$f" ]; then
    HAS_STACK=true
    add_boot "docker compose -f $f up -d --wait" "compose" "$f"
    grep -q "healthcheck" "$f" && HEALTH+=("compose healthchecks (--wait)")
    break
  fi
done

if [ -f package.json ]; then
  for s in dev start serve; do
    if jq -e --arg s "$s" '.scripts[$s]' package.json > /dev/null 2>&1; then
      HAS_STACK=true
      add_boot "npm run $s" "process" ""
    fi
  done
fi
if [ -f Makefile ]; then
  T=$(grep -oE '^(dev|up|run):' Makefile | head -1 | tr -d ':')
  [ -n "$T" ] && { HAS_STACK=true; add_boot "make $T" "process" ""; }
fi

while IFS= read -r f; do SEED+=("$f"); done < <(ls scripts/seed-*.sql scripts/seed-*.sh seed/*.sql 2>/dev/null || true)
[ -f package.json ] && jq -e '.scripts.seed' package.json > /dev/null 2>&1 && SEED+=("npm run seed")

for f in .env.example .env.sample .env.local .env; do
  [ -f "$f" ] && ENVF+=("$f")
done

to_json_array() {
  if [ "$#" -eq 0 ]; then echo "[]"; else printf '%s\n' "$@" | jq -R . | jq -s .; fi
}

jq -n \
  --argjson boot "$BOOT" \
  --argjson seed "$(to_json_array "${SEED[@]}")" \
  --argjson health "$(to_json_array "${HEALTH[@]}")" \
  --argjson env_files "$(to_json_array "${ENVF[@]}")" \
  --argjson has_stack "$HAS_STACK" \
  '{boot: $boot, seed: $seed, health: $health, env_files: $env_files, has_stack: $has_stack}'
