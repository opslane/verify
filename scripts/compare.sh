#!/usr/bin/env bash
# Manual compare-against-base. Usage:
#   VERIFY_ALLOW_DANGEROUS=1 compare.sh <base-ref> <ac-id> [<ac-id>...]
# Boots the base ref in its own uniquely-named worktree + throwaway stack
# (separately seeded, own marker), re-runs the chosen criteria there, and
# reports the comparison. Never automatic; never reuses the candidate's
# environment; hands the worktree the candidate's env file read-only.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs agents with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

BASE_REF="${1:?usage: compare.sh <base-ref> <ac-id>...}"; shift
[ "$#" -gt 0 ] || { echo "✗ name at least one AC id"; exit 1; }
[ -f .verify/report.json ] || { echo "✗ run /verify first; compare needs candidate results"; exit 1; }
if [ "$(jq -r '.mode' .verify/setup.json 2>/dev/null)" = "external" ]; then
  echo "✗ external mode reuses the already-running stack, which runs the CANDIDATE code —"
  echo "  a base comparison against it would compare the candidate with itself. Refusing."
  exit 1
fi
for id in "$@"; do
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "✗ invalid AC id: $id"; exit 1; }
  jq -e --arg id "$id" '.criteria[] | select(.id==$id)' .verify/plan.json > /dev/null \
    || { echo "✗ unknown AC id: $id"; exit 1; }
done

BASE_REPORT=$(mktemp "${TMPDIR:-/tmp}/verify-base-report-XXXXXX")
WT=$(mktemp -d /tmp/verify-base-wt-XXXXXX)
rmdir "$WT"   # git worktree add wants to create it
WT_CREATED=0
CAND_ROOT="$(pwd -P)"
CAND_ENV=""
EF=$(jq -r '.env_file // empty' .verify/setup.json 2>/dev/null || echo "")
if [ -n "$EF" ] && [ -f "$EF" ]; then
  case "$EF" in
    /*) CAND_ENV="$EF" ;;
    *) CAND_ENV="$CAND_ROOT/$EF" ;;
  esac
fi

cleanup() {
  [ "$WT_CREATED" = "1" ] && git worktree remove --force "$WT" 2>/dev/null || true
  rm -f "$BASE_REPORT"
}
trap cleanup EXIT

run_base() { # $1 = output report path; remaining args = AC ids
  local out="$1"; shift
  git worktree add --force "$WT" "$BASE_REF" > /dev/null || return 1
  WT_CREATED=1
  (
    set -e
    cd "$WT" || exit 1
    mkdir -p .verify
    cp "$CAND_ROOT/.verify/setup.json" .verify/setup.json
    cp "$CAND_ROOT/.verify/plan.json"  .verify/plan.json
    [ -f "$CAND_ROOT/.verify/auth.json" ] && cp "$CAND_ROOT/.verify/auth.json" .verify/auth.json
    [ -f "$CAND_ROOT/.verify/seed.sh" ]   && cp "$CAND_ROOT/.verify/seed.sh" .verify/seed.sh
    export VERIFY_ENV_FILE="$CAND_ENV"
    bash "$SCRIPT_DIR/env.sh" up
    trap 'bash "$SCRIPT_DIR/env.sh" down || true' EXIT
    bash "$SCRIPT_DIR/env.sh" seed
    if [ -f .verify/seed.sh ]; then
      BASE_MARKER=$(jq -r '.marker' .verify/run-env.json)
      bash .verify/seed.sh "$BASE_MARKER"
    fi
    bash "$SCRIPT_DIR/precheck.sh"
    for id in "$@"; do bash "$SCRIPT_DIR/agent.sh" "$id" "${AGENT_TIMEOUT:-240}"; done
    bash "$SCRIPT_DIR/judge.sh"
    cp .verify/report.json "$out"
  ) || return 1
}

BASE_OK=0
if [ -n "${BASE_RUNNER:-}" ]; then
  "$BASE_RUNNER" "$BASE_REPORT" "$@" || BASE_OK=$?
else
  run_base "$BASE_REPORT" "$@" || BASE_OK=$?
fi

reading() { # candidate base
  case "$1/$2" in
    */could_not_run)  echo "base could not run — no conclusion; reported as exactly that" ;;
    fail/fail)        echo "fails on base too — not this change's fault (harness, spec, or pre-existing issue)" ;;
    fail/pass)        echo "fails only on your change — likely a regression" ;;
    pass/fail)        echo "passes only on your change — the intended difference" ;;
    pass/pass)        echo "would have passed before your change — this criterion does not prove the change" ;;
    *)                echo "evidence too weak to compare — see both reasonings" ;;
  esac
}

RESULTS="[]"
for id in "$@"; do
  CAND=$(jq -r --arg id "$id" '[.criteria[] | select(.ac_id==$id) | .status][0] // "missing"' .verify/report.json)
  if [ "$BASE_OK" -ne 0 ] || [ ! -s "$BASE_REPORT" ]; then
    BASE="could_not_run"; BREASON="base environment or run failed"
  else
    BASE=$(jq -r --arg id "$id" '[.criteria[] | select(.ac_id==$id) | .status][0] // "could_not_run"' "$BASE_REPORT")
    BREASON=$(jq -r --arg id "$id" '[.criteria[] | select(.ac_id==$id) | .reasoning][0] // ""' "$BASE_REPORT")
  fi
  R=$(reading "$CAND" "$BASE")
  RESULTS=$(echo "$RESULTS" | jq --arg id "$id" --arg c "$CAND" --arg b "$BASE" --arg br "$BREASON" --arg r "$R" \
    '. + [{id: $id, candidate: $c, base: $b, base_reasoning: $br, reading: $r}]')
done

jq -n --arg ref "$BASE_REF" --argjson results "$RESULTS" \
  '{base_ref: $ref, results: $results}' > .verify/compare.json
jq -r '.results[] | "  \(.id): yours=\(.candidate) base=\(.base) → \(.reading)"' .verify/compare.json
echo "✓ Comparison → .verify/compare.json"
