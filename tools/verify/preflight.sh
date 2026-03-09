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

# 2. Auth validity check
if [ "$SKIP_AUTH" = false ]; then
  if [ ! -f ".verify/auth.json" ]; then
    echo "✗ No auth state found. Run /verify setup first."
    exit 1
  fi
  AUTH_URL="${VERIFY_BASE_URL}${VERIFY_AUTH_CHECK_URL}"
  echo "→ Checking auth at $AUTH_URL..."
  # Build Cookie header string from Playwright storageState JSON
  COOKIE_STR=$(jq -r '[.cookies[]? | "\(.name)=\(.value)"] | join("; ")' .verify/auth.json 2>/dev/null || echo "")
  HTTP_CODE=$(curl -sf --max-time 5 \
    ${COOKIE_STR:+-H "Cookie: $COOKIE_STR"} \
    -o /dev/null -w "%{http_code}" \
    "$AUTH_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "000" ]; then
    echo "✗ Session expired or invalid (HTTP $HTTP_CODE). Run /verify setup to re-authenticate."
    exit 1
  fi
  echo "✓ Auth valid (HTTP $HTTP_CODE)"
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
