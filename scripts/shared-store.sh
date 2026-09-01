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
umask 077

# Everything is anchored to the repo toplevel so running from a subdirectory
# cannot create a stray subdir/.verify or miss the real files.
TOP=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "✗ not inside a git repository" >&2; exit 1; }
cd "$TOP"

slug() {
  # Readable prefix + content hash. The prefix is for humans; the hash is the
  # identity, so distinct repos can never collide ("host/a-b/c" vs "host/a/b-c"
  # both flatten to the same dashes) and a credential-bearing origin URL
  # (https://user:token@host/...) never reaches a directory name or a log line.
  local url ident prefix hash
  url=$(git remote get-url origin 2>/dev/null || echo "")
  url=$(printf '%s' "$url" | sed -E 's|//[^@/]*@|//|')   # strip userinfo
  if [ -n "$url" ]; then
    ident="$url"
  else
    ident=$(git rev-parse --git-common-dir 2>/dev/null || echo "$TOP")
    case "$ident" in /*) : ;; *) ident="$TOP/$ident" ;; esac
  fi
  prefix=$(printf '%s' "$ident" \
    | sed -E 's|^[a-z+]+://||; s|^git@||; s|:|/|; s|\.git$||' \
    | tr '/' '-' | tr -cd 'A-Za-z0-9._-' | cut -c1-60)
  hash=$(printf '%s' "$ident" | git hash-object --stdin | cut -c1-10)
  [ -n "$hash" ] || { echo "✗ could not derive a repo identity" >&2; exit 1; }
  printf '%s-%s' "${prefix:-repo}" "$hash"
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
    if [ ! -f .verify/auth.json ] && [ -f "$STORE/auth.json" ] && [ ! -L "$STORE/auth.json" ]; then
      cp "$STORE/auth.json" .verify/auth.json
      echo "✓ auth.json pulled from $STORE"
      echo "  (deleting the store stops NEW worktrees inheriting it; copies already"
      echo "   pulled into worktrees remain until their .verify/ is deleted)"
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
    for f in "$STORE/auth.json" "$STORE/local.env"; do
      [ -L "$f" ] && { echo "✗ refusing to write through symlink: $f"; exit 1; }
    done
    PUSHED=0
    if [ -f .verify/auth.json ]; then
      cp .verify/auth.json "$STORE/auth.json.tmp" && mv "$STORE/auth.json.tmp" "$STORE/auth.json"
      echo "✓ auth.json shared for this repo's worktrees"
      PUSHED=1
    fi
    EF=$(jq -r '.env_file // empty' .verify/setup.json 2>/dev/null || echo "")
    if [ -n "$EF" ]; then
      # A configured-but-missing env file is an error, not a shrug: pushing
      # nothing while an old local.env sits in the store is how a later
      # worktree verifies against a stale environment.
      [ -f "$EF" ] || { echo "✗ setup.json names env_file=$EF but it does not exist here — fix the contract or run push from a checkout that has it"; exit 1; }
      cp "$EF" "$STORE/local.env.tmp" && mv "$STORE/local.env.tmp" "$STORE/local.env"
      echo "✓ $EF shared as the env fallback for this repo's worktrees"
      PUSHED=1
    elif [ -f "$STORE/local.env" ]; then
      rm -f "$STORE/local.env"
      echo "→ contract no longer names an env file — removed the stale store fallback"
    fi
    [ "$PUSHED" = 0 ] && echo "nothing to push (no .verify/auth.json and no configured env file)" || true
    ;;
  *) echo "usage: shared-store.sh path|pull|push"; exit 1 ;;
esac
