# Verify Pipeline v2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Playwright MCP with gstack's browse binary for reliable, fast AC verification with cookie-based auth.

**Architecture:** Same bash pipeline (`preflight → planner → orchestrate → agent → judge → report`), but agents use a persistent gstack browse daemon via CLI commands instead of Playwright MCP tools. Auth switches from Playwright codegen to cookie import from real browsers.

**Tech Stack:** Bash 3, `jq`, `claude -p`, gstack browse binary (compiled Playwright+Chromium daemon), Claude Code skills

**Design doc:** `docs/plans/2026-03-15-verify-v2-gstack-browser.md`

---

## Task 1: Browse Binary Installer

Create a script that downloads and caches the gstack browse binary.

**Files:**
- Create: `scripts/install-browse.sh`

**Step 1: Write the installer script**

```bash
#!/usr/bin/env bash
# Download and cache gstack browse binary at ~/.cache/verify/browse
set -e

GSTACK_VERSION="${GSTACK_VERSION:-v1.1.0}"
CACHE_DIR="$HOME/.cache/verify"
BROWSE_BIN="$CACHE_DIR/browse"
VERSION_FILE="$CACHE_DIR/browse.version"

# Skip if already installed at correct version
if [ -x "$BROWSE_BIN" ] && [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$GSTACK_VERSION" ]; then
  echo "✓ Browse binary up to date ($GSTACK_VERSION)"
  echo "$BROWSE_BIN"
  exit 0
fi

mkdir -p "$CACHE_DIR"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
esac

echo "→ Installing gstack browse $GSTACK_VERSION ($OS-$ARCH)..."

# Try GitHub release first
RELEASE_URL="https://github.com/garrytan/gstack/releases/download/$GSTACK_VERSION/browse-$OS-$ARCH"
if curl -fsSL --head "$RELEASE_URL" >/dev/null 2>&1; then
  curl -fsSL "$RELEASE_URL" -o "$BROWSE_BIN"
  chmod +x "$BROWSE_BIN"
  echo "$GSTACK_VERSION" > "$VERSION_FILE"
  echo "✓ Installed browse binary from release"
  echo "$BROWSE_BIN"
  exit 0
fi

# Fallback: build from source (requires bun + git)
echo "→ No pre-built binary found. Building from source..."
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ Bun is required to build gstack browse from source."
  echo "  Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

BUILD_DIR=$(mktemp -d)
trap "rm -rf '$BUILD_DIR'" EXIT
git clone --depth 1 --branch "$GSTACK_VERSION" https://github.com/garrytan/gstack.git "$BUILD_DIR" 2>/dev/null || \
  git clone --depth 1 https://github.com/garrytan/gstack.git "$BUILD_DIR"
cd "$BUILD_DIR"
bun install
bun run build
cp browse/dist/browse "$BROWSE_BIN"
chmod +x "$BROWSE_BIN"
echo "$GSTACK_VERSION" > "$VERSION_FILE"
echo "✓ Built and installed browse binary"
echo "$BROWSE_BIN"
```

Write this to `scripts/install-browse.sh`.

**Step 2: Verify it runs**

Run: `bash scripts/install-browse.sh`
Expected: either downloads binary or builds from source, prints path to `~/.cache/verify/browse`.

**Step 3: Test the binary works**

Run:
```bash
BROWSE_BIN=$(bash scripts/install-browse.sh | tail -1)
$BROWSE_BIN status
```
Expected: either "running" (daemon alive) or starts the daemon and reports status.

**Step 4: Commit**

```bash
git add scripts/install-browse.sh
git commit -m "feat: add gstack browse binary installer"
```

---

## Task 2: Update Preflight for Browse Engine

Modify `preflight.sh` to support both `VERIFY_ENGINE=browse` (new) and `VERIFY_ENGINE=mcp` (legacy).

**Files:**
- Modify: `scripts/preflight.sh`

**Step 1: Add engine detection and browse binary check**

Add after line 22 (after `export TIMEOUT_CMD`):

```bash
# Engine selection: browse (v2, default) or mcp (v1 legacy)
VERIFY_ENGINE="${VERIFY_ENGINE:-browse}"
export VERIFY_ENGINE

if [ "$VERIFY_ENGINE" = "browse" ]; then
  BROWSE_BIN="${BROWSE_BIN:-$HOME/.cache/verify/browse}"
  if [ ! -x "$BROWSE_BIN" ]; then
    echo "→ Browse binary not found. Installing..."
    BROWSE_BIN=$(bash "$(dirname "$0")/install-browse.sh" | tail -1)
  fi
  export BROWSE_BIN
  echo "✓ Browse binary: $BROWSE_BIN"
fi
```

**Step 2: Replace auth check for browse engine**

Replace lines 52-69 (the auth check block) with:

```bash
# 2. Auth validity check
if [ "$SKIP_AUTH" = false ]; then
  if [ "$VERIFY_ENGINE" = "browse" ]; then
    # Browse engine: validate auth by navigating and checking for login redirect
    echo "→ Checking auth via browse daemon..."
    # Start daemon if needed
    "$BROWSE_BIN" status >/dev/null 2>&1 || "$BROWSE_BIN" goto "$VERIFY_BASE_URL" >/dev/null 2>&1
    SNAPSHOT=$("$BROWSE_BIN" snapshot -i 2>/dev/null || echo "")
    if [ -z "$SNAPSHOT" ]; then
      echo "→ No auth state in browse daemon. Run /verify-setup to import cookies."
      echo "  (Continuing without auth — some pages may redirect to login.)"
    elif echo "$SNAPSHOT" | grep -qi "login\|sign.in\|password\|log.in"; then
      echo "✗ Auth cookies expired or invalid. Re-run /verify-setup."
      exit 1
    else
      echo "✓ Auth valid (browse daemon)"
    fi
  else
    # MCP engine (legacy): validate via auth.json + curl
    if [ ! -f ".verify/auth.json" ]; then
      echo "✗ No auth state found. Run /verify-setup first."
      exit 1
    fi
    AUTH_URL="${VERIFY_BASE_URL}${VERIFY_AUTH_CHECK_URL}"
    echo "→ Checking auth at $AUTH_URL..."
    COOKIE_STR=$(jq -r '[.cookies[]? | "\(.name)=\(.value)"] | join("; ")' .verify/auth.json 2>/dev/null || echo "")
    HTTP_CODE=$(curl -sf --max-time 5 \
      ${COOKIE_STR:+-H "Cookie: $COOKIE_STR"} \
      -o /dev/null -w "%{http_code}" \
      "$AUTH_URL" 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "000" ]; then
      echo "✗ Session expired or invalid (HTTP $HTTP_CODE). Run /verify-setup to re-authenticate."
      exit 1
    fi
    echo "✓ Auth valid (HTTP $HTTP_CODE)"
  fi
fi
```

**Step 3: Test preflight with browse engine**

Run: `VERIFY_ALLOW_DANGEROUS=1 bash scripts/preflight.sh --skip-spec`
Expected: checks browse binary, starts daemon, validates auth (or reports no auth).

**Step 4: Test preflight with MCP engine (rollback)**

Run: `VERIFY_ENGINE=mcp bash scripts/preflight.sh --skip-spec --skip-auth`
Expected: skips browse binary check, uses legacy path.

**Step 5: Commit**

```bash
git add scripts/preflight.sh
git commit -m "feat: preflight supports browse engine with mcp fallback"
```

---

## Task 3: Rewrite Agent Prompt for Browse CLI

Replace the Playwright MCP agent prompt with one that uses browse CLI commands.

**Files:**
- Create: `scripts/prompts/agent-browse.txt`
- Keep: `scripts/prompts/agent.txt` (legacy MCP prompt, unchanged)

**Step 1: Write the new browse agent prompt**

```
You are a browser verification agent. You have a browse CLI binary to control a headless browser.

Verify ONE acceptance criterion by following the steps. Report findings at the end.

ACCEPTANCE CRITERION: REPLACE_AC_DESCRIPTION
AC ID: REPLACE_AC_ID
START URL: REPLACE_BASE_URL
BROWSE BINARY: REPLACE_BROWSE_BIN

STEPS:
REPLACE_STEPS

INSTRUCTIONS:

1. Navigate to the start URL:
   REPLACE_BROWSE_BIN goto REPLACE_BASE_URL

2. Take a baseline snapshot to see interactive elements:
   REPLACE_BROWSE_BIN snapshot -i

3. Execute each step using browse commands. Common patterns:
   - Click: REPLACE_BROWSE_BIN click @e3        (use @ref from snapshot)
   - Fill:  REPLACE_BROWSE_BIN fill @e4 "value"
   - Select: REPLACE_BROWSE_BIN select @e5 "option"
   - Check state: REPLACE_BROWSE_BIN is visible ".selector"
   - Read text: REPLACE_BROWSE_BIN text
   - JS errors: REPLACE_BROWSE_BIN console --errors

4. After each interaction, diff to verify it worked:
   REPLACE_BROWSE_BIN snapshot -D

5. Take screenshots at key moments:
   REPLACE_BROWSE_BIN screenshot .verify/evidence/REPLACE_AC_ID/screenshot-LABEL.png
   SCREENSHOT CHECKPOINTS: REPLACE_SCREENSHOT_AT

6. After all steps, write your structured finding:

   Create file .verify/evidence/REPLACE_AC_ID/result.json with this EXACT format:
   {
     "ac_id": "REPLACE_AC_ID",
     "result": "pass or fail or error",
     "expected": "what the AC says should happen",
     "observed": "what actually happened — include snapshot diff output",
     "screenshots": ["screenshot-before.png", "screenshot-after.png"],
     "commands_run": ["goto ...", "snapshot -i", "click @e3", "snapshot -D"]
   }

   ALSO write the legacy format to .verify/evidence/REPLACE_AC_ID/agent.log:
   VERDICT: pass|fail|error
   REASONING: <one sentence>
   STEPS_COMPLETED: <n>/<total>

RULES:
- Use @e refs from snapshot -i to target elements. Never guess CSS selectors.
- After clicking/filling, always run snapshot -D to confirm the action worked.
- If snapshot -i doesn't show the element you need, try scrolling or navigating first.
- If the page shows a login screen, write result "error" with observed "Auth redirect".
- Be objective — report what you see, not what you expect.
- If a command fails, retry once. If it fails again, note the error and continue.
```

Write this to `scripts/prompts/agent-browse.txt`.

**Step 2: Commit**

```bash
git add scripts/prompts/agent-browse.txt
git commit -m "feat: add browse CLI agent prompt template"
```

---

## Task 4: Update agent.sh for Browse Engine

Modify `agent.sh` to select between browse CLI and Playwright MCP based on `VERIFY_ENGINE`.

**Files:**
- Modify: `scripts/agent.sh`

**Step 1: Add engine-specific prompt and launch logic**

Replace lines 39-92 (from "Build agent prompt" through the `claude -p` invocation) with logic that branches on `VERIFY_ENGINE`:

```bash
# Build agent prompt
mkdir -p ".verify/evidence/$AC_ID" ".verify/prompts"

if [ "${VERIFY_ENGINE:-browse}" = "browse" ]; then
  # ─── Browse engine (v2) ───
  BROWSE_BIN="${BROWSE_BIN:-$HOME/.cache/verify/browse}"
  PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/agent-browse.txt"

  REPLACE_AC_DESCRIPTION="$AC_DESC" \
  REPLACE_AC_ID="$AC_ID" \
  REPLACE_BASE_URL="${VERIFY_BASE_URL}${AC_URL}" \
  REPLACE_SCREENSHOT_AT="$SCREENSHOTS" \
  REPLACE_STEPS_VAL="$STEPS" \
  REPLACE_BROWSE_BIN_VAL="$BROWSE_BIN" \
  python3 -c "
import sys, os
content = open(sys.argv[1]).read()
content = content.replace('REPLACE_AC_DESCRIPTION', os.environ['REPLACE_AC_DESCRIPTION'])
content = content.replace('REPLACE_AC_ID',          os.environ['REPLACE_AC_ID'])
content = content.replace('REPLACE_BASE_URL',       os.environ['REPLACE_BASE_URL'])
content = content.replace('REPLACE_SCREENSHOT_AT',  os.environ['REPLACE_SCREENSHOT_AT'])
content = content.replace('REPLACE_STEPS',          os.environ['REPLACE_STEPS_VAL'])
content = content.replace('REPLACE_BROWSE_BIN',     os.environ['REPLACE_BROWSE_BIN_VAL'])
print(content, end='')
" "$PROMPT_TEMPLATE" > ".verify/prompts/${AC_ID}-agent.txt"

  echo "  → Agent $AC_ID [browse] (timeout: ${TIMEOUT_SECS}s)..."

  set +e
  EXIT_CODE=1
  for attempt in 1 2 3; do
    $TIMEOUT_CMD "$TIMEOUT_SECS" "$CLAUDE" -p \
      --model sonnet \
      --dangerously-skip-permissions \
      < ".verify/prompts/${AC_ID}-agent.txt" > ".verify/evidence/$AC_ID/claude.log" 2>&1
    EXIT_CODE=$?
    [ $EXIT_CODE -eq 0 ] && break
    [ $EXIT_CODE -eq 124 ] && break
    if [ $attempt -lt 3 ]; then
      echo "  ↻ $AC_ID: attempt $attempt failed (exit $EXIT_CODE), retrying in 5s..."
      sleep 5
    fi
  done
  set -e

else
  # ─── MCP engine (v1 legacy) ───
  PROMPT_TEMPLATE="$SCRIPT_DIR/prompts/agent.txt"

  REPLACE_AC_DESCRIPTION="$AC_DESC" \
  REPLACE_AC_ID="$AC_ID" \
  REPLACE_BASE_URL="${VERIFY_BASE_URL}${AC_URL}" \
  REPLACE_SCREENSHOT_AT="$SCREENSHOTS" \
  REPLACE_STEPS_VAL="$STEPS" \
  python3 -c "
import sys, os
content = open(sys.argv[1]).read()
content = content.replace('REPLACE_AC_DESCRIPTION', os.environ['REPLACE_AC_DESCRIPTION'])
content = content.replace('REPLACE_AC_ID',          os.environ['REPLACE_AC_ID'])
content = content.replace('REPLACE_BASE_URL',       os.environ['REPLACE_BASE_URL'])
content = content.replace('REPLACE_SCREENSHOT_AT',  os.environ['REPLACE_SCREENSHOT_AT'])
content = content.replace('REPLACE_STEPS',          os.environ['REPLACE_STEPS_VAL'])
print(content, end='')
" "$PROMPT_TEMPLATE" > ".verify/prompts/${AC_ID}-agent.txt"

  # Playwright MCP config
  EVIDENCE_DIR="$(pwd)/.verify/evidence/$AC_ID"
  AUTH_STATE_PATH="$(pwd)/.verify/auth.json"
  MCP_CONFIG_FILE=$(mktemp "${TMPDIR:-/tmp}/verify-mcp-XXXXXX")
  MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.68}"
  jq -n --arg outdir "$EVIDENCE_DIR" --arg authstate "$AUTH_STATE_PATH" --arg mcpver "$MCP_VERSION" '{
    mcpServers: {
      playwright: {
        command: "npx",
        args: [
          ("@playwright/mcp@" + $mcpver),
          "--save-video=1280x720",
          "--caps", "vision",
          "--storage-state", $authstate,
          "--save-trace",
          "--output-dir", $outdir
        ]
      }
    }
  }' > "$MCP_CONFIG_FILE"
  trap "rm -f '$MCP_CONFIG_FILE'" EXIT

  echo "  → Agent $AC_ID [mcp] (timeout: ${TIMEOUT_SECS}s)..."

  set +e
  EXIT_CODE=1
  for attempt in 1 2 3; do
    $TIMEOUT_CMD "$TIMEOUT_SECS" "$CLAUDE" -p \
      --model sonnet \
      --dangerously-skip-permissions \
      --mcp-config "$MCP_CONFIG_FILE" \
      < ".verify/prompts/${AC_ID}-agent.txt" > ".verify/evidence/$AC_ID/claude.log" 2>&1
    EXIT_CODE=$?
    [ $EXIT_CODE -eq 0 ] && break
    [ $EXIT_CODE -eq 124 ] && break
    if [ $attempt -lt 3 ]; then
      echo "  ↻ $AC_ID: attempt $attempt failed (exit $EXIT_CODE), retrying in 5s..."
      sleep 5
    fi
  done
  set -e
fi
```

Keep the existing post-run log processing (lines 103-141) unchanged — it handles both engines since the browse prompt also writes `agent.log`.

**Step 2: Test with browse engine (dry run — check prompt generation)**

Run:
```bash
# Create a minimal plan.json for testing
mkdir -p .verify
echo '{"criteria":[{"id":"ac1","description":"test button works","url":"/","steps":["click the button"],"screenshot_at":["after_click"]}],"skipped":[]}' > .verify/plan.json
VERIFY_ALLOW_DANGEROUS=1 VERIFY_ENGINE=browse bash -x scripts/agent.sh ac1 30 2>&1 | head -5
```
Expected: prompt file at `.verify/prompts/ac1-agent.txt` contains browse binary path, not MCP references.

**Step 3: Commit**

```bash
git add scripts/agent.sh
git commit -m "feat: agent.sh supports browse engine with mcp fallback"
```

---

## Task 5: Update Judge for Structured Evidence

Modify `judge.sh` to read `result.json` (browse engine) with fallback to `agent.log` (MCP engine).

**Files:**
- Modify: `scripts/judge.sh`
- Create: `scripts/prompts/judge-browse.txt`

**Step 1: Write the new judge prompt**

```
You are a quality judge reviewing frontend verification results.

For each acceptance criterion, you have structured evidence: a result.json from the agent, plus screenshots.

Return ONLY a valid JSON object. No markdown fences, no explanation. Raw JSON only.

Schema:
{
  "verdict": "pass|fail|partial",
  "summary": "<N>/<total> ACs passed",
  "criteria": [
    {
      "ac_id": "<id>",
      "status": "pass|fail|error|timeout",
      "reasoning": "<one sentence: what the evidence shows>",
      "evidence": "<screenshot path>",
      "agent_claimed": "<what the agent said>",
      "judge_override": false
    }
  ],
  "skipped": []
}

Rules:
1. The agent's result.json is the starting point. Check if the evidence supports its claim.
2. The "observed" field in result.json contains snapshot diffs — use these as primary evidence.
3. Screenshots are secondary evidence — confirm what the diffs describe.
4. pass = evidence clearly confirms the criterion is met.
5. fail = evidence clearly shows the criterion is NOT met.
6. error = agent crashed, hit login redirect, or result.json is missing/malformed.
7. timeout = agent timed out before completing.
8. Set judge_override=true ONLY when you disagree with the agent's claimed result.
9. Be strict: if evidence is ambiguous, mark as fail.
10. If result.json is missing, fall back to agent.log content.
```

Write this to `scripts/prompts/judge-browse.txt`.

**Step 2: Update judge.sh to read result.json**

Replace lines 30-57 (the evidence-building loop) with:

```bash
JUDGE_PROMPT="$SCRIPT_DIR/prompts/judge.txt"
if [ "${VERIFY_ENGINE:-browse}" = "browse" ]; then
  JUDGE_PROMPT="$SCRIPT_DIR/prompts/judge-browse.txt"
fi

{
  cat "$JUDGE_PROMPT"
  printf "\n\nEVIDENCE:\n"
} > "$PROMPT_FILE"

for AC_ID in "${AC_IDS[@]}"; do
  AC_DESC=$(jq -r --arg id "$AC_ID" '.criteria[] | select(.id==$id) | .description' .verify/plan.json)
  printf "\n--- AC: %s ---\nCRITERION: %s\n" "$AC_ID" "$AC_DESC" >> "$PROMPT_FILE"

  # Prefer result.json (browse engine), fall back to agent.log (MCP engine)
  RESULT_FILE=".verify/evidence/$AC_ID/result.json"
  LOG_FILE=".verify/evidence/$AC_ID/agent.log"

  if [ -f "$RESULT_FILE" ]; then
    printf "AGENT RESULT (structured):\n" >> "$PROMPT_FILE"
    cat "$RESULT_FILE" >> "$PROMPT_FILE"
    printf "\n" >> "$PROMPT_FILE"
  elif [ -f "$LOG_FILE" ]; then
    printf "AGENT LOG (unstructured):\n" >> "$PROMPT_FILE"
    cat "$LOG_FILE" >> "$PROMPT_FILE"
    printf "\n" >> "$PROMPT_FILE"
  else
    printf "AGENT EVIDENCE: not found (agent may have crashed)\n" >> "$PROMPT_FILE"
  fi

  # Embed one screenshot per AC
  SCREENSHOT=$(find ".verify/evidence/$AC_ID" -name "screenshot-*.png" 2>/dev/null | sort | head -1)
  if [ -f "$SCREENSHOT" ]; then
    THUMB=$(mktemp /tmp/verify-thumb-XXXXXX.png)
    trap "rm -f '$THUMB'" EXIT
    if command -v sips >/dev/null 2>&1; then
      sips -Z 300 "$SCREENSHOT" --out "$THUMB" >/dev/null 2>&1 || cp "$SCREENSHOT" "$THUMB"
    else
      cp "$SCREENSHOT" "$THUMB"
    fi
    printf "SCREENSHOT (%s): data:image/png;base64," "$(basename "$SCREENSHOT" .png)" >> "$PROMPT_FILE"
    base64 < "$THUMB" | tr -d '\n' >> "$PROMPT_FILE"
    printf "\n" >> "$PROMPT_FILE"
    rm -f "$THUMB"
  fi
done
```

**Step 3: Commit**

```bash
git add scripts/prompts/judge-browse.txt scripts/judge.sh
git commit -m "feat: judge reads structured result.json from browse agents"
```

---

## Task 6: Update Report for Browse Engine

Modify `report.sh` to handle the case where video is not available (browse engine doesn't record video).

**Files:**
- Modify: `scripts/report.sh`

**Step 1: Update the HTML report to gracefully handle missing video**

The current `report.sh` already handles missing video (lines 78-87 check `os.path.exists(video_path)`). No code change needed for the HTML generation.

Update the debug hints section (lines 35-40) to also show annotated screenshots:

Replace lines 35-40 with:

```bash
jq -r '.criteria[] | select(.status=="fail") | .ac_id' .verify/report.json | while IFS= read -r AC_ID; do
  TRACE=".verify/evidence/$AC_ID/trace"
  VIDEO=".verify/evidence/$AC_ID/session.webm"
  RESULT=".verify/evidence/$AC_ID/result.json"
  [ -d "$TRACE" ] && echo "  Debug: npx playwright show-report $TRACE"
  [ -f "$VIDEO" ]  && echo "  Video: open $VIDEO"
  [ -f "$RESULT" ] && echo "  Evidence: cat $RESULT"
  ls .verify/evidence/"$AC_ID"/screenshot-*.png 2>/dev/null | while read -r img; do
    echo "  Screenshot: open $img"
  done
done
```

**Step 2: Commit**

```bash
git add scripts/report.sh
git commit -m "fix: report shows evidence paths for browse engine"
```

---

## Task 7: Rewrite /verify-setup Skill for Cookie Import

Replace the Playwright codegen-based setup with gstack cookie import.

**Files:**
- Modify: `skills/verify-setup/SKILL.md`

**Step 1: Write the new verify-setup skill**

```markdown
---
name: verify-setup
description: One-time auth setup for /verify. Imports cookies from your real browser via gstack browse.
---

# /verify-setup

Run once before using /verify on any app that requires authentication.

## Steps

### 1. Add .verify/ to .gitignore

\```bash
for pattern in ".verify/evidence/" ".verify/prompts/" ".verify/report.json" ".verify/plan.json" ".verify/.spec_path" ".verify/browse.json" ".verify/report.html" ".verify/judge-prompt.txt" ".verify/progress.jsonl"; do
  grep -qF "$pattern" .gitignore 2>/dev/null || echo "$pattern" >> .gitignore
done
echo "✓ .gitignore updated"
\```

### 2. Create .verify/config.json if missing

\```bash
mkdir -p .verify
if [ ! -f .verify/config.json ]; then
  cat > .verify/config.json << 'CONFIG'
{
  "baseUrl": "http://localhost:3000",
  "specPath": null
}
CONFIG
fi
\```

Ask the user:
- "What is your dev server URL? (default: http://localhost:3000)"

Update .verify/config.json with their answer:
\```bash
jq --arg url "THEIR_URL" '.baseUrl = $url' \
  .verify/config.json > .verify/config.tmp && mv .verify/config.tmp .verify/config.json
\```

### 3. Install browse binary

\```bash
BROWSE_BIN=$(bash ~/.claude/tools/verify/install-browse.sh | tail -1)
echo "✓ Browse binary: $BROWSE_BIN"
\```

### 4. Check dev server is running

\```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
curl -sf "$BASE_URL" > /dev/null 2>&1 || echo "⚠ Dev server not running at $BASE_URL. Start it before continuing."
\```

### 5. Import cookies from browser

Ask the user:
- "Which browser are you logged into your app with? (Chrome / Arc / Edge / Brave / Comet)"
- "What domain should I import cookies for? (e.g. localhost)"

Then import:
\```bash
$BROWSE_BIN cookie-import-browser BROWSER --domain DOMAIN
\```

First time: a macOS Keychain dialog will appear. The user must click "Allow" or "Always Allow".

### 6. Verify auth was captured

\```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
$BROWSE_BIN goto "$BASE_URL"
$BROWSE_BIN snapshot -i
\```

Show the snapshot output to the user and ask: "Does this look like your app's authenticated page? (y/n)"

If yes:
\```
✓ Setup complete. Run /verify before your next push.
\```

If no:
\```
Auth may not have imported correctly. Make sure you're logged into DOMAIN in BROWSER, then try again.
\```

### 7. Legacy MCP setup (fallback)

If cookie import fails or the user prefers the old approach:

\```bash
BASE_URL=$(jq -r '.baseUrl' .verify/config.json)
echo "Falling back to Playwright codegen. A browser will open — log in, then close it."
npx playwright codegen --save-storage=.verify/auth.json "$BASE_URL"
chmod 600 .verify/auth.json
echo "✓ Auth saved. Use VERIFY_ENGINE=mcp when running /verify."
\```
```

Write this to `skills/verify-setup/SKILL.md` (replace entire file).

**Step 2: Commit**

```bash
git add skills/verify-setup/SKILL.md
git commit -m "feat: verify-setup uses cookie import from real browser"
```

---

## Task 8: Update /verify Skill for Foreground Execution

Update the verify skill to run orchestrate.sh in the foreground and reference the browse engine.

**Files:**
- Modify: `skills/verify/SKILL.md`

**Step 1: Update Stage 2 in the skill**

Replace the Stage 2 section (lines 169-193) with:

```markdown
## Stage 2: Browser Agents

Clear previous evidence:
\```bash
rm -rf .verify/evidence .verify/prompts
rm -f /tmp/verify-mcp-*.json
mkdir -p .verify/evidence
\```

Run agents sequentially in the foreground:
\```bash
VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/orchestrate.sh
\```

This runs each AC check one at a time using the persistent browse daemon. Each check takes ~10-20 seconds. Total time for 5 ACs: ~1-2 minutes.
```

**Step 2: Update prerequisites**

Replace the Prerequisites section (lines 10-12) with:

```markdown
## Prerequisites
- Dev server running (e.g. `npm run dev`)
- Auth set up (`/verify-setup`) if app requires login
- Browse binary installed (auto-installed on first run)
```

**Step 3: Update Quick Reference**

Replace the Quick Reference section at the end with:

```markdown
## Quick Reference

\```bash
/verify-setup                                          # one-time auth (cookie import)
/verify                                                # run pipeline
cat .verify/evidence/<id>/result.json                  # check evidence
open .verify/evidence/<id>/screenshot-*.png            # view screenshots
VERIFY_ENGINE=mcp /verify                              # fallback to Playwright MCP
\```
```

**Step 4: Commit**

```bash
git add skills/verify/SKILL.md
git commit -m "feat: verify skill uses foreground execution and browse engine"
```

---

## Task 9: Smoke Test on Real App

End-to-end validation against a real frontend app.

**Files:** None (testing only)

**Step 1: Pick a test app**

Use any running frontend with a spec. The formbricks app from the previous E2E test is ideal if still available, or any `localhost` dev server.

**Step 2: Run /verify-setup**

```bash
# Invoke the skill interactively
/verify-setup
```

Verify: cookie import works, browse daemon starts, authenticated page visible.

**Step 3: Run /verify with a simple spec**

Create a minimal spec with 2-3 ACs and run `/verify`. Observe:
- Do agents find elements via @refs?
- Do snapshot diffs provide useful evidence?
- Does the judge correctly assess pass/fail?
- Does the report render correctly?

**Step 4: Run with VERIFY_ENGINE=mcp to confirm rollback**

```bash
VERIFY_ENGINE=mcp /verify
```

Verify: old pipeline still works as before.

**Step 5: Document findings**

Note any issues found during smoke testing. These become the next iteration's tasks.

**Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in v2 smoke test"
```

---

## Summary

| Task | Files | What Changes |
|------|-------|--------------|
| 1 | `scripts/install-browse.sh` (new) | Download/cache gstack browse binary |
| 2 | `scripts/preflight.sh` | Browse binary check, daemon auth validation |
| 3 | `scripts/prompts/agent-browse.txt` (new) | Agent prompt for browse CLI commands |
| 4 | `scripts/agent.sh` | Engine toggle: browse CLI vs MCP |
| 5 | `scripts/judge.sh`, `scripts/prompts/judge-browse.txt` (new) | Read result.json, new judge prompt |
| 6 | `scripts/report.sh` | Handle missing video, show evidence paths |
| 7 | `skills/verify-setup/SKILL.md` | Cookie import replaces Playwright codegen |
| 8 | `skills/verify/SKILL.md` | Foreground execution, updated references |
| 9 | (testing) | Smoke test on real app |
