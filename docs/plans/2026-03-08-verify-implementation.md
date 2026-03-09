# Frontend Verify Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a `/verify` Claude Code skill that verifies frontend changes against spec doc acceptance criteria, producing per-AC verdicts and demo videos — running entirely locally via `claude -p` with OAuth.

**Architecture:** Bash scripts in `tools/verify/` handle each pipeline stage. Two Claude Code skill files (`.claude/skills/verify.md`, `.claude/skills/verify-setup.md`) orchestrate the scripts. `claude -p` subprocess calls drive LLM stages. Config is read inline via `jq` — no config abstraction layer.

**Tech Stack:** Bash, `jq` (JSON), `curl` (health checks), `claude -p` (LLM calls), `@playwright/mcp` (browser), Claude Code skills (markdown)

**Prerequisites:** `brew install coreutils` (for `gtimeout`), `jq`, `npx` (Node.js)

---

## Task 1: Project Bootstrap

**Files:**
- Create: `.gitignore`
- Create: `.verify/config.json`
- Create: `tools/verify/` (directory)
- Create: `tools/verify/tests/` (directory)
- Create: `tools/verify/prompts/` (directory)
- Create: `.claude/skills/` (directory)

**Step 1: Create directory structure**

```bash
mkdir -p tools/verify/tests tools/verify/prompts .verify .claude/skills
```

**Step 2: Create .gitignore**

```bash
cat > .gitignore << 'EOF'
# Verify pipeline — secrets and artifacts (config.json is committed)
.verify/auth.json
.verify/evidence/
.verify/prompts/
.verify/report.json
.verify/plan.json
.verify/.spec_path
.verify/chrome-profile/
EOF
```

**Step 3: Create default config**

```bash
cat > .verify/config.json << 'EOF'
{
  "baseUrl": "http://localhost:3000",
  "authCheckUrl": "/api/me",
  "specPath": null
}
EOF
```

Note: `specPath: null` means auto-detect from git diff. `config.json` is committed — no secrets.

**Step 4: Verify structure**

```bash
find tools .verify .claude -type d
```

Expected:
```
tools
tools/verify
tools/verify/tests
tools/verify/prompts
.verify
.claude
.claude/skills
```

**Step 5: Commit**

```bash
git init
git add .gitignore .verify/config.json
git commit -m "chore: bootstrap verify pipeline project structure"
```

---

## Task 2: Stage 0 — Pre-flight

**Files:**
- Create: `tools/verify/preflight.sh`
- Create: `tools/verify/tests/test_preflight.sh`

**Step 1: Write the failing test**

```bash
cat > tools/verify/tests/test_preflight.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Test 1: fails when dev server is down
export VERIFY_BASE_URL="http://localhost:19999"
output=$("$SCRIPT_DIR/preflight.sh" --skip-auth --skip-spec 2>&1)
exit_code=$?
[ $exit_code -ne 0 ] || { echo "FAIL: should exit non-zero when server down"; exit 1; }
echo "$output" | grep -q "not reachable" || { echo "FAIL: missing 'not reachable'. Got: $output"; exit 1; }

# Test 2: passes when server is up
python3 -c "
import http.server, threading
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
s = http.server.HTTPServer(('', 19998), H)
t = threading.Thread(target=s.serve_forever); t.daemon=True; t.start()
import time; time.sleep(5)
" &
SERVER_PID=$!
sleep 0.5

export VERIFY_BASE_URL="http://localhost:19998"
output=$("$SCRIPT_DIR/preflight.sh" --skip-auth --skip-spec 2>&1)
exit_code=$?
kill $SERVER_PID 2>/dev/null
[ $exit_code -eq 0 ] || { echo "FAIL: should pass when server up. Got: $output"; exit 1; }

echo "PASS: preflight tests"
EOF
chmod +x tools/verify/tests/test_preflight.sh
```

**Step 2: Run to verify it fails**

```bash
bash tools/verify/tests/test_preflight.sh
```

Expected: `preflight.sh: No such file or directory`

**Step 3: Implement preflight.sh**

```bash
cat > tools/verify/preflight.sh << 'EOF'
#!/usr/bin/env bash
set -e

SKIP_AUTH=false
SKIP_SPEC=false
for arg in "$@"; do
  case $arg in
    --skip-auth) SKIP_AUTH=true ;;
    --skip-spec) SKIP_SPEC=true ;;
  esac
done

# Check for gtimeout (macOS coreutils) or timeout (Linux)
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  echo "✗ timeout command not found. Install: brew install coreutils"
  exit 1
fi
export TIMEOUT_CMD

# Load config inline
CONFIG_FILE=".verify/config.json"
VERIFY_BASE_URL=$(jq -r '.baseUrl // "http://localhost:3000"' "$CONFIG_FILE" 2>/dev/null || echo "http://localhost:3000")
VERIFY_AUTH_CHECK_URL=$(jq -r '.authCheckUrl // "/api/me"' "$CONFIG_FILE" 2>/dev/null || echo "/api/me")
VERIFY_SPEC_PATH=$(jq -r '.specPath // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
export VERIFY_BASE_URL VERIFY_AUTH_CHECK_URL VERIFY_SPEC_PATH

# 1. Dev server health check
echo "→ Checking dev server at $VERIFY_BASE_URL..."
if ! curl -sf --max-time 5 "$VERIFY_BASE_URL" > /dev/null 2>&1; then
  echo "✗ Dev server not reachable at $VERIFY_BASE_URL. Start it and retry."
  exit 1
fi
echo "✓ Dev server reachable"

# 2. Auth validity check
if [ "$SKIP_AUTH" = false ]; then
  if [ ! -f ".verify/auth.json" ]; then
    echo "✗ No auth state found. Run /verify setup first."
    exit 1
  fi
  AUTH_URL="${VERIFY_BASE_URL}${VERIFY_AUTH_CHECK_URL}"
  echo "→ Checking auth at $AUTH_URL..."
  # Build Cookie header string from Playwright storageState JSON
  COOKIE_STR=$(jq -r '[.cookies[]? | "\(.name)=\(.value)"] | join("; ")' .verify/auth.json 2>/dev/null || echo "")
  HTTP_CODE=$(curl -sf --max-time 5 \
    ${COOKIE_STR:+-H "Cookie: $COOKIE_STR"} \
    -o /dev/null -w "%{http_code}" \
    "$AUTH_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "000" ]; then
    echo "✗ Session expired or invalid (HTTP $HTTP_CODE). Run /verify setup to re-authenticate."
    exit 1
  fi
  echo "✓ Auth valid (HTTP $HTTP_CODE)"
fi

# 3. Spec doc detection
if [ "$SKIP_SPEC" = false ]; then
  echo "→ Finding spec doc..."
  SPEC_PATH=""

  if [ -n "$VERIFY_SPEC_PATH" ]; then
    SPEC_PATH="$VERIFY_SPEC_PATH"
  else
    # Changed files in diff (tracked)
    SPEC_PATH=$(git diff --name-only HEAD 2>/dev/null | grep "^docs/plans/.*\.md$" | head -1 || true)
    # Newly added (untracked)
    if [ -z "$SPEC_PATH" ]; then
      SPEC_PATH=$(git ls-files --others --exclude-standard 2>/dev/null | grep "^docs/plans/.*\.md$" | head -1 || true)
    fi
    # Fall back to newest by mtime
    if [ -z "$SPEC_PATH" ]; then
      SPEC_PATH=$(find docs/plans -name "*.md" 2>/dev/null | xargs ls -t 2>/dev/null | head -1 || true)
    fi
  fi

  if [ -z "$SPEC_PATH" ] || [ ! -f "$SPEC_PATH" ]; then
    echo "✗ No spec doc found. Set specPath in .verify/config.json or add a plan doc to docs/plans/."
    exit 1
  fi

  echo "✓ Spec doc: $SPEC_PATH"
  mkdir -p .verify
  echo "$SPEC_PATH" > .verify/.spec_path
fi

echo "✓ Pre-flight complete"
EOF
chmod +x tools/verify/preflight.sh
```

**Step 4: Run to verify it passes**

```bash
bash tools/verify/tests/test_preflight.sh
```

Expected: `PASS: preflight tests`

**Step 5: Commit**

```bash
git add tools/verify/preflight.sh tools/verify/tests/test_preflight.sh
git commit -m "feat: stage 0 pre-flight — dev server, auth, and spec detection"
```

---

## Task 3: Planner Prompt Template

**Files:**
- Create: `tools/verify/prompts/planner.txt`

**Step 1: Write the planner prompt**

```bash
cat > tools/verify/prompts/planner.txt << 'EOF'
You are a frontend test planner. Read the spec document and produce structured acceptance criteria with concrete browser test steps.

Return ONLY a valid JSON object. No markdown fences, no explanation. Raw JSON only.

Schema:
{
  "criteria": [
    {
      "id": "ac1",
      "description": "<exact AC from spec>",
      "url": "<path, e.g. /dashboard>",
      "steps": [
        "<concrete browser action, e.g. 'scroll down 500px'>",
        "<assertion, e.g. 'assert header has CSS position fixed'>"
      ],
      "screenshot_at": ["<snake_case label for when to screenshot>"]
    }
  ],
  "skipped": ["<id>: <reason too vague to test automatically>"]
}

Rules:
1. Extract ONLY explicit, testable acceptance criteria. Skip vague ones ("looks good", "feels right").
2. Prefer selectors: data-testid > aria-label > role > text content > CSS class.
3. Steps must be concrete actions a Playwright agent can execute directly.
4. Each AC goes into criteria OR skipped — never both.
5. Use component file selectors where available. Do not invent selectors.
6. Screenshot labels are snake_case descriptions of page state at capture time.
7. Output raw JSON only — no ```json fences.
EOF
```

**Step 2: Commit**

```bash
git add tools/verify/prompts/planner.txt
git commit -m "feat: planner prompt template"
```

---

## Task 4: Stage 1 — Planner Script

**Files:**
- Create: `tools/verify/planner.sh`
- Create: `tools/verify/tests/test_planner.sh`

**Step 1: Write the failing test**

```bash
cat > tools/verify/tests/test_planner.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$SCRIPT_DIR/tests/fixtures"
mkdir -p "$FIXTURES"

cat > "$FIXTURES/test-spec.md" << 'SPEC'
## Acceptance Criteria
- Header must be sticky on scroll
- Mobile nav collapses below 768px viewport width
- The button looks nice
SPEC

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"criteria":[{"id":"ac1","description":"Header sticky on scroll","url":"/","steps":["scroll down 300px","assert header position fixed"],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav collapses below 768px","url":"/","steps":["set viewport 375x812","assert hamburger visible"],"screenshot_at":["viewport_set"]}],"skipped":["ac3: 'button looks nice' is too vague"]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

mkdir -p .verify
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_BASE_URL="http://localhost:3000" \
  "$SCRIPT_DIR/planner.sh" "$FIXTURES/test-spec.md" 2>/dev/null

[ -f ".verify/plan.json" ] || { echo "FAIL: plan.json not created"; exit 1; }
COUNT=$(jq '.criteria | length' .verify/plan.json)
[ "$COUNT" = "2" ] || { echo "FAIL: expected 2 criteria, got $COUNT"; exit 1; }
SKIPPED=$(jq -r '.skipped[0]' .verify/plan.json)
echo "$SKIPPED" | grep -q "vague" || { echo "FAIL: skipped should mention vague. Got: $SKIPPED"; exit 1; }

echo "PASS: planner tests"
rm -f "$MOCK_CLAUDE"
EOF
chmod +x tools/verify/tests/test_planner.sh
```

**Step 2: Run to verify it fails**

```bash
bash tools/verify/tests/test_planner.sh
```

Expected: `planner.sh: No such file or directory`

**Step 3: Implement planner.sh**

```bash
cat > tools/verify/planner.sh << 'EOF'
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

SPEC_PATH="${1:-$(cat .verify/.spec_path 2>/dev/null)}"
[ -n "$SPEC_PATH" ] && [ -f "$SPEC_PATH" ] || { echo "✗ Spec doc not found: $SPEC_PATH"; exit 1; }

VERIFY_BASE_URL="${VERIFY_BASE_URL:-$(jq -r '.baseUrl // "http://localhost:3000"' .verify/config.json 2>/dev/null)}"

echo "→ Running Planner (Opus)..."
echo "  Spec: $SPEC_PATH"

# Collect changed React component files (tracked changes + new untracked files)
COMPONENT_CONTEXT=""
{
  git diff --name-only HEAD 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
} | grep -E "\.(tsx?|jsx?)$" | head -10 | while IFS= read -r file; do
  [ -f "$file" ] || continue
  COMPONENT_CONTEXT+="\n\n--- FILE: $file ---\n$(cat "$file")"
done

PROMPT="$(cat "$SCRIPT_DIR/prompts/planner.txt")

---
BASE URL: ${VERIFY_BASE_URL}

SPEC DOC (${SPEC_PATH}):
$(cat "$SPEC_PATH")
${COMPONENT_CONTEXT}"

# Call Opus — capture raw output once, parse separately
RAW=$("$CLAUDE" -p --model opus "$PROMPT" 2>/dev/null)

# Strip markdown fences if model ignores the instruction
PLAN_JSON=$(echo "$RAW" | sed '/^```/d' | sed '/^$/d' | tr -d '\r')

# Validate JSON
if ! echo "$PLAN_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Planner returned invalid JSON:"
  echo "$PLAN_JSON" | head -20
  exit 1
fi

mkdir -p .verify
echo "$PLAN_JSON" | jq '.' > .verify/plan.json

# Print skipped
SKIPPED_COUNT=$(jq '.skipped | length' .verify/plan.json)
if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  jq -r '.skipped[]' .verify/plan.json | while IFS= read -r msg; do
    echo "  ⚠ Skipped: $msg"
  done
fi

CRITERIA_COUNT=$(jq '.criteria | length' .verify/plan.json)
echo "✓ Planner complete: $CRITERIA_COUNT criteria, $SKIPPED_COUNT skipped → .verify/plan.json"
EOF
chmod +x tools/verify/planner.sh
```

**Step 4: Run to verify it passes**

```bash
bash tools/verify/tests/test_planner.sh
```

Expected: `PASS: planner tests`

**Step 5: Commit**

```bash
git add tools/verify/planner.sh tools/verify/tests/test_planner.sh
git commit -m "feat: stage 1 planner — Opus AC extraction and test scenario generation"
```

---

## Task 5: Agent Prompt Template

**Files:**
- Create: `tools/verify/prompts/agent.txt`

**Step 1: Write agent system prompt**

```bash
cat > tools/verify/prompts/agent.txt << 'EOF'
You are a browser verification agent. You have Playwright MCP tools available to control a browser.

Verify ONE acceptance criterion by following the steps exactly. Report findings at the end.

ACCEPTANCE CRITERION: REPLACE_AC_DESCRIPTION
AC ID: REPLACE_AC_ID
START URL: REPLACE_BASE_URL

STEPS:
REPLACE_STEPS

SCREENSHOT CHECKPOINTS: Take a screenshot at each of these moments: REPLACE_SCREENSHOT_AT
Save screenshots to: .verify/evidence/REPLACE_AC_ID/screenshot-LABEL.png
(replace LABEL with the checkpoint name, e.g. screenshot-after_scroll.png)

INSTRUCTIONS:
1. Execute each step in order using Playwright MCP tools
2. Take a screenshot at each checkpoint and save it using the path above
3. If a step fails, retry once. Log the failure and continue
4. After all steps, write EXACTLY this to .verify/evidence/REPLACE_AC_ID/agent.log:

VERDICT: pass|fail|error
REASONING: <one sentence: what you observed>
STEPS_COMPLETED: <n>/<total>

5. Be objective — report what you see, not what you expect
6. If the page shows a login screen, write: VERDICT: error / REASONING: Auth redirect — session may be stale
EOF
```

Note: uses `REPLACE_` prefixes instead of `{{}}` to allow reliable `sed -i` replacement across all occurrences.

**Step 2: Commit**

```bash
git add tools/verify/prompts/agent.txt
git commit -m "feat: agent prompt template with REPLACE_ placeholders"
```

---

## Task 6: Stage 2 — Single Browser Agent

**Files:**
- Create: `tools/verify/agent.sh`
- Create: `tools/verify/tests/test_agent.sh`

**Step 1: Write the failing test**

```bash
cat > tools/verify/tests/test_agent.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p .verify/evidence/ac1
echo '{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":["scroll down 300px","assert header fixed"],"screenshot_at":["after_scroll"]}],"skipped":[]}' > .verify/plan.json
echo '{"cookies":[],"origins":[]}' > .verify/auth.json

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
mkdir -p .verify/evidence/ac1
printf "VERDICT: pass\nREASONING: Header remained fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
echo "Agent completed ac1"
MOCK
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_BASE_URL="http://localhost:3000" \
  "$SCRIPT_DIR/agent.sh" "ac1" 2>/dev/null

[ -f ".verify/evidence/ac1/agent.log" ] || { echo "FAIL: agent.log not created"; exit 1; }
VERDICT=$(grep "^VERDICT:" .verify/evidence/ac1/agent.log | awk '{print $2}')
[ "$VERDICT" = "pass" ] || { echo "FAIL: expected pass, got: $VERDICT"; exit 1; }

echo "PASS: agent tests"
rm -f "$MOCK_CLAUDE"
EOF
chmod +x tools/verify/tests/test_agent.sh
```

**Step 2: Run to verify it fails**

```bash
bash tools/verify/tests/test_agent.sh
```

Expected: `agent.sh: No such file or directory`

**Step 3: Implement agent.sh**

```bash
cat > tools/verify/agent.sh << 'EOF'
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

AC_ID="$1"
TIMEOUT_SECS="${2:-90}"

[ -n "$AC_ID" ] || { echo "Usage: $0 <ac_id> [timeout_secs]"; exit 1; }
[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

# Detect timeout command (macOS: gtimeout from coreutils; Linux: timeout)
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  echo "✗ timeout not found. Install: brew install coreutils"
  exit 1
fi

VERIFY_BASE_URL="${VERIFY_BASE_URL:-$(jq -r '.baseUrl // "http://localhost:3000"' .verify/config.json 2>/dev/null)}"

# Extract AC data
AC_JSON=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id == $id)' .verify/plan.json)
[ -n "$AC_JSON" ] || { echo "✗ AC '$AC_ID' not found in plan.json"; exit 1; }

AC_DESC=$(echo "$AC_JSON" | jq -r '.description')
AC_URL=$(echo "$AC_JSON" | jq -r '.url')
STEPS=$(echo "$AC_JSON" | jq -r '.steps[]' | nl -ba)
SCREENSHOTS=$(echo "$AC_JSON" | jq -r '.screenshot_at | join(", ")')

# Build agent prompt inline (no separate build_agent_prompt.sh)
# Use sed with global replacement so all REPLACE_AC_ID occurrences are substituted
PROMPT=$(sed \
  -e "s|REPLACE_AC_DESCRIPTION|$AC_DESC|g" \
  -e "s|REPLACE_AC_ID|$AC_ID|g" \
  -e "s|REPLACE_BASE_URL|${VERIFY_BASE_URL}${AC_URL}|g" \
  -e "s|REPLACE_SCREENSHOT_AT|$SCREENSHOTS|g" \
  "$SCRIPT_DIR/prompts/agent.txt")
# Steps may be multi-line — use Python for safe substitution
PROMPT=$(echo "$PROMPT" | python3 -c "
import sys
content = sys.stdin.read()
import os
steps = '''$STEPS'''
print(content.replace('REPLACE_STEPS', steps))
")

mkdir -p ".verify/evidence/$AC_ID"
echo "$PROMPT" > ".verify/prompts/${AC_ID}-agent.txt"

# Playwright MCP config
MCP_CONFIG=$(jq -n '{
  playwright: {
    command: "npx",
    args: [
      "@playwright/mcp@latest",
      "--save-video=1280x720",
      "--caps", "vision",
      "--storage-state", ".verify/auth.json",
      "--save-trace"
    ]
  }
}')

echo "  → Agent $AC_ID (timeout: ${TIMEOUT_SECS}s)..."

set +e
$TIMEOUT_CMD "$TIMEOUT_SECS" "$CLAUDE" -p \
  --model sonnet \
  --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG" \
  "$PROMPT" > ".verify/evidence/$AC_ID/claude.log" 2>&1
EXIT_CODE=$?
set -e

LOG_FILE=".verify/evidence/$AC_ID/agent.log"

if [ $EXIT_CODE -eq 124 ]; then
  printf "VERDICT: timeout\nREASONING: Agent exceeded ${TIMEOUT_SECS}s\nSTEPS_COMPLETED: unknown\n" > "$LOG_FILE"
  echo "  ⏱ $AC_ID: timeout"
elif [ $EXIT_CODE -ne 0 ]; then
  printf "VERDICT: error\nREASONING: Agent exited with code $EXIT_CODE\nSTEPS_COMPLETED: 0/unknown\n" > "$LOG_FILE"
  echo "  ✗ $AC_ID: error (exit $EXIT_CODE)"
else
  if [ ! -f "$LOG_FILE" ]; then
    grep -A2 "^VERDICT:" ".verify/evidence/$AC_ID/claude.log" > "$LOG_FILE" 2>/dev/null || \
      printf "VERDICT: error\nREASONING: Agent did not write agent.log\nSTEPS_COMPLETED: unknown\n" > "$LOG_FILE"
  fi
  VERDICT=$(grep "^VERDICT:" "$LOG_FILE" | awk '{print $2}')
  echo "  ✓ $AC_ID: done (verdict: $VERDICT)"
fi
EOF
chmod +x tools/verify/agent.sh
```

**Step 4: Run to verify it passes**

```bash
bash tools/verify/tests/test_agent.sh
```

Expected: `PASS: agent tests`

**Step 5: Commit**

```bash
git add tools/verify/agent.sh tools/verify/tests/test_agent.sh
git commit -m "feat: stage 2 browser agent — Playwright MCP, 90s timeout, inline prompt building"
```

---

## Task 7: Stage 2 — Agent Orchestrator

**Files:**
- Create: `tools/verify/orchestrate.sh`
- Create: `tools/verify/tests/test_orchestrate.sh`

**Step 1: Write the failing test**

```bash
cat > tools/verify/tests/test_orchestrate.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p .verify
echo '{"criteria":[{"id":"ac1","description":"T1","url":"/","steps":["s1"],"screenshot_at":["s1"]},{"id":"ac2","description":"T2","url":"/","steps":["s2"],"screenshot_at":["s2"]}],"skipped":[]}' > .verify/plan.json

MOCK_AGENT=$(mktemp)
cat > "$MOCK_AGENT" << 'MOCK'
#!/usr/bin/env bash
AC_ID="$1"
mkdir -p ".verify/evidence/$AC_ID"
printf "VERDICT: pass\nREASONING: mock\nSTEPS_COMPLETED: 1/1\n" > ".verify/evidence/$AC_ID/agent.log"
MOCK
chmod +x "$MOCK_AGENT"

unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
AGENT_BIN="$MOCK_AGENT" "$SCRIPT_DIR/orchestrate.sh" 2>/dev/null

[ -f ".verify/evidence/ac1/agent.log" ] || { echo "FAIL: ac1 agent.log missing"; exit 1; }
[ -f ".verify/evidence/ac2/agent.log" ] || { echo "FAIL: ac2 agent.log missing"; exit 1; }

echo "PASS: orchestrate tests"
rm -f "$MOCK_AGENT"
EOF
chmod +x tools/verify/tests/test_orchestrate.sh
```

**Step 2: Run to verify it fails**

```bash
bash tools/verify/tests/test_orchestrate.sh
```

Expected: `orchestrate.sh: No such file or directory`

**Step 3: Implement orchestrate.sh**

```bash
cat > tools/verify/orchestrate.sh << 'EOF'
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_BIN="${AGENT_BIN:-$SCRIPT_DIR/agent.sh}"
CLAUDE="${CLAUDE_BIN:-claude}"

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

# Read all AC IDs
mapfile -t AC_IDS < <(jq -r '.criteria[].id' .verify/plan.json)
COUNT=${#AC_IDS[@]}
echo "→ Running $COUNT browser agent(s)..."

if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" = "1" ]; then
  echo "  Mode: parallel (agent teams)"

  # Build --agents JSON safely using jq (not string concatenation)
  # Start with empty object, add each agent
  AGENTS_JSON='{}'
  for AC_ID in "${AC_IDS[@]}"; do
    AC_DESC=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .description' .verify/plan.json)
    # Pre-build the prompt file
    mkdir -p ".verify/prompts"
    # Run agent in dry-run to get the prompt without executing
    PROMPT_FILE=".verify/prompts/${AC_ID}-agent.txt"
    # Build prompt directly (same logic as agent.sh)
    AC_JSON=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id == $id)' .verify/plan.json)
    AC_URL=$(echo "$AC_JSON" | jq -r '.url')
    VERIFY_BASE_URL=$(jq -r '.baseUrl // "http://localhost:3000"' .verify/config.json 2>/dev/null)
    STEPS=$(echo "$AC_JSON" | jq -r '.steps[]' | nl -ba)
    SCREENSHOTS=$(echo "$AC_JSON" | jq -r '.screenshot_at | join(", ")')

    sed \
      -e "s|REPLACE_AC_DESCRIPTION|$AC_DESC|g" \
      -e "s|REPLACE_AC_ID|$AC_ID|g" \
      -e "s|REPLACE_BASE_URL|${VERIFY_BASE_URL}${AC_URL}|g" \
      -e "s|REPLACE_SCREENSHOT_AT|$SCREENSHOTS|g" \
      "$SCRIPT_DIR/prompts/agent.txt" | python3 -c "
import sys
content = sys.stdin.read()
steps = '''$STEPS'''
print(content.replace('REPLACE_STEPS', steps))
" > "$PROMPT_FILE"

    # Add to agents JSON using jq to ensure valid JSON encoding
    AGENTS_JSON=$(jq \
      --arg key "${AC_ID}_agent" \
      --arg desc "Verify: $AC_DESC" \
      --arg prompt "$(cat "$PROMPT_FILE")" \
      '.[$key] = {"description": $desc, "prompt": $prompt}' \
      <<< "$AGENTS_JSON")
  done

  MCP_CONFIG='{"playwright":{"command":"npx","args":["@playwright/mcp@latest","--save-video=1280x720","--caps","vision","--storage-state",".verify/auth.json","--save-trace"]}}'

  "$CLAUDE" -p \
    --model sonnet \
    --dangerously-skip-permissions \
    --mcp-config "$MCP_CONFIG" \
    --agents "$AGENTS_JSON" \
    "Run all browser verification agents. Each agent verifies one acceptance criterion and writes its verdict to .verify/evidence/<ac_id>/agent.log" \
    2>&1 | tee .verify/orchestrate.log

else
  echo "  Mode: sequential"
  for AC_ID in "${AC_IDS[@]}"; do
    "$AGENT_BIN" "$AC_ID" 90
  done
fi

echo "✓ All agents complete"
EOF
chmod +x tools/verify/orchestrate.sh
```

**Step 4: Run to verify it passes**

```bash
bash tools/verify/tests/test_orchestrate.sh
```

Expected: `PASS: orchestrate tests`

**Step 5: Commit**

```bash
git add tools/verify/orchestrate.sh tools/verify/tests/test_orchestrate.sh
git commit -m "feat: stage 2 orchestrator — parallel agents (safe jq JSON) + sequential fallback"
```

---

## Task 8: Stage 3 — Judge

**Files:**
- Create: `tools/verify/judge.sh`
- Create: `tools/verify/prompts/judge.txt`
- Create: `tools/verify/tests/test_judge.sh`

**Step 1: Write judge prompt**

```bash
cat > tools/verify/prompts/judge.txt << 'EOF'
You are a quality judge reviewing frontend verification results. Screenshots are embedded below as base64 images.

For each acceptance criterion, review the evidence (screenshot + agent log) and return a verdict.

Return ONLY a valid JSON object. No markdown fences, no explanation. Raw JSON only.

Schema:
{
  "verdict": "pass|fail|partial",
  "summary": "<N>/<total> ACs passed",
  "criteria": [
    {
      "ac_id": "<id>",
      "status": "pass|fail|error|timeout",
      "reasoning": "<one sentence: what you observed>",
      "evidence": "<screenshot path>"
    }
  ],
  "skipped": []
}

Rules:
1. Use the screenshot as primary evidence. Agent log is context.
2. pass = criterion clearly met in the screenshot
3. fail = criterion clearly not met
4. error = agent crashed or hit login redirect — cannot judge
5. timeout = agent timed out — cannot judge
6. Be strict: if you cannot clearly confirm the criterion, mark as fail.
7. If a screenshot shows a login page, mark as error: "Auth redirect".
EOF
```

**Step 2: Write the failing test**

```bash
cat > tools/verify/tests/test_judge.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p .verify/evidence/ac1 .verify/evidence/ac2
echo '{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":[],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav","url":"/","steps":[],"screenshot_at":["initial"]}],"skipped":[]}' > .verify/plan.json
printf "VERDICT: pass\nREASONING: Header fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
printf "VERDICT: fail\nREASONING: Hamburger missing\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac2/agent.log

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"verdict":"partial","summary":"1/2 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header confirmed fixed","evidence":".verify/evidence/ac1/agent.log"},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger not visible","evidence":".verify/evidence/ac2/agent.log"}],"skipped":[]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/judge.sh" 2>/dev/null

[ -f ".verify/report.json" ] || { echo "FAIL: report.json not created"; exit 1; }
VERDICT=$(jq -r '.verdict' .verify/report.json)
[ "$VERDICT" = "partial" ] || { echo "FAIL: expected partial, got $VERDICT"; exit 1; }

echo "PASS: judge tests"
rm -f "$MOCK_CLAUDE"
EOF
chmod +x tools/verify/tests/test_judge.sh
```

**Step 3: Run to verify it fails**

```bash
bash tools/verify/tests/test_judge.sh
```

Expected: `judge.sh: No such file or directory`

**Step 4: Implement judge.sh**

```bash
cat > tools/verify/judge.sh << 'EOF'
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }
echo "→ Running Judge (Opus)..."

SKIPPED=$(jq -r '.skipped' .verify/plan.json)
mapfile -t AC_IDS < <(jq -r '.criteria[].id' .verify/plan.json)

# Build evidence block — base64-encode screenshots inline (claude -p has no --file for local images)
EVIDENCE=""
for AC_ID in "${AC_IDS[@]}"; do
  AC_DESC=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .description' .verify/plan.json)
  EVIDENCE+="\n--- AC: $AC_ID ---\n"
  EVIDENCE+="CRITERION: $AC_DESC\n"

  LOG_FILE=".verify/evidence/$AC_ID/agent.log"
  if [ -f "$LOG_FILE" ]; then
    EVIDENCE+="AGENT LOG:\n$(cat "$LOG_FILE")\n"
  else
    EVIDENCE+="AGENT LOG: not found\n"
  fi

  # Embed screenshots as base64 inline — Opus can read them in the prompt
  while IFS= read -r screenshot; do
    [ -f "$screenshot" ] || continue
    LABEL=$(basename "$screenshot" .png)
    B64=$(base64 < "$screenshot" | tr -d '\n')
    EVIDENCE+="SCREENSHOT ($LABEL): data:image/png;base64,${B64}\n"
  done < <(find ".verify/evidence/$AC_ID" -name "screenshot-*.png" 2>/dev/null | sort)
done

PROMPT="$(cat "$SCRIPT_DIR/prompts/judge.txt")

EVIDENCE:
$EVIDENCE

SKIPPED FROM PLAN: $SKIPPED"

REPORT_JSON=$("$CLAUDE" -p \
  --model opus \
  --dangerously-skip-permissions \
  "$PROMPT" 2>/dev/null)

# Strip any markdown fences
REPORT_JSON=$(echo "$REPORT_JSON" | sed '/^```/d' | sed '/^$/d')

if ! echo "$REPORT_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Judge returned invalid JSON:"
  echo "$REPORT_JSON" | head -20
  exit 1
fi

echo "$REPORT_JSON" | jq '.' > .verify/report.json

VERDICT=$(jq -r '.verdict' .verify/report.json)
SUMMARY=$(jq -r '.summary' .verify/report.json)
echo "✓ Judge complete: $SUMMARY (verdict: $VERDICT)"
EOF
chmod +x tools/verify/judge.sh
```

**Step 5: Run to verify it passes**

```bash
bash tools/verify/tests/test_judge.sh
```

Expected: `PASS: judge tests`

**Step 6: Commit**

```bash
git add tools/verify/judge.sh tools/verify/prompts/judge.txt tools/verify/tests/test_judge.sh
git commit -m "feat: stage 3 judge — Opus visual verdict with base64 screenshot embedding"
```

---

## Task 9: Reporter

**Files:**
- Create: `tools/verify/report.sh`
- Create: `tools/verify/tests/test_report.sh`

**Step 1: Write the failing test**

```bash
cat > tools/verify/tests/test_report.sh << 'EOF'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cat > .verify/report.json << 'JSON'
{"verdict":"partial","summary":"2/3 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header fixed","evidence":".verify/evidence/ac1/screenshot-after_scroll.png"},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger missing","evidence":".verify/evidence/ac2/screenshot-initial.png"},{"ac_id":"ac3","status":"timeout","reasoning":"Timed out","evidence":""}],"skipped":["ac4: too vague"]}
JSON

output=$("$SCRIPT_DIR/report.sh" 2>&1)
echo "$output" | grep -q "✓ ac1" || { echo "FAIL: missing ✓ ac1. Output: $output"; exit 1; }
echo "$output" | grep -q "✗ ac2" || { echo "FAIL: missing ✗ ac2. Output: $output"; exit 1; }
echo "$output" | grep -q "ac3"   || { echo "FAIL: missing ac3. Output: $output"; exit 1; }
echo "$output" | grep -q "2/3"   || { echo "FAIL: missing 2/3 summary. Output: $output"; exit 1; }

echo "PASS: reporter tests"
EOF
chmod +x tools/verify/tests/test_report.sh
```

**Step 2: Run to verify it fails**

```bash
bash tools/verify/tests/test_report.sh
```

Expected: `report.sh: No such file or directory`

**Step 3: Implement report.sh**

```bash
cat > tools/verify/report.sh << 'EOF'
#!/usr/bin/env bash
[ -f ".verify/report.json" ] || { echo "✗ No report found. Run /verify first."; exit 1; }

SUMMARY=$(jq -r '.summary' .verify/report.json)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Verify — $SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

jq -c '.criteria[]' .verify/report.json | while IFS= read -r criterion; do
  AC_ID=$(echo "$criterion" | jq -r '.ac_id')
  STATUS=$(echo "$criterion" | jq -r '.status')
  REASON=$(echo "$criterion" | jq -r '.reasoning')
  case "$STATUS" in
    pass)    echo "  ✓ $AC_ID: $REASON" ;;
    fail)    echo "  ✗ $AC_ID: $REASON" ;;
    timeout) echo "  ⏱ $AC_ID: timed out" ;;
    error)   echo "  ⚠ $AC_ID: $REASON" ;;
    *)       echo "  ? $AC_ID: $STATUS — $REASON" ;;
  esac
done

SKIPPED_COUNT=$(jq '.skipped | length' .verify/report.json)
if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  jq -r '.skipped[]' .verify/report.json | while IFS= read -r msg; do
    echo "  ⚠ Skipped: $msg"
  done
fi

echo ""

# Debug hints for failures
jq -r '.criteria[] | select(.status=="fail") | .ac_id' .verify/report.json | while IFS= read -r AC_ID; do
  TRACE=".verify/evidence/$AC_ID/trace"
  VIDEO=".verify/evidence/$AC_ID/session.webm"
  [ -d "$TRACE" ] && echo "  Debug: npx playwright show-report $TRACE"
  [ -f "$VIDEO" ]  && echo "  Video: open $VIDEO"
done
EOF
chmod +x tools/verify/report.sh
```

**Step 4: Run to verify it passes**

```bash
bash tools/verify/tests/test_report.sh
```

Expected: `PASS: reporter tests`

**Step 5: Commit**

```bash
git add tools/verify/report.sh tools/verify/tests/test_report.sh
git commit -m "feat: reporter — terminal output with pass/fail/timeout/skipped"
```

---

## Task 10: /verify setup Skill

**Files:**
- Create: `.claude/skills/verify-setup.md`

**Step 1: Write the setup skill**

```bash
cat > .claude/skills/verify-setup.md << 'EOF'
---
name: verify-setup
description: One-time auth setup for /verify. Captures Playwright session state to .verify/auth.json.
---

# /verify setup

Run once before using /verify on any app that requires authentication.

## Steps

### 1. Add .verify/ to .gitignore

```bash
for pattern in ".verify/auth.json" ".verify/evidence/" ".verify/prompts/" ".verify/report.json" ".verify/plan.json" ".verify/.spec_path" ".verify/chrome-profile/"; do
  grep -qF "$pattern" .gitignore 2>/dev/null || echo "$pattern" >> .gitignore
done
echo "✓ .gitignore updated"
```

### 2. Create .verify/config.json if missing

```bash
mkdir -p .verify
if [ ! -f .verify/config.json ]; then
  cat > .verify/config.json << 'CONFIG'
{
  "baseUrl": "http://localhost:3000",
  "authCheckUrl": "/api/me",
  "specPath": null
}
CONFIG
fi
```

Ask the user:
- "What is your dev server URL? (default: http://localhost:3000)"
- "What URL returns 200 when authenticated? (default: /api/me)"

Update .verify/config.json with their answers using:
```bash
jq --arg url "THEIR_URL" --arg check "THEIR_CHECK" \
  '.baseUrl = $url | .authCheckUrl = $check' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
```

### 3. Check dev server is running

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before logging in."
```

### 4. Capture auth via Playwright codegen

`playwright codegen` opens a headed browser, lets the user log in, and saves auth state on exit.

```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
mkdir -p .verify
echo "A browser will open. Log in, then close the browser window."
npx playwright codegen --save-storage=.verify/auth.json "$BASE_URL"
```

This is the correct approach — the same browser session that captures login also saves the storage state. No session transfer needed.

### 5. Set permissions

```bash
chmod 600 .verify/auth.json
echo "✓ Auth saved to .verify/auth.json (chmod 600)"
```

### 6. Verify auth was captured

```bash
if [ -f .verify/auth.json ] && [ -s .verify/auth.json ]; then
  COOKIE_COUNT=$(jq '.cookies | length' .verify/auth.json 2>/dev/null || echo 0)
  echo "✓ Auth state captured: $COOKIE_COUNT cookies"
else
  echo "✗ auth.json is empty. Log in when the browser opens, then close it."
  exit 1
fi
```

### 7. Done

Tell the user:
```
✓ Setup complete. Run /verify before your next PR.
```
EOF
```

**Step 2: Commit**

```bash
git add .claude/skills/verify-setup.md
git commit -m "feat: /verify setup skill — playwright codegen auth capture"
```

---

## Task 11: /verify Main Skill

**Files:**
- Create: `.claude/skills/verify.md`

**Step 1: Write the main verify skill**

```bash
cat > .claude/skills/verify.md << 'EOF'
---
name: verify
description: Verify frontend changes against spec acceptance criteria locally. Uses claude -p with OAuth. No extra API charges.
---

# /verify

Verify your frontend changes before pushing.

## Prerequisites
- Dev server running (e.g. `npm run dev`)
- Auth set up (`/verify setup`) if app requires login

## Steps

### Stage 0: Pre-flight

```bash
bash tools/verify/preflight.sh
```

Stop if this fails. Fix the reported issue and re-run.

### Stage 1: Planner

```bash
SPEC_PATH=$(cat .verify/.spec_path)
bash tools/verify/planner.sh "$SPEC_PATH"
```

Show the extracted ACs to the user:
```bash
echo "Extracted acceptance criteria:"
jq -r '.criteria[] | "  • \(.id): \(.description)"' .verify/plan.json
jq -r '.skipped[]? | "  ⚠ Skipped: \(.)"' .verify/plan.json
```

Ask: "Does this look right? (y/n)"
- If n: stop. Ask them to refine the spec doc and re-run.
- If y: continue.

Stop if criteria count is 0:
```bash
COUNT=$(jq '.criteria | length' .verify/plan.json)
[ "$COUNT" -gt 0 ] || { echo "✗ No testable criteria found. Add explicit ACs to the spec and retry."; exit 1; }
```

### Stage 2: Browser Agents

Clear previous evidence first:
```bash
rm -rf .verify/evidence .verify/prompts
mkdir -p .verify/evidence
```

Run:
```bash
bash tools/verify/orchestrate.sh
```

### Stage 3: Judge

```bash
bash tools/verify/judge.sh
```

### Report

```bash
bash tools/verify/report.sh
```

## Error Handling

| Failure | Action |
|---------|--------|
| Pre-flight fails | Print error, stop |
| 0 criteria extracted | Print message, stop |
| All agents timeout/error | Print "Check dev server and auth", suggest `/verify setup` |
| Judge returns invalid JSON | Print raw output, tell user to check `.verify/evidence/` manually |

## Quick Reference

```bash
/verify setup                                          # one-time auth
/verify                                                # run pipeline
npx playwright show-report .verify/evidence/<id>/trace # debug failure
open .verify/evidence/<id>/session.webm                # watch video
```
EOF
```

**Step 2: Commit**

```bash
git add .claude/skills/verify.md
git commit -m "feat: /verify main skill — full pipeline orchestration"
```

---

## Task 12: Run All Tests

**Step 1: Run all unit tests**

```bash
echo "=== Verify Pipeline Tests ==="
bash tools/verify/tests/test_preflight.sh
bash tools/verify/tests/test_planner.sh
bash tools/verify/tests/test_agent.sh
bash tools/verify/tests/test_orchestrate.sh
bash tools/verify/tests/test_judge.sh
bash tools/verify/tests/test_report.sh
echo ""
echo "=== All tests passed ==="
```

Expected: each test prints `PASS: ...`

**Step 2: Verify .gitignore correctness**

```bash
# auth.json should be ignored, config.json should NOT be
git check-ignore .verify/auth.json && echo "✓ auth.json ignored"
git check-ignore .verify/config.json && echo "FAIL: config.json should be committed" || echo "✓ config.json not ignored"
```

**Step 3: Check all scripts are executable**

```bash
ls -la tools/verify/*.sh
```

Expected: all show `-rwxr-xr-x`

**Step 4: Final commit**

```bash
git add -A
git commit -m "test: all verify pipeline tests passing"
```

---

## Task 13: Integration Smoke Test (Manual)

Requires a real Next.js project with a running dev server. Skip if none available.

**Step 1: Install prerequisites**

```bash
brew install coreutils   # provides gtimeout
brew install jq
npm install -g @playwright/mcp@latest
npx playwright install chromium
```

**Step 2: Create a test spec**

```bash
mkdir -p docs/plans
cat > docs/plans/smoke-test.md << 'EOF'
## Acceptance Criteria
- The home page loads without errors and shows visible content
- The page has a visible header element at the top
EOF
```

**Step 3: Start dev server**

In a separate terminal: `npm run dev`

**Step 4: For public pages (no auth), update config**

```bash
jq '.authCheckUrl = "/"' .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
echo '{"cookies":[],"origins":[]}' > .verify/auth.json
chmod 600 .verify/auth.json
```

**Step 5: Run /verify**

In Claude Code: `/verify`

**Step 6: Verify output**

Expected terminal output:
```
✓ ac1: home page loads with visible content
✓ ac2: header element visible at top
```

And `.verify/evidence/ac1/session.webm` should exist and be non-empty.
