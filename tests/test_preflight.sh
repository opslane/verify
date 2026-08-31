#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

# Test 1: fails when dev server is down
export VERIFY_BASE_URL="http://localhost:19999"
output=$("$SCRIPT_DIR/preflight.sh" --skip-auth --skip-spec 2>&1)
exit_code=$?
[ $exit_code -ne 0 ] || { echo "FAIL: should exit non-zero when server down"; exit 1; }
echo "$output" | grep -q "not reachable" || { echo "FAIL: missing 'not reachable'. Got: $output"; exit 1; }

# Test 2: passes when server is up
python3 -c "
import http.server, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
s = http.server.HTTPServer(('', 19998), H)
t = threading.Thread(target=s.serve_forever); t.daemon=True; t.start()
import time; time.sleep(5)
" &
SERVER_PID=$!
sleep 0.5

export VERIFY_BASE_URL="http://localhost:19998"
output=$("$SCRIPT_DIR/preflight.sh" --skip-auth --skip-spec 2>&1)
exit_code=$?
[ $exit_code -eq 0 ] || { echo "FAIL: should pass when server up. Got: $output"; exit 1; }

# The setup contract replaces legacy config.json as the source of base_url.
TMP=$(mktemp -d)
mkdir -p "$TMP/.verify"
echo '{"base_url":"http://localhost:19998"}' > "$TMP/.verify/setup.json"
unset VERIFY_BASE_URL
output=$(cd "$TMP" && "$SCRIPT_DIR/preflight.sh" --skip-auth --skip-spec 2>&1)
exit_code=$?
rm -rf "$TMP"
kill $SERVER_PID 2>/dev/null
[ $exit_code -eq 0 ] || { echo "FAIL: setup.json base_url should pass. Got: $output"; exit 1; }

# Managed environments are booted after planning, so setup-aware callers can
# skip only the early server probe while retaining other preflight checks.
export VERIFY_BASE_URL="http://localhost:19999"
output=$("$SCRIPT_DIR/preflight.sh" --skip-server --skip-auth --skip-spec 2>&1)
exit_code=$?
[ $exit_code -eq 0 ] || { echo "FAIL: --skip-server should pass before managed boot. Got: $output"; exit 1; }

echo "PASS: preflight tests"
