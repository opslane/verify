# Frontend Verification Pipeline — Design

**Date:** 2026-03-08
**Status:** Design complete, ready for implementation
**Scope:** Local frontend verification for React/Next.js — developer-triggered, pre-PR

---

## Problem

Developers shipping frontend changes with Claude Code have no fast, local way to verify that what was built matches the acceptance criteria in the spec. Screenshots are not enough — you need to see the interaction. Existing solutions (v2 verify pipeline) are overengineered for this use case: cloud sandboxes, secret vaults, multi-blueprint orchestration.

## Goals

- Verify frontend changes against a spec doc's acceptance criteria before pushing
- Produce a demo video (developer artifact) per AC as evidence
- Run entirely locally, zero extra API charges (Claude Code OAuth token)
- Single command: `/verify`
- Fast enough to run on every PR (target: under 5 minutes for 5 ACs)

## Non-Goals (v1)

- Backend / API verification
- CI/CD integration
- Red/adversarial tests (v2)
- Non-React stacks (v2)
- Cloud execution (v2)

---

## Architecture

```
/verify (Claude Code skill)
    │
    ├── 0. Pre-flight        (bash checks, no LLM)
    ├── 1. Planner           (Opus — AC extraction + test scenarios in one call)
    ├── 2. Browser Agents    (Sonnet × N, parallel with sequential fallback)
    └── 3. Judge             (Opus)
```

All artifacts written to `.verify/` in the project root.

---

## Stage 0: Pre-flight

**No LLM — pure bash checks. Fail fast before spending any tokens.**

1. **Dev server health check** — `curl -sf http://localhost:3000 > /dev/null` (or port from config)
   - If down → print "Dev server not reachable at http://localhost:3000. Start it and retry." and exit
2. **Auth validity check** — hit a known authenticated endpoint, verify non-redirect response
   - If stale → print "Session expired. Run `/verify setup` to re-authenticate." and exit
3. **Spec doc detection** — find most recently modified `docs/plans/*.md` in git diff
   - Falls back to `docs/plans/*.md` by mtime for repos with no commits yet
   - If none found → ask developer to provide path before continuing
4. **Config load** — read `.verify/config.json` for `baseUrl`, `authCheckUrl`, `specPath` overrides

---

## Stage 1: Planner

**Model:** `claude -p --model opus`
**Input:** spec doc contents + React component files from git diff + base URL
**Output:** structured ACs with concrete test scenarios (one call, two responsibilities)

### Why merged

AC extraction and test planning are one thought. A single Opus call reads the spec and produces both: what the criteria are and exactly how to verify each one in the browser. Two separate LLM calls with two prompt templates for this is unnecessary overhead.

### Behavior

1. Reads spec doc and extracts acceptance criteria
2. Reads React component files touched in the git diff for selector hints
3. For each AC, produces concrete browser steps and screenshot checkpoints
4. Prefers semantic selectors: `role`, `aria-label`, `data-testid` over classnames
5. If any AC is ambiguous → skips it with a warning, continues with clear ones
   - Prints: "⚠ ac3 skipped: 'looks good on mobile' is too vague. Clarify in spec and re-run."
   - Non-interactive — does not block the pipeline

### Output Schema

```json
{
  "criteria": [
    {
      "id": "ac1",
      "description": "header is sticky on scroll",
      "url": "/dashboard",
      "steps": [
        "navigate to /dashboard",
        "scroll down 500px",
        "assert header is visible and position is fixed"
      ],
      "screenshot_at": ["after_scroll"]
    },
    {
      "id": "ac2",
      "description": "mobile nav collapses below 768px",
      "url": "/dashboard",
      "steps": [
        "set viewport to 375x812",
        "navigate to /dashboard",
        "assert hamburger menu is visible",
        "assert full nav links are hidden"
      ],
      "screenshot_at": ["initial_load"]
    }
  ],
  "skipped": ["ac3: 'looks good on mobile' — too vague"]
}
```

---

## Stage 2: Browser Agents

**Model:** `claude -p --model sonnet`
**Runtime:** Playwright MCP (`@playwright/mcp@latest`)
**Concurrency:** one subagent per AC, parallel via `--agents` with sequential fallback

### Playwright MCP Config (per agent)

```bash
claude -p --model sonnet \
  --mcp-config '{
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--save-video=1280x720",
        "--caps", "vision",
        "--storage-state", ".verify/auth.json",
        "--save-trace"
      ]
    }
  }' \
  "$(cat .verify/prompts/ac1-agent.txt)"
```

### Parallelism Strategy

**Primary:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `--agents` flag

**Sequential fallback** (when agent teams unavailable or flag not set):
```bash
for ac in ac1 ac2 ac3; do
  claude -p --model sonnet --mcp-config "..." "$(cat .verify/prompts/$ac-agent.txt)"
done
```

Skill auto-detects which mode to use by checking `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`.

### Behavior

1. Each agent receives its scenario steps as system prompt
2. Navigates, interacts, takes screenshots at defined checkpoints
3. On step failure → retries once, logs the issue
4. **Hard timeout: 90 seconds per agent** — kills and marks AC as `timeout` if exceeded
5. Saves evidence to `.verify/evidence/ac{n}/`
6. Agent self-reports preliminary pass/fail verdict with reasoning in `agent.log`

### Evidence Output (per AC)

```
.verify/evidence/
  ac1/
    screenshot-after_scroll.png   # one file per screenshot_at checkpoint
    session.webm                  # full interaction video (developer artifact)
    trace/                        # Playwright trace for npx playwright show-report
    agent.log                     # steps attempted + preliminary verdict
```

> **Note on video:** `.webm` files are for the developer to scrub through manually when investigating failures. The Judge does not consume video — Opus processes images, not video.

---

## Stage 3: Judge

**Model:** `claude -p --model opus`
**Input:** all AC criteria + screenshots + agent logs
**Output:** per-AC verdict + summary report

### Behavior

- Reads screenshots visually (`--caps vision`)
- Reads agent logs (steps attempted + preliminary verdict from browser agent)
- Reasons about each AC independently against the original criterion description
- Agent's preliminary verdict is a signal, not the final word — Judge can override
- Returns structured verdict JSON

### Output Schema

```json
{
  "verdict": "partial",
  "summary": "2/3 ACs passed",
  "criteria": [
    {
      "ac_id": "ac1",
      "status": "pass",
      "reasoning": "header remains fixed at top after scrolling 500px — confirmed by screenshot",
      "evidence": ".verify/evidence/ac1/screenshot-after_scroll.png"
    },
    {
      "ac_id": "ac2",
      "status": "fail",
      "reasoning": "mobile nav did not collapse — hamburger menu missing below 768px",
      "evidence": ".verify/evidence/ac2/screenshot-initial_load.png"
    }
  ],
  "skipped": ["ac3: too vague — refine and re-run"]
}
```

### Terminal Output

```
✓ ac1: header sticky on scroll
✗ ac2: mobile nav collapse — hamburger menu missing below 768px
⚠ ac3: skipped — too vague

Videos: .verify/evidence/ac2/session.webm
Debug:  npx playwright show-report .verify/evidence/ac2/trace/
```

---

## Auth Setup

Before first run, developer runs:

```bash
/verify setup
```

This:
1. Starts a headed browser via Playwright MCP
2. Developer logs in manually
3. Auth state saved to `.verify/auth.json` with `chmod 600`
4. `.verify/` is gitignored — auth never committed
5. Reused on all subsequent runs until session expires
6. On expiry: Stage 0 auth check catches it and prompts re-setup

---

## Config

`.verify/config.json` (committed, safe — no secrets):

```json
{
  "baseUrl": "http://localhost:3000",
  "authCheckUrl": "/api/me",
  "specPath": "docs/plans/my-feature.md"
}
```

`specPath` is optional — auto-detected from git diff if omitted.

---

## Security

- `.verify/` is added to `.gitignore` on first `/verify setup` run
- `auth.json` written with `chmod 600` — owner read/write only
- `.verify/config.json` is the only committed file — contains no secrets
- Stage 0 validates auth before any LLM call — fail fast, no wasted tokens

---

## File Layout

```
.verify/
  config.json           # committed — base URL, auth check URL, optional spec path
  auth.json             # gitignored, chmod 600 — Playwright storage state
  evidence/
    ac1/
      screenshot-after_scroll.png
      session.webm
      trace/
      agent.log
    ac2/
      ...
  prompts/              # ephemeral — generated per run, not committed
  report.json           # final Judge output
```

---

## Developer Flow

```bash
# One-time setup
/verify setup

# Before every PR
/verify

# Output
✓ ac1: sticky header
✗ ac2: mobile nav
⚠ ac3: skipped — too vague

# Debug a failure
npx playwright show-report .verify/evidence/ac2/trace/
# Watch the video
open .verify/evidence/ac2/session.webm
```

---

## Tech Stack

| Concern | Solution |
|---------|----------|
| LLM execution | `claude -p` (Claude Code OAuth, no extra charges) |
| AC extraction + test planning | Opus (single call) |
| Browser control | Playwright MCP (`@playwright/mcp@latest`) |
| Video recording | `--save-video=1280x720` (developer artifact, not Judge input) |
| Visual judgment | Opus + `--caps vision` |
| Parallelism | `--agents` + sequential fallback |
| Auth persistence | `--storage-state .verify/auth.json` |
| Debugging | `--save-trace` + `npx playwright show-report` |
| Config | `.verify/config.json` |

---

## Key Design Decisions

1. **OAuth over API keys** — `claude -p` uses existing Claude Code auth. Zero extra charges.
2. **Playwright MCP over CLI** — adaptive browser control; Claude sees page state and adjusts. CLI scripts are brittle against dynamic UIs.
3. **Merged Planner** — AC extraction and test scenario planning are one thought; one Opus call instead of two.
4. **Skip ambiguous ACs, don't block** — non-interactive; print warning and continue with clear criteria.
5. **Parallel subagents with sequential fallback** — speed when experimental flag is available, reliability when it's not.
6. **Video as developer artifact only** — Opus cannot process video; `.webm` is for manual inspection of failures.
7. **Stage 0 pre-flight** — catch dev server down and stale auth before spending any tokens.
8. **90s per-agent hard timeout** — hanging Playwright selectors don't block the terminal indefinitely.
9. **Spec doc as source of truth** — not the diff, not inferred intent. Explicit criteria only.

---

## What We Learned from v2

- Five-stage pipeline with E2B sandboxes was too heavy for local dev
- Per-criterion verdicts with traceability (AC → evidence → verdict) is the right model
- Opus for planning and judgment, Sonnet for execution — right quality split
- Auth state persistence (`storageState`) is essential for real-world apps
- Run evals not just unit tests — integration bugs only show up end-to-end
- Ask early for ambiguity, but non-interactively — don't block the pipeline

## v2 Improvements

- No cloud sandbox (E2B), no secret vault, no custom agent harness
- 3 stages instead of 5 — Planner merged, pre-flight is bash not LLM
- Video as evidence artifact (not just screenshots)
- Parallel browser agents with sequential fallback
- Single command, no server to run
- Uses Claude Code's own OAuth — no API key management
- Security-first: gitignore + chmod 600 on first setup
