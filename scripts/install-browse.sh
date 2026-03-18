#!/usr/bin/env bash
# Install gstack browse binary — download pre-built or build from source
set -e

CACHE_DIR="$HOME/.cache/verify"
BROWSE_BIN="$CACHE_DIR/browse"
VERSION_FILE="$CACHE_DIR/browse.version"
BROWSE_VERSION="${BROWSE_VERSION:-latest}"

# Skip if already installed
if [ -x "$BROWSE_BIN" ]; then
  echo "✓ Browse binary cached ($(cat "$VERSION_FILE" 2>/dev/null || echo "unknown"))"
  echo "$BROWSE_BIN"
  exit 0
fi

mkdir -p "$CACHE_DIR"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
esac

echo "→ Installing browse ($OS-$ARCH)..."

# Try pre-built binary from GitHub releases
REPO="opslane/verify"
if [ "$BROWSE_VERSION" = "latest" ]; then
  RELEASE_URL="https://github.com/$REPO/releases/latest/download/browse-$OS-$ARCH"
else
  RELEASE_URL="https://github.com/$REPO/releases/download/$BROWSE_VERSION/browse-$OS-$ARCH"
fi

if curl -fsSL --head "$RELEASE_URL" >/dev/null 2>&1; then
  curl -fsSL "$RELEASE_URL" -o "$BROWSE_BIN"
  chmod +x "$BROWSE_BIN"
  echo "$BROWSE_VERSION" > "$VERSION_FILE"
  echo "✓ Downloaded pre-built browse binary"
  echo "$BROWSE_BIN"
  exit 0
fi

echo "→ No pre-built binary available. Building from source..."

# Fallback: build from source (requires bun + git)
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ No pre-built binary for $OS-$ARCH and bun not installed."
  echo "  Install bun: curl -fsSL https://bun.sh/install | bash"
  echo "  Or download a binary from https://github.com/$REPO/releases"
  exit 1
fi

GSTACK_DIR="$CACHE_DIR/gstack"
GSTACK_SHA="${GSTACK_SHA:-main}"

if [ -d "$GSTACK_DIR" ]; then
  cd "$GSTACK_DIR" && git pull --ff-only 2>/dev/null || true
else
  git clone --depth 1 --branch "$GSTACK_SHA" https://github.com/garrytan/gstack.git "$GSTACK_DIR"
  cd "$GSTACK_DIR"
fi

bun install
bun run build
bunx playwright install chromium 2>/dev/null || true

# For source builds, the binary must stay in the gstack tree (it resolves server.ts relative to itself)
# So we symlink instead of copying
ln -sf "$GSTACK_DIR/browse/dist/browse" "$BROWSE_BIN"
git rev-parse --short HEAD > "$VERSION_FILE"
chmod +x "$GSTACK_DIR/browse/dist/browse"

echo "✓ Built browse binary from source"
echo "$BROWSE_BIN"
