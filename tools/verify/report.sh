#!/usr/bin/env bash
[ -f ".verify/report.json" ] || { echo "✗ No report found. Run /verify first."; exit 1; }

SUMMARY=$(jq -r '.summary' .verify/report.json)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Verify — $SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

jq -c '.criteria[]' .verify/report.json | while IFS= read -r criterion; do
  AC_ID=$(echo "$criterion" | jq -r '.ac_id')
  STATUS=$(echo "$criterion" | jq -r '.status')
  REASON=$(echo "$criterion" | jq -r '.reasoning')
  case "$STATUS" in
    pass)    echo "  ✓ $AC_ID: $REASON" ;;
    fail)    echo "  ✗ $AC_ID: $REASON" ;;
    timeout) echo "  ⏱ $AC_ID: timed out" ;;
    error)   echo "  ⚠ $AC_ID: $REASON" ;;
    *)       echo "  ? $AC_ID: $STATUS — $REASON" ;;
  esac
done

SKIPPED_COUNT=$(jq '.skipped | length' .verify/report.json)
if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  jq -r '.skipped[]' .verify/report.json | while IFS= read -r msg; do
    echo "  ⚠ Skipped: $msg"
  done
fi

echo ""

# Debug hints for failures
jq -r '.criteria[] | select(.status=="fail") | .ac_id' .verify/report.json | while IFS= read -r AC_ID; do
  TRACE=".verify/evidence/$AC_ID/trace"
  VIDEO=".verify/evidence/$AC_ID/session.webm"
  [ -d "$TRACE" ] && echo "  Debug: npx playwright show-report $TRACE"
  [ -f "$VIDEO" ]  && echo "  Video: open $VIDEO"
done
