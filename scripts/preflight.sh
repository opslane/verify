#!/usr/bin/env bash
set -e

SKIP_AUTH=false
SKIP_SPEC=false
for arg in "$@"; do
  case $arg in
    --skip-auth) SKIP_AUTH=true ;;
    --skip-spec) SKIP_SPEC=true ;;
  esac
done

# Check for gtimeout (macOS coreutils) or timeout (Linux)
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  echo "✗ timeout command not found. Install: brew install coreutils"
  exit 1
fi
export TIMEOUT_CMD

# Engine selection: browse (v2, default) or mcp (v1 legacy)
VERIFY_ENGINE="${VERIFY_ENGINE:-browse}"
export VERIFY_ENGINE

if [ "$VERIFY_ENGINE" = "browse" ]; then
  BROWSE_BIN="${BROWSE_BIN:-$HOME/.cache/verify/browse}"
  if [ ! -x "$BROWSE_BIN" ]; then
    echo "→ Browse binary not found. Installing..."
    BROWSE_BIN=$(bash "$(dirname "$0")/install-browse.sh" | tail -1)
  fi
  export BROWSE_BIN
  echo "✓ Browse binary: $BROWSE_BIN"

  # Kill existing daemon so we can restart with video recording
  "$BROWSE_BIN" stop >/dev/null 2>&1 || true
  sleep 1

  # Start fresh daemon with video recording enabled
  BROWSE_VIDEO_DIR="$(pwd)/.verify/evidence"
  export BROWSE_VIDEO_DIR
  mkdir -p "$BROWSE_VIDEO_DIR"
  echo "✓ Video recording: $BROWSE_VIDEO_DIR"
fi

# Load config inline
CONFIG_FILE=".verify/config.json"
VERIFY_BASE_URL="${VERIFY_BASE_URL:-$(jq -r '.baseUrl // "http://localhost:3000"' "$CONFIG_FILE" 2>/dev/null || echo "http://localhost:3000")}"
VERIFY_AUTH_CHECK_URL="${VERIFY_AUTH_CHECK_URL:-$(jq -r '.authCheckUrl // "/api/me"' "$CONFIG_FILE" 2>/dev/null || echo "/api/me")}"
VERIFY_SPEC_PATH="${VERIFY_SPEC_PATH:-$(jq -r '.specPath // empty' "$CONFIG_FILE" 2>/dev/null || echo "")}"
export VERIFY_BASE_URL VERIFY_AUTH_CHECK_URL VERIFY_SPEC_PATH

# 1. Dev server health check
PORT=$(echo "$VERIFY_BASE_URL" | grep -oE ':[0-9]+' | tr -d ':')
echo "→ Checking dev server at $VERIFY_BASE_URL..."
if ! curl -sf --max-time 5 "$VERIFY_BASE_URL" > /dev/null 2>&1; then
  # Surface which process is occupying the port if any
  if [ -n "$PORT" ]; then
    OCCUPANT=$(lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -I{} ps -p {} -o pid=,command= 2>/dev/null | head -1 || true)
    if [ -n "$OCCUPANT" ]; then
      echo "✗ Port $PORT is occupied by a different process: $OCCUPANT"
      echo "  Check your baseUrl in .verify/config.json and start the right dev server."
    else
      echo "✗ Dev server not reachable at $VERIFY_BASE_URL. Start it and retry."
    fi
  else
    echo "✗ Dev server not reachable at $VERIFY_BASE_URL. Start it and retry."
  fi
  exit 1
fi
echo "✓ Dev server reachable"

# 2. Auth — detect mode and authenticate
if [ "$SKIP_AUTH" = false ]; then
  # Read auth config
  AUTH_METHOD=$(jq -r '.auth.method // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  AUTH_EMAIL=$(jq -r '.auth.email // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  AUTH_PASSWORD=$(jq -r '.auth.password // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  AUTH_LOGIN_URL=$(jq -r '.auth.loginUrl // "/auth/login"' "$CONFIG_FILE" 2>/dev/null || echo "/auth/login")

  if [ "$VERIFY_ENGINE" = "browse" ]; then
    # Start daemon if needed
    "$BROWSE_BIN" status >/dev/null 2>&1 || "$BROWSE_BIN" goto "about:blank" >/dev/null 2>&1

    if [ "$AUTH_METHOD" = "credentials" ] && [ -n "$AUTH_EMAIL" ] && [ -n "$AUTH_PASSWORD" ]; then
      # Mode A: Login with credentials — use a mini agent to handle any login form
      AUTH_PASSWORD="${VERIFY_AUTH_PASSWORD:-$AUTH_PASSWORD}"
      echo "→ Logging in as $AUTH_EMAIL..."
      echo "  (credentials will be sent to Claude Haiku for form filling)"
      LOGIN_URL="${VERIFY_BASE_URL}${AUTH_LOGIN_URL}"
      "$BROWSE_BIN" goto "$LOGIN_URL" >/dev/null 2>&1
      sleep 2

      LOGIN_PROMPT="You are a login agent. Log in using the browse binary and exit.

BROWSE BINARY: $BROWSE_BIN
EMAIL: $AUTH_EMAIL
PASSWORD: $AUTH_PASSWORD

1. Run: $BROWSE_BIN snapshot -i
2. Look at the interactive elements. Find the email and password fields.
   - If you see a 'Login with Email' or 'Sign in with Email' button but no input fields, click that button first, then snapshot -i again.
3. Fill the email field: $BROWSE_BIN fill @eN \"$AUTH_EMAIL\"
4. Fill the password field: $BROWSE_BIN fill @eN \"$AUTH_PASSWORD\"
5. Click the submit/login button: $BROWSE_BIN click @eN
6. Wait 2 seconds, then run: $BROWSE_BIN snapshot -i
7. If you see a dashboard/home page (no login form), respond with just: LOGIN_OK
8. If you still see a login form or error, respond with just: LOGIN_FAILED

Respond with ONLY LOGIN_OK or LOGIN_FAILED. Nothing else."

      CLAUDE="${CLAUDE_BIN:-claude}"
      LOGIN_RESULT=$(echo "$LOGIN_PROMPT" | $TIMEOUT_CMD 60 "$CLAUDE" -p --model haiku --dangerously-skip-permissions 2>/dev/null | tail -1)

      if echo "$LOGIN_RESULT" | grep -q "LOGIN_OK"; then
        echo "✓ Logged in as $AUTH_EMAIL"
      else
        echo "✗ Login failed for $AUTH_EMAIL"
        echo "  Check credentials in .verify/config.json or loginUrl"
        "$BROWSE_BIN" snapshot -i 2>/dev/null | head -5
        exit 1
      fi

    elif [ -f ".verify/cookies.json" ]; then
      # Mode B: Load saved cookies
      echo "→ Loading saved cookies..."
      jq -r '.[] | "\(.name)=\(.value)"' .verify/cookies.json 2>/dev/null | while IFS= read -r cookie; do
        "$BROWSE_BIN" cookie "$cookie" >/dev/null 2>&1 || true
      done
      "$BROWSE_BIN" goto "$VERIFY_BASE_URL" >/dev/null 2>&1
      sleep 2
      SNAPSHOT=$("$BROWSE_BIN" snapshot -i 2>/dev/null || echo "")
      if echo "$SNAPSHOT" | grep -qi "login\|sign\.in\|password\|log\.in"; then
        echo "✗ Saved cookies expired. Re-run /verify-setup or add credentials to config."
        exit 1
      fi
      echo "✓ Auth valid (saved cookies)"

    else
      # No auth configured — check if daemon already has cookies (from /verify-setup)
      echo "→ Checking auth via browse daemon..."
      "$BROWSE_BIN" goto "$VERIFY_BASE_URL" >/dev/null 2>&1
      sleep 2
      SNAPSHOT=$("$BROWSE_BIN" snapshot -i 2>/dev/null || echo "")
      if [ -z "$SNAPSHOT" ]; then
        echo "→ No auth state. Add credentials to .verify/config.json or run /verify-setup."
        echo "  (Continuing without auth — some pages may redirect to login.)"
      elif echo "$SNAPSHOT" | grep -qi "login\|sign\.in\|password\|log\.in"; then
        echo "✗ Not authenticated. Add auth to .verify/config.json:"
        echo '  {"auth": {"method": "credentials", "loginUrl": "/auth/login", "email": "...", "password": "..."}}'
        exit 1
      else
        echo "✓ Auth valid (browse daemon)"
      fi
    fi
  else
    # MCP engine (legacy): validate via auth.json + curl
    if [ ! -f ".verify/auth.json" ]; then
      echo "✗ No auth state found. Run /verify-setup first."
      exit 1
    fi
    AUTH_URL="${VERIFY_BASE_URL}${VERIFY_AUTH_CHECK_URL}"
    echo "→ Checking auth at $AUTH_URL..."
    COOKIE_STR=$(jq -r '[.cookies[]? | "\(.name)=\(.value)"] | join("; ")' .verify/auth.json 2>/dev/null || echo "")
    HTTP_CODE=$(curl -sf --max-time 5 \
      ${COOKIE_STR:+-H "Cookie: $COOKIE_STR"} \
      -o /dev/null -w "%{http_code}" \
      "$AUTH_URL" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "000" ]; then
      echo "✗ Session expired or invalid (HTTP $HTTP_CODE). Run /verify-setup to re-authenticate."
      exit 1
    fi
    echo "✓ Auth valid (HTTP $HTTP_CODE)"
  fi
fi

# 3. Spec doc detection
if [ "$SKIP_SPEC" = false ]; then
  echo "→ Finding spec doc..."
  SPEC_PATH=""

  if [ -n "$VERIFY_SPEC_PATH" ]; then
    SPEC_PATH="$VERIFY_SPEC_PATH"
  else
    # Changed files in diff (tracked)
    SPEC_PATH=$(git diff --name-only HEAD 2>/dev/null | grep "^docs/plans/.*\.md$" | head -1 || true)
    # Newly added (untracked)
    if [ -z "$SPEC_PATH" ]; then
      SPEC_PATH=$(git ls-files --others --exclude-standard 2>/dev/null | grep "^docs/plans/.*\.md$" | head -1 || true)
    fi
    # Fall back to newest by mtime (avoid xargs ls -t which breaks on spaces)
    if [ -z "$SPEC_PATH" ]; then
      SPEC_PATH=$(find docs/plans -name "*.md" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}' || true)
      # macOS fallback: find doesn't support -printf
      if [ -z "$SPEC_PATH" ]; then
        SPEC_PATH=$(ls -t docs/plans/*.md 2>/dev/null | head -1 || true)
      fi
    fi
  fi

  if [ -z "$SPEC_PATH" ] || [ ! -f "$SPEC_PATH" ]; then
    echo "✗ No spec doc found. Set specPath in .verify/config.json or add a plan doc to docs/plans/."
    exit 1
  fi

  echo "✓ Spec doc: $SPEC_PATH"
  mkdir -p .verify
  echo "$SPEC_PATH" > .verify/.spec_path
fi

echo "✓ Pre-flight complete"
