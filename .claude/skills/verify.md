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
bash ~/.claude/tools/verify/preflight.sh
```

Stop if this fails. Fix the reported issue and re-run.

### Stage 1: Planner

```bash
SPEC_PATH=$(cat .verify/.spec_path)
bash ~/.claude/tools/verify/planner.sh "$SPEC_PATH"
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

Clear previous evidence and stale temp files first:
```bash
rm -rf .verify/evidence .verify/prompts
rm -f /tmp/verify-mcp-*.json
mkdir -p .verify/evidence
```

Run:
```bash
bash ~/.claude/tools/verify/orchestrate.sh
```

### Stage 3: Judge

```bash
bash ~/.claude/tools/verify/judge.sh
```

### Report

```bash
bash ~/.claude/tools/verify/report.sh
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
