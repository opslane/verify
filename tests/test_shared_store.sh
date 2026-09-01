#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export VERIFY_STORE_ROOT="$TMP/store-root"

# "Main checkout": capture auth + env, push
MAIN="$TMP/main"; mkdir -p "$MAIN"; cd "$MAIN"
git init -q . && git config user.email t@t && git config user.name t
git remote add origin git@github.com:opslane/verify.git
mkdir -p .verify
echo '{"cookies":[{"name":"s","value":"1"}]}' > .verify/auth.json
echo "DATABASE_URL=postgres://x" > .env.test
echo '{"mode":"none","compose_file":null,"boot":"","teardown":"","seed":[],"seed_data_files":[],"health_url":"","base_url":"","env_file":".env.test","observe":{},"probes":{}}' > .verify/setup.json
"$SCRIPTS_DIR/shared-store.sh" push || { echo "FAIL: push"; exit 1; }
STORE=$("$SCRIPTS_DIR/shared-store.sh" path)
echo "$STORE" | grep -q "github.com-opslane-verify" || { echo "FAIL: slug from origin url, got $STORE"; exit 1; }
echo "$STORE" | grep -qE -- "-[0-9a-f]{10}$" || { echo "FAIL: slug must carry the identity hash, got $STORE"; exit 1; }
# Distinct repos with dash-colliding paths must get distinct stores
C1="$TMP/c1"; mkdir -p "$C1"; cd "$C1"; git init -q .; git remote add origin "git@github.com:a-b/c.git"
S1=$("$SCRIPTS_DIR/shared-store.sh" path)
C2="$TMP/c2"; mkdir -p "$C2"; cd "$C2"; git init -q .; git remote add origin "git@github.com:a/b-c.git"
S2=$("$SCRIPTS_DIR/shared-store.sh" path)
[ "$S1" != "$S2" ] || { echo "FAIL: colliding slugs for distinct repos"; exit 1; }
cd "$MAIN"
[ -f "$STORE/auth.json" ] || { echo "FAIL: auth not in store"; exit 1; }
[ -f "$STORE/local.env" ] || { echo "FAIL: env not in store"; exit 1; }

# "Fresh worktree": same remote, no gitignored files
WT="$TMP/wt"; mkdir -p "$WT"; cd "$WT"
git init -q . && git remote add origin git@github.com:opslane/verify.git
mkdir -p .verify && cp "$MAIN/.verify/setup.json" .verify/setup.json
"$SCRIPTS_DIR/shared-store.sh" pull | grep -q "auth.json pulled" || { echo "FAIL: pull should copy auth"; exit 1; }
[ -f .verify/auth.json ] || { echo "FAIL: auth.json missing after pull"; exit 1; }

# env fallback: .env.test doesn't exist here; env.sh should use the store copy
"$SCRIPTS_DIR/env.sh" up > up.out 2>&1 || { echo "FAIL: up exited non-zero"; cat up.out; exit 1; }
grep -q "shared fallback" up.out || { echo "FAIL: env.sh must fall back to store env"; cat up.out; exit 1; }
[ "$(printenv DATABASE_URL)" = "" ] || true  # exported only inside env.sh
jq -e '.marker' .verify/run-env.json > /dev/null || { echo "FAIL: up did not complete"; exit 1; }
"$SCRIPTS_DIR/env.sh" down

# no store, no local env -> loud failure
rm -rf "$VERIFY_STORE_ROOT" .verify/run-env.json .verify/current-run .verify/run-lock
"$SCRIPTS_DIR/env.sh" up 2>/dev/null && { echo "FAIL: missing env with no fallback must fail"; exit 1; }

# Dangerous keys in an env file are ignored, never exported
cd "$MAIN"
printf 'PATH=/tmp/evil\nLD_PRELOAD=/tmp/x.so\nSAFE_KEY=ok\n' > .env.test
rm -rf .verify/run-lock .verify/run-env.json .verify/current-run
"$SCRIPTS_DIR/env.sh" up > up2.out 2>&1 || { echo "FAIL: up with dangerous env keys"; cat up2.out; exit 1; }
grep -q "ignoring PATH" up2.out || { echo "FAIL: PATH from env file must be ignored"; cat up2.out; exit 1; }
grep -q "ignoring LD_PRELOAD" up2.out || { echo "FAIL: LD_PRELOAD must be ignored"; exit 1; }
"$SCRIPTS_DIR/env.sh" down > /dev/null 2>&1 || true
echo "PASS: shared store tests"
