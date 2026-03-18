# Pipeline Stage Split: Reliability Over Speed

## Problem

The planner does too much in one LLM call — parsing ACs, writing browser steps, guessing SQL, guessing timeouts, guessing URLs. Every failure mode gets patched with another rule in the planner prompt. This doesn't scale. The prompt is becoming a bag of special cases.

Core failures this addresses:
- Hallucinated DB slugs/values in setup SQL (no feedback loop)
- Missing render-dependency fields (signingStatus set but signedAt not)
- Wrong env var names (DATABASE_URL vs NEXT_PRIVATE_DATABASE_URL)
- Timeout underestimation (120s for 14-step flows)
- Full URLs doubled by agent.sh
- External-service ACs not skipped
- Setup commands that silently affect 0 rows

## Principle

**Reliability and trust over speed.** If it takes 2 minutes longer but is always correct, that's the right trade-off. Let the planner be a rough draft. Validate and correct with feedback loops.

## Current Pipeline

```
spec → planner (one LLM: ACs + setup + steps + timeouts + URLs) → orchestrate → agents → judge → report
```

## Proposed Pipeline

```
spec → planner (LLM: ACs + steps only) → plan-validator (deterministic) → setup-researcher (LLM per-AC) → orchestrate → agents → judge → report
```

### Stage 1: Planner (LLM) — "what to test"

**Responsibility:** Understand the spec and code diff. Output what to test and how to verify it.

**Keeps:**
- Parse spec → list of ACs with descriptions
- Classify testability (direct / conditional / skip)
- Write browser steps (concrete Playwright actions)
- Determine relative URL from route files
- Write `condition` field in English (what must be true, not how to make it true)

**Removes:**
- Setup commands (SQL, curl, env vars) — moved to setup researcher
- Timeout calculation — moved to plan validator
- All infrastructure concerns (URL format, env var names, DB connection strings)

**Output schema change:**
```json
{
  "criteria": [
    {
      "id": "ac1",
      "testability": "conditional",
      "description": "Billing page shows trial banner",
      "condition": "Organization must be on trial with billing enabled",
      "url": "/settings/billing",
      "steps": ["Navigate to billing page", "Assert trial banner visible"],
      "screenshot_at": ["billing_trial_banner"]
    }
  ]
}
```

No `setup` field. No `timeout_seconds`. The planner just says what and where.

### Stage 2: Plan Validator (deterministic) — "infrastructure guardrails"

**Responsibility:** Fix known planner mistakes and enforce constraints. Pure bash, no LLM.

**Does:**
1. **URL sanitization** — strip `http(s)://host:port` prefixes to relative paths. Ensure result starts with `/` (bare origins like `http://localhost:3000` with no path become `/`, not empty string).
2. **Timeout computation** — `timeout = min(max(steps * 20 + 30, 90), 300)`. The 300s cap is an intentional increase from the current planner's 180s limit — each browse engine round-trip takes ~10-15s, so 10 steps need ~230s.
3. **Step count enforcement** — if an AC has >10 steps, split it into sub-ACs (ac1a, ac1b) at logical boundaries (e.g. after a page navigation or form submit). The split only triggers on step count, not on keywords alone.
4. **External-service auto-skip** — scan description/steps for stripe, paypal, oauth, email delivery keywords → write `VERDICT: skipped`
5. **Schema validation** — ensure required fields present, no nulls

**Step splitting logic (deterministic):**
- Triggered only when step count exceeds 10
- Find the split point: look for steps containing "navigate", "reload", "click.*tab", "submit", "save" — these are natural boundaries
- If no natural boundary, split at step 5
- Each sub-AC inherits the parent's URL and condition
- Sub-AC IDs: `ac1a`, `ac1b`

**Output:** validated plan.json with computed timeouts and any split ACs.

### Stage 3: Setup Researcher (LLM, per-AC) — "how to set up state"

**Responsibility:** For each AC that has a `condition`, research the codebase and write working setup commands.

**Runs as:** `claude -p` subprocess per AC (with `--dangerously-skip-permissions`).

**Per-AC flow:**
1. Receive: AC condition (English), relevant file paths from code diff
2. Read DB schema (Prisma schema, migrations, models)
3. Read component code — trace conditional rendering to find ALL fields that gate display
4. Detect DB connection env var from `.env` / `.env.example` (not guessed — actually read the file)
5. Write setup command (prefer INSERT with known values over UPDATE with guessed values)
6. **Run it** and check exit code + output
7. If failed → read error message, fix, retry (max 2 attempts)
8. Write validated setup command to plan.json

**Prompt structure:**
```
You are a test setup researcher. Your job is to make this condition true:

CONDITION: {ac.condition}
DATABASE SCHEMA: {prisma_schema_excerpt}
COMPONENT CODE: {component_file_excerpt}
ENV FILE: {dot_env_contents}

Write a shell command that creates the required state. Then RUN it.
If it fails, read the error and try again (max 2 retries).

Output the working command as JSON: {"setup": ["<command>"]}
```

**Key properties:**
- Feedback loop: can try, fail, read error, fix
- Reads actual `.env` — no guessing env var names
- Traces component render deps — not just DB schema
- Per-AC isolation — one failure doesn't affect others
- `direct` testability ACs skip this stage entirely

### Stage 4-6: Orchestrate → Agents → Judge → Report

Same as today, but with robustness fixes and verdict contract updates:
- Process substitution for global setup (env vars persist)
- Setup failure → `VERDICT: setup_failed` (skip agent)
- External-service auto-skip (defense in depth)
- **Parallel mode fix:** maintain a `SPAWNED_IDS` array alongside `PIDS` so the wait loop correlates correctly when ACs are skipped (currently `PIDS[i]` can misalign with `AC_IDS[i]` after a skip)
- **Verdict contract:** judge prompt and report.sh must handle `setup_failed` and `skipped` as valid verdicts. Report HTML needs icon/color mappings for both (currently only covers `pass|fail|timeout|error`)
- Remove duplicate echo lines in setup command logging (orchestrate.sh, agent.sh)
- Initialize `SETUP_EXIT=0` defensively in agent.sh

## What This Fixes

| Failure | How it's fixed |
|---------|---------------|
| Hallucinated DB slug (`30-min` vs `30min`) | Setup researcher reads actual DB/code, runs command, self-corrects |
| Missing render dep fields (`signedAt`) | Researcher traces component conditional rendering |
| Wrong env var (`DATABASE_URL` vs `NEXT_PRIVATE_DATABASE_URL`) | Researcher reads `.env` file directly |
| Timeout too short (120s for 14 steps) | Validator computes from step count: `steps * 20 + 30` |
| Too many steps per AC | Validator splits ACs with >10 steps |
| Full URLs doubled | Validator strips to relative paths |
| External-service ACs not skipped | Validator auto-skips on keyword match |
| Setup SQL returns UPDATE 0 silently | Researcher runs and validates output |

## Files to Create/Modify

| File | Change |
|------|--------|
| `scripts/prompts/planner.txt` | Strip down: remove setup, timeout, URL rules. Keep AC/step generation |
| `scripts/plan-validator.sh` | New: deterministic validation + timeout + step splitting |
| `scripts/setup-researcher.sh` | New: per-AC LLM setup with feedback loop |
| `scripts/prompts/setup-researcher.txt` | New: focused prompt for setup research |
| `scripts/planner.sh` | Add plan-validator call after planner |
| `scripts/orchestrate.sh` | Fix parallel SPAWNED_IDS array, remove duplicate echos, init SETUP_EXIT |
| `scripts/agent.sh` | Remove duplicate echo, remove redundant mkdir, init SETUP_EXIT=0 |
| `scripts/report.sh` | Add `setup_failed` and `skipped` to status icon/color mappings |
| `skills/verify/SKILL.md` | Update Turn 5 to call setup-researcher instead of manual research |
| `tests/test_plan_validator.sh` | New: tests for URL fix (incl. bare origin), timeout calc, step split, external skip |
| `tests/test_setup_researcher.sh` | New: tests for setup research flow |

## Migration

The existing orchestrator-level fixes (URL sanitization, external-service skip) become redundant once the plan validator runs — but keeping them as defense-in-depth is fine. No breaking changes.

## Review Findings Incorporated

From code review (3 reviewers — technical, codex, simplicity):
1. **Parallel PID misalignment** — `SPAWNED_IDS` array needed alongside `PIDS` (blocker)
2. **Verdict contract gap** — judge/report must handle `setup_failed` and `skipped` (blocker)
3. **URL bare-origin edge case** — `http://localhost:3000` → `/` not empty string (should fix)
4. **Duplicate echo lines** — pick one style for setup command logging (cleanup)
5. **Redundant mkdir in agent.sh** — already done earlier in script (cleanup)
6. **SETUP_EXIT uninitialized** — defensive init to 0 (cleanup)

Pushed back on:
- Per-AC subshell in agent.sh `$()` — intentional, per-AC setup doesn't need export persistence
- Extract `_is_skipped` helper — 2-line duplication not worth a function
- Regex dot precision in external pattern — false positives skip (safe direction), pattern is a stopgap
