#!/bin/bash
# Spike 1: Test executor prompt on 3 Documenso ACs
# Usage: bash pipeline/spikes/executor/run-spike.sh

set -euo pipefail

BROWSE_BIN=~/.cache/verify/gstack/browse/dist/browse
BASE_URL="http://localhost:3003"
SPIKE_DIR="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE_BASE="$SPIKE_DIR/evidence"
PROMPT_TEMPLATE="$SPIKE_DIR/prompt.txt"

# Check prerequisites
if ! curl -sf "$BASE_URL" > /dev/null 2>&1; then
  echo "ERROR: Documenso not running at $BASE_URL"
  exit 1
fi

if [ ! -f "$BROWSE_BIN" ]; then
  echo "ERROR: browse binary not found at $BROWSE_BIN"
  exit 1
fi

echo "=== SPIKE 1: Executor Prompt Test ==="
echo "Base URL: $BASE_URL"
echo "Browse: $BROWSE_BIN"
echo ""

# Define 3 test ACs
declare -a AC_IDS=("ac1" "ac2" "ac3")
declare -a AC_DESCS=(
  "The Documents page shows tabs for Inbox, Pending, Completed, Draft, and All. The All tab should be visible and the document list should display at least one document."
  "On the Documents page, clicking the Pending tab filters the document list to show only documents with Pending status. The tab should show a count badge."
  "The Templates page (accessible from the top navigation) shows an empty state message when no templates exist, with text containing 'You have not yet created any templates'."
)

# No diff hints for spike 1 (we test without hints first)
DIFF_HINTS="No diff information available. Navigate using the app's UI."

RESULTS=()
PASS_COUNT=0
TOTAL=3

for i in 0 1 2; do
  AC_ID="${AC_IDS[$i]}"
  AC_DESC="${AC_DESCS[$i]}"
  EVIDENCE_DIR="$EVIDENCE_BASE/$AC_ID"
  mkdir -p "$EVIDENCE_DIR"

  echo "--- AC $AC_ID ---"
  echo "Description: $AC_DESC"
  echo ""

  # Build prompt from template
  PROMPT=$(cat "$PROMPT_TEMPLATE")
  PROMPT="${PROMPT//\{\{ac_description\}\}/$AC_DESC}"
  PROMPT="${PROMPT//\{\{baseUrl\}\}/$BASE_URL}"
  PROMPT="${PROMPT//\{\{browseBin\}\}/$BROWSE_BIN}"
  PROMPT="${PROMPT//\{\{evidenceDir\}\}/$EVIDENCE_DIR}"
  PROMPT="${PROMPT//\{\{acId\}\}/$AC_ID}"
  PROMPT="${PROMPT//\{\{diffHints\}\}/$DIFF_HINTS}"

  echo "Running executor for $AC_ID..."

  # Run claude -p with the prompt
  RESULT=$(claude -p "$PROMPT" \
    --allowedTools "Bash(description:*browse*)" "Bash(description:*screenshot*)" "Bash(description:*Navigate*)" "Bash(description:*snapshot*)" "Bash(description:*click*)" "Bash(description:*fill*)" "Bash(description:*hover*)" "Bash(description:*wait*)" "Bash(description:*press*)" "Bash(description:*curl*)" \
    --model sonnet \
    --output-format json \
    2>/dev/null) || RESULT='{"error": "claude -p failed"}'

  # Extract the JSON result (claude -p with --output-format json wraps in a result field)
  echo "$RESULT" > "$EVIDENCE_DIR/raw-output.json"

  # Try to extract verdict
  VERDICT=$(echo "$RESULT" | jq -r '.result // .verdict // "error"' 2>/dev/null || echo "parse_error")

  echo "Raw output saved to $EVIDENCE_DIR/raw-output.json"
  echo "Verdict: $VERDICT"
  echo ""

  RESULTS+=("$AC_ID: $VERDICT")
done

echo ""
echo "=== SPIKE 1 RESULTS ==="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "Evidence: $EVIDENCE_BASE/"
echo ""
echo "Review the raw outputs in evidence/*/raw-output.json to assess quality."
