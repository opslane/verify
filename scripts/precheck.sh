#!/usr/bin/env bash
# Pipeline checks: prove each part the criteria depend on works, before
# judging anything. A down part taints only the criteria that depend on it.
# Unknown (no probe available) never taints — unknown is not down — but is
# reported, and fails on unknown-depending criteria get flagged as possibly
# environmental by the report.
set -e
PLAN=".verify/plan.json"
SETUP=".verify/setup.json"
[ -f "$PLAN" ] && [ -f "$SETUP" ] || { echo "✗ plan.json or setup.json missing"; exit 1; }
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi

ENV_FILE="${VERIFY_ENV_FILE:-$(jq -r '.env_file // empty' "$SETUP")}"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

BASE_URL=$(jq -r '.base_url // empty' "$SETUP")
MARKER=$(jq -r '.marker // empty' .verify/run-env.json 2>/dev/null || echo "")
mkdir -p .verify/evidence/prechecks

PARTS=$(jq -r '[.criteria[].depends_on[]?] | unique | .[]' "$PLAN")

probe() { # part -> ok|down|unknown ; evidence to prechecks/<part>.log
  local part="$1" log=".verify/evidence/prechecks/$1.log" custom
  { echo "part: $part"; date -u +"%Y-%m-%dT%H:%M:%SZ"; } > "$log"
  case "$part" in
    worker|sink|storage)
      custom=$(jq -r --arg p "$part" '.probes[$p] // empty' "$SETUP")
      if [ -z "$custom" ]; then echo "no probe configured" >> "$log"; echo unknown; return; fi
      if "$TIMEOUT_CMD" 10 bash -c "$custom" >> "$log" 2>&1; then echo ok; else echo down; fi ;;
    api)
      [ -n "$BASE_URL" ] || { echo "no base_url" >> "$log"; echo unknown; return; }
      # Any HTTP response proves the API is up; a 404 at the root is common
      # and healthy. Only a dead socket (code 000) is down.
      CODE=$("$TIMEOUT_CMD" 10 curl -s -o /dev/null -w '%{http_code}' "$BASE_URL" 2>> "$log" || echo 000)
      echo "http_code: $CODE" >> "$log"
      if [ "$CODE" != "000" ]; then echo ok; else echo down; fi ;;
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
  [.criteria[] | {id: .id, down: [.depends_on[]? | select($parts[.] == "down")][0]}
   | select(.down != null)]
  | map({(.id): .down}) | add // {}' "$PLAN")

UNCHECKED=$(echo "$PARTS_JSON" | jq '[to_entries[] | select(.value=="unknown") | .key]')

jq -n --argjson parts "$PARTS_JSON" --argjson tainted "$TAINTED" --argjson unchecked "$UNCHECKED" \
  '{parts: $parts, tainted: $tainted, unchecked: $unchecked}' > .verify/precheck.json

DOWN=$(echo "$PARTS_JSON" | jq -r 'to_entries[] | select(.value=="down") | .key' | tr '\n' ' ')
[ -n "${DOWN// }" ] && echo "⚠ Down: $DOWN— dependent criteria will be marked could-not-verify"
echo "✓ Pipeline check complete → .verify/precheck.json"
