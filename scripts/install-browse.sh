#!/usr/bin/env bash
# Build and cache gstack browse at ~/.cache/verify/gstack
# The binary must live inside the gstack repo — it resolves server.ts relative to itself.
# Requires: bun, git
set -e

CACHE_DIR="$HOME/.cache/verify"
GSTACK_DIR="$CACHE_DIR/gstack"
BROWSE_BIN="$GSTACK_DIR/browse/dist/browse"
VERSION_FILE="$CACHE_DIR/browse.version"
GSTACK_SHA="${GSTACK_SHA:-main}"

# Skip if already built and version matches
if [ -x "$BROWSE_BIN" ] && [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$GSTACK_SHA" ]; then
  CACHED_VERSION=$(cat "$VERSION_FILE" 2>/dev/null || echo "unknown")
  echo "✓ Browse binary cached ($CACHED_VERSION)"
  echo "$BROWSE_BIN"
  exit 0
fi

# Check prerequisites
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ Bun is required to build gstack browse."
  echo "  Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

mkdir -p "$CACHE_DIR"

echo "→ Building gstack browse from source (one-time)..."

if [ -d "$GSTACK_DIR" ]; then
  cd "$GSTACK_DIR" && git pull --ff-only 2>/dev/null || true
else
  git clone --depth 1 --branch "$GSTACK_SHA" https://github.com/garrytan/gstack.git "$GSTACK_DIR"
  cd "$GSTACK_DIR"
fi

bun install
bun run build

# Also install Playwright's Chromium if not present
bunx playwright install chromium 2>/dev/null || true

echo "$GSTACK_SHA" > "$VERSION_FILE"
chmod +x "$BROWSE_BIN"

echo "✓ Built and installed browse binary"
echo "$BROWSE_BIN"
