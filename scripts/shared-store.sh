#!/usr/bin/env bash
# Per-repo shared store, so fresh git worktrees inherit the files git ignores.
#
# A worktree is a checkout: it gets the committed setup contract for free, but
# not the captured login state (auth.json) or the local env file the contract
# names. Those live once per repo under ~/.verify/<repo-slug>/ and every
# worktree pulls them on demand.
#
#   shared-store.sh path   — print the store directory for this repo
#   shared-store.sh pull   — copy auth.json into .verify/ when missing;
#                            report whether a fallback env file exists
#   shared-store.sh push   — copy this checkout's auth.json and resolved env
#                            file into the store for other worktrees
#
# The store holds a login session and local config, not passwords or keys —
# same trust level as the gitignored .verify/ directory it mirrors. Deleting
# the folder revokes it everywhere.
set -e

slug() {
  local url
  url=$(git remote get-url origin 2>/dev/null || echo "")
  if [ -n "$url" ]; then
    # git@github.com:org/repo.git and https://github.com/org/repo -> github.com-org-repo
    printf '%s' "$url" \
      | sed -E 's|^[a-z+]+://||; s|^git@||; s|:|/|; s|\.git$||' \
      | tr '/' '-' | tr -cd 'A-Za-z0-9._-'
  else
    basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" | tr -cd 'A-Za-z0-9._-'
  fi
}

STORE="${VERIFY_STORE_ROOT:-$HOME/.verify}/$(slug)"
CMD="${1:-path}"

case "$CMD" in
  path)
    echo "$STORE"
    ;;
  pull)
    mkdir -p .verify
    PULLED=0
    if [ ! -f .verify/auth.json ] && [ -f "$STORE/auth.json" ]; then
      cp "$STORE/auth.json" .verify/auth.json
      echo "✓ auth.json pulled from $STORE (delete the store to revoke everywhere)"
      PULLED=1
    fi
    # The env file is never copied into the repo (it stays wherever the user
    # keeps it); scripts consume it via the VERIFY_ENV_FILE override instead.
    if [ -f "$STORE/local.env" ]; then
      echo "env-fallback: $STORE/local.env"
      PULLED=1
    fi
    [ "$PULLED" = 0 ] && echo "nothing to pull (store: $STORE)" || true
    ;;
  push)
    mkdir -p "$STORE"
    chmod 700 "${VERIFY_STORE_ROOT:-$HOME/.verify}" "$STORE" 2>/dev/null || true
    PUSHED=0
    if [ -f .verify/auth.json ]; then
      cp .verify/auth.json "$STORE/auth.json"
      chmod 600 "$STORE/auth.json" 2>/dev/null || true
      echo "✓ auth.json shared for this repo's worktrees"
      PUSHED=1
    fi
    EF=$(jq -r '.env_file // empty' .verify/setup.json 2>/dev/null || echo "")
    if [ -n "$EF" ] && [ -f "$EF" ]; then
      cp "$EF" "$STORE/local.env"
      chmod 600 "$STORE/local.env" 2>/dev/null || true
      echo "✓ $EF shared as the env fallback for this repo's worktrees"
      PUSHED=1
    fi
    [ "$PUSHED" = 0 ] && echo "nothing to push (no .verify/auth.json and no resolvable env file)" || true
    ;;
  *) echo "usage: shared-store.sh path|pull|push"; exit 1 ;;
esac
