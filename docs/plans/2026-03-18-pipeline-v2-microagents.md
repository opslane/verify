# Pipeline v2: Microagent Architecture

> **For Claude:** This is a design document, not an implementation plan. Read this first to understand the context, the problems we've faced, the approaches that failed, and the principles that guide the new design. Then create a detailed implementation plan from this.

---

## What is /verify?

`/verify` is an automated acceptance criteria verification pipeline for frontend changes. A developer writes a spec (or has one from a PR), runs `/verify`, and the pipeline:
1. Reads the spec
2. Generates a test plan (which pages to visit, what to check)
3. Runs browser agents that navigate the app and check each criterion
4. Judges the results
5. Reports pass/fail per acceptance criterion

The pipeline runs locally via Claude Code. It uses `claude -p` (non-interactive CLI) to invoke LLM agents as subprocesses. A headless browser (`browse` binary) provides browser automation. No API keys needed — uses Claude's OAuth.

---

## The Problems We Faced

We ran the pipeline on real eval repos (Formbricks, Cal.com) over 2 weeks. Here's what kept breaking and why.

### Problem 1: The $DATABASE_URL hallucination

Some acceptance criteria need database state to be testable. For example, "show trial alert when org is trialing" requires the seed organization to have `subscriptionStatus: "trialing"` in the database.

We built a **setup-researcher** — a Sonnet agent that reads the app's Prisma schema and generates SQL INSERT/UPDATE commands. The researcher prompt told it: "Use the DB connection string from APP CONTEXT (db_url_env field). Look up the actual env var name from app.json."

**What happened:** The researcher ignored this instruction and wrote `psql "$DATABASE_URL" -c "..."` every time. The Formbricks app uses `DATABASE_URL` in `.env`, so it worked there — but the instruction was irrelevant. The LLM followed its training data pattern, not our prompt.

We then built a **setup-judge** (Haiku) to review the researcher's output and catch wrong variable names. The judge sometimes said "OK" to commands that would fail. We added a retry loop: judge catches issue → re-runs researcher with critique → judge reviews again. Up to 3 attempts.

**The result:** 3 Haiku calls + 3 Sonnet calls per AC for setup alone. The pipeline was slower, more complex, and still failed when the researcher generated `DB_URL="${DATABASE_URL%\\?*}"; psql "$DB_URL"` — a pattern the judge's grep didn't catch.

**Root cause:** We were adding validation layers for LLM output instead of making the LLM's job simpler. The researcher prompt was 45 lines long with injected schema context, cache entries, and rules. The LLM skimmed past it.

### Problem 2: Mega-prompts that LLMs ignore

The planner prompt (`scripts/prompts/planner.txt`) grew to 77 lines of rules:
- Schema definition (15 lines)
- Testability classification rules (5 lines)
- Playbook matching instructions (8 lines)
- 8 numbered rules about URLs, selectors, assertions, data-dependent ACs, external services, code grounding
- App context injected inline (hundreds of chars of JSON)

The agent-browse prompt (`scripts/prompts/agent-browse.txt`) was 64 lines.

**What happened:**
- The planner kept emitting a `testability` field we removed from the schema. Turns out `plan-validator.sh` was silently re-adding it with a default value — but even after fixing that, the planner sometimes added it from habit.
- The planner hallucinated `data-testid` selectors that existed in source code but weren't forwarded to the DOM by UI components (Radix UI, shadcn). ACs failed as false negatives.
- The planner used placeholder URLs like `/environments/{envId}/settings` instead of real IDs, even though `app.json` was injected into the prompt with the actual environment ID.
- The agent-browse prompt had so many rules that agents sometimes produced no output at all — just timed out silently.

**Root cause:** Long prompts with injected context compete with the LLM's training priors. The more rules you add, the more likely some get ignored. Injected JSON blobs (app.json pages, data model, DB env var) get treated as noise.

### Problem 3: Silent failures with no logging

When something went wrong, we couldn't tell what happened:

- `setup-researcher.sh` piped Claude's stdout to `/dev/null` (line 170). If the researcher crashed, the only signal was a default JSON file pre-seeded with `{"setup": [], "error": "agent did not complete"}`.
- `judge.sh` called Opus with no timeout (line 83) and discarded stderr (`2>/dev/null`). If Opus hung, the pipeline blocked forever. If it returned an API error, we never saw it.
- `setup-judge.sh` captured the judge's response in a bash variable but never wrote it to disk. When the judge incorrectly approved bad SQL, there was no audit trail.
- The orchestrator (`verify-run.ts`) spawned agents with `stdio: "inherit"` — output went to the terminal and was lost.
- No per-AC timing data. When a 5-AC run took 15 minutes, we couldn't tell which AC consumed the time.

**Debugging workflow:** To figure out why an AC failed, we had to manually run `claude -p` with the prompt, then manually run `browse goto <url>`, then manually check if the page loaded. This took 20-30 minutes per failure.

### Problem 4: Auth session expiry

The browse daemon holds auth state in memory. When it restarts (crash, 30-min idle timeout, or between preflight and agents), authentication is lost. The `next-auth` session token expires every ~24 hours.

Preflight re-logs in via a Haiku mini-agent, but doesn't persist cookies to disk. When the daemon restarts mid-run, every subsequent agent navigates to a login redirect page. Each agent independently discovers this and writes "error: Auth redirect" — wasting its full timeout budget (120-150s per AC).

**We designed a reauth.sh script** and an agent-browse.txt rule to call it on redirect. But there was no circuit breaker — if AC1 hit auth redirect, AC2-AC5 still ran and all failed the same way. A 5-AC run could waste 10 minutes on auth failures.

### Problem 5: No learning across runs

Every run made the same mistakes:
- Researcher hallucinated `$DATABASE_URL` on every Formbricks eval
- Planner generated the same wrong URL for the billing page
- Agent timed out on the same slow-loading page

We built a `setup-cache.json` that stored working setup commands per condition. But it only cached researcher output — not pipeline-level learnings like "this app's DB variable is `POSTGRES_URL`" or "modals take 2s to render, always add a wait."

### Problem 6: Retry loops masking real failures

The pipeline had 6 retry layers:
1. `setup-judge.sh` retry loop (up to 3 judge + researcher iterations)
2. `verify-run.ts` `runSetupWithRetry` (up to 3 setup command retries with researcher re-invocation)
3. Agent replay mode → explore mode fallback
4. Agent `result.json` recovery on timeout
5. Researcher parallel spawn with per-AC fallback
6. `|| true` patterns throughout that swallowed errors

When a user saw `setup_failed`, they had no idea which of the 6 layers gave up, what was tried, or why. The retries added 2-5 minutes of latency per conditional AC, and the pipeline still failed at the same rate.

---

## Approaches We Tried (on the `pipeline-stage-split` worktree)

### Attempt 1: TypeScript orchestrator with setup lifecycle

Replaced `orchestrate.sh` with `verify-run.ts` — a TypeScript orchestrator that splits ACs into "direct" (parallel, no setup) and "conditional" (sequential, with setup → agent → teardown lifecycle). Added `$VERIFY_RUN_ID` for row isolation, teardown in reverse FK order.

**What worked:** The lifecycle model (setup → agent → teardown) is correct. Parallel execution of direct ACs saved time.

**What didn't work:** The "direct vs conditional" classification was done by the planner (a `testability` field). The planner got it wrong. We removed the field and switched to `setup[].length > 0` as the signal, which was better but required the researcher to have already run.

### Attempt 2: Setup-researcher with semantic cache

Rewrote the setup-researcher to use a semantic cache — Claude reads prior cache entries and reasons about whether a cached setup matches the current condition. Added `VERIFY_RETRY_AC` for single-AC retry, cache failure tracking.

**What worked:** Semantic cache matching was better than keyword matching. The researcher could reuse "org must be trialing" setup even if the condition was worded differently.

**What didn't work:** The researcher still generated bad SQL on first attempt. The cache helped on re-runs but not on first contact with a new app.

### Attempt 3: Setup-judge (LLM validation of LLM output)

Added a Haiku judge that reviews researcher-generated setup commands: checks variable names, FK ordering, table names. Retries researcher with critique on failure.

**What worked:** The judge caught `$DATABASE_URL` mismatches when the pattern was simple.

**What didn't work:** Haiku missed complex patterns like `DB_URL="${DATABASE_URL%\\?*}"`. The retry loop added 30-60s latency. The judge's response was never logged — when it wrongly approved bad SQL, we couldn't debug it. This was fundamentally the wrong approach: adding an LLM to validate another LLM's output is a losing game.

### Attempt 4: Planner prompt improvements

- Added Rule 5: prefer visible text assertions over `data-testid` for visibility checks
- Added Rule 8: skip ACs requiring external services
- Removed `testability` from schema
- Added playbook matching (Claude reads a playbook index and reuses known-good steps)

**What worked:** Text assertions over data-testid was a real improvement — eliminated false negatives from DOM forwarding issues.

**What didn't work:** Adding more rules to an already-long prompt had diminishing returns. The planner ignored some rules. The playbook system added complexity (write-playbook.sh, match-playbooks.sh, replay mode in agent.sh) for marginal speed gains.

### What we learned from all of this

1. **LLMs follow training patterns over prompt instructions.** The more you inject, the more they ignore. The solution is smaller prompts with file pointers, not bigger prompts with more rules.
2. **Validation layers for LLM output don't scale.** Every validator needs its own validator. The right approach is making the original task simpler.
3. **Retry within a run is expensive and rarely helps.** If the researcher gets the SQL wrong, retrying with "you got it wrong, try again" produces marginally better results at 3x the cost. Learning across runs (persistent memory) is more effective.
4. **Every LLM call must be logged.** Without input/output on disk, debugging is manual reproduction — which takes 10x longer than reading a log file.
5. **The pipeline should be honest about what it can't do.** Saying "we couldn't test AC4 because it needs Stripe" is more useful than silently retrying and failing.

---

## The New Design: Microagent Architecture

### Core Principles

**P1: One agent, one job, small prompt.** Each microagent does exactly one thing. Prompts are under 15 lines of instructions. If a prompt needs more, the agent is doing too many things — split it.

**P2: Read, don't inject.** Instead of stuffing app.json into a prompt as inline context, the prompt says "Read `.verify/app.json` for routes and selectors." The agent reads files via tool calls. This keeps prompts small, avoids competing with training priors, and lets the agent decide what context is relevant.

**P3: Log everything.** Every `claude -p` call saves its prompt, stdout, and stderr to disk. Every stage writes timing data to a unified `timeline.jsonl`. When something fails, you read `.verify/logs/`, not re-run the pipeline manually.

**P4: Timeout everything.** No unbounded LLM calls. Opus: 60s. Sonnet: 90-300s (agents get more). Haiku: 30s. Exit code 124 = timeout, logged explicitly.

**P5: Skip over retry.** If setup fails, mark it `setup_failed` with a clear explanation and move on. Don't retry within the run. Write the failure to `verify-learnings.md` so the next run avoids the mistake. The learning loop IS the retry mechanism — it just operates across runs instead of within one. Exception: one retry for transient infrastructure errors (DB connection refused).

**P6: Every failure is user-explainable.** Instead of `setup_failed`, the user sees: "Setup failed for ac1: table 'users' does not exist. The setup-writer used the wrong table name. Check `.verify/logs/setup-writer-group-a-output.txt` for details." The user knows what happened, where to look, and what to do.

**P7: The learning loop is persistent memory.** `verify-learnings.md` is committed to the repo root. It accumulates app-specific knowledge across runs: correct DB variable names, working SQL patterns, selector tips, timeout history. The planner reads it on every run. The system gets measurably better over time.

### The 10-Stage Pipeline

```
Stage 1:  PREFLIGHT        (bash, no LLM)
Stage 2:  AC GENERATOR     (Opus)     — spec → acceptance criteria
Stage 3:  PLANNER          (Opus)     — ACs → test plan with steps, URLs
Stage 4:  VALIDATOR        (bash)     — deterministic checks on plan
Stage 5:  CLASSIFIER       (Haiku)    — group ACs by shared condition, assign types
Stage 6:  SETUP PLANNER    (Haiku)    — per-group: what DB state to create (approach)
Stage 7:  SETUP WRITER     (Sonnet)   — per-group: exact SQL from schema files
Stage 8:  BROWSE AGENTS    (Sonnet)   — per-AC: navigate, act, screenshot, verdict
Stage 9:  JUDGE            (Opus)     — review all evidence, final pass/fail
Stage 10: LEARNER          (Haiku)    — update verify-learnings.md
          REPORT           (bash)     — format and display results
```

### Why split AC Generator from Planner?

The current planner does both: extracts ACs from the spec AND decides how to test them. This conflates two responsibilities. A human plan file might not have explicit ACs — the AC generator handles that. A spec with clear ACs still needs condition extraction ("this AC needs trialing state"). Separating them means:
- AC Generator: "What are we testing?" (reads spec only)
- Planner: "How do we test it?" (reads ACs + app.json + learnings)

### Why split Setup Planner from Setup Writer?

When setup fails, you need to know: was the approach wrong (wrong table, wrong state) or was the SQL wrong (right approach, syntax error)? Two agents make this debuggable:
- Setup Planner (Haiku): "Update the Organization's billing JSON to set subscriptionStatus to trialing." Fast, cheap, no tool use — gets a schema summary in the prompt.
- Setup Writer (Sonnet): Reads the actual Prisma schema files, writes exact psql commands. If the planner's approach was wrong, the writer may detect the mismatch ("there's no billing JSON field — it's a separate Billing table").

### Why Haiku for Classifier?

The classifier groups ACs by shared setup condition ("ac1, ac2, ac3, ac5 all need the org to be trialing — group them"). This is semantic equivalence, not keyword matching. A regex can't tell that "Organization must be on trial with billing enabled" and "Organization in trialing state" are the same condition. Haiku handles this and is fast (~3s).

Deterministic regex still runs first as a safety net for hard skips (Stripe, PayPal, Twilio → auto-skip before Haiku sees them).

### The grouping optimization

When multiple ACs share the same condition, setup runs ONCE for the group:
- Setup planner → setup writer → run SQL → ac1 agent → ac2 agent → ac3 agent → ac5 agent → teardown

Instead of 4 separate setup/teardown cycles. For the Formbricks trial alerts spec, this turns 4 setup calls into 1.

ACs within a group run sequentially (they share a browser instance). Groups run in parallel with each other (group A with setup, group B pure-UI in parallel).

### Circuit breaker

If any agent returns "Auth redirect" (session expired), the orchestrator aborts all remaining agents immediately. Instead of 5 agents each discovering the auth failure independently (wasting 10+ minutes), the pipeline stops after the first failure and tells the user: "Session expired. Run /verify-setup to re-authenticate."

### The learning loop

After every run, a Learner agent (Haiku) reads the verdicts and evidence, then updates `verify-learnings.md`:

```markdown
# /verify learnings

## App Facts
- Database env var: DATABASE_URL
- Auth: credentials (admin@formbricks.com at /auth/login)
- Seed org ID: clseedorgprod000000000

## Setup Patterns
- Trial state: UPDATE Organization SET billing = jsonb_set(...)
- Billing field is JSONB with subscriptionStatus, trialEnd

## Known Limitations
- ac4 (hasPaymentMethod=true) requires Stripe API — always skip

## Selector Tips
- Navigation items: use visible text, not data-testid (Radix doesn't forward)
- Modals take ~2s to render — always wait before asserting

## Timing
- Agents: avg 40s for simple assert ACs, 90s for form interactions
```

The Planner reads this on the next run. It knows to skip Stripe ACs, use the right DB variable, wait for modals, and avoid data-testid for navigation. The pipeline improves with every run without any code changes.

The file is committed to the repo root (not gitignored) so learnings persist across branches and machines.

### Execution DAG (Formbricks example)

```
AC Generator → 6 ACs (ac4 skipped: Stripe)
    │
Planner → 5 ACs with steps, URLs (/environments/clseedenvprod000000000/...)
    │
Validator → timeouts computed, URLs validated
    │
Classifier → Group A (ac1,2,3,5: trialing), Group B (ac6: pure UI)
    │
    ├── Group A                          Group B
    │   Setup Planner (Haiku)            │
    │   Setup Writer (Sonnet)            │
    │   Run SQL                          │
    │   ac1 agent ─┐                     ac6 agent (parallel)
    │   ac2 agent  │ (sequential)        │
    │   ac3 agent  │                     │
    │   ac5 agent ─┘                     │
    │   Teardown                         │
    │                                    │
    └───────────┬────────────────────────┘
                │
Judge (Opus) → 5 pass, 1 skipped
    │
Learner → verify-learnings.md updated
    │
Report → results to user (~5 min total)
```

### File system layout

```
.verify/
├── config.json              # base URL, auth (existing)
├── app.json                 # app surface map (existing, from /verify-setup)
├── acs.json                 # NEW: AC Generator output
├── plan.json                # Planner output (simplified schema)
├── classification.json      # NEW: Classifier output (groups)
├── setup/{group-id}/        # NEW: per-group setup artifacts
│   ├── approach.json        #   Setup Planner output
│   └── commands.json        #   Setup Writer output
├── evidence/{ac-id}/        # per-AC agent output (existing pattern)
│   ├── result.json
│   ├── agent.log
│   └── screenshot-*.png
├── verdicts.json            # NEW: Judge output
├── logs/                    # NEW: all LLM call logs
│   ├── timeline.jsonl       #   unified event log
│   ├── {stage}-prompt.txt   #   rendered prompt for each call
│   ├── {stage}-output.txt   #   stdout for each call
│   └── {stage}-stderr.txt   #   stderr for each call
└── report.json              # Final report

verify-learnings.md          # COMMITTED to repo root — persistent memory
```

### Model assignments

| Agent | Model | Why |
|-------|-------|-----|
| AC Generator | Opus | Judgment call: extracting conditions from specs, deciding what to skip |
| Planner | Opus | Judgment call: mapping ACs to URLs, writing browser steps |
| Classifier | Haiku | Simple grouping task, fast |
| Setup Planner | Haiku | Approach only, no file reading, schema summary provided |
| Setup Writer | Sonnet | Reads files, writes precise SQL, needs tool use |
| Browse Agent | Sonnet | Agentic browser control, needs tool use |
| Judge | Opus | Highest-stakes judgment, weighs conflicting evidence |
| Learner | Haiku | Summarization of structured data |

### What stays from the current pipeline

- `preflight.sh` — works well, keep it. Add cookie persistence after login.
- `report.sh` — formats results, mostly unchanged.
- `code-review.sh` — runs in parallel with agents, unchanged.
- `install-browse.sh` — unchanged.
- SKILL.md turn structure — spec intake, clarification, plan display, execution. Update execution turns.

### What gets removed

- `plan-validator.sh` from the worktree (was adding `testability` back silently) — replace with simpler deterministic validator
- `setup-researcher.sh` — replaced by setup-planner + setup-writer
- `setup-judge.sh` — eliminated entirely. Run the SQL; the database is the validator.
- `verify-run.ts` / `verify-run.js` — TypeScript orchestrator replaced by bash (no compile step)
- Playbook system (`write-playbook.sh`, replay mode in `agent.sh`) — intentionally excluded from v2. Add back once base pipeline is reliable.
- All retry loops — replaced by skip + learn pattern
- `orchestrate.sh` — replaced by new orchestrator with group-based execution

### Reference: the `pipeline-stage-split` worktree

The worktree at `.worktrees/pipeline-stage-split` has useful reference code but should NOT be merged. Key files to reference for patterns (not to copy directly):
- `scripts/verify-run.ts` — orchestrator lifecycle (setup → agent → teardown → retry)
- `scripts/setup-researcher.sh` — semantic cache reading, parallel researcher spawning
- `scripts/setup-judge.sh` — the approach we're replacing (LLM validates LLM)
- `tests/test_orchestrator.sh` — good test patterns for orchestrator lifecycle
- `scripts/prompts/setup-researcher.txt` — what a 45-line prompt looks like (cautionary example)

The worktree also has useful design docs:
- `docs/plans/2026-03-17-pipeline-reliability.md` — the combined plan we were implementing
- `docs/plans/2026-03-17-setup-judge.md` — the setup-judge plan (approach we're abandoning)
