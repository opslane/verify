#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

cat > .verify/report.json << 'JSON'
{"verdict":"partial_pass","summary":"2/3 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header fixed","evidence":".verify/evidence/ac1/screenshot-after_scroll.png","code_review":{"status":"clean","findings":[],"coverage":"full"}},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger missing","evidence":".verify/evidence/ac2/screenshot-initial.png","code_review":{"status":"has_findings","findings":["Missing tablet breakpoint"],"coverage":"partial"}},{"ac_id":"ac3","status":"timeout","reasoning":"Timed out","evidence":"","code_review":{"status":"unavailable","findings":[],"coverage":"unknown"}}],"skipped":["ac4: too vague"]}
JSON

output=$("$SCRIPT_DIR/report.sh" 2>&1)
echo "$output" | grep -q "✓ ac1" || { echo "FAIL: missing ✓ ac1. Output: $output"; exit 1; }
echo "$output" | grep -q "✗ ac2" || { echo "FAIL: missing ✗ ac2. Output: $output"; exit 1; }
echo "$output" | grep -q "ac3"   || { echo "FAIL: missing ac3. Output: $output"; exit 1; }
echo "$output" | grep -q "2/3"   || { echo "FAIL: missing 2/3 summary. Output: $output"; exit 1; }

# Code review lines
echo "$output" | grep -q "code: clean"        || { echo "FAIL: missing 'code: clean' for ac1. Output: $output"; exit 1; }
echo "$output" | grep -q "code: ⚠"            || { echo "FAIL: missing code review findings for ac2. Output: $output"; exit 1; }
echo "$output" | grep -q "code: unavailable"   || { echo "FAIL: missing 'code: unavailable' for ac3. Output: $output"; exit 1; }

echo "PASS: reporter tests"
