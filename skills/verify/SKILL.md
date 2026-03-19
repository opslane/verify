---
name: verify
description: Verify frontend changes against spec acceptance criteria locally. Uses claude -p with OAuth. No extra API charges.
---

# /verify

Verify your frontend changes before pushing.

## Prerequisites
- Dev server running (e.g. `npm run dev`)
- Auth set up (`/verify-setup`) if app requires login
- App indexed (`/verify-setup` step 7) for column mappings and seed IDs

## Conversation Flow

This skill is turn-based. Each turn has a trigger and a bounded set of actions. **Never skip ahead.**

---

## Turn 1: Spec Intake

**Trigger:** User invokes `/verify`.

**Check for arguments first.** If the user passed a file path as an argument (e.g. `/verify path/to/spec.md`), skip this turn entirely — go straight to Turn 2 using that path.

**Otherwise**, send this message and end your response:

> "What spec are you verifying? Paste the spec content or give a file path."

Do not call any tools. Do not run any bash commands. Do not read any files. End your response and wait for the user to reply.

---

## Turn 2: Read Spec + Pre-flight

**Trigger:** User has provided a spec (pasted content or file path).

1. If they gave a **file path** — read the file now with the Read tool.
2. If they **pasted content** — first create the directory, then write the file:

```bash
mkdir -p .verify
```

Then write the content to `.verify/spec.md` with the Write tool.

Then run pre-flight checks:

```bash
# Check dev server
BASE_URL=$(jq -r '.baseUrl' .verify/config.json 2>/dev/null || echo "http://localhost:3000")
curl -sf "$BASE_URL" > /dev/null 2>&1 || { echo "⚠ Dev server not running at $BASE_URL"; exit 1; }

# Check app.json exists
[ -f .verify/app.json ] || echo "⚠ No .verify/app.json — run /verify-setup first for column mappings"
```

Proceed to Turn 3.

---

## Turn 3: Spec Interpreter

**Trigger:** Pre-flight passed.

Review the spec inline — no subprocess needed. For each AC, check:

1. **Reveal action** — does it say "shown/displayed/visible" without saying how (inline, hover, click, modal)? → flag
2. **Preconditions** — requires specific data to exist (sent doc, user role, feature flag)? → flag
3. **Target** — UI element identifiable by label or button text? If too vague → flag
4. **Success** — clear pass/fail? If not → flag

If **no ambiguities found**: skip Turn 4, go directly to Turn 5.

If **ambiguities found**: ask the user the first flagged question now. End your response and wait for their answer.

---

## Turn 4: Clarification Loop

**Trigger:** User has answered a clarifying question.

Keep a running list of AC annotations as you collect answers, e.g.:
- AC3: expiry date revealed via hover on Pending badge
- AC1: expiration field is inline in the send dialog

Note the new answer and add it to the list. If more flagged ambiguities remain — ask the next one. End your response and wait.

When all ambiguities are answered — proceed to Turn 5.

---

## Turn 5: Write Annotated Spec → Run Pipeline

**Trigger:** All ambiguities resolved (or there were none).

Write `.verify/spec.md` incorporating all clarifications as inline HTML comments, e.g.:
`<!-- clarified: expiry date revealed via hover on Pending badge -->`

Then run the pipeline:

```bash
cd "$(git rev-parse --show-toplevel)"
npx tsx ~/.claude/tools/verify/pipeline/src/cli.ts run \
  --spec .verify/spec.md \
  --verify-dir .verify
```

The pipeline runs these stages automatically:
1. **AC Generator** — extracts testable acceptance criteria from the spec
2. **Planner** — plans browser steps, URLs, and screenshots for each AC
3. **Setup Writer** — generates SQL to set up the required DB state (reads column mappings from app.json)
4. **Browse Agents** — navigates the app and captures evidence (parallel per group)
5. **Judge** — evaluates evidence against each AC
6. **Learner** — writes corrections to `.verify/learnings.md` for future runs

Wait for completion, then show results.

---

## Report

After the pipeline finishes, show results:

```bash
echo ""
echo "Results:"
cat .verify/runs/*/verdicts.json 2>/dev/null | jq -r '.verdicts[] | "  \(if .verdict == "pass" then "✓" else "✗" end) \(.ac_id): \(.verdict) — \(.reasoning[:100])"'
```

---

## Error Handling

| Failure | Action |
|---------|--------|
| Dev server not running | Print error, stop |
| No app.json | Warn, suggest `/verify-setup` |
| All agents timeout/error | Print "Check dev server and auth", suggest `/verify-setup` |
| Pipeline exits non-zero | Print "Check logs in .verify/runs/" |
| Auth redirects on all ACs | Auth cookies expired — re-run `/verify-setup` |

## Quick Reference

```bash
/verify-setup                                          # one-time auth + app indexing
/verify                                                # run pipeline
/verify path/to/spec.md                                # run with specific spec
cat .verify/runs/*/verdicts.json | jq                  # check verdicts
ls .verify/runs/*/evidence/                            # browse evidence
cat .verify/learnings.md                               # see accumulated learnings
```
