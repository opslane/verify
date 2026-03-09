#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cat > .verify/report.json << 'JSON'
{"verdict":"partial","summary":"2/3 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header fixed","evidence":".verify/evidence/ac1/screenshot-after_scroll.png"},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger missing","evidence":".verify/evidence/ac2/screenshot-initial.png"},{"ac_id":"ac3","status":"timeout","reasoning":"Timed out","evidence":""}],"skipped":["ac4: too vague"]}
JSON

output=$("$SCRIPT_DIR/report.sh" 2>&1)
echo "$output" | grep -q "✓ ac1" || { echo "FAIL: missing ✓ ac1. Output: $output"; exit 1; }
echo "$output" | grep -q "✗ ac2" || { echo "FAIL: missing ✗ ac2. Output: $output"; exit 1; }
echo "$output" | grep -q "ac3"   || { echo "FAIL: missing ac3. Output: $output"; exit 1; }
echo "$output" | grep -q "2/3"   || { echo "FAIL: missing 2/3 summary. Output: $output"; exit 1; }

echo "PASS: reporter tests"
