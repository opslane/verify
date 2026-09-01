#!/usr/bin/env bash
# Expand the restricted contract placeholder grammar — ${VAR} and
# ${VAR:-default} only, no nesting, no command substitution — from stdin to
# stdout. The ONE bash implementation, mirrored exactly by the TS engine
# (pipeline/src/lib/steps.ts expandEnv), so every consumer resolves the same
# endpoint from a committed recipe-form contract.
#
#   expand.sh                       — expand stdin against the current env
#   expand.sh --load-env setup.json — first load the contract's env_file
#                                     (VERIFY_ENV_FILE override and shared-
#                                     store fallback, parsed never sourced —
#                                     same rules as env.sh/precheck.sh), so
#                                     expansion sees the environment boot saw
set -e
command -v python3 >/dev/null 2>&1 || { echo "✗ python3 not found — required to expand contract placeholders" >&2; exit 1; }

if [ "${1:-}" = "--load-env" ]; then
  SETUP="${2:?--load-env needs the setup.json path}"
  if [ -n "${VERIFY_ENV_FILE:-}" ]; then
    ENV_FILE="$VERIFY_ENV_FILE"
    [ -f "$ENV_FILE" ] || { echo "✗ VERIFY_ENV_FILE does not exist: $ENV_FILE" >&2; exit 1; }
  else
    ENV_FILE="$(jq -r '.env_file // empty' "$SETUP")"
    if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
      STORE_ENV="$(bash "$(cd "$(dirname "$0")" && pwd)/shared-store.sh" path)/local.env"
      [ -f "$STORE_ENV" ] && ENV_FILE="$STORE_ENV"
    fi
  fi
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      key="${line%%=*}"
      val="${line#*=}"
      case "$key" in
        ''|'#'*|*[!A-Za-z0-9_]*) continue ;;
      esac
      export "$key=$val"
    done < "$ENV_FILE"
  fi
fi

python3 -c 'import os, re, sys; print(re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}", lambda m: os.environ.get(m.group(1)) or m.group(2) or "", sys.stdin.read()), end="")'
