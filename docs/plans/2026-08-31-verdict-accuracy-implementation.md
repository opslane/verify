# Verdict Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make /verify's pass/fail verdicts trustworthy (setup contract, throwaway stacks, pipeline pre-checks, proof-of-run, base comparison, second-opinion review) and deliver results as a visual HTML report with playable evidence.

**Architecture:** The existing bash pipeline (`preflight → planner → orchestrate → judge → report`) gains stages rather than a rewrite: a repo sniffer feeding a setup interview, an environment manager booting a throwaway stack per run (boot and seed as separate verbs so teardown can be armed between them), a pre-check stage probing every surface the criteria depend on, a front-door seed runner, and a reviewer stage between planner and approval. The judge enforces proof-of-run and is reconciled against the plan; the report derives every count from one canonical per-criterion result set; the deliverable is a self-contained HTML page.

**Tech Stack:** bash + jq (matching every existing script), `claude -p` with mockable `CLAUDE_BIN`, optional `codex` CLI, Docker Compose for stacks, Playwright evidence (screenshots, `session.webm`) already produced by `agent.sh`.

**Spec:** `docs/plans/2026-08-31-verdict-accuracy-design.md`

## Global Constraints

- Verify never holds or asks for sensitive credentials. No production connection strings, no cloud keys, in any file it writes. The ceiling is reusing a repo's existing local `.env` file, chosen by the user during setup.
- The setup contract file is `.verify/setup.json` (spec says `setup.yaml`; JSON is a deliberate deviation because every script in this repo parses config with `jq` — carry the note into RELEASE-NOTES).
- All new scripts follow existing conventions: `#!/usr/bin/env bash`, `set -e`, `CLAUDE="${CLAUDE_BIN:-claude}"` for LLM calls, artifacts under `.verify/`, tests in `tests/test_<name>.sh` using mock binaries on `$PATH` or via `*_BIN` env vars.
- Timeout portability: every new script that needs a timeout includes this exact block (matching preflight.sh, including the error branch):

```bash
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi
```

- No `seq` (unreliable on macOS); use bash arithmetic loops (`for ((i=0; i<60; i++))`).
- User-facing text is plain English: "pipeline check" not canary, "proves the new behavior" / "guards existing behavior", "my guess, please confirm", "would have passed before your change".
- A check that did not run never disappears from any count. All report counts derive from one canonical result set built from `plan.json`; neither the judge nor the report may shrink it.
- During drafting and judging, nothing outside `.verify/` may change in the target repo; the run snapshots repo state before starting (tracked diff + untracked file hashes) and fails loudly if non-`.verify/` changes appear. Codify (Task 10) runs only after the report renders, writes only with explicit per-test consent, and never commits.
- Every LLM call reads its prompt from a file via stdin (`< "$PROMPT_FILE"`), never as an argv argument. This includes codex (`codex exec` with the prompt on stdin using its `-` argument).
- AC ids are validated against `^[A-Za-z0-9][A-Za-z0-9_-]*$` and uniqueness before any use in file paths.
- Run history: every run gets its own folder `.verify/runs/<run_id>/` holding evidence and the report; `env.sh up` rotates old runs, keeping the newest 5. A symlink `.verify/evidence -> .verify/runs/<run_id>/evidence` is repointed per run so existing scripts keep their paths. Nothing is ever silently overwritten within the 5-run window.
- The report is a local page, not a cloud artifact: `report.html` lives in the run folder, references screenshots and videos RELATIVE (no base64 inlining), and the skill serves it itself with a background `python3 -m http.server` at the end of the run. There is no artifact-publishing step.
- Run every test from the repo root: `bash tests/test_<name>.sh`. Each prints `PASS: ...` on success and exits non-zero on failure.

---

### Task 1: Repo sniffer (`scripts/sniff.sh`)

Detects boot/seed/health/observe candidates so the setup interview presents found options instead of blank questions. Each boot candidate carries the stack mode it implies, so setup cannot pair an `npm run dev` boot with a compose teardown.

**Files:**
- Create: `scripts/sniff.sh`
- Test: `tests/test_sniff.sh`

**Interfaces:**
- Consumes: nothing (reads the target repo's working tree).
- Produces: JSON on stdout:

```json
{
  "boot": [{"cmd": "docker compose -f compose.yaml up -d --wait", "mode": "compose", "compose_file": "compose.yaml"},
           {"cmd": "npm run dev", "mode": "process", "compose_file": null}],
  "seed": ["scripts/seed-e2e.sql"],
  "health": ["compose healthchecks (--wait)"],
  "env_files": [".env.example"],
  "has_stack": true
}
```

Task 2's interview and Task 3's `env.sh` read this shape. `mode` is one of `compose | process | external`.

- [ ] **Step 1: Write the failing test**

```bash
cat > tests/test_sniff.sh << 'EOF'
#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

cat > compose.yaml << 'YML'
services:
  app: {image: x, healthcheck: {test: ["CMD", "true"]}}
  postgres: {image: postgres}
YML
mkdir -p scripts && echo "select 1;" > scripts/seed-e2e.sql
echo "DATABASE_URL=postgres://localhost:5432/app" > .env.example
echo '{"scripts":{"dev":"vite"}}' > package.json

OUT=$("$SCRIPTS_DIR/sniff.sh")
echo "$OUT" | jq . > /dev/null || { echo "FAIL: not JSON"; exit 1; }
[ "$(echo "$OUT" | jq -r '.has_stack')" = "true" ] || { echo "FAIL: has_stack"; exit 1; }
echo "$OUT" | jq -e '.boot[] | select(.mode=="compose" and .compose_file=="compose.yaml")' > /dev/null \
  || { echo "FAIL: compose candidate missing mode/compose_file"; exit 1; }
echo "$OUT" | jq -e '.boot[] | select(.cmd=="npm run dev" and .mode=="process")' > /dev/null \
  || { echo "FAIL: npm candidate missing or wrong mode"; exit 1; }
echo "$OUT" | jq -r '.seed[]' | grep -q "scripts/seed-e2e.sql" || { echo "FAIL: seed not found"; exit 1; }
echo "$OUT" | jq -r '.env_files[]' | grep -q ".env.example" || { echo "FAIL: env file not found"; exit 1; }

cd "$(mktemp -d)"
OUT=$("$SCRIPTS_DIR/sniff.sh")
[ "$(echo "$OUT" | jq -r '.has_stack')" = "false" ] || { echo "FAIL: bare repo should be has_stack=false"; exit 1; }

echo "PASS: sniff tests"
EOF
chmod +x tests/test_sniff.sh
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_sniff.sh`
Expected: FAIL (sniff.sh does not exist).

- [ ] **Step 3: Write the implementation**

```bash
cat > scripts/sniff.sh << 'EOF'
#!/usr/bin/env bash
# Detect how this repo boots, seeds, and reports health. Pure read-only.
# Output: one JSON object on stdout. Never asks questions; the setup
# interview in the verify-setup skill turns these candidates into choices.
set -e

BOOT="[]"
SEED=()
HEALTH=()
ENVF=()
HAS_STACK=false

add_boot() { # cmd mode compose_file
  BOOT=$(echo "$BOOT" | jq --arg c "$1" --arg m "$2" --arg f "${3:-}" \
    '. + [{cmd: $c, mode: $m, compose_file: (if $f == "" then null else $f end)}]')
}

for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$f" ]; then
    HAS_STACK=true
    add_boot "docker compose -f $f up -d --wait" "compose" "$f"
    grep -q "healthcheck" "$f" && HEALTH+=("compose healthchecks (--wait)")
    break
  fi
done

if [ -f package.json ]; then
  for s in dev start serve; do
    if jq -e --arg s "$s" '.scripts[$s]' package.json > /dev/null 2>&1; then
      HAS_STACK=true
      add_boot "npm run $s" "process" ""
    fi
  done
fi
if [ -f Makefile ]; then
  T=$(grep -oE '^(dev|up|run):' Makefile | head -1 | tr -d ':')
  [ -n "$T" ] && { HAS_STACK=true; add_boot "make $T" "process" ""; }
fi

while IFS= read -r f; do SEED+=("$f"); done < <(ls scripts/seed-*.sql scripts/seed-*.sh seed/*.sql 2>/dev/null || true)
[ -f package.json ] && jq -e '.scripts.seed' package.json > /dev/null 2>&1 && SEED+=("npm run seed")

for f in .env.example .env.sample .env.local .env; do
  [ -f "$f" ] && ENVF+=("$f")
done

to_json_array() {
  if [ "$#" -eq 0 ]; then echo "[]"; else printf '%s\n' "$@" | jq -R . | jq -s .; fi
}

jq -n \
  --argjson boot "$BOOT" \
  --argjson seed "$(to_json_array "${SEED[@]}")" \
  --argjson health "$(to_json_array "${HEALTH[@]}")" \
  --argjson env_files "$(to_json_array "${ENVF[@]}")" \
  --argjson has_stack "$HAS_STACK" \
  '{boot: $boot, seed: $seed, health: $health, env_files: $env_files, has_stack: $has_stack}'
EOF
chmod +x scripts/sniff.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_sniff.sh`
Expected: `PASS: sniff tests`

- [ ] **Step 5: Commit**

```bash
git add scripts/sniff.sh tests/test_sniff.sh
git commit -m "feat: repo sniffer detects typed boot/seed/health candidates for setup"
```

---

### Task 2: Setup contract and interview (`.verify/setup.json`, verify-setup skill)

**Files:**
- Modify: `skills/verify-setup/SKILL.md` (full rewrite of the flow; auth capture section stays)
- Modify: `commands/verify-setup.md`
- Test: `tests/test_setup_contract.sh`

**Interfaces:**
- Consumes: `scripts/sniff.sh` JSON (Task 1).
- Produces: `.verify/setup.json` with exactly these keys, read by Tasks 3, 5, 6:

```json
{
  "mode": "compose",
  "compose_file": "compose.yaml",
  "boot": "docker compose -f compose.yaml up -d --wait",
  "teardown": "docker compose -f compose.yaml down -v",
  "seed": ["scripts/seed-e2e.sql"],
  "seed_data_files": [],
  "health_url": "",
  "base_url": "http://localhost:3000",
  "env_file": ".env.example",
  "observe": {"db_url_env": "DATABASE_URL"},
  "probes": {"worker": "", "sink": "", "storage": ""}
}
```

`mode` is `compose | process | external | none`:
- `compose`: `env.sh` manages boot/teardown itself from `compose_file` with a unique project; `boot`/`teardown` strings are informational.
- `process`: `env.sh` backgrounds `boot` in its own process group, and `health_url` is REQUIRED — the interview must not write a process-mode contract without one.
- `external`: user runs the stack themselves; `env.sh` only health-checks. The interview warns this breaks isolation.
- `none`: plain-command mode; boot/teardown/health empty, Tasks 3/5 skip stack work.

`probes` maps exactly the parts with no built-in probe (`worker`, `sink`, `storage`) to health commands (empty = no probe known). `api`, `browser`, and `db` probes are built into `precheck.sh` and cannot be overridden. The interview asks for each suppliable probe, explaining: "a criterion that depends on a part with no probe still runs, but if it fails, the report will say the failure might be environmental."

- [ ] **Step 1: Write the failing test**

```bash
cat > tests/test_setup_contract.sh << 'EOF'
#!/usr/bin/env bash
# The setup contract is written by an interactive skill, so the test
# validates the documented example in the skill file parses and carries
# every key the pipeline reads. Drift in the SKILL.md example breaks the build.
SKILL="$(cd "$(dirname "$0")/.." && pwd)/skills/verify-setup/SKILL.md"
EXAMPLE=$(awk '/^```json setup-contract$/,/^```$/' "$SKILL" | sed '1d;$d')
echo "$EXAMPLE" | jq . > /dev/null || { echo "FAIL: setup.json example in SKILL.md is not valid JSON"; exit 1; }
for key in mode compose_file boot teardown seed seed_data_files health_url base_url env_file observe probes; do
  echo "$EXAMPLE" | jq -e --arg k "$key" 'has($k)' > /dev/null || { echo "FAIL: example missing key $key"; exit 1; }
done
echo "$EXAMPLE" | jq -e '.probes | keys == ["sink","storage","worker"]' > /dev/null \
  || { echo "FAIL: probes must cover exactly worker/sink/storage"; exit 1; }
grep -q "sniff.sh" "$SKILL" || { echo "FAIL: skill does not run the sniffer"; exit 1; }
grep -qi "never.*credential" "$SKILL" || { echo "FAIL: skill missing the no-credentials rule"; exit 1; }
grep -q '"process"' "$SKILL" || { echo "FAIL: skill missing process mode"; exit 1; }
grep -qi "health_url.*required\|required.*health_url" "$SKILL" || { echo "FAIL: process mode must require health_url"; exit 1; }
echo "PASS: setup contract tests"
EOF
chmod +x tests/test_setup_contract.sh
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_setup_contract.sh`
Expected: FAIL (no `setup-contract` fenced example in the skill yet).

- [ ] **Step 3: Rewrite `skills/verify-setup/SKILL.md`**

Replace the file's content with the flow below. Keep the existing auth-capture steps (Playwright `storageState` to `.verify/auth.json`) as the final section, unchanged.

````markdown
---
name: verify-setup
description: One-time setup for /verify. Sniffs the repo, confirms boot/seed/health with you, writes .verify/setup.json. Also captures auth if the app needs login.
---

# /verify-setup

Run once per repo. Later `/verify` runs read `.verify/setup.json` and ask nothing.

**Hard rule: never ask for or store sensitive credentials.** No production
connection strings, no cloud keys. The most this file may reference is one of the
repo's own local `.env` files, chosen by the user. If a user pastes a secret,
refuse to write it and tell them to keep it in their environment.

## 1. Ignore rules

```bash
grep -qxF ".verify/" .gitignore 2>/dev/null || echo ".verify/" >> .gitignore
```

`.verify/setup.json` is the one file meant to be shared. After writing it, offer:
"Commit `.verify/setup.json` so your team skips this interview? (y/n)" — on yes,
`git add -f .verify/setup.json` and commit it.

## 2. Sniff the repo

```bash
bash ~/.claude/tools/verify/sniff.sh > /tmp/verify-sniff.json
cat /tmp/verify-sniff.json
```

## 3. Confirm, one question per unknown

Use AskUserQuestion. Every option must come from the sniff output; the user
corrects rather than authors. A single unambiguous candidate is taken silently
and shown in the final summary.

- Boot: options = each `.boot[]` candidate (label with its `cmd`), plus
  "it's already running (breaks isolation — not recommended)" which selects
  `"mode": "external"`. **The chosen candidate's `mode` and `compose_file`
  are copied into the contract — never mix a process boot with a compose
  teardown.** For `"process"` mode, `health_url` is required — do not write
  the contract until the user supplies the URL to poll. For `"compose"`
  mode, write `teardown: "docker compose -f <file> down -v"` — a throwaway
  stack that keeps its volumes is not throwaway.
- Seed: options = `.seed[]`, plus "no seeding" and "I have a data file to load"
  (if chosen, ask for the path and put it in `seed_data_files`; it is a plain
  file the user produced themselves — how they made it is outside verify).
- Env file: options = `.env_files[]`, plus "none". The chosen file is sourced
  by the environment manager before boot, seeds, and probes.
- Base URL: default `http://localhost:3000`, or the value in the env file if
  it names one.
- Probes: for each of `worker`, `sink`, `storage`, ask "is there a one-line
  command that proves your <part> is alive? (leave blank to skip)". Explain:
  a part with no probe still runs its criteria, but a failure on it will be
  reported as possibly environmental rather than blamed on the change.
  (`api`, `browser`, and `db` have built-in probes; don't ask about them.)

If `.has_stack` is false: plain-command mode. Write the contract with
`"mode": "none"` and empty boot/teardown/health, and say: "No runnable stack
found; /verify will run criteria as plain commands."

## 4. Write the contract

Write `.verify/setup.json`. The shape (this example is load-bearing — a test
parses it):

```json setup-contract
{
  "mode": "compose",
  "compose_file": "compose.yaml",
  "boot": "docker compose -f compose.yaml up -d --wait",
  "teardown": "docker compose -f compose.yaml down -v",
  "seed": ["scripts/seed-e2e.sql"],
  "seed_data_files": [],
  "health_url": "",
  "base_url": "http://localhost:3000",
  "env_file": ".env.example",
  "observe": {"db_url_env": "DATABASE_URL"},
  "probes": {"worker": "", "sink": "", "storage": ""}
}
```

Valid modes: `"compose"`, `"process"` (health_url required), `"external"`, `"none"`.

Show the written file and the summary of silently-taken single candidates.
````

- [ ] **Step 4: Update `commands/verify-setup.md`** to describe the new flow in one line (mirror the skill's description field).

- [ ] **Step 5: Run test to verify it passes**

Run: `bash tests/test_setup_contract.sh`
Expected: `PASS: setup contract tests`

- [ ] **Step 6: Commit**

```bash
git add skills/verify-setup/SKILL.md commands/verify-setup.md tests/test_setup_contract.sh
git commit -m "feat: setup interview writes typed .verify/setup.json from sniffed candidates"
```

---

### Task 3: Throwaway environment manager (`scripts/env.sh`)

Boot and seed are separate verbs so the caller can arm a teardown trap between them — a seed failure must never leak a stack.

**Files:**
- Create: `scripts/env.sh`
- Test: `tests/test_env.sh`

**Interfaces:**
- Consumes: `.verify/setup.json` (Task 2 shape). Optional `VERIFY_ENV_FILE` (absolute path) overrides `setup.json.env_file` — the compare button uses this to hand a worktree the candidate's local env file; if the resolved env file is configured but missing, `up` and `seed` fail loudly.
- Produces:
  - `env.sh up`: boots per `mode`, writes `.verify/run-env.json` (`{"run_id", "project", "marker", "pgid"}`). No seeding.
  - `env.sh seed`: runs `seed` + `seed_data_files`. Non-zero on any failure.
  - `env.sh down`: compose `down -v` under the unique project; process mode kills the recorded process group, waits bounded, then removes `run-env.json`.

- [ ] **Step 1: Write the failing test**

```bash
cat > tests/test_env.sh << 'EOF'
#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p bin .verify scripts
cat > bin/docker << 'MOCK'
#!/usr/bin/env bash
echo "docker $*" >> docker-calls.log
MOCK
chmod +x bin/docker
cat > bin/psql << 'MOCK'
#!/usr/bin/env bash
echo "psql $*" >> psql-calls.log
MOCK
chmod +x bin/psql
export PATH="$TMP/bin:$PATH"

echo "select 1;" > scripts/seed.sql
echo "DATABASE_URL=postgres://x" > .env.test
cat > .verify/setup.json << 'JSON'
{"mode":"compose","compose_file":"compose.yaml",
 "boot":"docker compose -f compose.yaml up -d --wait",
 "teardown":"docker compose -f compose.yaml down -v",
 "seed":["scripts/seed.sql"],"seed_data_files":[],"health_url":"",
 "base_url":"http://localhost:3000","env_file":".env.test",
 "observe":{"db_url_env":"DATABASE_URL"},"probes":{}}
JSON

mkdir -p .verify/runs/old-{1,2,3,4,5,6}/evidence   # rotation fodder
"$SCRIPTS_DIR/env.sh" up || { echo "FAIL: up exited non-zero"; exit 1; }
MARKER=$(jq -r '.marker' .verify/run-env.json)
echo "$MARKER" | grep -q "^verify-" || { echo "FAIL: marker shape"; exit 1; }
grep -q -- "-p verify-" docker-calls.log || { echo "FAIL: no unique compose project"; exit 1; }
[ -f psql-calls.log ] && { echo "FAIL: up must not seed"; exit 1; }
RUN_ID=$(jq -r '.run_id' .verify/run-env.json)
[ -d ".verify/runs/$RUN_ID/evidence" ] || { echo "FAIL: run folder missing"; exit 1; }
[ "$(readlink .verify/evidence)" = "runs/$RUN_ID/evidence" ] || { echo "FAIL: evidence symlink wrong"; exit 1; }
[ "$(ls -1d .verify/runs/*/ | wc -l)" -le 5 ] || { echo "FAIL: rotation must keep at most 5 runs"; exit 1; }

"$SCRIPTS_DIR/env.sh" seed || { echo "FAIL: seed exited non-zero"; exit 1; }
grep -q "ON_ERROR_STOP" psql-calls.log || { echo "FAIL: sql seed not run via psql"; exit 1; }

"$SCRIPTS_DIR/env.sh" down || { echo "FAIL: down exited non-zero"; exit 1; }
grep -q "down -v" docker-calls.log || { echo "FAIL: teardown must remove volumes"; exit 1; }

# Missing configured env file fails loudly
rm .env.test
"$SCRIPTS_DIR/env.sh" up 2>/dev/null && { echo "FAIL: missing env file must fail"; exit 1; }
echo "DATABASE_URL=postgres://x" > .env.test

# Process mode requires health_url
cat > .verify/setup.json << 'JSON'
{"mode":"process","compose_file":null,"boot":"sleep 300","teardown":"",
 "seed":[],"seed_data_files":[],"health_url":"","base_url":"","env_file":"",
 "observe":{},"probes":{}}
JSON
"$SCRIPTS_DIR/env.sh" up 2>/dev/null && { echo "FAIL: process mode without health_url must fail"; exit 1; }

# Process mode with health_url: mock curl always healthy; group killed on down
cat > bin/curl << 'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x bin/curl
cat > .verify/setup.json << 'JSON'
{"mode":"process","compose_file":null,"boot":"sleep 300","teardown":"",
 "seed":[],"seed_data_files":[],"health_url":"http://localhost:1/health",
 "base_url":"","env_file":"","observe":{},"probes":{}}
JSON
"$SCRIPTS_DIR/env.sh" up || { echo "FAIL: process mode up failed"; exit 1; }
PGID=$(jq -r '.pgid' .verify/run-env.json)
kill -0 -- "-$PGID" 2>/dev/null || { echo "FAIL: process group not running"; exit 1; }
"$SCRIPTS_DIR/env.sh" down
sleep 0.2
kill -0 -- "-$PGID" 2>/dev/null && { echo "FAIL: process group not killed on down"; exit 1; }
[ -f .verify/run-env.json ] && { echo "FAIL: down must remove run-env.json"; exit 1; }

# Plain mode (none): no docker, still writes a marker
rm -f docker-calls.log
cat > .verify/setup.json << 'JSON'
{"mode":"none","compose_file":null,"boot":"","teardown":"","seed":[],
 "seed_data_files":[],"health_url":"","base_url":"","env_file":"","observe":{},"probes":{}}
JSON
"$SCRIPTS_DIR/env.sh" up || { echo "FAIL: plain mode up failed"; exit 1; }
[ -f docker-calls.log ] && { echo "FAIL: plain mode must not call docker"; exit 1; }
jq -e '.marker' .verify/run-env.json > /dev/null || { echo "FAIL: plain mode marker"; exit 1; }

echo "PASS: env tests"
EOF
chmod +x tests/test_env.sh
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_env.sh`
Expected: FAIL (env.sh does not exist).

- [ ] **Step 3: Write the implementation**

```bash
cat > scripts/env.sh << 'EOF'
#!/usr/bin/env bash
# Throwaway environment per run.
#   up   — boot only (compose: unique project; process: own process group,
#          health_url REQUIRED; external: health check; none: marker only)
#   seed — run seed scripts and user data files; non-zero on any failure
#   down — compose down -v under the project / kill the process group;
#          removes run-env.json
# Boot and seed are separate so the caller arms a teardown trap in between.
set -e
SETUP=".verify/setup.json"
[ -f "$SETUP" ] || { echo "✗ .verify/setup.json not found. Run /verify-setup."; exit 1; }
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi

MODE=$(jq -r '.mode' "$SETUP")
ENV_FILE="${VERIFY_ENV_FILE:-$(jq -r '.env_file // empty' "$SETUP")}"
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || { echo "✗ configured env file missing: $ENV_FILE"; exit 1; }
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
CMD="${1:-up}"

case "$CMD" in
  up)
    RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
    MARKER="verify-$RUN_ID"
    PROJECT="verify-$RUN_ID"
    mkdir -p ".verify/runs/$RUN_ID/evidence"
    # Repoint the evidence symlink so every existing script path still works.
    rm -rf .verify/evidence 2>/dev/null || true
    ln -sfn "runs/$RUN_ID/evidence" .verify/evidence
    # Rotate: keep the newest 5 runs.
    ls -1dt .verify/runs/*/ 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
    PGID=""

    case "$MODE" in
      compose)
        CF=$(jq -r '.compose_file' "$SETUP")
        echo "→ Booting throwaway stack (project $PROJECT)..."
        docker compose -p "$PROJECT" -f "$CF" up -d --wait
        echo "✓ Stack up"
        ;;
      process)
        BOOT=$(jq -r '.boot' "$SETUP")
        HEALTH_URL=$(jq -r '.health_url // empty' "$SETUP")
        [ -n "$HEALTH_URL" ] || { echo "✗ process mode requires health_url in setup.json"; exit 1; }
        echo "→ Starting: $BOOT"
        setsid bash -c "$BOOT" > .verify/boot.log 2>&1 &
        PGID=$!
        OK=0
        for ((i=0; i<60; i++)); do
          curl -sf --max-time 2 "$HEALTH_URL" > /dev/null 2>&1 && { OK=1; break; }
          kill -0 "$PGID" 2>/dev/null || break
          sleep 1
        done
        [ "$OK" = "1" ] || { echo "✗ Never became healthy (see .verify/boot.log)"; kill -- "-$PGID" 2>/dev/null || true; exit 1; }
        echo "✓ Process up (pgid $PGID)"
        ;;
      external)
        BASE=$(jq -r '.base_url // empty' "$SETUP")
        echo "⚠ External mode: reusing a running stack breaks isolation."
        [ -n "$BASE" ] && { curl -sf --max-time 5 "$BASE" > /dev/null || { echo "✗ $BASE unreachable"; exit 1; }; }
        ;;
      none)
        echo "→ Plain-command mode: no stack to boot."
        ;;
      *) echo "✗ Unknown mode: $MODE"; exit 1 ;;
    esac

    jq -n --arg r "$RUN_ID" --arg p "$PROJECT" --arg m "$MARKER" --arg g "$PGID" \
      '{run_id: $r, project: $p, marker: $m, pgid: (if $g == "" then null else ($g|tonumber) end)}' \
      > .verify/run-env.json
    echo "✓ Environment ready (marker: $MARKER)"
    ;;
  seed)
    # Failure aborts — judging against a half-seeded database is how wrong
    # verdicts happen.
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      echo "→ Seeding: $s"
      case "$s" in
        *.sql)
          DB_ENV=$(jq -r '.observe.db_url_env // empty' "$SETUP")
          if [ -n "$DB_ENV" ] && [ -n "${!DB_ENV:-}" ]; then
            "$TIMEOUT_CMD" 120 psql "${!DB_ENV}" -v ON_ERROR_STOP=1 -f "$s"
          else
            echo "✗ SQL seed needs observe.db_url_env resolvable from the env file"; exit 1
          fi ;;
        *) "$TIMEOUT_CMD" 300 bash -c "$s" ;;
      esac
    done < <(jq -r '.seed[]?, .seed_data_files[]?' "$SETUP")
    echo "✓ Seeded"
    ;;
  down)
    case "$MODE" in
      compose)
        CF=$(jq -r '.compose_file' "$SETUP")
        PROJECT=$(jq -r '.project // empty' .verify/run-env.json 2>/dev/null || echo "")
        [ -n "$PROJECT" ] && docker compose -p "$PROJECT" -f "$CF" down -v || true
        echo "✓ Stack removed (volumes included)"
        ;;
      process)
        PGID=$(jq -r '.pgid // empty' .verify/run-env.json 2>/dev/null || echo "")
        if [ -n "$PGID" ]; then
          kill -- "-$PGID" 2>/dev/null || true
          for ((i=0; i<10; i++)); do
            kill -0 -- "-$PGID" 2>/dev/null || break
            sleep 0.5
          done
          kill -9 -- "-$PGID" 2>/dev/null || true
        fi
        echo "✓ Process group stopped"
        ;;
      *) : ;;
    esac
    rm -f .verify/run-env.json
    ;;
  *) echo "usage: env.sh up|seed|down"; exit 1 ;;
esac
EOF
chmod +x scripts/env.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_env.sh`
Expected: `PASS: env tests`

- [ ] **Step 5: Commit**

```bash
git add scripts/env.sh tests/test_env.sh
git commit -m "feat: env manager with separate up/seed/down verbs and process-group teardown"
```

---

### Task 4: Criteria schema — dependencies, proof-of-run, seed plan (planner)

**Files:**
- Modify: `scripts/prompts/planner.txt`
- Modify: `scripts/planner.sh` (schema validation + one retry)
- Modify: `tests/test_planner.sh`

**Interfaces:**
- Consumes: existing planner flow.
- Produces: every criterion in `.verify/plan.json` gains:
  - `depends_on`: array from `["api","db","worker","browser","sink","storage"]`.
  - `proof`: `{"kind": "marker-in-data" | "marked-request-rejected" | "live-read", "detail": "..."}`.
  - `guards`: `"new-behavior"` or `"existing-behavior"`.
  - Top-level `seed_plan`: array of `{"description": "...", "via": "..."}` objects, both non-empty strings. May be empty.
  - Ids validated: unique, matching `^[A-Za-z0-9][A-Za-z0-9_-]*$` (they become directory names).

- [ ] **Step 1: Extend the planner prompt.** Append to `scripts/prompts/planner.txt`:

```
For every criterion, also emit:

- "depends_on": which parts of the system this check relies on, from exactly
  this vocabulary: "api", "db", "worker", "browser", "sink", "storage".
  List every part the check drives OR observes. A digest check that posts
  events and reads Slack depends on api, worker, db, sink.
- "proof": how a reader will know this check actually ran. One of:
    {"kind": "marker-in-data", "detail": "<where the run marker will appear>"}
    {"kind": "marked-request-rejected", "detail": "<the rejection paired with the marked request>"}
    {"kind": "live-read", "detail": "<the fresh value read during the run>"}
  A criterion you cannot name a proof for is defective: move it to "skipped"
  with the reason "no way to prove it ran".
- "guards": "new-behavior" if this check proves the change works,
  "existing-behavior" if it guards something the change could have broken.

Criterion ids must be short alphanumeric slugs (letters, digits, - and _),
unique within the plan.

Also emit a top-level "seed_plan": data the run must create through the
application's own front door before checking. Each entry is
{"description": "<plain sentence>", "via": "<how: HTTP method + path, or the UI page>"}
e.g. {"description": "create 6 users with 2 sessions each",
      "via": "POST /api/v1/events"}.
Empty array if the seed script alone suffices. Never plan direct SQL inserts.
```

- [ ] **Step 2: Add schema validation to `scripts/planner.sh`.** After the existing JSON validity check and before writing `plan.json`, insert:

```bash
validate_plan() {
  echo "$1" | jq -e '
    (.criteria | type == "array") and
    (.seed_plan | type == "array") and
    ((.criteria | map(.id) | length) == (.criteria | map(.id) | unique | length)) and
    ([.criteria[] |
       (.id | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_-]*$")) and
       (.depends_on | type == "array" and length > 0 and all(.[]; IN("api","db","worker","browser","sink","storage"))) and
       (.proof.kind | IN("marker-in-data","marked-request-rejected","live-read")) and
       (.proof.detail | type == "string" and length > 0) and
       (.guards | IN("new-behavior","existing-behavior"))
     ] | all) and
    ([.seed_plan[] |
       (.description | type == "string" and length > 0) and
       (.via | type == "string" and length > 0)
     ] | all)' > /dev/null 2>&1
}

if ! validate_plan "$PLAN_JSON"; then
  echo "⚠ Planner output failed schema validation — retrying once..."
  RAW=$("$CLAUDE" -p --model opus --dangerously-skip-permissions < "$PROMPT_FILE")
  PLAN_JSON=$(echo "$RAW" | sed '/^```/d' | tr -d '\r')
  if ! validate_plan "$PLAN_JSON"; then
    echo "✗ Planner output invalid after retry. Offending output:"
    echo "$PLAN_JSON" | head -30
    exit 1
  fi
fi
```

- [ ] **Step 3: Update the planner test.** Extend the mock's criteria with the new fields and `"seed_plan":[]` at top level; assert `depends_on`, `proof.kind`, `seed_plan` exist (same jq asserts as before). Add a second mock returning criteria without the new fields twice and assert `planner.sh` exits non-zero. Add a third mock returning a bad id (`"ac/1"`) and assert non-zero.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_planner.sh`
Expected: `PASS: planner tests`

- [ ] **Step 5: Commit**

```bash
git add scripts/prompts/planner.txt scripts/planner.sh tests/test_planner.sh
git commit -m "feat: criteria schema with dependencies, proof, seed plan; ids validated"
```

---

### Task 5: Pipeline checks with taint (`scripts/precheck.sh`)

**Files:**
- Create: `scripts/precheck.sh`
- Test: `tests/test_precheck.sh`

**Interfaces:**
- Consumes: `.verify/plan.json` (`depends_on`), `.verify/setup.json` (`base_url`, `observe`, `probes` — customs only for `worker|sink|storage`), `.verify/run-env.json` (`marker`).
- Produces: `.verify/precheck.json`: `{"parts": {...: "ok"|"down"|"unknown"}, "tainted": {"<ac_id>": "<down part>"}, "unchecked": [...]}` plus per-part evidence logs under `.verify/evidence/prechecks/<part>.log`. `unknown` never taints (user decision: unknown is not down); the report flags fails on unknown-depending criteria as possibly environmental.

Probes (each bounded 10s, output to the part's log):
- `api`: `curl -sf "$base_url"` (built-in, not overridable).
- `browser`: `curl -sf "$base_url"`, body must contain `<` (built-in).
- `db`: marker round-trip via a **temporary table** (session-scoped, auto-dropped — the check must not permanently mutate any database) with the marker passed as a psql variable, not interpolated SQL (built-in).
- `worker`/`sink`/`storage`: the command from `setup.json.probes.<part>`; empty → `unknown`.

- [ ] **Step 1: Write the failing test** (mocks `curl` and `psql` on `$PATH` so built-ins are exercised)

```bash
cat > tests/test_precheck.sh << 'EOF'
#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p bin .verify
cat > bin/curl << 'MOCK'
#!/usr/bin/env bash
echo "<html>ok</html>"
exit 0
MOCK
chmod +x bin/curl
cat > bin/psql << 'MOCK'
#!/usr/bin/env bash
# echo back the marker variable (-v m=verify-t) like a successful select
for a in "$@"; do case "$a" in m=*) echo "${a#m=}";; esac; done
MOCK
chmod +x bin/psql
export PATH="$TMP/bin:$PATH"
export TESTDB_URL="postgres://mock"

cat > .verify/setup.json << 'JSON'
{"mode":"none","compose_file":null,"boot":"","teardown":"","seed":[],
 "seed_data_files":[],"health_url":"","base_url":"http://localhost:9","env_file":"",
 "observe":{"db_url_env":"TESTDB_URL"},"probes":{"sink":"false","worker":""}}
JSON
echo '{"run_id":"t","project":"verify-t","marker":"verify-t","pgid":null}' > .verify/run-env.json
cat > .verify/plan.json << 'JSON'
{"criteria":[
 {"id":"ac1","description":"api+db thing","depends_on":["api","db"]},
 {"id":"ac2","description":"sink thing","depends_on":["api","sink"]},
 {"id":"ac3","description":"worker thing","depends_on":["worker"]},
 {"id":"ac4","description":"ui thing","depends_on":["browser"]}
],"skipped":[],"seed_plan":[]}
JSON

"$SCRIPTS_DIR/precheck.sh" || { echo "FAIL: precheck exited non-zero"; exit 1; }
[ "$(jq -r '.parts.api' .verify/precheck.json)" = "ok" ] || { echo "FAIL: api should be ok"; exit 1; }
[ "$(jq -r '.parts.browser' .verify/precheck.json)" = "ok" ] || { echo "FAIL: browser should be ok"; exit 1; }
[ "$(jq -r '.parts.db' .verify/precheck.json)" = "ok" ] || { echo "FAIL: db should be ok (marker echoed)"; exit 1; }
[ "$(jq -r '.parts.sink' .verify/precheck.json)" = "down" ] || { echo "FAIL: sink should be down"; exit 1; }
[ "$(jq -r '.parts.worker' .verify/precheck.json)" = "unknown" ] || { echo "FAIL: worker should be unknown"; exit 1; }
[ "$(jq -r '.tainted.ac2' .verify/precheck.json)" = "sink" ] || { echo "FAIL: ac2 must be tainted by sink"; exit 1; }
jq -e '.tainted | has("ac1") | not' .verify/precheck.json > /dev/null || { echo "FAIL: ac1 must not be tainted"; exit 1; }
jq -e '.tainted | has("ac3") | not' .verify/precheck.json > /dev/null || { echo "FAIL: unknown must not taint"; exit 1; }
jq -e '.unchecked | index("worker") != null' .verify/precheck.json > /dev/null || { echo "FAIL: worker must be listed unchecked"; exit 1; }
[ -f .verify/evidence/prechecks/sink.log ] || { echo "FAIL: down part must leave an evidence log"; exit 1; }
echo "PASS: precheck tests"
EOF
chmod +x tests/test_precheck.sh
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_precheck.sh`
Expected: FAIL (precheck.sh does not exist).

- [ ] **Step 3: Write the implementation**

```bash
cat > scripts/precheck.sh << 'EOF'
#!/usr/bin/env bash
# Pipeline checks: prove each part the criteria depend on works, before
# judging anything. A down part taints only the criteria that depend on it.
# Unknown (no probe available) never taints — unknown is not down — but is
# reported, and fails on unknown-depending criteria get flagged as possibly
# environmental by the report.
set -e
PLAN=".verify/plan.json"
SETUP=".verify/setup.json"
[ -f "$PLAN" ] && [ -f "$SETUP" ] || { echo "✗ plan.json or setup.json missing"; exit 1; }
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi

ENV_FILE="${VERIFY_ENV_FILE:-$(jq -r '.env_file // empty' "$SETUP")}"
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

BASE_URL=$(jq -r '.base_url // empty' "$SETUP")
MARKER=$(jq -r '.marker // empty' .verify/run-env.json 2>/dev/null || echo "")
mkdir -p .verify/evidence/prechecks

PARTS=$(jq -r '[.criteria[].depends_on[]?] | unique | .[]' "$PLAN")

probe() { # part -> ok|down|unknown ; evidence to prechecks/<part>.log
  local part="$1" log=".verify/evidence/prechecks/$1.log" custom
  { echo "part: $part"; date -u +"%Y-%m-%dT%H:%M:%SZ"; } > "$log"
  case "$part" in
    worker|sink|storage)
      custom=$(jq -r --arg p "$part" '.probes[$p] // empty' "$SETUP")
      if [ -z "$custom" ]; then echo "no probe configured" >> "$log"; echo unknown; return; fi
      if "$TIMEOUT_CMD" 10 bash -c "$custom" >> "$log" 2>&1; then echo ok; else echo down; fi ;;
    api)
      [ -n "$BASE_URL" ] || { echo "no base_url" >> "$log"; echo unknown; return; }
      if "$TIMEOUT_CMD" 10 curl -sf "$BASE_URL" -o /dev/null 2>> "$log"; then echo ok; else echo down; fi ;;
    browser)
      [ -n "$BASE_URL" ] || { echo "no base_url" >> "$log"; echo unknown; return; }
      BODY=$("$TIMEOUT_CMD" 10 curl -sf "$BASE_URL" 2>> "$log" || true)
      printf '%s\n' "$BODY" >> "$log"
      if printf '%s' "$BODY" | grep -q '<'; then echo ok; else echo down; fi ;;
    db)
      DB_ENV=$(jq -r '.observe.db_url_env // empty' "$SETUP")
      if [ -n "$DB_ENV" ] && [ -n "${!DB_ENV:-}" ] && [ -n "$MARKER" ]; then
        # Temporary table: session-scoped, auto-dropped; no permanent mutation.
        # Marker travels as a psql variable, never interpolated into SQL.
        if "$TIMEOUT_CMD" 10 psql "${!DB_ENV}" -v m="$MARKER" -tAc \
          "create temporary table _verify_precheck(m text); insert into _verify_precheck values (:'m'); select m from _verify_precheck where m = :'m' limit 1;" \
          >> "$log" 2>&1 && grep -q "$MARKER" "$log"; then echo ok; else echo down; fi
      else echo "no db_url_env resolvable" >> "$log"; echo unknown; fi ;;
    *) echo "no probe for unknown part" >> "$log"; echo unknown ;;
  esac
}

PARTS_JSON="{}"
for p in $PARTS; do
  s=$(probe "$p")
  echo "  $p: $s"
  PARTS_JSON=$(echo "$PARTS_JSON" | jq --arg p "$p" --arg s "$s" '.[$p] = $s')
done

TAINTED=$(jq --argjson parts "$PARTS_JSON" '
  [.criteria[] | {id: .id, down: [.depends_on[]? | select($parts[.] == "down")][0]}
   | select(.down != null)]
  | map({(.id): .down}) | add // {}' "$PLAN")

UNCHECKED=$(echo "$PARTS_JSON" | jq '[to_entries[] | select(.value=="unknown") | .key]')

jq -n --argjson parts "$PARTS_JSON" --argjson tainted "$TAINTED" --argjson unchecked "$UNCHECKED" \
  '{parts: $parts, tainted: $tainted, unchecked: $unchecked}' > .verify/precheck.json

DOWN=$(echo "$PARTS_JSON" | jq -r 'to_entries[] | select(.value=="down") | .key' | tr '\n' ' ')
[ -n "${DOWN// }" ] && echo "⚠ Down: $DOWN— dependent criteria will be marked could-not-verify"
echo "✓ Pipeline check complete → .verify/precheck.json"
EOF
chmod +x scripts/precheck.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_precheck.sh`
Expected: `PASS: precheck tests`

- [ ] **Step 5: Commit**

```bash
git add scripts/precheck.sh tests/test_precheck.sh
git commit -m "feat: pipeline checks with built-in api/browser/db probes and evidence logs"
```

---

### Task 6: Marker injection, proof enforcement, verdict recomputation (agent, judge)

**Files:**
- Modify: `scripts/agent.sh`
- Modify: `scripts/prompts/agent.txt`
- Modify: `scripts/prompts/judge.txt`
- Modify: `scripts/judge.sh`
- Modify: `tests/test_judge.sh`, `tests/test_agent.sh`

**Interfaces:**
- Consumes: `marker` (Task 3), `proof` per criterion (Task 4), `tainted` map (Task 5), `base_url` from setup.json.
- Produces: judge statuses `pass | fail | not_proven | could_not_verify`; entries gain `proof_seen`, `did`, `observed`. `report.json` is reconciled against the plan (every plan id exactly once; missing → synthesized `not_proven`) **and its top-level `verdict`/`summary` are recomputed from the reconciled criteria** — the judge's own top line is discarded (a review finding: an omitting judge could otherwise headline "pass").

- [ ] **Step 1: Wire setup.json and the marker into `scripts/agent.sh`.** First, fix the legacy config read so a missing `config.json` cannot kill the script under `set -e` (read agent.sh before editing; its config lines mirror preflight.sh):

```bash
VERIFY_BASE_URL="${VERIFY_BASE_URL:-}"
if [ -z "$VERIFY_BASE_URL" ] && [ -f .verify/config.json ]; then
  VERIFY_BASE_URL=$(jq -r '.baseUrl // empty' .verify/config.json 2>/dev/null || echo "")
fi
if [ -f .verify/setup.json ]; then
  SETUP_BASE=$(jq -r '.base_url // empty' .verify/setup.json 2>/dev/null || echo "")
  [ -n "$SETUP_BASE" ] && VERIFY_BASE_URL="$SETUP_BASE"
fi
VERIFY_BASE_URL="${VERIFY_BASE_URL:-http://localhost:3000}"

MARKER=""
[ -f .verify/run-env.json ] && MARKER=$(jq -r '.marker // empty' .verify/run-env.json 2>/dev/null || echo "")
export VERIFY_MARKER="$MARKER"
TAINT=""
[ -f .verify/precheck.json ] && TAINT=$(jq -r --arg id "$AC_ID" '.tainted[$id] // empty' .verify/precheck.json 2>/dev/null || echo "")
if [ -n "$TAINT" ]; then
  mkdir -p ".verify/evidence/$AC_ID"
  printf "COULD_NOT_VERIFY: dependent part '%s' failed its pipeline check (see .verify/evidence/prechecks/%s.log)\n" "$TAINT" "$TAINT" \
    > ".verify/evidence/$AC_ID/agent.log"
  exit 0
fi
```

Where `agent.sh` builds the per-AC prompt, append the criterion's proof declaration and the marker (use the prompt-file variable agent.sh actually uses):

```bash
AC_PROOF=$(jq -c --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .proof // {}' .verify/plan.json)
printf "\nVERIFY_MARKER: %s\nDECLARED PROOF (your log must capture this): %s\n" "$MARKER" "$AC_PROOF" >> "$AGENT_PROMPT_FILE"
```

- [ ] **Step 2: Marker instructions in `scripts/prompts/agent.txt`.** Append:

```
RUN MARKER: VERIFY_MARKER (also shown below) is this run's unique marker.
Weave it into every piece of data you create: form text fields, event
payloads, entity names. Your criterion's DECLARED PROOF says what artifact
must carry it. Capture that artifact in your log, quoted verbatim: the
marker-bearing row/response/read.
```

- [ ] **Step 3: Judge enforcement in `scripts/prompts/judge.txt`.** Append:

```
STATUSES: pass | fail | not_proven | could_not_verify

- An agent log starting with COULD_NOT_VERIFY: status "could_not_verify",
  reasoning copied from the log. Never convert it to fail.
- A pass REQUIRES the criterion's declared proof visible in the evidence:
  the run marker in created data, the rejection paired with the marked
  request, or the fresh live read. Evidence lacking it: status "not_proven",
  reasoning "the check may not have actually run: <what is missing>".
  Status codes alone and absence-of-error are never sufficient evidence.
- Set "proof_seen": true only when you can quote the proof from the evidence.
- For each criterion also emit "did": one sentence of what the agent actually
  did, and "observed": one sentence of what the evidence shows.
```

- [ ] **Step 4: Reconcile and recompute in `scripts/judge.sh`.** After the JSON validity check, before writing `report.json`:

```bash
RECONCILED=$(jq --slurpfile plan .verify/plan.json '
  . as $rep |
  ($plan[0].criteria | map(.id)) as $ids |
  .criteria = [ $ids[] as $id |
    ([$rep.criteria[]? | select(.ac_id == $id
       and (.status | IN("pass","fail","not_proven","could_not_verify")))][0]) //
    {ac_id: $id, status: "not_proven", proof_seen: false,
     did: "", observed: "",
     reasoning: "the judge returned no result for this criterion",
     evidence: ""} ] |
  # Verdict and summary are ALWAYS recomputed; the judge cannot shrink or
  # inflate the run.
  ([.criteria[] | select(.status=="pass" and .proof_seen==true)] | length) as $proven |
  (.criteria | length) as $total |
  .verdict = (if $proven == $total and $total > 0 then "pass"
              elif $proven > 0 then "partial" else "fail" end) |
  .summary = "\($proven)/\($total) proven"' <<< "$REPORT_JSON")
REPORT_JSON="$RECONCILED"
```

Also pass proof + marker context into the judge prompt inside the AC loop (guarded reads):

```bash
  AC_PROOF=$(jq -c --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .proof // {}' .verify/plan.json)
  MARKER=""
  [ -f .verify/run-env.json ] && MARKER=$(jq -r '.marker // empty' .verify/run-env.json 2>/dev/null || echo "")
  printf "DECLARED PROOF: %s\nRUN MARKER: %s\n" "$AC_PROOF" "$MARKER" >> "$PROMPT_FILE"
```

- [ ] **Step 5: Update tests.**

`tests/test_judge.sh`: plan gains ac3 (tainted) and ac4 (omitted by the mock judge); run-env.json with a marker; mock judge returns entries for ac1/ac2/ac3 only, with `proof_seen`/`did`/`observed`, ac3 `could_not_verify`, and a deliberately wrong top-level `"verdict":"pass"`. Assert:

```bash
[ "$(jq -r '.criteria[] | select(.ac_id=="ac3") | .status' .verify/report.json)" = "could_not_verify" ] \
  || { echo "FAIL: tainted AC must be could_not_verify"; exit 1; }
[ "$(jq -r '.criteria[] | select(.ac_id=="ac4") | .status' .verify/report.json)" = "not_proven" ] \
  || { echo "FAIL: judge-omitted AC must be synthesized not_proven"; exit 1; }
[ "$(jq '.criteria | length' .verify/report.json)" = "4" ] || { echo "FAIL: count must come from plan"; exit 1; }
[ "$(jq -r '.verdict' .verify/report.json)" != "pass" ] || { echo "FAIL: verdict must be recomputed, not trusted"; exit 1; }
```

`tests/test_agent.sh`: add `.verify/precheck.json` tainting the test's AC; assert `agent.sh` writes the `COULD_NOT_VERIFY` log and exits 0 without invoking the mock claude. Also run once with no `.verify/config.json` present to prove the guarded config read survives `set -e`.

- [ ] **Step 6: Run tests**

Run: `bash tests/test_judge.sh && bash tests/test_agent.sh`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/agent.sh scripts/judge.sh scripts/prompts/agent.txt scripts/prompts/judge.txt tests/test_judge.sh tests/test_agent.sh
git commit -m "feat: proof-of-run; judge reconciled against plan with recomputed verdict"
```

---

### Task 7: Compare-against-base button (`scripts/compare.sh`)

**Files:**
- Create: `scripts/compare.sh`
- Test: `tests/test_compare.sh`

**Interfaces:**
- Consumes: `.verify/plan.json`, `.verify/setup.json`, `.verify/report.json`, a base ref, AC ids (validated). The candidate's resolved env file is passed into the worktree run as an absolute `VERIFY_ENV_FILE` (the worktree won't contain ignored local files — a review finding).
- Produces: `.verify/compare.json`: `{"base_ref", "results": [{"id", "candidate", "base", "base_reasoning", "reading"}]}` with a defined reading for every status pairing.

- [ ] **Step 1: Write the failing test**

```bash
cat > tests/test_compare.sh << 'EOF'
#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q && git commit -q --allow-empty -m base
mkdir -p .verify
echo '{"criteria":[{"id":"ac1","description":"x","depends_on":["api"]},{"id":"ac2","description":"y","depends_on":["api"]}],"skipped":[],"seed_plan":[]}' > .verify/plan.json
cat > .verify/report.json << 'JSON'
{"verdict":"partial","summary":"1/2","criteria":[
 {"ac_id":"ac1","status":"fail","proof_seen":false,"reasoning":"nope","evidence":"e"},
 {"ac_id":"ac2","status":"pass","proof_seen":true,"reasoning":"ok","evidence":"e"}]}
JSON

# Gate: refuses without VERIFY_ALLOW_DANGEROUS=1
"$SCRIPTS_DIR/compare.sh" HEAD ac1 2>/dev/null && { echo "FAIL: must gate on VERIFY_ALLOW_DANGEROUS"; exit 1; }

# Unknown AC id: refuse
VERIFY_ALLOW_DANGEROUS=1 BASE_RUNNER=/bin/true "$SCRIPTS_DIR/compare.sh" HEAD nope 2>/dev/null \
  && { echo "FAIL: unknown AC id must be rejected"; exit 1; }

# Base runner fails -> could_not_run
cat > mock-base-fail.sh << 'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
chmod +x mock-base-fail.sh
VERIFY_ALLOW_DANGEROUS=1 BASE_RUNNER=./mock-base-fail.sh "$SCRIPTS_DIR/compare.sh" HEAD ac1 \
  || { echo "FAIL: compare must not die on base failure"; exit 1; }
[ "$(jq -r '.results[0].base' .verify/compare.json)" = "could_not_run" ] || { echo "FAIL: expected could_not_run"; exit 1; }
jq -r '.results[0].reading' .verify/compare.json | grep -q "no conclusion" || { echo "FAIL: reading"; exit 1; }

# Base fails identically; pass/pass free-pass wording; base reasoning preserved
cat > mock-base-same.sh << 'MOCK'
#!/usr/bin/env bash
echo '{"criteria":[{"ac_id":"ac1","status":"fail","reasoning":"same break"},{"ac_id":"ac2","status":"pass","reasoning":"also fine"}]}' > "$1"
MOCK
chmod +x mock-base-same.sh
VERIFY_ALLOW_DANGEROUS=1 BASE_RUNNER=./mock-base-same.sh "$SCRIPTS_DIR/compare.sh" HEAD ac1 ac2
jq -r '.results[0].reading' .verify/compare.json | grep -q "not this change" || { echo "FAIL: same-fail reading"; exit 1; }
jq -r '.results[1].reading' .verify/compare.json | grep -q "would have passed before" || { echo "FAIL: free-pass reading"; exit 1; }
[ "$(jq -r '.results[0].base_reasoning' .verify/compare.json)" = "same break" ] || { echo "FAIL: base reasoning lost"; exit 1; }
echo "PASS: compare tests"
EOF
chmod +x tests/test_compare.sh
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_compare.sh`
Expected: FAIL (compare.sh does not exist).

- [ ] **Step 3: Write the implementation**

```bash
cat > scripts/compare.sh << 'EOF'
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
for id in "$@"; do
  jq -e --arg id "$id" '.criteria[] | select(.id==$id)' .verify/plan.json > /dev/null \
    || { echo "✗ unknown AC id: $id"; exit 1; }
done

BASE_REPORT=$(mktemp /tmp/verify-base-report-XXXXXX.json)
WT=$(mktemp -d /tmp/verify-base-wt-XXXXXX)
rmdir "$WT"   # git worktree add wants to create it
WT_CREATED=0
CAND_ROOT="$(pwd -P)"
CAND_ENV=""
EF=$(jq -r '.env_file // empty' .verify/setup.json 2>/dev/null || echo "")
[ -n "$EF" ] && [ -f "$EF" ] && CAND_ENV="$CAND_ROOT/$EF"

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
    export VERIFY_ENV_FILE="$CAND_ENV"
    bash "$SCRIPT_DIR/env.sh" up
    trap 'bash "$SCRIPT_DIR/env.sh" down || true' EXIT
    bash "$SCRIPT_DIR/env.sh" seed
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
EOF
chmod +x scripts/compare.sh
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_compare.sh`
Expected: `PASS: compare tests`

- [ ] **Step 5: Commit**

```bash
git add scripts/compare.sh tests/test_compare.sh
git commit -m "feat: compare-against-base with unique worktree, env handoff, full status matrix"
```

---

### Task 8: Second-opinion reviewer (`scripts/review.sh`)

**Files:**
- Create: `scripts/review.sh`
- Create: `scripts/prompts/reviewer.txt`
- Test: `tests/test_review.sh`

**Interfaces:**
- Consumes: `.verify/plan.json`, the spec path from `.verify/.spec_path`.
- Produces: `.verify/review.json`: `{"reviewer": "codex"|"fresh-claude"|"unavailable", "criteria": [{"id", "keep": "load-bearing"|"redundant"|"unreachable", "why", "codify": bool}], "missing": [...]}`. Fallback chain codex → fresh claude → `"unavailable"`; output validated (every plan id exactly once, enums correct); prompts travel via stdin only.

- [ ] **Step 1: Write the reviewer prompt** (same content as revision 2 — keep verbatim):

```bash
cat > scripts/prompts/reviewer.txt << 'EOF'
You are a second-opinion reviewer for a verification plan. You did not write
these criteria. Attack them.

For each criterion, judge:
- keep: "load-bearing" (a real user-visible behavior this change must have),
  "redundant" (name which other criterion already covers it in why),
  or "unreachable" (tests something no user can reach or no evidence can prove).
- why: one blunt sentence.
- codify: true if this check should become a permanent test in the repo
  (it guards the new capability end to end, or it would catch a real
  regression class), else false.

Then list what the set is MISSING as "missing": checks a lazy implementation
would need to be caught by. Rules:
- A set where every check verifies something is refused/hidden/cleared is
  satisfied by code that refuses everything. Demand at least one end-to-end
  "the new capability actually works" check.
- Every rule with an on and an off needs both directions. Cutting one half
  of such a pair is not a valid prune — if one half is present and load-bearing,
  the other half is load-bearing.
- For each criterion ask: could a stub that always does the same thing pass
  it? If yes, say so in why.
- Check each criterion's depends_on list: could this criterion pass or fail
  while a part NOT on its list is down? If yes, name the missing part in why.

Output ONLY JSON: {"criteria":[{"id","keep","why","codify"}...],"missing":["..."]}
Cover EVERY criterion id you were given, each exactly once.
EOF
```

- [ ] **Step 2: Write the failing test**

```bash
cat > tests/test_review.sh << 'EOF'
#!/usr/bin/env bash
SCRIPTS_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify
echo "spec text" > spec.md && echo "spec.md" > .verify/.spec_path
echo '{"criteria":[{"id":"ac1","description":"x","depends_on":["api"],"proof":{"kind":"live-read","detail":"d"},"guards":"new-behavior"}],"skipped":[],"seed_plan":[]}' > .verify/plan.json

GOOD=$(mktemp)
cat > "$GOOD" << 'M'
#!/usr/bin/env bash
# consume stdin like a real model call, then answer
cat > /dev/null
echo '{"criteria":[{"id":"ac1","keep":"load-bearing","why":"only end-to-end check","codify":true}],"missing":["a valid key still works"]}'
M
chmod +x "$GOOD"
BAD=$(mktemp)
printf '#!/usr/bin/env bash\ncat > /dev/null\necho not-json\n' > "$BAD" && chmod +x "$BAD"

CODEX_BIN="$GOOD" CLAUDE_BIN=/bin/false "$SCRIPTS_DIR/review.sh" || { echo "FAIL: review with codex"; exit 1; }
[ "$(jq -r '.reviewer' .verify/review.json)" = "codex" ] || { echo "FAIL: reviewer should be codex"; exit 1; }

CODEX_BIN="$BAD" CLAUDE_BIN="$GOOD" "$SCRIPTS_DIR/review.sh" || { echo "FAIL: fallback"; exit 1; }
[ "$(jq -r '.reviewer' .verify/review.json)" = "fresh-claude" ] || { echo "FAIL: should fall back to fresh-claude"; exit 1; }

CODEX_BIN="$BAD" CLAUDE_BIN="$BAD" "$SCRIPTS_DIR/review.sh" || { echo "FAIL: unavailable path must not crash"; exit 1; }
[ "$(jq -r '.reviewer' .verify/review.json)" = "unavailable" ] || { echo "FAIL: reviewer should be unavailable"; exit 1; }
echo "PASS: review tests"
EOF
chmod +x tests/test_review.sh
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bash tests/test_review.sh`
Expected: FAIL (review.sh does not exist).

- [ ] **Step 4: Write the implementation** (no `bash -c` command strings; reviewers invoked directly, prompt on stdin)

```bash
cat > scripts/review.sh << 'EOF'
#!/usr/bin/env bash
# Second-opinion review of the criteria. Codex when installed (different
# vendor, different blind spots); otherwise a fresh `claude -p` call that
# receives ONLY the spec and the plan — nothing from the drafting session.
# Fallback chain: codex -> fresh claude -> unavailable (loud, never fatal).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CODEX="${CODEX_BIN:-codex}"
CLAUDE="${CLAUDE_BIN:-claude}"
if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
else echo "✗ timeout command not found. Install: brew install coreutils"; exit 1; fi
[ -f .verify/plan.json ] || { echo "✗ .verify/plan.json not found"; exit 1; }
SPEC_PATH=$(cat .verify/.spec_path 2>/dev/null || echo "")

PROMPT_FILE=".verify/reviewer-prompt.txt"
{
  cat "$SCRIPT_DIR/prompts/reviewer.txt"
  printf "\n\nTHE SPEC:\n"
  [ -f "$SPEC_PATH" ] && cat "$SPEC_PATH" || echo "(no spec file)"
  printf "\n\nTHE CRITERIA:\n"
  cat .verify/plan.json
} > "$PROMPT_FILE"

valid_review() { # $1 = json string; every plan id covered, enums correct
  echo "$1" | jq -e --slurpfile plan .verify/plan.json '
    (.criteria | type == "array") and (.missing | type == "array") and
    (($plan[0].criteria | map(.id) | sort) == (.criteria | map(.id) | sort)) and
    ([.criteria[] | .keep | IN("load-bearing","redundant","unreachable")] | all) and
    ([.criteria[] | .codify | type == "boolean"] | all)' > /dev/null 2>&1
}

accept() { # $1 = name, $2 = raw output
  local clean
  clean=$(echo "$2" | sed '/^```/d' | tr -d '\r')
  valid_review "$clean" || return 1
  echo "$clean" | jq --arg r "$1" '. + {reviewer: $r}' > .verify/review.json
}

RAW=""
DONE=0
if command -v "$CODEX" > /dev/null 2>&1; then
  # codex exec reads the prompt from stdin when given "-"
  RAW=$("$TIMEOUT_CMD" 300 "$CODEX" exec -s read-only - < "$PROMPT_FILE" 2>/dev/null) || RAW=""
  [ -n "$RAW" ] && accept "codex" "$RAW" && DONE=1
fi
if [ "$DONE" = "0" ]; then
  RAW=$("$TIMEOUT_CMD" 300 "$CLAUDE" -p --model opus --dangerously-skip-permissions < "$PROMPT_FILE" 2>/dev/null) || RAW=""
  [ -n "$RAW" ] && accept "fresh-claude" "$RAW" && DONE=1
fi
if [ "$DONE" = "0" ]; then
  echo "⚠ NO SECOND OPINION AVAILABLE — criteria were reviewed only by the model that wrote them."
  jq -n '{reviewer: "unavailable", criteria: [], missing: []}' > .verify/review.json
  exit 0
fi

echo "✓ Second opinion ($(jq -r '.reviewer' .verify/review.json)) → .verify/review.json"
jq -r '.criteria[] | "  \(.id): \(.keep) — \(.why)"' .verify/review.json
jq -r '.missing[]? | "  missing: \(.)"' .verify/review.json
EOF
chmod +x scripts/review.sh
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bash tests/test_review.sh`
Expected: `PASS: review tests`

- [ ] **Step 6: Commit**

```bash
git add scripts/review.sh scripts/prompts/reviewer.txt tests/test_review.sh
git commit -m "feat: validated second-opinion review, stdin prompts, codex->claude->unavailable"
```

---

### Task 9: Visual HTML report (`scripts/report.sh` rewrite)

**Files:**
- Modify: `scripts/report.sh`
- Test: `tests/test_report.sh` (extend)

**Interfaces:**
- Consumes: `.verify/report.json`, `.verify/precheck.json`, `.verify/plan.json`, `.verify/run-env.json` (`run_id`), `.verify/compare.json` (optional), `.verify/review.json` (optional), the run's evidence dir, and the flag file `.verify/runs/<run_id>/clean-repo-violation` (optional, written by the skill when the post-run repo check fails).
- Produces: `.verify/runs/<run_id>/report.html` **and** `.verify/runs/<run_id>/canonical.json` — one canonical result per plan criterion, built first; every count and card derives from it. Screenshots and videos are referenced RELATIVE (`evidence/<ac>/...`) — the page ships as a folder, not a self-contained file, and is served locally (Task 10). No base64 inlining. When the violation flag exists, a red banner renders above the headline: "This run modified your working tree (a verify bug) — verdicts may not describe your code."

- [ ] **Step 1: Extend the report test**

```bash
cat > tests/test_report.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
mkdir -p .verify/runs/r1/evidence/ac1
ln -sfn "runs/r1/evidence" .verify/evidence
echo '{"run_id":"r1","project":"verify-r1","marker":"verify-r1","pgid":null}' > .verify/run-env.json
printf 'fake-png' > .verify/evidence/ac1/screenshot-1.png
cat > .verify/plan.json << 'JSON'
{"criteria":[
 {"id":"ac1","description":"new thing works <b>bold</b>","guards":"new-behavior","depends_on":["api"],"proof":{"kind":"marker-in-data","detail":"row"}},
 {"id":"ac2","description":"old guard holds","guards":"existing-behavior","depends_on":["sink"],"proof":{"kind":"marked-request-rejected","detail":"401"}},
 {"id":"ac3","description":"worker path","guards":"new-behavior","depends_on":["worker"],"proof":{"kind":"marker-in-data","detail":"job row"}}
],"skipped":[],"seed_plan":[]}
JSON
cat > .verify/report.json << 'JSON'
{"verdict":"partial","summary":"1/3","criteria":[
 {"ac_id":"ac1","status":"pass","proof_seen":true,"did":"posted event","observed":"marker row","reasoning":"marker row seen","evidence":".verify/evidence/ac1/agent.log"},
 {"ac_id":"ac2","status":"could_not_verify","proof_seen":false,"did":"","observed":"","reasoning":"sink down","evidence":""},
 {"ac_id":"ac3","status":"fail","proof_seen":false,"did":"queued job","observed":"nothing arrived","reasoning":"no job row","evidence":""}]}
JSON
echo '{"parts":{"api":"ok","sink":"down","worker":"unknown"},"tainted":{"ac2":"sink"},"unchecked":["worker"]}' > .verify/precheck.json

"$SCRIPT_DIR/report.sh" > /dev/null || { echo "FAIL: report.sh exited non-zero"; exit 1; }
HTML=".verify/runs/r1/report.html"
[ -f "$HTML" ] || { echo "FAIL: report.html not in run folder"; exit 1; }
grep -q "1 of 3 proven" "$HTML" || { echo "FAIL: headline missing or wrong"; exit 1; }
grep -qi "couldn't run\|could not run" "$HTML" || { echo "FAIL: could-not-run absent"; exit 1; }
grep -q 'src="evidence/ac1/screenshot-1.png"' "$HTML" || { echo "FAIL: screenshot must be relative, not inlined"; exit 1; }
grep -q "data:image" "$HTML" && { echo "FAIL: no base64 inlining"; exit 1; }
grep -q "proves the new behavior" "$HTML" || { echo "FAIL: plain-English guard label missing"; exit 1; }
grep -q "may be environmental" "$HTML" || { echo "FAIL: unchecked-part flag on fail missing"; exit 1; }
grep -q "&lt;b&gt;" "$HTML" || { echo "FAIL: description must be HTML-escaped"; exit 1; }
grep -qE '<h1[^>]*>PASS' "$HTML" && { echo "FAIL: partial run must not headline PASS"; exit 1; }
grep -q "codify-block-begin" "$HTML" || { echo "FAIL: codify markers missing"; exit 1; }
grep -qi "modified your working tree" "$HTML" && { echo "FAIL: banner must not render without flag"; exit 1; }

# Canonical set drives everything: duplicate + ghost entries must not change counts.
jq '.criteria += [.criteria[0], {"ac_id":"ghost","status":"pass","proof_seen":true,"did":"","observed":"","reasoning":"","evidence":""}]' \
  .verify/report.json > .verify/report.tmp && mv .verify/report.tmp .verify/report.json
"$SCRIPT_DIR/report.sh" > /dev/null
grep -q "1 of 3 proven" "$HTML" || { echo "FAIL: duplicate/ghost entries must not change counts"; exit 1; }
[ -f .verify/runs/r1/canonical.json ] || { echo "FAIL: canonical.json not written"; exit 1; }

# Violation flag renders the red banner
touch .verify/runs/r1/clean-repo-violation
"$SCRIPT_DIR/report.sh" > /dev/null
grep -qi "modified your working tree" "$HTML" || { echo "FAIL: violation banner missing"; exit 1; }

# All-proven run with a video: relative src, PASS headline allowed
rm .verify/runs/r1/clean-repo-violation
touch .verify/evidence/ac1/session.webm
cat > .verify/report.json << 'JSON'
{"verdict":"pass","summary":"3/3","criteria":[
 {"ac_id":"ac1","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""},
 {"ac_id":"ac2","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""},
 {"ac_id":"ac3","status":"pass","proof_seen":true,"did":"d","observed":"o","reasoning":"ok","evidence":""}]}
JSON
echo '{"parts":{"api":"ok","sink":"ok","worker":"ok"},"tainted":{},"unchecked":[]}' > .verify/precheck.json
"$SCRIPT_DIR/report.sh" > /dev/null
grep -q "3 of 3 proven" "$HTML" || { echo "FAIL: all-proven headline"; exit 1; }
grep -q '<video controls src="evidence/ac1/session.webm"' "$HTML" || { echo "FAIL: video must be relative"; exit 1; }
echo "PASS: report tests"
EOF
chmod +x tests/test_report.sh
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash tests/test_report.sh`
Expected: FAIL.

- [ ] **Step 3: Rewrite `scripts/report.sh`.** Keep the terminal summary. Build the canonical set FIRST; derive everything from it:

```bash
esc() { jq -rn --arg s "$1" '$s | @html'; }

PLAN=".verify/plan.json"; REPORT=".verify/report.json"; PRECHECK=".verify/precheck.json"
RUN_ID=$(jq -r '.run_id' .verify/run-env.json)
RUN_DIR=".verify/runs/$RUN_ID"
CANON="$RUN_DIR/canonical.json"
HTML="$RUN_DIR/report.html"

# One entry per plan criterion, first matching report entry wins, missing or
# invalid entries default to not_proven. Every count and card reads this file.
jq --slurpfile rep "$REPORT" '
  [ .criteria[] as $c |
    ([$rep[0].criteria[]? | select(.ac_id == $c.id
        and (.status | IN("pass","fail","not_proven","could_not_verify")))][0]
     // {ac_id: $c.id, status: "not_proven", proof_seen: false, did: "",
         observed: "", reasoning: "no result recorded for this criterion", evidence: ""})
    + {description: $c.description, guards: ($c.guards // ""),
       depends_on: ($c.depends_on // [])} ]' "$PLAN" > "$CANON"

TOTAL=$(jq 'length' "$CANON")
PROVEN=$(jq '[.[] | select(.status=="pass" and .proof_seen==true)] | length' "$CANON")
CNV=$(jq '[.[] | select(.status=="could_not_verify")] | length' "$CANON")
FAILED_IDS=$(jq -r '[.[] | select(.status=="fail") | .ac_id] | join(", ")' "$CANON")
NOTPROVEN=$(jq '[.[] | select(.status=="not_proven" or (.status=="pass" and .proof_seen!=true))] | length' "$CANON")
DOWN_PARTS=$(jq -r '[.parts // {} | to_entries[] | select(.value=="down") | .key] | join(", ")' "$PRECHECK" 2>/dev/null || echo "")
UNCHECKED=$(jq -c '.unchecked // []' "$PRECHECK" 2>/dev/null || echo "[]")

HEADLINE="$PROVEN of $TOTAL proven."
[ "$CNV" -gt 0 ] && HEADLINE="$HEADLINE $CNV couldn't run (${DOWN_PARTS:-parts down})."
[ -n "$FAILED_IDS" ] && HEADLINE="$HEADLINE Failed: $FAILED_IDS."
[ "$NOTPROVEN" -gt 0 ] && HEADLINE="$HEADLINE $NOTPROVEN not proven."
[ "$PROVEN" = "$TOTAL" ] && [ "$TOTAL" -gt 0 ] && HEADLINE="PASS — $HEADLINE"
```

Then render to `$HTML` (all dynamic strings through `esc`): the CSS card layout; the red violation banner FIRST when `$RUN_DIR/clean-repo-violation` exists ("This run modified your working tree (a verify bug) — verdicts may not describe your code. See pre-run.diff vs post-run.diff."); `<h1>`; the down-parts note; one card per canonical entry (status label, guard label "proves the new behavior"/"guards existing behavior", `did`/`observed`/`reasoning`, the environmental note when `status=="fail"` and any `depends_on[]` is in `$UNCHECKED`, screenshot as `<img src="evidence/<ac>/screenshot-N.png">`, video as `<video controls src="evidence/<ac>/session.webm">` — all evidence RELATIVE, never base64); a "Not checked" section (unchecked parts, plan `skipped`, missing recorders — always rendered, "Nothing." when empty); compare and second-opinion sections when their files exist (red warning when reviewer is `unavailable`); and the codify region delimited by explicit begin/end markers:

```html
<!-- codify-block-begin -->
<p class="why">Codify suggestions appear here after the run's closing turn.</p>
<!-- codify-block-end -->
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash tests/test_report.sh`
Expected: `PASS: report tests`

- [ ] **Step 5: Commit**

```bash
git add scripts/report.sh tests/test_report.sh
git commit -m "feat: canonical result set drives escaped HTML report with inline evidence"
```

---

### Task 10: Reviewed seed script + skill wiring

Seeding is a generated, human-reviewed script, not a live agent (user decision). During
half one, the skill turns the plan's `seed_plan` into a literal `bash` script of curl (or
Playwright) commands; the script appears verbatim in the approval message next to the
criteria; half two just executes it with the run's marker as `$1`. No LLM runs at seed
time. If the API shape changes, the script fails visibly and gets regenerated at the next
drafting.

**Files:**
- Modify: `skills/verify/SKILL.md`
- Modify: `commands/verify.md`
- Test: covered by Task 11's e2e test (seed script success and failure paths).

**Interfaces:**
- Consumes: `.verify/plan.json` (`seed_plan`), marker from `.verify/run-env.json`.
- Produces: `.verify/seed.sh` (written during half one, shown at approval), executed in
  half two as `bash .verify/seed.sh "$MARKER"`; the script and its full output are copied
  into the run folder as evidence (`$RUN_DIR/seed.sh`, `$RUN_DIR/seed.log`). Non-zero
  exit aborts the run before judging.

The generated script's contract, stated at the top of the file it writes:

```bash
#!/usr/bin/env bash
# Generated by /verify from the approved seed plan. Reviewed at approval.
# $1 = this run's marker. Every entity created must carry it.
set -euo pipefail
MARKER="${1:?usage: seed.sh <marker>}"
BASE_URL="${VERIFY_BASE_URL:?}"
# one block per seed_plan entry, e.g.:
# create 6 users with 2 sessions each (via POST /api/v1/events)
for i in 1 2 3 4 5 6; do
  curl -sf -X POST "$BASE_URL/api/v1/events" \
    -H 'Content-Type: application/json' \
    -d "{\"user\":\"seed-user-$i-$MARKER\", \"session\":\"s1-$MARKER\"}"
done
```

A `seed_plan` entry that genuinely cannot be scripted (needs real browser interaction)
is flagged at approval as "needs an agent — approve separately?"; only with that explicit
yes does an agent handle that one entry.

- [ ] **Step 1: Update the turn structure in `skills/verify/SKILL.md`** (edit existing turns in place; each bullet becomes real prose/steps):

- Turn 2 (pre-flight): if `.verify/setup.json` is missing, ask once: "No setup contract found. Run `/verify-setup` (recommended), or continue in plain-command mode without a managed stack?" Plain-command consent writes a minimal `{"mode":"none",...}` contract inline. Never silently proceed.
- Snapshot the repo right after preflight (tracked diff plus untracked hashes — set comparison of status lines misses edits to already-dirty files, a review finding):

```bash
mkdir -p .verify
git diff > .verify/pre-run.diff
git ls-files -o --exclude-standard -z | xargs -0 -I{} shasum {} 2>/dev/null | grep -v "^.verify/" > .verify/pre-run-untracked.txt || true
```

- After Turn 5 (planner) and the conditional-AC loop, add **Turn 5b: Second opinion + dependency review**: run `VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/review.sh`. In the approval message show: the reviewer's keep/why table; its missing-check list (and the unavailable warning verbatim when `reviewer` is `"unavailable"`); each criterion's dependency line ("AC2 relies on: api, worker, db, sink"); the seed plan AND the generated `.verify/seed.sh` printed verbatim (write it now from the seed_plan entries; it only runs after approval); and the parts that will run unprobed, computed now (a review finding — do not wait for precheck):

```bash
jq -r --slurpfile s .verify/setup.json '
  [.criteria[].depends_on[]?] | unique
  | map(select(IN("worker","sink","storage") and (($s[0].probes[.] // "") == "")))
  | if length > 0 then "Unprobed parts this run relies on: " + join(", ") else empty end' .verify/plan.json
```

  The user's y/n covers all of it. Prune or add ACs per the user's answer with the existing `jq del` pattern.
- Stage 2 becomes, in order:
  1. `bash ~/.claude/tools/verify/env.sh up`
  2. Immediately arm teardown for every later exit path: run the rest of Stage 2 in a subshell opening with `trap 'bash ~/.claude/tools/verify/env.sh down' EXIT` (boot and seed are separate verbs precisely so a seed failure cannot leak the stack).
  3. `bash ~/.claude/tools/verify/env.sh seed`
  4. Run the approved seed script: `VERIFY_BASE_URL=<base_url> bash .verify/seed.sh "$MARKER" 2>&1 | tee "$RUN_DIR/seed.log"` and copy `.verify/seed.sh` into the run folder — a non-zero exit aborts before judging.
  5. `bash ~/.claude/tools/verify/precheck.sh`
  6. Orchestrate (existing; its evidence wipe `rm -rf .verify/evidence` stays and now also clears precheck/seed evidence from prior runs — it must run BEFORE `env.sh up`, move it accordingly).
  7. Teardown fires via the trap.
- After judging, verify the clean-repo promise:

```bash
git diff > .verify/post-run.diff
git ls-files -o --exclude-standard -z | xargs -0 -I{} shasum {} 2>/dev/null | grep -v "^.verify/" > .verify/post-run-untracked.txt || true
if ! diff -q .verify/pre-run.diff .verify/post-run.diff > /dev/null \
   || ! diff -q .verify/pre-run-untracked.txt .verify/post-run-untracked.txt > /dev/null; then
  echo "✗ verify modified your repo during the run — this is a verify bug."
  echo "  Compare .verify/pre-run.diff with .verify/post-run.diff."
  touch "$RUN_DIR/clean-repo-violation"   # report.sh renders the red banner from this
  VERIFY_RUN_TAINTED=1                     # exit non-zero at the end of the flow
fi
```

- Report section: after `report.sh`, serve the page locally so the user never starts a server themselves: kill any previous server (`[ -f .verify/server.pid ] && kill $(cat .verify/server.pid) 2>/dev/null`), then from the run folder start `python3 -m http.server 8123 --directory "$RUN_DIR" > /dev/null 2>&1 &`, record its PID to `.verify/server.pid`, fall back to 8124/8125 if the port is taken, and print the finished URL: `http://localhost:8123/report.html` (on a remote box, the host's address). The server outlives the session on purpose; the next run replaces it.
- New closing turn, **Codify**: if `.verify/review.json` marks any AC `codify: true`, inspect the repo's e2e suite first (find the test directory; grep for the feature's route/component), list overlaps by file name, and ask per AC: "Keep this as a permanent test? (y/n)". On yes: write the test in the repo's own framework and conventions as an uncommitted file, run it once (if it cannot run here, say so plainly), report exactly which files were created, and update the report's codify region by replacing everything between `<!-- codify-block-begin -->` and `<!-- codify-block-end -->` (markers survive so repeated codify decisions replace, never duplicate). Never commit. On silence or n, the suggestion stays in the run artifacts only.
- Add a "Compare against base" section documenting the manual button: `VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/compare.sh <merge-base> <ac-id>...` — offer it whenever a criterion fails and the user questions the verdict.
- Error-handling table gains rows: pipeline check finds parts down → dependent ACs render "could not verify", the rest are judged; reviewer unavailable → approval carries the warning; stack boot fails → run aborts with `.verify/boot.log`; seed script fails → run aborts before judging, stack torn down by the trap.

- [ ] **Step 2: Update `commands/verify.md`** to the new one-line description (spec → criteria with dependencies and proof → second opinion → throwaway stack + pipeline checks → evidence-backed verdicts → visual report → optional codify).

- [ ] **Step 3: Self-check the skill file.** Read the rewritten SKILL.md top to bottom once; every `bash ~/.claude/tools/verify/<script>.sh` it names must exist in `scripts/`. Fix any mismatch now.

- [ ] **Step 4: Commit**

```bash
git add skills/verify/SKILL.md commands/verify.md
git commit -m "feat: skill wires setup, seed script, prechecks, reviewer, local report, codify"
```

---

### Task 11: Mocked end-to-end pipeline test

**Files:**
- Create: `tests/test_pipeline_e2e.sh`

- [ ] **Step 1: Write the test.** In a temp git repo: `.verify/setup.json` (mode `none`, probes `{"sink":"false"}`), plan.json with four valid-id ACs (one healthy pass whose mocked agent log quotes the marker, one depending on the down sink, one omitted by the mocked judge, one failing with a `worker` dependency that has no probe), a `.verify/seed.sh` that appends the marker to a file (proof it ran), then the real chain: `env.sh up` → `env.sh seed` → `bash .verify/seed.sh "$MARKER"` → `precheck.sh` → write agent logs directly (skip orchestrate) → `judge.sh` (mocked judge returning a wrong top-level verdict) → `report.sh`. Hard assertions:

```bash
# - run-env.json has a marker; seed.sh output shows the marker; run folder holds seed.sh + seed.log
# - precheck tainted the sink AC; worker listed in unchecked
# - report.json: tainted AC could_not_verify; omitted AC synthesized not_proven;
#   verdict recomputed (not the mock's "pass")
# - canonical.json length == 4; report.html headline "1 of 4 proven"; no "<h1>PASS"
# - the worker-dependent fail carries "may be environmental"
# - a second run whose seed.sh exits 1 aborts before judging (non-zero)
```

- [ ] **Step 2: Run it**

Run: `bash tests/test_pipeline_e2e.sh`
Expected: `PASS: pipeline e2e tests`

- [ ] **Step 3: Commit**

```bash
git add tests/test_pipeline_e2e.sh
git commit -m "test: mocked end-to-end pipeline covering seed script, taint, reconciliation, headline"
```

---

### Task 12: Full test sweep, docs, release notes

**Files:**
- Modify: `README.md`
- Modify: `RELEASE-NOTES.md`

- [ ] **Step 1: Run every test**

Run: `for t in tests/test_*.sh; do echo "== $t"; bash "$t" || exit 1; done`
Expected: every suite prints PASS.

- [ ] **Step 2: Update README.** Rewrite the "How it works" section to the new flow in plain English (sniff/setup once → criteria with dependencies and proof → second opinion → throwaway stack + pipeline checks → judged with proof-of-run → visual HTML report → optional codify). Include the headline example: `1 of 3 proven. 1 couldn't run (sink down). Failed: ac3.` State the credential rule verbatim: "Verify never holds or asks for sensitive credentials."

- [ ] **Step 3: Update RELEASE-NOTES.md** with one line each: setup contract, throwaway stacks, pipeline checks with taint, proof-of-run, reviewed seed script, compare button, second-opinion review, HTML report, codify — plus the `setup.yaml`→`setup.json` deviation from the design doc.

- [ ] **Step 4: Commit**

```bash
git add README.md RELEASE-NOTES.md
git commit -m "docs: verdict-accuracy release notes and plain-English pipeline overview"
```

---

## Self-review notes

- Spec §1 → Tasks 1–2. §2 → Task 3. §3 → Tasks 4–5 (+ agent skip in Task 6, environmental flag in Task 9). §4 → Tasks 4, 6. §5 → Tasks 2 (data files), 3 (seed verb), 4 (`seed_plan` schema), 10 (reviewed seed script). §6 → Task 7. §7 → Task 8 (+ approval wiring Task 10). §8 → Task 9 (+ local server wiring Task 10; report is a locally served page, per user decision — no cloud artifact). §9 → Task 10 (codify turn) with the reviewer signal from Task 8. Out-of-scope respected: no auto base runs, no credentials anywhere, no AC cap.
- Vocabulary consistent: statuses `pass | fail | not_proven | could_not_verify`; proof kinds `marker-in-data | marked-request-rejected | live-read`; parts `api db worker browser sink storage`; modes `compose | process | external | none`; probes overridable only for `worker|sink|storage`.
- Second-review findings incorporated: reviewed seed script replacing the live-agent seeder (F1, then superseded by user decision: generated script shown at approval), boot/seed split so traps arm between them (F2), `run_base` hardened with `set -e` subshell and `|| BASE_OK=$?` (F3), verdict/summary recomputed after reconciliation (F4), guarded legacy config read (F5), unique mktemp worktree with created-flag cleanup (F6), canonical.json as the single count source (F7), diff+hash repo snapshot (F8), evidence wipe repositioned before boot (F9), `VERIFY_ENV_FILE` handoff to the base worktree (F10), custom probes restricted with built-ins tested via mocked curl/psql (F11), temp-table psql-variable db probe (F12), seed_plan entry schema validation (F13), AC id pattern + uniqueness (F14), codex prompt via stdin `-` and no `bash -c` reviewer invocation (F15), process mode requires health_url (F16), process-group teardown with bounded wait and run-env cleanup (F17), full TIMEOUT_CMD detection + no `seq` (F18), unprobed-parts computed at approval (F19), codify begin/end markers (F20).
- Standing deviation (from review round 1, F1 there): `unknown` probe results do not taint — user decision. Compensations: probes asked for in setup, unprobed parts shown at approval (Turn 5b) and in the report's Not-checked section, and fails on unchecked dependencies flagged "may be environmental".
- Known simplifications, accepted: the `db` probe assumes Postgres (`psql`); other stores use custom probes on `worker|sink|storage` slots. `compare.sh` reuses the candidate's judge model. Sniffer covers compose/npm/Make; anything else lands in the interview's free-text path.
- Post-grill deltas (user decisions, 2026-08-31, after the two Codex rounds): run history kept per-run under `.verify/runs/<id>/` rotated to the newest 5; the report is a locally served HTML folder (verify starts the `python3 -m http.server` itself, port 8123 with fallback) with relative evidence and no cloud-artifact step; a clean-repo violation stamps a red banner on the report and exits non-zero rather than only warning; seeding is a generated script reviewed at approval and executed with the run marker, never a live agent (agent allowed only per-entry with explicit approval).
