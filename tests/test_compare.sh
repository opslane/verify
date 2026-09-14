#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q . && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m base
mkdir -p .verify
cat > .verify/setup.json << 'JSON'
{"mode":"none","compose_file":null,"boot":"","teardown":"","seed":[],
 "seed_data_files":[],"health_url":"","base_url":"","env_file":"","observe":{},"probes":{}}
JSON

# Unknown ref refused
"$SCRIPTS_DIR/compare.sh" up nonsense-ref 2>/dev/null && { echo "FAIL: unknown ref must be refused"; exit 1; }

# up boots a worktree on the base ref; down removes it
"$SCRIPTS_DIR/compare.sh" up HEAD || { echo "FAIL: up failed"; exit 1; }
WT=$(cat .verify/base-worktree-path)
[ -d "$WT" ] || { echo "FAIL: worktree missing"; exit 1; }
[ -f "$WT/.verify/run-env.json" ] || { echo "FAIL: base env not booted"; exit 1; }
"$SCRIPTS_DIR/compare.sh" down || { echo "FAIL: down failed"; exit 1; }
[ -d "$WT" ] && { echo "FAIL: worktree not removed"; exit 1; }
git worktree list | grep -q verify-base-wt && { echo "FAIL: worktree still registered"; exit 1; }

# A boot that fails is reported as a failure, never as "Base stack up":
# process mode without health_url makes env.sh up exit non-zero.
cat > .verify/setup.json << 'JSON'
{"mode":"process","compose_file":null,"boot":"sleep 300","teardown":"","seed":[],
 "seed_data_files":[],"health_url":"","base_url":"","env_file":"","observe":{},"probes":{}}
JSON
OUT=$("$SCRIPTS_DIR/compare.sh" up HEAD 2>&1) && { echo "FAIL: failed boot must exit non-zero"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "base environment failed to come up" || { echo "FAIL: failed boot must be reported as such"; exit 1; }
[ -f .verify/base-worktree-path ] && { echo "FAIL: failed boot must not leave base-worktree-path"; exit 1; }
git worktree list | grep -q verify-base-wt && { echo "FAIL: failed boot must remove the worktree"; exit 1; }

# External mode refused (it would compare the candidate with itself)
jq '.mode = "external"' .verify/setup.json > .verify/setup.tmp && mv .verify/setup.tmp .verify/setup.json
"$SCRIPTS_DIR/compare.sh" up HEAD 2>/dev/null && { echo "FAIL: external mode must be refused"; exit 1; }

echo "PASS: compare tests"
