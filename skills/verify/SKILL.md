---
name: verify
description: Verify frontend changes against spec acceptance criteria. Uses Playwright MCP for browser interaction.
---

# /verify

Verify your frontend changes before pushing.

## Prerequisites
- Dev server running (e.g. `npm run dev`)
- Playwright MCP configured in Claude Code (see install section below)
- Auth set up if app requires login (`/verify-setup`)

## Playwright MCP Install

If Playwright MCP is not available, show this:

> /verify requires Playwright MCP for browser interaction.
>
> **Install:**
> ```
> claude mcp add playwright -- npx @playwright/mcp@latest --storage-state .verify/auth.json --isolated
> ```
> Restart Claude Code, then re-run `/verify`.

## Conversation Flow

This skill is turn-based. Each turn has a trigger and a bounded set of actions. **Never skip ahead.**

---

## Turn 1: Spec Intake

**Trigger:** User invokes `/verify`.

**Check for arguments first.** If the user passed a file path as an argument (e.g. `/verify path/to/spec.md`), skip this turn entirely — go straight to Turn 2 using that path.

**Otherwise**, try smart spec discovery first:

```bash
find . -maxdepth 3 -name "*.md" \( -name "*spec*" -o -name "*plan*" -o -name "*requirements*" -o -name "*acceptance*" \) -not -path "./.verify/*" -not -path "./node_modules/*" -not -path "./.git/*" 2>/dev/null | head -5
```

- If **exactly 1 file** found: suggest it. "Found a likely spec: `path/to/spec.md`. Use this? (y/n)"
- If **multiple files** found: show the list and ask the user to pick one.
- If **no files** found: "What spec are you verifying? Paste the spec content or give a file path."

Do not call any other tools. End your response and wait.

---

## Turn 2: Pre-flight + MCP Check

**Trigger:** User has provided a spec (pasted content, file path, or confirmed a discovered file).

1. If they gave a **file path** — read the file with the Read tool.
2. If they **pasted content** — `mkdir -p .verify` then write to `.verify/spec.md`.

**MCP preflight:** Check if Playwright MCP is available:

```
Use ListMcpResourcesTool with server="playwright"
```

- If the server exists → Playwright MCP is available, proceed.
- If "Server not found" → show the install instructions from the Prerequisites section. Stop.
- If MCP is configured but non-responsive (e.g. connection error), show: "Playwright MCP is configured but not responding. Try restarting Claude Code."

**Dev server check:**

```bash
BASE_URL=$(cat .verify/config.json 2>/dev/null | grep -o '"baseUrl"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o 'http[^"]*' || echo "http://localhost:3000")
curl -sf "$BASE_URL" > /dev/null 2>&1 || { echo "Dev server not running at $BASE_URL"; exit 1; }
```

**Auth check:** Navigate to the app and check if you're logged in:

```
Use mcp__playwright__browser_navigate to go to $BASE_URL
Use mcp__playwright__browser_snapshot to read the page
```

If the page shows a login/signup form instead of authenticated content:
- Tell the user: "You're not logged in. Re-run `/verify-setup` to import fresh cookies, or provide credentials and I'll log in via the browser."
- If user provides credentials, use `mcp__playwright__browser_type` and `mcp__playwright__browser_click` to log in.
- After login succeeds, take a snapshot to confirm.

Proceed to Turn 3.

---

## Turn 3: Spec Interpreter

**Trigger:** Pre-flight passed.

Review the spec inline. For each AC, check:

1. **Reveal action** — does it say "shown/displayed/visible" without saying how? → flag
2. **Preconditions** — requires specific data to exist? → flag
3. **Target** — UI element identifiable by label or text? If too vague → flag
4. **Success** — clear pass/fail? If not → flag

If **no ambiguities**: skip Turn 4, go directly to Turn 5.
If **ambiguities found**: ask the first flagged question. End response and wait.

---

## Turn 4: Clarification Loop

**Trigger:** User answered a clarifying question.

Keep a running list of AC annotations, e.g.:
- AC3: expiry date revealed via hover on Pending badge
- AC1: expiration field is inline in the send dialog

Note the answer and add it to the list. If more ambiguities remain — ask the next one and wait.

When all answered — proceed to Turn 5.

---

## Turn 5: Extract ACs + Verify with Playwright MCP

**Trigger:** All ambiguities resolved (or there were none).

This turn has three phases: AC extraction, verification, and reporting.

### Phase 1: Extract Acceptance Criteria

Read the spec content and any clarifications. Also read context files if they exist:

- `.verify/app.json` — known routes, use for specific navigation paths in AC descriptions
- `.verify/seed-data.txt` — actual database records, use for specific data references (limit: first 8000 chars)
- `.verify/learnings.md` — corrections from past verification runs

Extract testable ACs. Each AC must be concrete enough for browser verification:

**AC quality standard — this is critical:**
- BAD: "The settings form shows an expiration field"
- GOOD: "The team document settings page (/t/{teamUrl}/settings/document) shows a 'Default Envelope Expiration' combobox with options 'Never expires' and 'Custom duration'"

USE THE SEED DATA. If the spec says "a document with expiration set" and seed data shows a recipient "recipient-expiry@test.documenso.com", reference those exact values.

USE THE ROUTES. If app routes show `/t/personal_xyz/settings/document`, reference that navigation path.

**Extraction rules:**
- Each AC: one specific testable behavior
- Skip ACs requiring external services (Stripe, email, OAuth)
- Pure UI ACs with multiple checks on the same page should be split into individual ACs (one behavior each)
- NEVER use template variables like {envId}, {orgId} — resolve to actual values from routes or seed data

Present the AC list to the user: "I've extracted N acceptance criteria. Here's the plan: [list ACs]. Starting verification now."

### Phase 2: Verify Each AC with Playwright MCP

Set up the evidence directory:

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)
mkdir -p .verify/runs/$RUN_ID/evidence
```

For EACH acceptance criterion, follow this sequence:

1. **Navigate** to the right page using `mcp__playwright__browser_navigate`.
   - Use known routes from `.verify/app.json` for direct URLs.
   - REUSE navigation context from previous ACs — the browser session persists.

2. **Check preconditions** — use `mcp__playwright__browser_snapshot` to read the page.
   - If required data is not visible after the first snapshot → verdict `blocked`, move on.

3. **Interact** as needed:
   - `mcp__playwright__browser_click` — click elements (use `ref` from snapshot)
   - `mcp__playwright__browser_type` — type into inputs
   - `mcp__playwright__browser_hover` — hover for tooltips
   - `mcp__playwright__browser_press_key` — keyboard actions
   - `mcp__playwright__browser_wait_for` — wait for animations/loads

4. **Collect evidence** — take a screenshot after verification:
   - `mcp__playwright__browser_take_screenshot`
   - The file is automatically saved by Playwright MCP to its configured `--output-dir`

5. **Check for auth redirect** — if the page URL contains `/login`, `/signin`, `/signup`, `/auth`, or `/forgot-password`, AND the AC does not intentionally target an auth page:
   - Write verdict `auth_expired` with observed: "Auth redirect — session may have expired"

6. **Judge the result** — based on what you observed, determine:
   - `verdict`: one of `pass`, `fail`, `blocked`, `unclear`, `error`, `timeout`, `skipped`, `auth_expired`, `spec_unclear`
   - `confidence`: `high`, `medium`, or `low`
   - `reasoning`: what you saw and why you reached this verdict

   Verdict meanings:
   - `pass` — AC verified successfully
   - `fail` — AC clearly not met
   - `blocked` — precondition missing, cannot test
   - `unclear` — partial evidence, cannot determine
   - `error` — Playwright command failed unexpectedly
   - `timeout` — page or element didn't load in time
   - `skipped` — AC skipped (depends on failed prior AC)
   - `auth_expired` — redirected to login page unexpectedly
   - `spec_unclear` — AC description too vague to verify

7. **Write the result** — create a subdirectory per AC and write result.json:

   ```bash
   mkdir -p .verify/runs/$RUN_ID/evidence/{ac_id}
   ```

   Then use the Write tool to create `.verify/runs/$RUN_ID/evidence/{ac_id}/result.json`:

   ```json
   {
     "ac_id": "{ac_id}",
     "verdict": "pass",
     "confidence": "high",
     "reasoning": "What you observed and why",
     "observed": "Exact text/state on the page",
     "steps_taken": ["navigate to /settings", "snapshot", "click @ref"],
     "screenshots": ["screenshot-filename.png"],
     "blocker": null
   }
   ```

8. **Move to next AC.** Do NOT close or reset the browser between ACs.

### Phase 3: Report Results

After all ACs are verified:

1. Read each `result.json` from the evidence subdirectories and show inline summary:

   For each AC:
   - `pass` → "✓ ac1: pass"
   - anything else → "✗ ac2: fail — [first 100 chars of reasoning]"

2. Write combined `verdicts.json` using the Write tool to `.verify/runs/$RUN_ID/verdicts.json`:

   ```json
   {
     "run_id": "{RUN_ID}",
     "verdicts": [
       {"ac_id": "ac1", "verdict": "pass", "confidence": "high", "reasoning": "..."},
       {"ac_id": "ac2", "verdict": "fail", "confidence": "high", "reasoning": "..."}
     ]
   }
   ```

3. Show pass/fail summary counts.

---

## Hard Constraints — DO NOT VIOLATE

These rules are battle-tested from 15+ real verification runs:

1. **BUDGET:** Aim for 12 Playwright commands per AC max. If you've done 10 commands and haven't resolved the AC, write your best verdict and move on.

2. **PRECONDITION CHECK:** After your first snapshot on the target page, if required data is not visible, write `blocked` immediately. Do NOT explore the entire app looking for data.

3. **BAIL EARLY:** If after 3 navigation attempts you haven't found the target page, write `blocked` and move on.

4. **ONE RECOVERY:** If a Playwright command fails, retry once. Then write the result and move on.

5. **NO CODEBASE ACCESS:** Do not use Read, Bash, Glob, Grep, `ls`, `git`, or `rg` to access source code files (.ts, .tsx, .js, .jsx, .py, .rb, etc). You are testing the running app, not the code. The ONLY files you may read/write are under `.verify/`.

6. **NO DATA MUTATION:** Do not submit forms that change app state, create accounts, or modify data. Read-only verification only.

7. **AUTH REDIRECT:** If you land on a login page unexpectedly, write verdict `auth_expired`. Suggest the user re-run `/verify-setup`.

8. **ALWAYS WRITE RESULT:** Before moving to the next AC, you MUST write the result JSON. A partial result is better than no result.

---

## Error Handling

| Failure | Action |
|---------|--------|
| Dev server not running | Print error, stop |
| Playwright MCP not available | Show install instructions, stop |
| Playwright MCP configured but crashed | "Playwright MCP not responding. Try restarting Claude Code." |
| Auth redirect on all ACs | "Auth cookies expired. Re-run `/verify-setup` to import fresh cookies." |
| Playwright command timeout | Write `timeout` for current AC, continue to next |
| All ACs blocked | "Check dev server and auth. Run `/verify-setup` to reconfigure." |

---

## Quick Reference

```bash
/verify-setup                       # one-time setup (port detection + cookie export + app indexing)
/verify                             # run verification
/verify path/to/spec.md             # run with specific spec
cat .verify/runs/*/verdicts.json    # check verdicts
ls .verify/runs/*/evidence/         # browse evidence (each AC has a subdirectory)
```
