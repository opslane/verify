# Claude Code Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure this repo into an installable Claude Code plugin so users can install it via `/plugin marketplace add` + `/plugin install`.

**Architecture:** Follow the obra/superpowers plugin format exactly. Scripts move from `tools/verify/` to `scripts/` and keep their SCRIPT_DIR-relative prompt references intact. Skills get new `CLAUDE_PLUGIN_ROOT`-based paths. Two thin command wrappers (`commands/verify.md`, `commands/verify-setup.md`) give users slash commands. Two manifest files (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) register the plugin.

**Tech Stack:** Bash, Claude Code plugin format (`.claude-plugin/`, `skills/`, `commands/`), `${CLAUDE_PLUGIN_ROOT}` env var

---

### Task 1: Create plugin manifest files

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`

**Step 1: Create `.claude-plugin/plugin.json`**

```json
{
  "name": "opslane-verify",
  "description": "Browser-based acceptance criteria verification for frontend PRs using Claude + Playwright",
  "version": "1.0.0",
  "author": {
    "name": "Opslane",
    "url": "https://github.com/opslane"
  },
  "homepage": "https://github.com/opslane/opslane-v3",
  "repository": "https://github.com/opslane/opslane-v3",
  "license": "MIT",
  "keywords": ["verify", "playwright", "frontend", "acceptance-criteria", "qa"]
}
```

**Step 2: Create `.claude-plugin/marketplace.json`**

```json
{
  "name": "opslane-verify-marketplace",
  "description": "Browser-based AC verification for frontend PRs",
  "owner": {
    "name": "opslane"
  },
  "plugins": [
    {
      "name": "opslane-verify",
      "description": "Browser-based acceptance criteria verification for frontend PRs using Claude + Playwright",
      "version": "1.0.0",
      "source": "./",
      "author": {
        "name": "opslane"
      }
    }
  ]
}
```

**Step 3: Verify both files are valid JSON**

```bash
jq . .claude-plugin/plugin.json && jq . .claude-plugin/marketplace.json
```

Expected: Both print formatted JSON, no errors.

**Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat: add claude-code plugin manifest files"
```

---

### Task 2: Move scripts to `scripts/` and prompts to `scripts/prompts/`

**Files:**
- Create: `scripts/preflight.sh` (copy of `tools/verify/preflight.sh`)
- Create: `scripts/planner.sh`
- Create: `scripts/orchestrate.sh`
- Create: `scripts/agent.sh`
- Create: `scripts/judge.sh`
- Create: `scripts/report.sh`
- Create: `scripts/prompts/agent.txt`
- Create: `scripts/prompts/judge.txt`
- Create: `scripts/prompts/planner.txt`

**Step 1: Create `scripts/` directory and copy all scripts**

```bash
mkdir -p scripts/prompts
cp tools/verify/preflight.sh scripts/preflight.sh
cp tools/verify/planner.sh scripts/planner.sh
cp tools/verify/orchestrate.sh scripts/orchestrate.sh
cp tools/verify/agent.sh scripts/agent.sh
cp tools/verify/judge.sh scripts/judge.sh
cp tools/verify/report.sh scripts/report.sh
cp tools/verify/prompts/agent.txt scripts/prompts/agent.txt
cp tools/verify/prompts/judge.txt scripts/prompts/judge.txt
cp tools/verify/prompts/planner.txt scripts/prompts/planner.txt
```

**Step 2: Make scripts executable**

```bash
chmod +x scripts/preflight.sh scripts/planner.sh scripts/orchestrate.sh \
         scripts/agent.sh scripts/judge.sh scripts/report.sh
```

**Step 3: Verify scripts reference `$SCRIPT_DIR/prompts/` (not `tools/verify/prompts/`)**

The scripts already use `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"` and reference `$SCRIPT_DIR/prompts/agent.txt` etc. Since prompts are now co-located at `scripts/prompts/`, no path changes needed inside the scripts themselves.

Verify by checking each script that uses prompts:

```bash
grep -n "SCRIPT_DIR/prompts" scripts/planner.sh scripts/agent.sh scripts/judge.sh scripts/orchestrate.sh
```

Expected: Lines like `cat "$SCRIPT_DIR/prompts/planner.txt"` — these work correctly because SCRIPT_DIR resolves to `scripts/` at runtime.

**Step 4: Smoke test that scripts are syntactically valid**

```bash
bash -n scripts/preflight.sh && \
bash -n scripts/planner.sh && \
bash -n scripts/orchestrate.sh && \
bash -n scripts/agent.sh && \
bash -n scripts/judge.sh && \
bash -n scripts/report.sh
```

Expected: No output (no syntax errors).

**Step 5: Commit**

```bash
git add scripts/
git commit -m "feat: move verify scripts to scripts/ for plugin packaging"
```

---

### Task 3: Create skill files with `CLAUDE_PLUGIN_ROOT` paths

**Files:**
- Create: `skills/verify/SKILL.md`
- Create: `skills/verify-setup/SKILL.md`

**Step 1: Create `skills/verify/SKILL.md`**

This is the existing `.claude/skills/verify.md` content with all `tools/verify/*.sh` references replaced by `"${CLAUDE_PLUGIN_ROOT}/scripts/*.sh"`.

```markdown
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
bash "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.sh"
```

Stop if this fails. Fix the reported issue and re-run.

### Stage 1: Planner

```bash
SPEC_PATH=$(cat .verify/.spec_path)
bash "${CLAUDE_PLUGIN_ROOT}/scripts/planner.sh" "$SPEC_PATH"
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
bash "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.sh"
```

### Stage 3: Judge

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/judge.sh"
```

### Report

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/report.sh"
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
```

**Step 2: Create `skills/verify-setup/SKILL.md`**

Copy the existing `.claude/skills/verify-setup.md` content verbatim — it contains no path references to `tools/verify/`, only bash commands that operate on `.verify/` in the user's project CWD:

```bash
mkdir -p skills/verify-setup
cp .claude/skills/verify-setup.md skills/verify-setup/SKILL.md
```

**Step 3: Verify the SKILL.md frontmatter is correct for both files**

```bash
head -5 skills/verify/SKILL.md && echo "---" && head -5 skills/verify-setup/SKILL.md
```

Expected: Both show `---`, `name:`, `description:` frontmatter fields.

**Step 4: Commit**

```bash
git add skills/
git commit -m "feat: add plugin skill files with CLAUDE_PLUGIN_ROOT paths"
```

---

### Task 4: Create slash command wrappers

**Files:**
- Create: `commands/verify.md`
- Create: `commands/verify-setup.md`

These are thin wrappers that delegate to the skills. Based on the obra/superpowers pattern, commands use `disable-model-invocation: true` and just invoke the skill.

**Step 1: Create `commands/verify.md`**

```markdown
---
description: "Verify frontend changes against acceptance criteria using browser agents"
disable-model-invocation: true
---

Invoke the opslane-verify:verify skill and follow it exactly as presented to you.
```

**Step 2: Create `commands/verify-setup.md`**

```markdown
---
description: "One-time auth setup for /verify. Captures Playwright session state."
disable-model-invocation: true
---

Invoke the opslane-verify:verify-setup skill and follow it exactly as presented to you.
```

**Step 3: Verify both files are valid markdown with correct frontmatter**

```bash
head -6 commands/verify.md && echo "---" && head -6 commands/verify-setup.md
```

Expected: Both show description and disable-model-invocation fields.

**Step 4: Commit**

```bash
git add commands/
git commit -m "feat: add slash command wrappers for verify and verify-setup"
```

---

### Task 5: Update README with install instructions

**Files:**
- Modify: `README.md` (create if missing)

**Step 1: Check if README exists**

```bash
ls README.md 2>/dev/null || echo "missing"
```

**Step 2: Write/overwrite `README.md`**

```markdown
# opslane-verify

Browser-based acceptance criteria verification for frontend PRs. Runs Claude + Playwright agents against your local dev server to verify each AC in a spec doc — no CI required.

## How it works

1. `/verify setup` — one-time: captures auth session for apps that require login
2. `/verify` — runs the full pipeline:
   - **Planner**: reads your spec doc, extracts testable ACs
   - **Browser Agents**: one Claude+Playwright agent per AC, takes screenshots
   - **Judge**: reviews evidence, returns pass/fail per AC
   - **Report**: prints results with debug links for failures

## Installation

### Claude Code

Register the marketplace:

```bash
/plugin marketplace add <github-org>/opslane-v3
```

Install the plugin:

```bash
/plugin install opslane-verify@opslane-v3
```

### Prerequisites

- `claude` CLI with OAuth login (`claude login`)
- `node` + `npx` (for Playwright MCP)
- `jq`
- `curl`
- `coreutils` on macOS: `brew install coreutils` (for `gtimeout`)

## Usage

```bash
# One-time auth setup (skip if app has no login)
/verify setup

# Run verification
/verify
```

## Configuration

`.verify/config.json` (created by `/verify setup`):

```json
{
  "baseUrl": "http://localhost:3000",
  "authCheckUrl": "/api/me",
  "specPath": null
}
```

- `baseUrl`: your dev server URL
- `authCheckUrl`: endpoint that returns 200 when authenticated
- `specPath`: override spec doc path (default: auto-detect from `docs/plans/`)

## Debugging failures

```bash
npx playwright show-report .verify/evidence/<ac_id>/trace
open .verify/evidence/<ac_id>/session.webm
```
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add plugin installation and usage instructions"
```

---

### Task 6: Update `.gitignore` and clean up old paths

**Files:**
- Modify: `.gitignore`

**Step 1: Verify current `.gitignore` entries for verify artifacts**

```bash
cat .gitignore
```

**Step 2: Ensure `.gitignore` covers plugin artifacts (add if missing)**

These entries should already be present from `/verify setup`. If any are missing, add them:

```
.verify/auth.json
.verify/evidence/
.verify/prompts/
.verify/report.json
.verify/plan.json
.verify/.spec_path
.verify/chrome-profile/
```

**Step 3: Remove the old `.claude/skills/` files (now superseded by `skills/`)**

```bash
rm .claude/skills/verify.md .claude/skills/verify-setup.md
rmdir .claude/skills 2>/dev/null || true
rmdir .claude 2>/dev/null || true
```

**Step 4: Commit gitignore update and cleanup**

```bash
git add -u
git commit -m "chore: remove old .claude/skills files superseded by plugin skills/"
```

---

### Task 7: Verify final repo structure matches plugin format

**Step 1: List the final directory tree (non-git, non-artifact files)**

```bash
find . -not -path './.git/*' \
       -not -path './.verify/*' \
       -not -path './.playwright-mcp/*' \
       -not -path './node_modules/*' \
       -type f | sort
```

Expected output should match:
```
./.claude-plugin/marketplace.json
./.claude-plugin/plugin.json
./.gitignore
./commands/verify-setup.md
./commands/verify.md
./docs/evals/...
./docs/plans/...
./README.md
./scripts/agent.sh
./scripts/judge.sh
./scripts/orchestrate.sh
./scripts/planner.sh
./scripts/preflight.sh
./scripts/prompts/agent.txt
./scripts/prompts/judge.txt
./scripts/prompts/planner.txt
./scripts/report.sh
./skills/verify-setup/SKILL.md
./skills/verify/SKILL.md
./tools/verify/tests/...   ← keep tests in place, or move to tests/
```

**Step 2: Confirm `tools/verify/` only contains tests now**

```bash
find tools/ -type f | sort
```

Expected: Only `tools/verify/tests/` files remain.

**Step 3: Optionally move tests to top-level `tests/`**

```bash
mkdir -p tests
cp -r tools/verify/tests/* tests/
rm -rf tools/
git add tests/ && git rm -r tools/
git commit -m "chore: move tests to top-level tests/ directory"
```

---

### Task 8: Smoke test the plugin scripts from the new location

**Step 1: Run preflight from new path to verify it resolves correctly**

In a project that has a dev server running, run:

```bash
CLAUDE_PLUGIN_ROOT="$(pwd)" bash scripts/preflight.sh --skip-auth --skip-spec
```

Expected: `✓ Dev server reachable` (or appropriate error if no dev server — that's OK, the path resolution is what matters).

**Step 2: Verify orchestrate.sh resolves agent.sh correctly from new location**

```bash
AGENT_BIN="$(pwd)/scripts/agent.sh" bash -n scripts/orchestrate.sh
```

Expected: No syntax errors.

**Step 3: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "chore: final plugin structure verified"
```

---

## Post-Install Verification

Once published, users install with:

```bash
/plugin marketplace add <github-org>/<repo-name>
/plugin install opslane-verify@<repo-name>
```

Then in any project:
```bash
/verify setup   # one-time
/verify         # run pipeline
```

Skills are referenced as `opslane-verify:verify` and `opslane-verify:verify-setup`.
