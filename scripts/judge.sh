#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs claude with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }
echo "→ Running Judge (Opus)..."

SKIPPED=$(jq -r '.skipped' .verify/plan.json)
# Read AC IDs (bash 3 compatible — no mapfile)
AC_IDS=()
while IFS= read -r line; do
  AC_IDS+=("$line")
done < <(jq -r '.criteria[].id' .verify/plan.json)

PROMPT_FILE=".verify/judge-prompt.txt"
# Build prompt by appending directly to file — avoids printf %b interpreting
# backslash sequences in log content (e.g. \n, \t inside agent logs)
{
  cat "$SCRIPT_DIR/prompts/judge.txt"
  printf "\n\nEVIDENCE:\n"
} > "$PROMPT_FILE"

for AC_ID in "${AC_IDS[@]}"; do
  AC_DESC=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .description' .verify/plan.json)
  printf "\n--- AC: %s ---\nCRITERION: %s\n" "$AC_ID" "$AC_DESC" >> "$PROMPT_FILE"
  AC_PROOF=$(jq -c --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .proof // {}' .verify/plan.json)
  MARKER=""
  [ -f .verify/run-env.json ] && MARKER=$(jq -r '.marker // empty' .verify/run-env.json 2>/dev/null || echo "")
  printf "DECLARED PROOF: %s\nRUN MARKER: %s\n" "$AC_PROOF" "$MARKER" >> "$PROMPT_FILE"

  LOG_FILE=".verify/evidence/$AC_ID/agent.log"
  if [ -f "$LOG_FILE" ]; then
    printf "AGENT LOG:\n" >> "$PROMPT_FILE"
    cat "$LOG_FILE" >> "$PROMPT_FILE"
    printf "\n" >> "$PROMPT_FILE"
  else
    printf "AGENT LOG: not found\n" >> "$PROMPT_FILE"
  fi

  # Embed one screenshot per AC — resize to 300px to keep prompt under limits
  SCREENSHOT=$(find ".verify/evidence/$AC_ID" -name "screenshot-*.png" 2>/dev/null | sort | head -1)
  if [ -f "$SCREENSHOT" ]; then
    THUMB=$(mktemp /tmp/verify-thumb-XXXXXX.png)
    trap "rm -f '$THUMB'" EXIT
    if command -v sips >/dev/null 2>&1; then
      sips -Z 300 "$SCREENSHOT" --out "$THUMB" >/dev/null 2>&1 || cp "$SCREENSHOT" "$THUMB"
    else
      cp "$SCREENSHOT" "$THUMB"
    fi
    printf "SCREENSHOT (%s): data:image/png;base64," "$(basename "$SCREENSHOT" .png)" >> "$PROMPT_FILE"
    base64 < "$THUMB" | tr -d '\n' >> "$PROMPT_FILE"
    printf "\n" >> "$PROMPT_FILE"
    rm -f "$THUMB"
  fi
done

printf "\nSKIPPED FROM PLAN: %s\n" "$SKIPPED" >> "$PROMPT_FILE"

REPORT_JSON=$("$CLAUDE" -p \
  --model opus \
  --dangerously-skip-permissions \
  < "$PROMPT_FILE" 2>/dev/null)

# Strip any markdown fences (jq . below will reformat, so don't strip blank lines)
REPORT_JSON=$(echo "$REPORT_JSON" | sed '/^```/d')

if ! echo "$REPORT_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Judge returned invalid JSON:"
  echo "$REPORT_JSON" | head -20
  exit 1
fi

RECONCILED=$(jq --slurpfile plan .verify/plan.json '
  . as $rep |
  ($plan[0].criteria | map(.id)) as $ids |
  .criteria = [ $ids[] as $id |
    ([$rep.criteria[]? | select(.ac_id == $id
       and (.status | IN("pass","fail","not_proven","could_not_verify")))][0]) //
    {ac_id: $id, status: "not_proven", proof_seen: false,
     did: "", observed: "",
     reasoning: "the judge returned no result for this criterion",
     evidence: ""} ] |
  # Verdict and summary are ALWAYS recomputed; the judge cannot shrink or
  # inflate the run.
  ([.criteria[] | select(.status=="pass" and .proof_seen==true)] | length) as $proven |
  (.criteria | length) as $total |
  .verdict = (if $proven == $total and $total > 0 then "pass"
              elif $proven > 0 then "partial" else "fail" end) |
  .summary = "\($proven)/\($total) proven"' <<< "$REPORT_JSON")
REPORT_JSON="$RECONCILED"

echo "$REPORT_JSON" | jq '.' > .verify/report.json

VERDICT=$(jq -r '.verdict' .verify/report.json)
SUMMARY=$(jq -r '.summary' .verify/report.json)
echo "✓ Judge complete: $SUMMARY (verdict: $VERDICT)"
