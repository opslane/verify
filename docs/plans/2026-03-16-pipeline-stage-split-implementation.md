# Pipeline Stage Split — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the monolithic planner into three stages (planner → plan-validator → setup-researcher) to eliminate hallucinated SQL, bad timeouts, and doubled URLs. Fix existing bugs found in code review.

**Architecture:** The planner LLM generates ACs + steps only (no setup, no timeouts). A deterministic plan-validator fixes URLs, computes timeouts from step count, splits >10-step ACs, and auto-skips external-service ACs. A per-AC setup-researcher LLM reads the codebase, writes setup commands, runs them, and self-corrects on failure.

**Tech Stack:** Bash 3 (macOS + Linux compat), jq, `claude -p` for LLM calls

**Design doc:** `docs/plans/2026-03-16-pipeline-stage-split.md`

---

## Phase 1: Fix existing bugs from code review

### Task 1: Fix parallel SPAWNED_IDS array in orchestrate.sh

**Files:**
- Modify: `scripts/orchestrate.sh:107-134`
- Test: `tests/test_pipeline_robustness.sh`

**Step 1: Write failing test**

Add to `tests/test_pipeline_robustness.sh`:

```bash
# ── Test 5: Parallel mode skips don't misalign PIDs ─────────────────────────
echo "Test 5: parallel skip PID alignment"
_setup

cat > .verify/plan.json << 'EOF'
{
  "criteria": [
    {"id":"ac1","description":"Click Stripe checkout button","url":"/billing","steps":["click stripe"],"screenshot_at":["s1"],"timeout_seconds":90},
    {"id":"ac2","description":"Check sidebar","url":"/","steps":["check"],"screenshot_at":["s2"],"timeout_seconds":90},
    {"id":"ac3","description":"Check footer","url":"/","steps":["check"],"screenshot_at":["s3"],"timeout_seconds":90}
  ],
  "skipped": []
}
EOF

MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
printf "VERDICT: pass\nREASONING: mock\n" > ".verify/evidence/$AC_ID/agent.log"
MOCK
chmod +x "$MOCK_AGENT"

VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=none VERIFY_SEQUENTIAL=0 AGENT_BIN="$MOCK_AGENT" \
  "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

# ac1 should be skipped (stripe), ac2 and ac3 should run
VERDICT_AC1=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log 2>/dev/null | awk '{print $2}')
VERDICT_AC2=$(grep "^VERDICT:" .verify/evidence/ac2/agent.log 2>/dev/null | awk '{print $2}')
VERDICT_AC3=$(grep "^VERDICT:" .verify/evidence/ac3/agent.log 2>/dev/null | awk '{print $2}')
_assert "parallel: stripe AC skipped" '[ "$VERDICT_AC1" = "skipped" ]'
_assert "parallel: ac2 ran correctly" '[ "$VERDICT_AC2" = "pass" ]'
_assert "parallel: ac3 ran correctly" '[ "$VERDICT_AC3" = "pass" ]'
rm -f "$MOCK_AGENT"
```

**Step 2: Run test to verify it fails**

Run: `bash tests/test_pipeline_robustness.sh`
Expected: Test 5 assertions fail (PIDS misaligned with AC_IDS)

**Step 3: Implement fix**

In `scripts/orchestrate.sh`, add `SPAWNED_IDS` array in the parallel branch:

```bash
  PIDS=()
  SPAWNED_IDS=()
  for AC_ID in "${AC_IDS[@]}"; do
    # Skip ACs already marked (external-service auto-skip)
    _is_skipped=false
    for _sid in "${SKIP_IDS[@]}"; do [ "$_sid" = "$AC_ID" ] && _is_skipped=true; done
    if [ "$_is_skipped" = true ]; then
      echo "  → skipped $AC_ID (external service)"
      continue
    fi
    mkdir -p ".verify/evidence/$AC_ID"
    AC_TIMEOUT=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .timeout_seconds // empty' .verify/plan.json 2>/dev/null)
    AC_TIMEOUT=$(_safe_timeout "${AC_TIMEOUT:-${AGENT_TIMEOUT:-240}}")
    "$AGENT_BIN" "$AC_ID" "$AC_TIMEOUT" > ".verify/evidence/$AC_ID/orchestrate.log" 2>&1 &
    PIDS+=($!)
    SPAWNED_IDS+=("$AC_ID")
    echo "  → spawned $AC_ID (pid $!, timeout: ${AC_TIMEOUT}s)"
  done

  # ...wait loop:
  for i in "${!PIDS[@]}"; do
    AC_ID="${SPAWNED_IDS[$i]}"
    wait "${PIDS[$i]}" || FAILED=$((FAILED + 1))
    cat ".verify/evidence/$AC_ID/orchestrate.log"
  done
```

**Step 4: Run test to verify it passes**

Run: `bash tests/test_pipeline_robustness.sh`
Expected: All tests pass including Test 5

**Step 5: Commit**

```bash
git add scripts/orchestrate.sh tests/test_pipeline_robustness.sh
git commit -m "fix: parallel SPAWNED_IDS array prevents PID/AC misalignment on skip"
```

---

### Task 2: Add setup_failed and skipped to verdict contract

**Files:**
- Modify: `scripts/prompts/judge-browse.txt:14`
- Modify: `scripts/report.sh:15-19` (bash case), `scripts/report.sh:68-69` (python dicts)

**Step 1: Update judge prompt**

In `scripts/prompts/judge-browse.txt`, change line 14:

```
"status": "pass|fail|error|timeout",
```

to:

```
"status": "pass|fail|error|timeout|setup_failed|skipped",
```

Add rules after line 7 (timeout rule):
```
8. setup_failed = a setup command failed before the browser agent ran. The AC was not tested.
9. skipped = the AC requires an external service (Stripe, email, etc.) and was auto-skipped.
```

Renumber existing rules 8-10 to 10-12.

**Step 2: Update report.sh bash case statement**

In `scripts/report.sh`, add cases after line 18:

```bash
    setup_failed) echo "  ⚙ $AC_ID: setup failed — $REASON" ;;
    skipped)      echo "  ⊘ $AC_ID: skipped — $REASON" ;;
```

**Step 3: Update report.sh python status mappings**

In `scripts/report.sh`, update lines 68-69:

```python
status_icon   = {"pass": "✓", "fail": "✗", "timeout": "⏱", "error": "⚠", "setup_failed": "⚙", "skipped": "⊘"}
status_color  = {"pass": "#22c55e", "fail": "#ef4444", "timeout": "#f59e0b", "error": "#f59e0b", "setup_failed": "#94a3b8", "skipped": "#64748b"}
```

**Step 4: Verify**

Run: `bash tests/test_report.sh` (if exists) or manually inspect the changes.

**Step 5: Commit**

```bash
git add scripts/prompts/judge-browse.txt scripts/report.sh
git commit -m "fix: judge and report handle setup_failed and skipped verdicts"
```

---

### Task 3: Cleanup — duplicate echos, redundant mkdir, SETUP_EXIT init

**Files:**
- Modify: `scripts/orchestrate.sh:67`
- Modify: `scripts/agent.sh:44,49,65`

**Step 1: Remove duplicate echo in orchestrate.sh**

Remove line 67 (`echo "  → $cmd"`), keeping only line 68 (`echo "  ⚡ Running: $cmd"`).

**Step 2: Fix agent.sh — init SETUP_EXIT, remove duplicate echo, remove redundant mkdir**

Line 44, change:
```bash
SETUP_FAILED=false
```
to:
```bash
SETUP_FAILED=false
SETUP_EXIT=0
```

Remove line 49 (`echo "    → $cmd"`), keeping only line 50 (`echo "  ⚡ Running: $cmd"`).

Remove line 65 (`mkdir -p ".verify/evidence/$AC_ID"`) — already done on line 40.

**Step 3: Run existing tests**

Run: `VERIFY_ALLOW_DANGEROUS=1 bash tests/test_agent.sh && bash tests/test_pipeline_robustness.sh`
Expected: All pass

**Step 4: Commit**

```bash
git add scripts/orchestrate.sh scripts/agent.sh
git commit -m "fix: remove duplicate echos, redundant mkdir, init SETUP_EXIT"
```

---

### Task 4: Fix URL sanitization bare-origin edge case

**Files:**
- Modify: `scripts/orchestrate.sh:39-40`
- Test: `tests/test_pipeline_robustness.sh`

**Step 1: Write failing test**

Add to `tests/test_pipeline_robustness.sh`:

```bash
# ── Test 6: Bare origin URL sanitized to / ───────────────────────────────────
echo "Test 6: bare origin URL becomes /"
_setup

cat > .verify/plan.json << 'EOF'
{
  "criteria": [{"id":"ac1","description":"homepage","url":"http://localhost:3000","steps":["check"],"screenshot_at":["s1"],"timeout_seconds":90}],
  "skipped": []
}
EOF

MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
printf "VERDICT: pass\nREASONING: mock\n" > ".verify/evidence/$AC_ID/agent.log"
MOCK
chmod +x "$MOCK_AGENT"

VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=none AGENT_BIN="$MOCK_AGENT" \
  "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

PLAN_URL=$(jq -r '.criteria[0].url' .verify/plan.json)
_assert "bare origin sanitized to /" '[ "$PLAN_URL" = "/" ]'
rm -f "$MOCK_AGENT"
```

**Step 2: Run test to verify it fails**

Run: `bash tests/test_pipeline_robustness.sh`
Expected: Test 6 fails (url becomes empty string, not "/")

**Step 3: Implement fix**

In `scripts/orchestrate.sh`, change the jq sanitization (lines 39-40):

```bash
  jq '(.criteria[]?.url) |= (sub("^https?://[^/]+";"") | if . == "" then "/" else . end)' .verify/plan.json > .verify/plan.json.tmp \
    && mv .verify/plan.json.tmp .verify/plan.json
```

**Step 4: Run test to verify it passes**

Run: `bash tests/test_pipeline_robustness.sh`
Expected: All tests pass including Test 6

**Step 5: Commit**

```bash
git add scripts/orchestrate.sh tests/test_pipeline_robustness.sh
git commit -m "fix: bare origin URLs sanitized to / not empty string"
```

---

## Phase 2: Plan Validator (new deterministic script)

### Task 5: Create plan-validator.sh with tests

**Files:**
- Create: `scripts/plan-validator.sh`
- Create: `tests/test_plan_validator.sh`

**Step 1: Write failing tests**

Create `tests/test_plan_validator.sh`:

```bash
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
PASS=0; FAIL=0

_setup() {
  find .verify/evidence -mindepth 1 -delete 2>/dev/null || true
  rm -f .verify/plan.json .verify/plan.json.tmp 2>/dev/null || true
  mkdir -p .verify/evidence
}

_assert() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    echo "  PASS: $name"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"; FAIL=$((FAIL + 1))
  fi
}

# ── Test 1: URL sanitization ────────────────────────────────────────────────
echo "Test 1: URL sanitization"
_setup
cat > .verify/plan.json << 'EOF'
{"criteria":[
  {"id":"ac1","url":"http://localhost:3001/settings","steps":["s1"],"description":"d","screenshot_at":["s"]},
  {"id":"ac2","url":"https://example.com","steps":["s1"],"description":"d","screenshot_at":["s"]},
  {"id":"ac3","url":"/already-relative","steps":["s1"],"description":"d","screenshot_at":["s"]}
],"skipped":[]}
EOF

"$SCRIPT_DIR/plan-validator.sh" 2>/dev/null

_assert "full URL → relative" '[ "$(jq -r ".criteria[0].url" .verify/plan.json)" = "/settings" ]'
_assert "bare origin → /" '[ "$(jq -r ".criteria[1].url" .verify/plan.json)" = "/" ]'
_assert "relative unchanged" '[ "$(jq -r ".criteria[2].url" .verify/plan.json)" = "/already-relative" ]'

# ── Test 2: Timeout computation ──────────────────────────────────────────────
echo "Test 2: timeout from step count"
_setup
cat > .verify/plan.json << 'EOF'
{"criteria":[
  {"id":"ac1","url":"/","steps":["s1","s2","s3"],"description":"d","screenshot_at":["s"]},
  {"id":"ac2","url":"/","steps":["s1","s2","s3","s4","s5","s6","s7","s8","s9","s10"],"description":"d","screenshot_at":["s"]}
],"skipped":[]}
EOF

"$SCRIPT_DIR/plan-validator.sh" 2>/dev/null

T1=$(jq '.criteria[0].timeout_seconds' .verify/plan.json)
T2=$(jq '.criteria[1].timeout_seconds' .verify/plan.json)
_assert "3-step AC gets 90s (floor)" '[ "$T1" -eq 90 ]'
_assert "10-step AC gets 230s" '[ "$T2" -eq 230 ]'

# ── Test 3: Step count enforcement (>10 steps split) ────────────────────────
echo "Test 3: step splitting"
_setup
cat > .verify/plan.json << 'EOF'
{"criteria":[
  {"id":"ac1","url":"/page","description":"big test","condition":"needs data","screenshot_at":["s"],
   "steps":["Navigate to page","Fill name field","Fill email field","Click submit","Wait for toast",
            "Navigate to settings","Click Advanced tab","Scroll down","Change dropdown","Click save",
            "Reload page","Verify dropdown value"]}
],"skipped":[]}
EOF

"$SCRIPT_DIR/plan-validator.sh" 2>/dev/null

AC_COUNT=$(jq '.criteria | length' .verify/plan.json)
_assert "12-step AC split into 2" '[ "$AC_COUNT" -eq 2 ]'

AC1_ID=$(jq -r '.criteria[0].id' .verify/plan.json)
AC2_ID=$(jq -r '.criteria[1].id' .verify/plan.json)
_assert "first sub-AC is ac1a" '[ "$AC1_ID" = "ac1a" ]'
_assert "second sub-AC is ac1b" '[ "$AC2_ID" = "ac1b" ]'

AC1_STEPS=$(jq '.criteria[0].steps | length' .verify/plan.json)
AC2_STEPS=$(jq '.criteria[1].steps | length' .verify/plan.json)
_assert "both sub-ACs have ≤10 steps" '[ "$AC1_STEPS" -le 10 ] && [ "$AC2_STEPS" -le 10 ]'
_assert "condition inherited" '[ "$(jq -r ".criteria[1].condition // empty" .verify/plan.json)" = "needs data" ]'

# ── Test 4: External-service auto-skip ───────────────────────────────────────
echo "Test 4: external service skip"
_setup
cat > .verify/plan.json << 'EOF'
{"criteria":[
  {"id":"ac1","url":"/","description":"Stripe checkout redirect","steps":["click pay"],"screenshot_at":["s"]},
  {"id":"ac2","url":"/","description":"Normal page check","steps":["look"],"screenshot_at":["s"]}
],"skipped":[]}
EOF

"$SCRIPT_DIR/plan-validator.sh" 2>/dev/null

REMAINING=$(jq '.criteria | length' .verify/plan.json)
VERDICT=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log 2>/dev/null | awk '{print $2}')
_assert "stripe AC removed from criteria" '[ "$REMAINING" -eq 1 ]'
_assert "skipped verdict written" '[ "$VERDICT" = "skipped" ]'

# ── Test 5: Schema validation ────────────────────────────────────────────────
echo "Test 5: schema validation"
_setup
cat > .verify/plan.json << 'EOF'
{"criteria":[
  {"id":"ac1","url":"/","steps":["s1"],"screenshot_at":["s"]}
],"skipped":[]}
EOF

"$SCRIPT_DIR/plan-validator.sh" 2>/dev/null
EXIT=$?
# Missing description should be caught — validator adds a warning but doesn't fail
_assert "missing description gets default" '[ "$(jq -r ".criteria[0].description" .verify/plan.json)" != "null" ]'

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

**Step 2: Run test to verify it fails**

Run: `bash tests/test_plan_validator.sh`
Expected: FAIL — `plan-validator.sh` doesn't exist

**Step 3: Implement plan-validator.sh**

Create `scripts/plan-validator.sh`:

```bash
#!/usr/bin/env bash
# Plan Validator — deterministic guardrails applied after the planner LLM.
# No LLM calls. Fixes URLs, computes timeouts, splits long ACs, skips external services.
set -e

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

echo "→ Validating plan..."

# ── 1. URL sanitization ──────────────────────────────────────────────────────
if jq -e '.criteria[]? | select(.url | test("^https?://"))' .verify/plan.json >/dev/null 2>&1; then
  echo "  → Sanitizing absolute URLs to relative paths"
  jq '(.criteria[]?.url) |= (sub("^https?://[^/]+";"") | if . == "" then "/" else . end)' \
    .verify/plan.json > .verify/plan.json.tmp && mv .verify/plan.json.tmp .verify/plan.json
fi

# ── 2. Timeout computation ───────────────────────────────────────────────────
# Formula: max(steps * 20 + 30, 90), capped at 300
echo "  → Computing timeouts from step count"
jq '(.criteria[]?) |= (
  .timeout_seconds = (
    [([(.steps | length) * 20 + 30, 90] | max), 300] | min
  )
)' .verify/plan.json > .verify/plan.json.tmp && mv .verify/plan.json.tmp .verify/plan.json

# ── 3. Step count enforcement (split ACs with >10 steps) ─────────────────────
# Read ACs that need splitting
SPLIT_NEEDED=false
while IFS= read -r ac_json; do
  step_count=$(echo "$ac_json" | jq '.steps | length')
  [ "$step_count" -gt 10 ] && SPLIT_NEEDED=true && break
done < <(jq -c '.criteria[]' .verify/plan.json)

if [ "$SPLIT_NEEDED" = true ]; then
  echo "  → Splitting ACs with >10 steps"
  python3 -c '
import json, re, sys

plan = json.load(open(".verify/plan.json"))
new_criteria = []

for ac in plan.get("criteria", []):
    steps = ac.get("steps", [])
    if len(steps) <= 10:
        new_criteria.append(ac)
        continue

    # Find split point: look for natural boundaries after step 5
    split_at = len(steps) // 2  # default: middle
    boundary_pattern = re.compile(r"(navigate|reload|click.*tab|submit|save)", re.IGNORECASE)
    for i in range(4, len(steps) - 1):  # search from step 5 onward
        if boundary_pattern.search(steps[i]):
            split_at = i + 1  # split after the boundary step
            break

    ac_id = ac["id"]
    base = {k: v for k, v in ac.items() if k not in ("id", "steps", "timeout_seconds")}

    part_a = {**base, "id": f"{ac_id}a", "steps": steps[:split_at]}
    part_b = {**base, "id": f"{ac_id}b", "steps": steps[split_at:]}

    new_criteria.append(part_a)
    new_criteria.append(part_b)

plan["criteria"] = new_criteria
with open(".verify/plan.json", "w") as f:
    json.dump(plan, f, indent=2)
' || echo "  ⚠ Step splitting failed (continuing)"

  # Recompute timeouts for split ACs
  jq '(.criteria[]?) |= (
    .timeout_seconds = (
      [([(.steps | length) * 20 + 30, 90] | max), 300] | min
    )
  )' .verify/plan.json > .verify/plan.json.tmp && mv .verify/plan.json.tmp .verify/plan.json
fi

# ── 4. External-service auto-skip ────────────────────────────────────────────
_EXTERNAL_PATTERN="stripe|paypal|payment.gateway|external.oauth|email.delivery|sendgrid|mailgun|twilio"
SKIP_IDS=()
while IFS= read -r line; do
  ac_id=$(echo "$line" | jq -r '.id')
  ac_desc=$(echo "$line" | jq -r '.description')
  ac_steps=$(echo "$line" | jq -r '.steps[]' 2>/dev/null | tr '\n' ' ')
  combined="$ac_desc $ac_steps"
  if echo "$combined" | grep -qiE "$_EXTERNAL_PATTERN"; then
    echo "  → Auto-skipping $ac_id: requires external service"
    mkdir -p ".verify/evidence/$ac_id"
    printf "VERDICT: skipped\nREASONING: Auto-skipped — requires external service (matched: %s)\nSTEPS_COMPLETED: 0\n" \
      "$(echo "$combined" | grep -oiE "$_EXTERNAL_PATTERN" | head -1)" > ".verify/evidence/$ac_id/agent.log"
    SKIP_IDS+=("$ac_id")
  fi
done < <(jq -c '.criteria[]' .verify/plan.json)

# Remove skipped ACs from criteria
if [ ${#SKIP_IDS[@]} -gt 0 ]; then
  for skip_id in "${SKIP_IDS[@]}"; do
    jq --arg id "$skip_id" 'del(.criteria[] | select(.id == $id))' \
      .verify/plan.json > .verify/plan.json.tmp && mv .verify/plan.json.tmp .verify/plan.json
  done
fi

# ── 5. Schema validation ────────────────────────────────────────────────────
# Ensure required fields; add defaults for missing optional ones
jq '(.criteria[]?) |= (
  .description //= "(no description)" |
  .screenshot_at //= [] |
  .testability //= "direct"
)' .verify/plan.json > .verify/plan.json.tmp && mv .verify/plan.json.tmp .verify/plan.json

CRITERIA_COUNT=$(jq '.criteria | length' .verify/plan.json)
echo "✓ Plan validated: $CRITERIA_COUNT criteria, ${#SKIP_IDS[@]} auto-skipped"
```

**Step 4: Run test to verify it passes**

Run: `bash tests/test_plan_validator.sh`
Expected: All pass

**Step 5: Commit**

```bash
git add scripts/plan-validator.sh tests/test_plan_validator.sh
git commit -m "feat: plan-validator — deterministic URL, timeout, step-split, skip guardrails"
```

---

## Phase 3: Simplify planner prompt + integrate validator

### Task 6: Strip planner.txt and wire plan-validator into planner.sh

**Files:**
- Modify: `scripts/prompts/planner.txt`
- Modify: `scripts/planner.sh:84`

**Step 1: Strip planner.txt**

Replace the entire file with a simplified version that removes:
- All setup-related rules (rule 13 and sub-bullets)
- Timeout rules (rule 15)
- URL format rule (the "IMPORTANT" block after line 46)
- `setup` field from schema
- `timeout_seconds` field from schema
- `ON_ERROR_STOP` guidance
- Render dependency tracing guidance

Keep:
- Schema structure (minus setup/timeout fields)
- Rules 1-12, 14 (minus setup sub-bullets in 13)
- Testability tiers
- The `condition` field (English description of what must be true)

The new planner.txt should be ~40 lines, down from ~78. The `condition` field stays — it's the handoff to the setup researcher.

**Step 2: Wire plan-validator into planner.sh**

After line 84 (`echo "$PLAN_JSON" | jq '.' > .verify/plan.json`), add:

```bash
# ── Run plan validator ────────────────────────────────────────────────────────
echo "→ Running Plan Validator..."
bash "$SCRIPT_DIR/plan-validator.sh"
```

**Step 3: Run existing planner test**

Run: `bash tests/test_planner.sh`
Expected: Pass (planner test uses a mock Claude, validator runs on mock output)

**Step 4: Commit**

```bash
git add scripts/prompts/planner.txt scripts/planner.sh
git commit -m "feat: strip planner prompt to ACs+steps only, wire in plan-validator"
```

---

## Phase 4: Setup Researcher

### Task 7: Create setup-researcher prompt

**Files:**
- Create: `scripts/prompts/setup-researcher.txt`

**Step 1: Write the prompt**

Create `scripts/prompts/setup-researcher.txt`:

```
You are a test setup researcher. Your job is to create the database/application state needed for a browser test.

CONDITION: REPLACE_CONDITION
AC ID: REPLACE_AC_ID

Your task:
1. Read the project's database schema to find the right tables and columns.
   - Search for: prisma/schema.prisma, db/schema.*, **/migrations/**, src/models/**
2. Read the component code that renders the UI being tested to find ALL fields that gate rendering.
   - Look for conditional rendering: ternary operators, && gates, if checks
   - Set every field the component checks, not just what the condition describes
3. Find the database connection string from .env or .env.example — never guess the env var name.
4. Write a shell command that creates the required state.
   - Prefer INSERT ... ON CONFLICT over UPDATE with guessed values
   - Use the actual env var name from .env (e.g. NEXT_PRIVATE_DATABASE_URL, not DATABASE_URL)
   - For psql: always use --set ON_ERROR_STOP=1
5. RUN the command and check the output.
6. If it fails, read the error, fix the command, and retry (max 2 retries).

After the command succeeds, output ONLY this JSON (no markdown fences):
{"setup": ["<the working command>"]}

If you cannot create the required state after retries, output:
{"setup": [], "error": "<what went wrong>"}
```

**Step 2: Commit**

```bash
git add scripts/prompts/setup-researcher.txt
git commit -m "feat: setup-researcher prompt template"
```

---

### Task 8: Create setup-researcher.sh with tests

**Files:**
- Create: `scripts/setup-researcher.sh`
- Create: `tests/test_setup_researcher.sh`

**Step 1: Write failing test**

Create `tests/test_setup_researcher.sh`:

```bash
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"
PASS=0; FAIL=0

_assert() {
  local name="$1" cond="$2"
  if eval "$cond"; then
    echo "  PASS: $name"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"; FAIL=$((FAIL + 1))
  fi
}

# ── Test 1: Direct ACs skip researcher entirely ─────────────────────────────
echo "Test 1: direct ACs skip researcher"

find .verify/evidence -mindepth 1 -delete 2>/dev/null || true
rm -f .verify/plan.json 2>/dev/null || true
mkdir -p .verify/evidence

cat > .verify/plan.json << 'EOF'
{
  "criteria": [
    {"id":"ac1","testability":"direct","description":"CSS check","url":"/","steps":["s1"],"screenshot_at":["s"],"timeout_seconds":90},
    {"id":"ac2","testability":"conditional","condition":"needs org data","description":"billing","url":"/billing","steps":["s1"],"screenshot_at":["s"],"timeout_seconds":90}
  ],
  "skipped": []
}
EOF

# Mock Claude that returns a valid setup JSON
MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
echo '{"setup": ["echo mock-setup-ran"]}'
MOCK
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 "$SCRIPT_DIR/setup-researcher.sh" 2>/dev/null

# ac1 (direct) should have no setup in plan.json
AC1_SETUP=$(jq '.criteria[0].setup // [] | length' .verify/plan.json)
# ac2 (conditional) should have setup from researcher
AC2_SETUP=$(jq '.criteria[1].setup // [] | length' .verify/plan.json)
_assert "direct AC has no setup" '[ "$AC1_SETUP" -eq 0 ]'
_assert "conditional AC has setup" '[ "$AC2_SETUP" -gt 0 ]'
rm -f "$MOCK_CLAUDE"

# ── Test 2: Researcher failure doesn't crash pipeline ────────────────────────
echo "Test 2: researcher failure handled gracefully"

find .verify/evidence -mindepth 1 -delete 2>/dev/null || true
rm -f .verify/plan.json 2>/dev/null || true
mkdir -p .verify/evidence

cat > .verify/plan.json << 'EOF'
{
  "criteria": [
    {"id":"ac1","testability":"conditional","condition":"needs something","description":"test","url":"/","steps":["s1"],"screenshot_at":["s"],"timeout_seconds":90}
  ],
  "skipped": []
}
EOF

# Mock Claude that returns an error
MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
echo '{"setup": [], "error": "could not find schema"}'
MOCK
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 "$SCRIPT_DIR/setup-researcher.sh" 2>/dev/null
EXIT=$?

_assert "researcher exits 0 even on failure" '[ "$EXIT" -eq 0 ]'
# AC should still exist in plan (not removed)
AC_COUNT=$(jq '.criteria | length' .verify/plan.json)
_assert "AC preserved despite setup failure" '[ "$AC_COUNT" -eq 1 ]'
rm -f "$MOCK_CLAUDE"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
```

**Step 2: Run test to verify it fails**

Run: `bash tests/test_setup_researcher.sh`
Expected: FAIL — `setup-researcher.sh` doesn't exist

**Step 3: Implement setup-researcher.sh**

Create `scripts/setup-researcher.sh`:

```bash
#!/usr/bin/env bash
# Setup Researcher — per-AC LLM calls to research and validate setup commands.
# Only runs for ACs with testability=conditional.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs claude with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

# Detect timeout command
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  TIMEOUT_CMD=""
fi

# Count conditional ACs
CONDITIONAL_COUNT=$(jq '[.criteria[] | select(.testability == "conditional")] | length' .verify/plan.json)
if [ "$CONDITIONAL_COUNT" -eq 0 ]; then
  echo "→ No conditional ACs — skipping setup research"
  exit 0
fi

echo "→ Running Setup Researcher for $CONDITIONAL_COUNT conditional AC(s)..."

PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/setup-researcher.txt"

# Process each conditional AC
while IFS= read -r ac_json; do
  ac_id=$(echo "$ac_json" | jq -r '.id')
  testability=$(echo "$ac_json" | jq -r '.testability // "direct"')

  # Skip direct ACs
  if [ "$testability" != "conditional" ]; then
    continue
  fi

  condition=$(echo "$ac_json" | jq -r '.condition // "unknown"')
  echo "  → $ac_id: $condition"

  # Build prompt
  mkdir -p .verify/prompts
  PROMPT_FILE=".verify/prompts/${ac_id}-setup.txt"

  sed "s|REPLACE_CONDITION|$condition|g; s|REPLACE_AC_ID|$ac_id|g" \
    "$PROMPT_TEMPLATE" > "$PROMPT_FILE"

  # Call Claude with timeout
  set +e
  if [ -n "$TIMEOUT_CMD" ]; then
    RAW=$($TIMEOUT_CMD 120 "$CLAUDE" -p --model sonnet --dangerously-skip-permissions < "$PROMPT_FILE" 2>/dev/null)
  else
    RAW=$("$CLAUDE" -p --model sonnet --dangerously-skip-permissions < "$PROMPT_FILE" 2>/dev/null)
  fi
  EXIT=$?
  set -e

  if [ $EXIT -ne 0 ]; then
    echo "    ⚠ Researcher failed for $ac_id (exit $EXIT) — AC will run without setup"
    continue
  fi

  # Parse response — strip markdown fences
  SETUP_JSON=$(echo "$RAW" | sed '/^```/d' | tr -d '\r')

  # Extract setup commands
  SETUP_CMDS=$(echo "$SETUP_JSON" | jq '.setup // []' 2>/dev/null)
  ERROR_MSG=$(echo "$SETUP_JSON" | jq -r '.error // empty' 2>/dev/null)

  if [ -n "$ERROR_MSG" ]; then
    echo "    ⚠ Researcher error for $ac_id: $ERROR_MSG — AC will run without setup"
    continue
  fi

  SETUP_COUNT=$(echo "$SETUP_CMDS" | jq 'length' 2>/dev/null || echo 0)
  if [ "$SETUP_COUNT" -gt 0 ]; then
    # Write validated setup commands into plan.json
    jq --arg id "$ac_id" --argjson setup "$SETUP_CMDS" \
      '(.criteria[] | select(.id == $id)).setup = $setup' \
      .verify/plan.json > .verify/plan.json.tmp && mv .verify/plan.json.tmp .verify/plan.json
    echo "    ✓ $ac_id: $SETUP_COUNT setup command(s) validated"
  else
    echo "    → $ac_id: no setup needed"
  fi

done < <(jq -c '.criteria[]' .verify/plan.json)

echo "✓ Setup research complete"
```

**Step 4: Run test to verify it passes**

Run: `bash tests/test_setup_researcher.sh`
Expected: All pass

**Step 5: Commit**

```bash
git add scripts/setup-researcher.sh scripts/prompts/setup-researcher.txt tests/test_setup_researcher.sh
git commit -m "feat: setup-researcher — per-AC LLM setup with feedback loop"
```

---

### Task 9: Wire setup-researcher into planner.sh

**Files:**
- Modify: `scripts/planner.sh`

**Step 1: Add setup-researcher call after plan-validator**

After the plan-validator call added in Task 6, add:

```bash
# ── Run setup researcher ─────────────────────────────────────────────────────
echo "→ Running Setup Researcher..."
bash "$SCRIPT_DIR/setup-researcher.sh"
```

**Step 2: Run planner test**

Run: `bash tests/test_planner.sh`
Expected: Pass

**Step 3: Commit**

```bash
git add scripts/planner.sh
git commit -m "feat: wire setup-researcher into planner pipeline"
```

---

## Phase 5: Update verify skill

### Task 10: Update SKILL.md Turn 5

**Files:**
- Modify: `skills/verify/SKILL.md`

**Step 1: Simplify Turn 5**

The setup research (Steps 2-3) is now handled by `setup-researcher.sh` inside `planner.sh`. Update Turn 5 to remove the manual research steps and replace with the automated pipeline.

Replace Turn 5 Steps 2-5 with:

```markdown
**Step 2 — Review the plan**

The planner has already:
- Computed timeouts from step count
- Split ACs with >10 steps
- Auto-skipped external-service ACs
- Researched and validated setup commands for conditional ACs

Show the plan to the user:

\```bash
echo "ACs to verify:"
jq -r '.criteria[] | "  • \(.id) [\(.testability)] \(.description) (timeout: \(.timeout_seconds)s, \(.steps | length) steps)"' .verify/plan.json
echo ""
jq -r '.criteria[] | select(.setup != null and (.setup | length) > 0) | "  Setup for \(.id): \(.setup | join("; "))"' .verify/plan.json
\```

**Step 3 — Single confirmation**

Ask:
> "Ready to run? (y = run all / s [ac-id] = skip that AC / edit = adjust)"
```

Remove Steps 4-5 (the manual setup execution) — the orchestrator handles setup now.

**Step 2: Commit**

```bash
git add skills/verify/SKILL.md
git commit -m "feat: simplify verify skill Turn 5 — setup research now automated"
```

---

## Phase 6: Remove redundant orchestrator checks

### Task 11: Remove orchestrator URL/skip logic (now in validator)

**Files:**
- Modify: `scripts/orchestrate.sh`

**Step 1: Remove the URL sanitization block (lines 34-41)**

This is now handled by `plan-validator.sh` which runs before orchestrate.

**Step 2: Remove the external-service auto-skip block (lines 43-59)**

Also now in `plan-validator.sh`. Keep the `SKIP_IDS` array and skip-check in the loops as defense-in-depth, but populate it from plan.json's evidence directory instead:

```bash
# Check for ACs already skipped by plan-validator
SKIP_IDS=()
while IFS= read -r ac_id; do
  if [ -f ".verify/evidence/$ac_id/agent.log" ] && grep -q "^VERDICT: skipped" ".verify/evidence/$ac_id/agent.log" 2>/dev/null; then
    SKIP_IDS+=("$ac_id")
  fi
done < <(jq -r '.criteria[].id' .verify/plan.json)
```

**Step 3: Run all tests**

Run: `bash tests/test_pipeline_robustness.sh && bash tests/test_orchestrate.sh && bash tests/test_plan_validator.sh`
Expected: All pass

**Step 4: Commit**

```bash
git add scripts/orchestrate.sh
git commit -m "refactor: remove redundant URL/skip logic from orchestrator (now in validator)"
```

---

## Verification

After all tasks, run the full test suite:

```bash
for f in tests/test_*.sh; do
  echo "=== $f ==="
  VERIFY_ALLOW_DANGEROUS=1 bash "$f" || echo "FAILED: $f"
  echo ""
done
```

All tests should pass. The pipeline flow is now:

```
spec → planner (ACs + steps) → plan-validator (URLs, timeouts, splits, skips) → setup-researcher (per-AC setup) → orchestrate → agents → judge → report
```
