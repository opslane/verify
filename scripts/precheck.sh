#!/usr/bin/env bash
# Pipeline checks: prove each part the criteria depend on works, before
# judging anything. A down part taints only the criteria that depend on it.
# Unknown (no probe available) never taints — unknown is not down — but is
# reported, and fails on unknown-depending criteria get flagged as possibly
# environmental by the report.
set -e
RUN_ID="$(cat .verify/current-run 2>/dev/null || echo "")"
[ -n "$RUN_ID" ] || { echo "✗ .verify/current-run missing — create the run first"; exit 1; }
RUN_DIR=".verify/runs/$RUN_ID"
PLAN="$RUN_DIR/criteria.json"
SETUP=".verify/setup.json"
[ -f "$PLAN" ] && [ -f "$SETUP" ] || { echo "✗ criteria.json or setup.json missing"; exit 1; }
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi

if [ -n "${VERIFY_ENV_FILE:-}" ]; then
  ENV_FILE="$VERIFY_ENV_FILE"
  [ -f "$ENV_FILE" ] || { echo "✗ VERIFY_ENV_FILE does not exist: $ENV_FILE"; exit 1; }
else
  ENV_FILE="$(jq -r '.env_file // empty' "$SETUP")"
  if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
    STORE_ENV="$(bash "$(cd "$(dirname "$0")" && pwd)/shared-store.sh" path)/local.env"
    if [ -f "$STORE_ENV" ]; then
      echo "→ $ENV_FILE missing here — using shared fallback: $STORE_ENV"
      ENV_FILE="$STORE_ENV"
    fi
  fi
fi
# Fail closed: probing with process-default env against who-knows-what stack
# is how a wrong stack gets health-checked.
[ -z "$ENV_FILE" ] || [ -f "$ENV_FILE" ] || { echo "✗ configured env file missing: $ENV_FILE (no shared fallback either)"; exit 1; }
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  # Parsed, never sourced — same rule as env.sh: repo-controlled data must not
  # execute in the verifier.
  while IFS= read -r line || [ -n "$line" ]; do
    key="${line%%=*}"
    val="${line#*=}"
      case "$key" in
        *[!A-Za-z0-9_]*|""|[0-9]*) continue ;;
        PATH|IFS|ENV|BASH_ENV|SHELL|CDPATH|LD_*|DYLD_*|PS4|PROMPT_COMMAND|TMPDIR)
          echo "→ ignoring $key from env file — the verifier's own environment is not configurable from repo data"
          continue ;;
      esac
    [ "$line" = "$key" ] && continue
    case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; esac
    export "$key=$val"
  done < "$ENV_FILE"
fi

BASE_URL=$(jq -r '.base_url // empty' "$SETUP")
MARKER=$(jq -r '.marker // empty' .verify/run-env.json 2>/dev/null || echo "")
mkdir -p "$RUN_DIR/prechecks"

PARTS=$(jq -r '[.criteria[].dependsOn[]?] | unique | .[]' "$PLAN")

probe() { # part -> ok|down|unknown ; evidence to prechecks/<part>.log
  local part="$1" log="$RUN_DIR/prechecks/$1.log" custom
  { echo "part: $part"; date -u +"%Y-%m-%dT%H:%M:%SZ"; } > "$log"
  case "$part" in
    worker|sink|storage)
      custom=$(jq -r --arg p "$part" '.probes[$p] // empty' "$SETUP")
      if [ -z "$custom" ]; then echo "no probe configured" >> "$log"; echo unknown; return; fi
      if "$TIMEOUT_CMD" 10 bash -c "$custom" >> "$log" 2>&1; then echo ok; else echo down; fi ;;
    api)
      [ -n "$BASE_URL" ] || { echo "no base_url" >> "$log"; echo unknown; return; }
      # Any HTTP response proves the API is up; a 404 at the root is common
      # and healthy. Only a dead socket is down. curl prints 000 AND exits
      # non-zero on connection failure, so capture the code alone and judge
      # it — a fallback echo would concatenate into "000000" and read as ok.
      CODE=$("$TIMEOUT_CMD" 10 curl -s -o /dev/null -w '%{http_code}' "$BASE_URL" 2>> "$log")
      RC=$?
      echo "http_code: ${CODE:-none} (curl exit $RC)" >> "$log"
      if [ "$RC" -eq 0 ] || { [ -n "$CODE" ] && [ "$CODE" != "000" ]; }; then echo ok; else echo down; fi ;;
    browser)
      [ -n "$BASE_URL" ] || { echo "no base_url" >> "$log"; echo unknown; return; }
      BODY=$("$TIMEOUT_CMD" 10 curl -sf "$BASE_URL" 2>> "$log" || true)
      printf '%s\n' "$BODY" >> "$log"
      if printf '%s' "$BODY" | grep -q '<'; then echo ok; else echo down; fi ;;
    db)
      DB_ENV=$(jq -r '.observe.db_url_env // empty' "$SETUP")
      if [ -n "$DB_ENV" ] && [ -n "${!DB_ENV:-}" ] && [ -n "$MARKER" ]; then
        # Temporary table: session-scoped, auto-dropped; no permanent mutation.
        # Marker travels as a psql variable. The SQL goes via stdin (-f -):
        # psql does NOT interpolate :'m' inside a -c string.
        if printf '%s' "create temporary table _verify_precheck(m text); insert into _verify_precheck values (:'m'); select m from _verify_precheck where m = :'m' limit 1;" \
          | "$TIMEOUT_CMD" 10 psql "${!DB_ENV}" -v m="$MARKER" -tA -f - \
          >> "$log" 2>&1 && grep -q "$MARKER" "$log"; then echo ok; else echo down; fi
      else echo "no db_url_env resolvable" >> "$log"; echo unknown; fi ;;
    *) echo "no probe for unknown part" >> "$log"; echo unknown ;;
  esac
}

PARTS_JSON="{}"
for p in $PARTS; do
  s=$(probe "$p")
  echo "  $p: $s"
  PARTS_JSON=$(echo "$PARTS_JSON" | jq --arg p "$p" --arg s "$s" '.[$p] = $s')
done

TAINTED=$(jq --argjson parts "$PARTS_JSON" '
  [.criteria[] | {id: .id, down: [.dependsOn[]? | select($parts[.] == "down")][0]}
   | select(.down != null)]
  | map({(.id): .down}) | add // {}' "$PLAN")

UNCHECKED=$(echo "$PARTS_JSON" | jq '[to_entries[] | select(.value=="unknown") | .key]')

jq -n --argjson parts "$PARTS_JSON" --argjson tainted "$TAINTED" --argjson unchecked "$UNCHECKED" \
  '{parts: $parts, tainted: $tainted, unchecked: $unchecked}' > "$RUN_DIR/precheck.json"

DOWN=$(echo "$PARTS_JSON" | jq -r 'to_entries[] | select(.value=="down") | .key' | tr '\n' ' ')
[ -n "${DOWN// }" ] && echo "⚠ Down: $DOWN— dependent criteria will be marked could-not-verify"
echo "✓ Pipeline check complete → $RUN_DIR/precheck.json"
