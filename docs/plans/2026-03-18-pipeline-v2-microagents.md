# Pipeline v2: Microagent Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the /verify pipeline as a chain of microagents — small, focused LLM calls that each do one thing with minimal prompts — replacing the current mega-prompt approach that is unreliable, undebuggable, and fragile.

**Architecture:** 10-stage pipeline where each stage is either a bash script (deterministic) or a microagent (one LLM call, one job, <15 lines of instructions). Agents read context from files via tool calls instead of having it injected into prompts. A `learnings.md` file provides persistent memory across runs. All LLM calls are logged to disk with timeouts. The pipeline skips what it can't do and explains why, rather than retrying silently.

**Tech Stack:** Bash (3-compatible), `claude -p` (non-interactive Claude CLI with OAuth), `jq`, headless browser (`browse` binary), Node.js (orchestrator).

---

## Why This Rewrite

We spent 2 weeks on the `pipeline-stage-split` worktree adding reliability features: setup-researcher, setup-judge, retry loops, plan-validator, playbook system, orchestrator. **The result was more complex but not more reliable.** Real eval runs on Formbricks and Cal.com revealed:

1. **Mega-prompts don't work.** The planner prompt is 77 lines of rules. The agent-browse prompt is 64 lines. LLMs routinely ignore injected context and follow training-data patterns instead (e.g., using `$DATABASE_URL` even when told to use `$POSTGRES_URL`).

2. **Validation layers for LLM output are a losing game.** We added a setup-judge (Haiku) to validate setup-researcher (Sonnet) output, then a retry loop to re-invoke the researcher with critique. 6 retry layers total. The pipeline still failed because Haiku approved bad SQL.

3. **No logging.** When agents failed, there was no output on disk. `setup-researcher.sh` piped stdout to `/dev/null`. `judge.sh` had no timeout on Opus calls. Debugging required manual reproduction of each step.

4. **The learning gap.** Every run made the same mistakes. `$DATABASE_URL` hallucination happened on every eval. There was no persistent memory to break the cycle.

**The new philosophy:**
- **Microagents over mega-prompts.** Each LLM call does ONE thing with <15 lines of instructions.
- **File pointers over injection.** Instead of stuffing app.json into a prompt, tell the agent "Read .verify/app.json" and let it use tool calls.
- **Skip over retry.** If setup fails, mark `setup_failed` and explain why. Learn across runs via `learnings.md`, not within a run via retry loops.
- **Log everything.** Every LLM call saves its prompt and response to disk. Every stage has a timeout.
- **Every failure is explainable.** The user should never see an opaque error. Every failure message tells them what went wrong and how to fix it.

---

## Pipeline Overview

```
1. PREFLIGHT        (bash)     — server up? auth works? browse installed?
2. AC GENERATOR     (Opus)     — spec → list of acceptance criteria
3. PLANNER          (Opus)     — ACs → test plan with steps, URLs
4. VALIDATOR        (bash)     — deterministic checks on plan
5. CLASSIFIER       (Haiku)    — group ACs, assign setup types, timeouts
6. SETUP PLANNER    (Haiku)    — per-group: what DB state to create (approach)
7. SETUP WRITER     (Sonnet)   — per-group: exact SQL from schema files
8. BROWSE AGENTS    (Sonnet)   — per-AC: navigate, act, screenshot, verdict
9. JUDGE            (Opus)     — review all evidence, final pass/fail
10. LEARNER         (Haiku)    — write learnings.md for next run
    REPORT          (bash)     — format and display results
```

**Execution DAG for a typical 6-AC spec (e.g., Formbricks trial alerts):**

```
AC Generator (Opus, 30s)
    │ acs.json (6 ACs, 1 skipped)
Planner (Opus, 45s)
    │ plan.json (5 ACs with steps)
Validator (bash, 2s)
    │ plan.json (validated)
Classifier (Haiku, 15s)
    │ classification.json
    ├── Group A: ac1,ac2,ac3,ac5 (shared condition: "org trialing")
    └── Group B: ac6 (pure UI, no setup)
         │
    ┌────┴────┐
    │         │
 Group A   Group B
    │         │
 Setup Planner (Haiku, 20s)    │
    │         │
 Setup Writer (Sonnet, 90s)    │
    │         │
 Run setup SQL                 │
    │         │
 ac1 agent ──┐  ac6 agent ←── runs in parallel with Group A
 ac2 agent   │
 ac3 agent   │
 ac5 agent ──┘ (sequential — shared browser state)
    │         │
 Run teardown │
    │         │
    └────┬────┘
         │
Judge (Opus, 45s)
    │ verdicts.json
Learner (Haiku, 15s)
    │ learnings.md
Report (bash, 2s)
    │ results to user
```

---

## Design Principles

These are non-negotiable for the implementing agent:

### P1: Microagent prompts are under 15 lines of instructions
No mega-prompts. If a prompt needs more than 15 lines, the agent is doing too many things. Split it.

### P2: Context is read, not injected
Instead of `APP_CONTEXT=$(jq ... app.json); printf "$APP_CONTEXT" >> prompt.txt`, write: `"Read .verify/app.json for app routes and selectors."` The agent reads files via tool calls. This keeps prompts small, avoids stale context, and lets the agent decide what's relevant.

### P3: Every LLM call is logged
For every `claude -p` invocation:
- Save the rendered prompt to `.verify/logs/{stage}-prompt.txt`
- Save stdout to `.verify/logs/{stage}-output.txt`
- Save stderr to `.verify/logs/{stage}-stderr.txt`
- Record wall-clock duration in `.verify/logs/timeline.jsonl`

### P4: Every LLM call has a timeout
No unbounded calls. Opus: 60s max. Sonnet: 90-300s (agents get more). Haiku: 30s max.

### P5: Skip over retry
If a step fails, mark it failed with a clear explanation. Do NOT retry within the same run. Write the failure to `learnings.md` so the next run avoids the mistake. Exception: transient infrastructure errors (connection refused to DB) get one retry.

### P6: Every failure is user-explainable
Instead of `setup_failed`, say: `"Setup failed for ac1: table 'users' does not exist. The setup-writer may have used the wrong table name. Check .verify/logs/setup-writer-group-a-output.txt for details. Re-run /verify after checking the schema."`

### P7: The learning loop is the retry mechanism
`learnings.md` is committed to the repo. It accumulates app-specific knowledge: correct DB variable names, working setup SQL patterns, selector tips, timeout history. The planner reads it on every run, getting better over time.

---

## File System Layout

```
.verify/
├── config.json                  # base URL, auth, environmentId
├── app.json                     # indexed app surface (from /verify-setup)
├── spec.md                      # the spec being verified
├── acs.json                     # AC Generator output
├── plan.json                    # Planner output (steps, URLs per AC)
├── classification.json          # Classifier output (groups, types, models)
├── setup/                       # per-group setup artifacts
│   └── {group-id}/
│       ├── approach.json        # Setup Planner output (natural language)
│       └── commands.json        # Setup Writer output (SQL + teardown)
├── evidence/                    # per-AC agent output
│   └── {ac-id}/
│       ├── result.json          # structured: ac_id, status, expected, observed
│       ├── agent.log            # VERDICT / REASONING / STEPS_COMPLETED
│       └── screenshot-*.png
├── verdicts.json                # Judge output
├── report.json                  # Final report
├── logs/                        # ALL LLM call logs
│   ├── timeline.jsonl           # unified event log
│   ├── ac-generator-prompt.txt
│   ├── ac-generator-output.txt
│   ├── planner-prompt.txt
│   ├── planner-output.txt
│   ├── classifier-prompt.txt
│   ├── classifier-output.txt
│   ├── setup-planner-{group}-prompt.txt
│   ├── setup-planner-{group}-output.txt
│   ├── setup-writer-{group}-prompt.txt
│   ├── setup-writer-{group}-output.txt
│   ├── agent-{ac-id}-prompt.txt
│   ├── agent-{ac-id}-output.txt
│   ├── judge-prompt.txt
│   ├── judge-output.txt
│   ├── learner-prompt.txt
│   └── learner-output.txt
└── prompts/                     # rendered prompts (symlinks or copies of logs/)

verify-learnings.md              # COMMITTED to repo root — persistent memory
```

---

## Agent Specifications

### Agent 1: AC Generator

| Field | Value |
|-------|-------|
| Model | Opus |
| Timeout | 30s |
| Input | spec file |
| Output | `.verify/acs.json` |
| Reads via tool | spec file path, git diff (optional) |

**Prompt (~12 lines):**
```
You are an acceptance criteria extractor. Read the spec file and output structured ACs.

Read the spec at: {spec_path}
If a git diff is available, read it to understand what code changed.

Output .verify/acs.json:
{
  "acs": [
    {"id": "ac1", "description": "...", "condition": "what state is needed, or null"}
  ],
  "skipped": ["ac4: requires Stripe API — cannot seed payment state via DB"]
}

Rules:
- If an AC needs external services (Stripe, email, OAuth, webhooks), skip it with reason.
- If an AC needs DB state, describe the condition in plain English.
- Each AC must be independently testable.
```

### Agent 2: Planner

| Field | Value |
|-------|-------|
| Model | Opus |
| Timeout | 45s |
| Input | `acs.json`, `app.json`, `learnings.md` |
| Output | `.verify/plan.json` |
| Reads via tool | `.verify/acs.json`, `.verify/app.json`, `verify-learnings.md` |

**Prompt (~15 lines):**
```
You are a test planner. Turn acceptance criteria into executable browser test plans.

Read these files:
- .verify/acs.json — the acceptance criteria to test
- .verify/app.json — app routes (use for real URLs), selectors, data model
- verify-learnings.md — learnings from prior runs (if exists)

Output .verify/plan.json:
{
  "criteria": [{
    "id": "ac1", "description": "...",
    "condition": "plain English condition or null",
    "url": "/real/path/with/ids",
    "steps": ["navigate to URL", "assert text 'X' visible", "screenshot sidebar"],
    "screenshot_at": ["sidebar_trial_alert"]
  }],
  "skipped": ["ac4: requires Stripe"]
}

Rules:
- URLs must use real IDs from app.json. Never use placeholders like {envId}.
- Steps must be concrete browser actions. Assert by visible text, not data-testid.
- Each AC is independent. Never reference another AC's state.
```

### Agent 3: Validator (deterministic bash)

No LLM. Pure bash/jq. Runs in <2s.

**Checks:**
- All URLs start with `/` and contain no placeholder syntax (`{`, `:id`)
- Computes `timeout_seconds` per AC based on step count (base 120s + 30s per step over 3)
- Auto-skips ACs whose condition mentions external services (regex: `stripe|paypal|twilio|sendgrid|oauth|webhook`)
- Validates JSON schema of `plan.json`

### Agent 4: Classifier

| Field | Value |
|-------|-------|
| Model | Haiku |
| Timeout | 15s |
| Input | `plan.json`, `acs.json` |
| Output | `.verify/classification.json` |

**Prompt (~10 lines):**
```
You are a test classifier. Group acceptance criteria by shared setup conditions.

Read .verify/plan.json and .verify/acs.json.

Output .verify/classification.json:
{
  "groups": [
    {"id": "trialing-org", "acs": ["ac1","ac2","ac3","ac5"], "condition": "org in trialing state", "type": "db_setup"},
    {"id": "pure-ui", "acs": ["ac6"], "condition": null, "type": "none"}
  ]
}

Rules:
- Group ACs that share the same DB setup condition.
- Types: "db_setup", "feature_flag", "none", "external_skip"
- ACs with no condition go in a group with type "none".
```

### Agent 5: Setup Planner

| Field | Value |
|-------|-------|
| Model | Haiku |
| Timeout | 20s |
| Input | group condition + app.json data_model summary |
| Output | `.verify/setup/{group-id}/approach.json` |
| Runs | Once per group with `type: "db_setup"` |

**Prompt (~10 lines):**
```
You are a database setup planner. Decide what DB changes are needed for a test condition.

CONDITION: {condition}
GROUP ID: {group_id}
ACs IN THIS GROUP: {ac_ids}

APP DATA MODEL (from .verify/app.json):
{data_model_summary}

DB ENV VAR: {db_url_env}

Output .verify/setup/{group_id}/approach.json:
{
  "approach": "Update the Organization record to set billing status to trialing with trialEnd in the future",
  "tables": ["Organization"],
  "schema_files": ["prisma/schema.prisma"],
  "db_env_var": "DATABASE_URL"
}

If this requires an external service, output: {"approach": "untestable", "reason": "requires Stripe API"}
```

**Note:** This agent gets the data_model summary IN the prompt (from app.json, extracted by the orchestrator). It does NOT use tool calls. Haiku tool-use reliability is lower than Sonnet, so we keep this agent's job simple: reason about the approach, don't read files.

### Agent 6: Setup Writer

| Field | Value |
|-------|-------|
| Model | Sonnet |
| Timeout | 90s |
| Input | `approach.json`, schema files |
| Output | `.verify/setup/{group-id}/commands.json` |
| Reads via tool | approach.json, actual schema files (prisma, SQL migrations, etc.) |

**Prompt (~12 lines):**
```
You are a database setup writer. Write exact SQL commands for a test setup.

Read .verify/setup/{group_id}/approach.json for the approach and tables to modify.
Read the schema files listed in the approach to find correct table/column names.
Read verify-learnings.md for prior setup failures (if exists).

Output .verify/setup/{group_id}/commands.json:
{
  "setup": ["psql \"${db_env_var}\" --set ON_ERROR_STOP=1 -c \"...\""],
  "teardown": ["psql \"${db_env_var}\" --set ON_ERROR_STOP=1 -c \"...\""]
}

Rules:
- Use the exact DB env var from the approach (e.g. $DATABASE_URL, $POSTGRES_URL).
- Use $VERIFY_RUN_ID as the primary key for row isolation.
- Use INSERT ... ON CONFLICT DO NOTHING for idempotency.
- Teardown deletes in reverse FK order (children first).
```

### Agent 7: Browse Agent

| Field | Value |
|-------|-------|
| Model | Sonnet |
| Timeout | 150-300s (from validator, based on step count) |
| Input | its AC entry from plan.json |
| Output | `.verify/evidence/{ac-id}/result.json`, screenshots |
| Reads via tool | `.verify/plan.json` (own AC), `verify-learnings.md` |

**Prompt (~12 lines):**
```
You are a browser verification agent. Test ONE acceptance criterion.

AC ID: {ac_id}
BROWSE BINARY: {browse_bin}

Read .verify/plan.json — find the criterion with id="{ac_id}" for your URL, steps, and description.
Read verify-learnings.md for tips about selectors and timing (if exists).

Commands: goto URL, snapshot -i, click @ref, fill @ref "value", screenshot path

Workflow:
1. Navigate to the URL from your plan entry.
2. Run: {browse_bin} snapshot -i — see interactive elements.
3. Execute each step from your plan.
4. After key actions, screenshot to .verify/evidence/{ac_id}/screenshot-{label}.png
5. Write .verify/evidence/{ac_id}/result.json: {ac_id, status: pass|fail|error, expected, observed}

If you see a login page, write status "error" with observed "Auth redirect — session expired."
```

### Agent 8: Judge

| Field | Value |
|-------|-------|
| Model | Opus |
| Timeout | 60s |
| Input | all evidence, plan, code review |
| Output | `.verify/verdicts.json` |
| Reads via tool | `.verify/plan.json`, `.verify/evidence/*/result.json`, screenshots, `.verify/code-review.json` |

**Prompt (~12 lines):**
```
You are a test judge. Review browser test evidence and determine pass/fail for each AC.

Read these files:
- .verify/plan.json — criterion descriptions and expected behavior
- .verify/evidence/{ac_id}/result.json — each agent's structured findings
- .verify/evidence/{ac_id}/screenshot-*.png — visual confirmation
- .verify/code-review.json — static analysis (informational only, does not change verdicts)

Output .verify/verdicts.json:
{ "criteria": [{ "ac_id": "ac1", "status": "pass|fail|error|skip|setup_failed", "reasoning": "one sentence", "evidence": "screenshot path" }] }

Rules:
- result.json "observed" field is primary evidence. Screenshots confirm or refute.
- If evidence is ambiguous, mark fail.
- setup_failed ACs keep their existing verdict — do not override.
```

### Agent 9: Learner

| Field | Value |
|-------|-------|
| Model | Haiku |
| Timeout | 15s |
| Input | verdicts, evidence, prior learnings |
| Output | `verify-learnings.md` (updated) |

**Prompt (~10 lines):**
```
You are a test learnings writer. Update the project's learnings file based on this run's results.

Read .verify/verdicts.json for pass/fail results.
Read .verify/evidence/*/result.json for detailed findings.
Read .verify/setup/*/commands.json for what setup was attempted.
Read verify-learnings.md for existing learnings (if exists).

Update verify-learnings.md. Keep these sections, max 20 lines each:
- App Facts (DB env var, auth method, seed IDs)
- Setup Patterns (SQL that worked, table/column names)
- Known Limitations (ACs that are always untestable and why)
- Selector Tips (what works in the DOM vs what doesn't)
- Timing (average agent times, setup times)

Keep the file under 50 lines total. Overwrite stale entries. Preserve confirmed patterns.
```

---

## Task Breakdown

### Task 1: Logging infrastructure + timeline

Create the logging layer that ALL subsequent agents will use. Every `claude -p` call goes through this.

**Files:**
- Create: `scripts/lib/log.sh` — logging helper functions
- Create: `scripts/lib/run-agent.sh` — wrapper for `claude -p` that handles logging, timeouts, prompt saving

**Step 1: Create `scripts/lib/log.sh`**

```bash
#!/usr/bin/env bash
# Logging helpers for the verify pipeline.
# Usage: source scripts/lib/log.sh

VERIFY_LOG_DIR=".verify/logs"

# Ensure log directory exists
mkdir -p "$VERIFY_LOG_DIR"

# Write a timeline event (JSON line to timeline.jsonl)
# Usage: log_event "stage" "ac_id_or_empty" "status" "duration_ms" "extra_json"
log_event() {
  local stage="$1" ac_id="${2:-}" status="$3" duration_ms="${4:-0}" extra="${5:-{}}"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"ts":"%s","stage":"%s","ac":"%s","status":"%s","duration_ms":%s,"extra":%s}\n' \
    "$ts" "$stage" "$ac_id" "$status" "$duration_ms" "$extra" \
    >> "$VERIFY_LOG_DIR/timeline.jsonl"
}

# Log a message with timestamp to a stage log file
# Usage: log_stage "planner" "Starting planner..."
log_stage() {
  local stage="$1" msg="$2"
  printf "[%s] %s\n" "$(date -u +"%H:%M:%S")" "$msg" >> "$VERIFY_LOG_DIR/${stage}.log"
}
```

**Step 2: Create `scripts/lib/run-agent.sh`**

```bash
#!/usr/bin/env bash
# Runs a claude -p agent with logging, timeout, and prompt capture.
# Usage: run_agent <stage_name> <model> <timeout_secs> <prompt_file> [ac_id]
#
# Saves: logs/{stage}-prompt.txt, logs/{stage}-output.txt, logs/{stage}-stderr.txt
# Returns: claude exit code

set -e
source "$(dirname "$0")/log.sh"

STAGE="$1"
MODEL="$2"
TIMEOUT_SECS="$3"
PROMPT_FILE="$4"
AC_ID="${5:-}"

CLAUDE="${CLAUDE_BIN:-claude}"

# Detect timeout command
if [ -z "${TIMEOUT_CMD:-}" ]; then
  if command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout"
  elif command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout"
  else echo "✗ timeout command not found"; exit 1
  fi
fi

# Save prompt for debugging
LABEL="${STAGE}"
[ -n "$AC_ID" ] && LABEL="${STAGE}-${AC_ID}"
cp "$PROMPT_FILE" "$VERIFY_LOG_DIR/${LABEL}-prompt.txt"

log_stage "$STAGE" "Starting $STAGE (model=$MODEL, timeout=${TIMEOUT_SECS}s)"

START_MS=$(date +%s%3N 2>/dev/null || echo 0)

set +e
$TIMEOUT_CMD "$TIMEOUT_SECS" "$CLAUDE" -p --model "$MODEL" --dangerously-skip-permissions \
  < "$PROMPT_FILE" \
  > "$VERIFY_LOG_DIR/${LABEL}-output.txt" \
  2> "$VERIFY_LOG_DIR/${LABEL}-stderr.txt"
EXIT_CODE=$?
set -e

END_MS=$(date +%s%3N 2>/dev/null || echo 0)
DURATION=$((END_MS - START_MS))

if [ $EXIT_CODE -eq 124 ]; then
  log_stage "$STAGE" "TIMEOUT after ${TIMEOUT_SECS}s"
  log_event "$STAGE" "$AC_ID" "timeout" "$DURATION"
elif [ $EXIT_CODE -ne 0 ]; then
  log_stage "$STAGE" "FAILED (exit $EXIT_CODE)"
  log_event "$STAGE" "$AC_ID" "failed" "$DURATION" "{\"exit_code\":$EXIT_CODE}"
else
  log_stage "$STAGE" "OK (${DURATION}ms)"
  log_event "$STAGE" "$AC_ID" "ok" "$DURATION"
fi

exit $EXIT_CODE
```

**Step 3: Write tests**

Create `tests/test_logging.sh`:

```bash
#!/usr/bin/env bash
set -e
PASS=0; FAIL=0
_assert() {
  local name="$1" cond="$2"
  if eval "$cond"; then echo "  PASS: $name"; PASS=$((PASS + 1))
  else echo "  FAIL: $name"; FAIL=$((FAIL + 1)); fi
}

_cleanup() {
  rm -rf .verify/logs 2>/dev/null || true
  mkdir -p .verify/logs
}

echo "Test 1: log_event writes to timeline.jsonl"
_cleanup
source scripts/lib/log.sh
log_event "test-stage" "ac1" "ok" "1234"
_assert "timeline entry written" 'grep -q "test-stage" .verify/logs/timeline.jsonl'
_assert "has duration" 'grep -q "1234" .verify/logs/timeline.jsonl'

echo "Test 2: run-agent captures prompt and output"
_cleanup
MOCK_CLAUDE=$(mktemp); cat > "$MOCK_CLAUDE" << 'M'
#!/usr/bin/env bash
echo "mock output"
M
chmod +x "$MOCK_CLAUDE"
echo "test prompt content" > /tmp/test-prompt.txt

CLAUDE_BIN="$MOCK_CLAUDE" bash scripts/lib/run-agent.sh "test-stage" "haiku" "10" "/tmp/test-prompt.txt" "ac1"
_assert "prompt saved" 'grep -q "test prompt" .verify/logs/test-stage-ac1-prompt.txt'
_assert "output saved" 'grep -q "mock output" .verify/logs/test-stage-ac1-output.txt'
_assert "timeline event" 'grep -q "test-stage" .verify/logs/timeline.jsonl'
rm -f "$MOCK_CLAUDE" /tmp/test-prompt.txt

echo "Test 3: timeout produces exit 124 and logs it"
_cleanup
MOCK_CLAUDE=$(mktemp); cat > "$MOCK_CLAUDE" << 'M'
#!/usr/bin/env bash
sleep 30
M
chmod +x "$MOCK_CLAUDE"
echo "prompt" > /tmp/test-prompt.txt

CLAUDE_BIN="$MOCK_CLAUDE" bash scripts/lib/run-agent.sh "timeout-test" "haiku" "2" "/tmp/test-prompt.txt" "" || true
_assert "timeout logged" 'grep -q "timeout" .verify/logs/timeline.jsonl'
rm -f "$MOCK_CLAUDE" /tmp/test-prompt.txt

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

**Step 4: Run tests**

```bash
VERIFY_ALLOW_DANGEROUS=1 bash tests/test_logging.sh 2>&1
```

**Step 5: Commit**

```bash
mkdir -p scripts/lib
git add scripts/lib/log.sh scripts/lib/run-agent.sh tests/test_logging.sh
git commit -m "feat: logging infrastructure — timeline.jsonl, prompt/output capture, timeouts"
```

---

### Task 2: AC Generator

Extract acceptance criteria from spec. First new microagent.

**Files:**
- Create: `scripts/ac-generator.sh`
- Create: `scripts/prompts/ac-generator.txt`
- Create: `tests/test_ac_generator.sh`

**Step 1: Create `scripts/prompts/ac-generator.txt`**

```
You are an acceptance criteria extractor. Read the spec file and output structured ACs.

Read the spec at: REPLACE_SPEC_PATH
If a git diff is available, run: git log --all --format="%H %s" | head -20 to find the relevant commit, then git show <commit> to see changes.

Output .verify/acs.json:
{
  "acs": [
    {"id": "ac1", "description": "what this AC tests", "condition": "what DB/app state is needed, or null if none"}
  ],
  "skipped": ["ac4: requires Stripe API — cannot seed via DB"]
}

Rules:
- If an AC needs external services (Stripe, Twilio, email delivery, SMS, third-party OAuth, external webhooks), add to skipped with reason.
- If an AC needs DB state (user role, feature flag, specific record), add condition in plain English.
- Each AC must be independently testable — never reference another AC.
- Number ACs sequentially: ac1, ac2, ac3, etc.
```

**Step 2: Create `scripts/ac-generator.sh`**

```bash
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "${VERIFY_ALLOW_DANGEROUS:-0}" = "1" ] || { echo "✗ Set VERIFY_ALLOW_DANGEROUS=1"; exit 1; }

SPEC_PATH="${1:-$(cat .verify/.spec_path 2>/dev/null)}"
[ -n "$SPEC_PATH" ] && [ -f "$SPEC_PATH" ] || { echo "✗ Spec not found: $SPEC_PATH"; exit 1; }

source "$SCRIPT_DIR/lib/log.sh"

echo "→ Running AC Generator (Opus)..."
echo "  Spec: $SPEC_PATH"

# Build prompt
PROMPT_FILE=".verify/logs/ac-generator-prompt.txt"
sed "s|REPLACE_SPEC_PATH|$SPEC_PATH|g" "$SCRIPT_DIR/prompts/ac-generator.txt" > "$PROMPT_FILE"

# Run agent
bash "$SCRIPT_DIR/lib/run-agent.sh" "ac-generator" "opus" "30" "$PROMPT_FILE"

# Validate output
if [ ! -f ".verify/acs.json" ]; then
  echo "✗ AC Generator did not write .verify/acs.json"
  echo "  Check .verify/logs/ac-generator-output.txt for details"
  exit 1
fi

if ! jq . .verify/acs.json > /dev/null 2>&1; then
  echo "✗ AC Generator wrote invalid JSON to .verify/acs.json"
  exit 1
fi

AC_COUNT=$(jq '.acs | length' .verify/acs.json)
SKIP_COUNT=$(jq '.skipped | length' .verify/acs.json)
echo "✓ AC Generator: $AC_COUNT criteria, $SKIP_COUNT skipped → .verify/acs.json"
```

**Step 3: Create `tests/test_ac_generator.sh`**

```bash
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
PASS=0; FAIL=0

_assert() {
  local name="$1" cond="$2"
  if eval "$cond"; then echo "  PASS: $name"; PASS=$((PASS + 1))
  else echo "  FAIL: $name"; FAIL=$((FAIL + 1)); fi
}

_cleanup() {
  rm -f .verify/acs.json 2>/dev/null || true
  rm -rf .verify/logs 2>/dev/null || true
  mkdir -p .verify/logs
}

echo "Test 1: writes acs.json from mock claude output"
_cleanup

cat > .verify/spec.md << 'SPEC'
## Acceptance Criteria
1. Button is red
2. Payment form requires Stripe
SPEC

MOCK_CLAUDE=$(mktemp); cat > "$MOCK_CLAUDE" << 'M'
#!/usr/bin/env bash
cat > .verify/acs.json << 'JSON'
{"acs":[{"id":"ac1","description":"Button is red","condition":null}],"skipped":["ac2: requires Stripe API"]}
JSON
M
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 bash "$SCRIPT_DIR/ac-generator.sh" .verify/spec.md 2>/dev/null
_assert "acs.json created" '[ -f ".verify/acs.json" ]'
_assert "1 AC extracted" '[ "$(jq ".acs | length" .verify/acs.json)" -eq 1 ]'
_assert "1 skipped" '[ "$(jq ".skipped | length" .verify/acs.json)" -eq 1 ]'
_assert "prompt logged" '[ -f ".verify/logs/ac-generator-prompt.txt" ]'
rm -f "$MOCK_CLAUDE"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

**Step 4: Run tests**

```bash
VERIFY_ALLOW_DANGEROUS=1 bash tests/test_ac_generator.sh 2>&1
```

**Step 5: Commit**

```bash
git add scripts/ac-generator.sh scripts/prompts/ac-generator.txt tests/test_ac_generator.sh
git commit -m "feat: AC generator microagent — extracts acceptance criteria from spec"
```

---

### Task 3: Planner microagent

**Files:**
- Rewrite: `scripts/planner.sh` (replace current 98-line mega-prompt caller)
- Rewrite: `scripts/prompts/planner.txt` (replace 77-line prompt)
- Update: `tests/test_planner.sh`

**Step 1: Rewrite `scripts/prompts/planner.txt`**

Replace the entire 77-line file with the ~15-line prompt from the Agent Specifications section above.

**Step 2: Rewrite `scripts/planner.sh`**

Replace the 98-line file. The new version:
- Reads `acs.json` (not spec directly)
- Does NOT inject app.json content — the prompt tells the agent to read it
- Uses `run-agent.sh` for logging/timeout
- Validates output JSON

**Step 3: Update tests, run, commit**

```bash
git add scripts/planner.sh scripts/prompts/planner.txt tests/test_planner.sh
git commit -m "feat: planner microagent — small prompt, reads files via tool calls"
```

---

### Task 4: Validator (deterministic bash)

**Files:**
- Rewrite: `scripts/plan-validator.sh` (currently doesn't exist on main — was added in worktree)
- Create if needed, or inline in orchestrator

**Checks to implement:**
- URL validation (no placeholders)
- Timeout computation (120s base + 30s per step over 3)
- External service auto-skip (regex on condition field)
- JSON schema validation of plan.json

**Commit message:** `feat: deterministic plan validator — URLs, timeouts, external service skip`

---

### Task 5: Classifier microagent

**Files:**
- Create: `scripts/classifier.sh`
- Create: `scripts/prompts/classifier.txt`
- Create: `tests/test_classifier.sh`

The classifier reads plan.json, groups ACs by shared condition, and assigns types. Output is `classification.json`. Uses Haiku.

**Commit message:** `feat: classifier microagent — groups ACs by shared condition, assigns setup types`

---

### Task 6: Setup Planner + Setup Writer

**Files:**
- Create: `scripts/setup-planner.sh`
- Create: `scripts/prompts/setup-planner.txt`
- Create: `scripts/setup-writer.sh`
- Create: `scripts/prompts/setup-writer.txt`
- Create: `tests/test_setup.sh`

Two agents per group:
1. Setup Planner (Haiku) — approach from schema summary (in prompt, no tool calls)
2. Setup Writer (Sonnet) — reads actual schema files, writes SQL, validates by running

**Deterministic validation after Setup Writer:**
- Check that `$VARIABLE` references in commands match an entry in `.env`
- If mismatch → mark `setup_failed` with clear message

**Commit message:** `feat: setup planner + writer microagents — approach then SQL with validation`

---

### Task 7: Orchestrator rewrite

**Files:**
- Rewrite: `scripts/orchestrate.sh` OR create new `scripts/verify-run.sh` (bash, not TypeScript)
- Create: `tests/test_orchestrator_v2.sh`

The orchestrator:
1. Reads `classification.json` to understand groups
2. For each group with `type: "db_setup"`: runs setup-planner → setup-writer → setup SQL → agents (sequential) → teardown
3. For groups with `type: "none"`: runs agents in parallel
4. **Circuit breaker:** if any agent returns "Auth redirect", abort remaining agents
5. Logs everything to timeline.jsonl
6. Calls judge after all agents complete
7. Calls learner after judge

**Decision: bash or TypeScript?**

The worktree used TypeScript (verify-run.ts compiled to .js). For the rewrite, **use bash** — it's consistent with every other script, doesn't need a compile step, and the orchestrator is just sequencing subprocess calls. Use `wait` for parallel execution.

**Commit message:** `feat: orchestrator v2 — group-based execution, circuit breaker, full logging`

---

### Task 8: Browse agent rewrite

**Files:**
- Rewrite: `scripts/agent.sh` (currently 246 lines — replace with ~80 lines)
- Rewrite: `scripts/prompts/agent-browse.txt` (currently 64 lines → ~12 lines)

The new agent:
- Small prompt that tells the agent to READ plan.json for its steps
- Uses `run-agent.sh` for logging/timeout
- Writes `result.json` + `agent.log` + screenshots
- No MCP engine fallback (remove dead code)
- No replay/playbook mode (remove — add back later if needed)

**Commit message:** `feat: browse agent microagent — small prompt, reads plan via tool calls`

---

### Task 9: Judge rewrite

**Files:**
- Rewrite: `scripts/judge.sh` (currently 101 lines)
- Rewrite: `scripts/prompts/judge-browse.txt`

The new judge:
- Uses `run-agent.sh` for logging/timeout (60s for Opus)
- Reads evidence via tool calls (not injected)
- Outputs `verdicts.json`

**Commit message:** `feat: judge microagent — reads evidence via tool calls, Opus with timeout`

---

### Task 10: Learner microagent

**Files:**
- Create: `scripts/learner.sh`
- Create: `scripts/prompts/learner.txt`
- Create: `tests/test_learner.sh`

Reads verdicts + evidence, updates `verify-learnings.md` in project root. Keeps file under 50 lines. Haiku, 15s timeout.

**Commit message:** `feat: learner microagent — writes verify-learnings.md from run results`

---

### Task 11: SKILL.md rewrite

**Files:**
- Rewrite: `skills/verify/SKILL.md`

Update the skill to call the new pipeline stages in order. The turn structure stays similar but the execution turns change:

- Turn 5 (execution): calls `ac-generator.sh` → `planner.sh` → shows plan to user → user confirms → `orchestrate.sh` (which runs validator → classifier → setup → agents → judge → learner → report)
- Turn 6 (results): reads `verdicts.json`, shows results, shows skipped ACs with reasons

**Commit message:** `feat: update SKILL.md for pipeline v2 microagent architecture`

---

### Task 12: Sync hook update

**Files:**
- Update: `.claude/hooks/sync-skill.sh`

Add all new scripts to the sync list: `ac-generator.sh`, `classifier.sh`, `setup-planner.sh`, `setup-writer.sh`, `learner.sh`, `lib/log.sh`, `lib/run-agent.sh`.

**Commit message:** `fix: sync hook includes all pipeline v2 scripts`

---

### Task 13: End-to-end test with Formbricks eval

Run the full pipeline against the Formbricks trial alerts spec and verify:
- AC Generator produces 6 ACs, skips ac4 (Stripe)
- Planner uses real environmentId from app.json
- Classifier groups ac1/2/3/5 under shared condition
- Setup writes correct SQL for billing JSON
- Agents produce pass/fail verdicts
- Judge produces final verdicts.json
- Learner writes verify-learnings.md
- All logs present in `.verify/logs/`
- Timeline.jsonl has entries for every stage

---

## Verification (run after all tasks)

```bash
# 1. All tests pass
for f in tests/test_logging.sh tests/test_ac_generator.sh tests/test_planner.sh tests/test_classifier.sh tests/test_setup.sh tests/test_orchestrator_v2.sh tests/test_learner.sh; do
  echo "=== $f ==="
  VERIFY_ALLOW_DANGEROUS=1 bash "$f" 2>&1 | tail -2
done

# 2. Sync skills
bash .claude/hooks/sync-skill.sh

# 3. Run on Formbricks eval
cd ~/Projects/opslane/evals/formbricks
# invoke /verify with .verify/spec.md
```

## Notes

- The worktree `pipeline-stage-split` has useful reference code (verify-run.ts, setup-researcher.sh, setup-judge.sh) but should NOT be merged. Start fresh from main.
- `report.sh` stays mostly unchanged — it reads verdicts.json and generates the HTML report.
- `code-review.sh` stays unchanged — it runs in parallel with agents (orchestrator handles this).
- `preflight.sh` stays mostly unchanged — add cookie persistence after login (from worktree Task 2 design).
- The playbook system (write-playbook.sh, replay mode) is intentionally excluded from v2. Add it back in a future iteration once the base pipeline is reliable.
- `install-browse.sh` stays unchanged.
