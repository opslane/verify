#!/usr/bin/env bash
# Download and cache gstack browse binary at ~/.cache/verify/browse
set -e

GSTACK_VERSION="${GSTACK_VERSION:-v1.1.0}"
CACHE_DIR="$HOME/.cache/verify"
BROWSE_BIN="$CACHE_DIR/browse"
VERSION_FILE="$CACHE_DIR/browse.version"

# Skip if already installed at correct version
if [ -x "$BROWSE_BIN" ] && [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$GSTACK_VERSION" ]; then
  echo "✓ Browse binary up to date ($GSTACK_VERSION)"
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

echo "→ Installing gstack browse $GSTACK_VERSION ($OS-$ARCH)..."

# Try GitHub release first
RELEASE_URL="https://github.com/garrytan/gstack/releases/download/$GSTACK_VERSION/browse-$OS-$ARCH"
if curl -fsSL --head "$RELEASE_URL" >/dev/null 2>&1; then
  curl -fsSL "$RELEASE_URL" -o "$BROWSE_BIN"
  chmod +x "$BROWSE_BIN"
  echo "$GSTACK_VERSION" > "$VERSION_FILE"
  echo "✓ Installed browse binary from release"
  echo "$BROWSE_BIN"
  exit 0
fi

# Fallback: build from source (requires bun + git)
echo "→ No pre-built binary found. Building from source..."
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ Bun is required to build gstack browse from source."
  echo "  Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

BUILD_DIR=$(mktemp -d)
trap "rm -rf '$BUILD_DIR'" EXIT
git clone --depth 1 --branch "$GSTACK_VERSION" https://github.com/garrytan/gstack.git "$BUILD_DIR" 2>/dev/null || \
  git clone --depth 1 https://github.com/garrytan/gstack.git "$BUILD_DIR"
cd "$BUILD_DIR"
bun install
bun run build
cp browse/dist/browse "$BROWSE_BIN"
chmod +x "$BROWSE_BIN"
echo "$GSTACK_VERSION" > "$VERSION_FILE"
echo "✓ Built and installed browse binary"
echo "$BROWSE_BIN"
