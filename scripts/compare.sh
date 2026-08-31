#!/usr/bin/env bash
# Manual compare-against-base plumbing. Usage:
#   compare.sh up <base-ref>   — boot the base ref in its own worktree + stack
#   compare.sh down            — tear it down and remove the worktree
#
# The skill drives the chosen criteria in the printed worktree exactly the way
# it drove them on the candidate, then reads both observations side by side.
# This script only provides the environment: a separately seeded stack running
# the OLD code, with the candidate's setup contract, auth state, and reviewed
# seed script carried over. It never runs automatically.
#
# Reading the comparison (the skill prints one line per compared criterion):
#   fails on base too        -> not this change's fault (harness, spec, or pre-existing)
#   fails only on candidate  -> likely a regression
#   passes only on candidate -> the intended difference
#   passes on base too       -> would have passed before the change; proves nothing
#   base could not run       -> no conclusion; reported as exactly that
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CMD="${1:?usage: compare.sh up <base-ref> | compare.sh down}"
WT_STATE=".verify/base-worktree-path"

case "$CMD" in
  up)
    BASE_REF="${2:?usage: compare.sh up <base-ref>}"
    [ -f .verify/setup.json ] || { echo "✗ .verify/setup.json not found. Run /verify-setup."; exit 1; }
    if [ "$(jq -r '.mode' .verify/setup.json 2>/dev/null)" = "external" ]; then
      echo "✗ external mode reuses the already-running stack, which runs the CANDIDATE code —"
      echo "  a base comparison against it would compare the candidate with itself. Refusing."
      exit 1
    fi
    git rev-parse --verify --quiet "$BASE_REF^{commit}" > /dev/null \
      || { echo "✗ unknown revision: $BASE_REF"; exit 1; }

    CAND_ROOT="$(pwd -P)"
    WT=$(mktemp -d "${TMPDIR:-/tmp}/verify-base-wt-XXXXXX")
    rmdir "$WT"   # git worktree add wants to create it
    git worktree add --force "$WT" "$BASE_REF" > /dev/null
    printf '%s\n' "$WT" > "$WT_STATE"

    (
      set -e
      cd "$WT"
      mkdir -p .verify
      cp "$CAND_ROOT/.verify/setup.json" .verify/setup.json
      [ -f "$CAND_ROOT/.verify/auth.json" ] && cp "$CAND_ROOT/.verify/auth.json" .verify/auth.json
      [ -f "$CAND_ROOT/.verify/seed.sh" ]   && cp "$CAND_ROOT/.verify/seed.sh" .verify/seed.sh
      # The worktree has no ignored local env file; hand it the candidate's.
      EF=$(jq -r '.env_file // empty' .verify/setup.json)
      if [ -n "$EF" ] && [ -f "$CAND_ROOT/$EF" ]; then
        export VERIFY_ENV_FILE="$CAND_ROOT/$EF"
      fi
      bash "$SCRIPT_DIR/env.sh" up
      bash "$SCRIPT_DIR/env.sh" seed
      if [ -f .verify/seed.sh ]; then
        BASE_MARKER=$(jq -r '.marker' .verify/run-env.json)
        VERIFY_BASE_URL="$(jq -r '.base_url // empty' .verify/setup.json)" \
          bash .verify/seed.sh "$BASE_MARKER"
      fi
    ) || {
      git worktree remove --force "$WT" 2>/dev/null || true
      rm -f "$WT_STATE"
      echo "✗ base environment failed to come up — report it as 'base could not run', never reinterpret"
      exit 1
    }
    echo "✓ Base stack up in worktree: $WT"
    echo "  Drive the chosen criteria there exactly as on the candidate, then: compare.sh down"
    ;;
  down)
    WT=$(cat "$WT_STATE" 2>/dev/null || echo "")
    if [ -n "$WT" ] && [ -d "$WT" ]; then
      ( cd "$WT" && bash "$SCRIPT_DIR/env.sh" down ) || true
      git worktree remove --force "$WT" 2>/dev/null || true
    fi
    rm -f "$WT_STATE"
    echo "✓ Base worktree removed"
    ;;
  *) echo "usage: compare.sh up <base-ref> | compare.sh down"; exit 1 ;;
esac
