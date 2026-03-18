# Pipeline v2: Microagent Architecture — Design

> **Status:** Approved design. Ready for implementation planning.
>
> **Context:** This design was refined from `2026-03-18-pipeline-v2-microagents.md` (the problem analysis and initial proposal) through collaborative brainstorming. That doc remains the source of truth for problems, failed approaches, and principles.

---

## Core Principles

Unchanged from the original doc:

- **P1: One agent, one job, small prompt.** Prompts under 15 lines. If longer, split the agent.
- **P2: Read, don't inject.** Prompts say "Read `.verify/app.json`" — agents read files via tool calls.
- **P3: Log everything.** Every `claude -p` call saves prompt, stdout, stderr, timing to disk.
- **P4: Timeout everything.** No unbounded LLM calls. Exit code 124 = timeout, logged explicitly.
- **P5: Skip over retry.** Failures are logged and learned from, not retried within a run.
- **P6: Every failure is user-explainable.** Clear error messages with log file pointers.
- **P7: The learning loop is persistent memory.** `.verify/learnings.md` improves the pipeline across runs.

---

## Pipeline Stages

```
ORCHESTRATOR (TypeScript)
├── init()                       — env checks, config, auth, browse daemon
│
├── Stage 1: AC GENERATOR        (Opus, full tools)
│   └── USER CHECKPOINT          — show ACs, user confirms/edits
│
├── Stage 2: PLANNER             (Opus, full tools)
│   └── PLAN VALIDATOR           — deterministic checks, one targeted retry
│
├── Stage 3: SETUP WRITER        (Sonnet, Prisma-specific, per-group)
│
├── Stage 4: BROWSE AGENTS       (Sonnet, per-AC)
│
├── Stage 5: JUDGE               (Opus)
│
├── Stage 6: LEARNER             (Sonnet)
│
└── report()                     — format and display results
```

### Stage 1: AC Generator (Opus)

**Job:** Read the spec, extract acceptance criteria, group by shared condition, skip untestable ACs.

**Input:** Spec file path. Agent reads the spec, `app.json`, and `learnings.md` via tool calls.

**Output:** `.verify/runs/{run-id}/acs.json`

```json
{
  "groups": [
    {
      "id": "group-a",
      "condition": "Organization must be in trialing state",
      "acs": [
        {"id": "ac1", "description": "Trial alert banner appears on dashboard"},
        {"id": "ac2", "description": "Trial days remaining shows correct count"},
        {"id": "ac3", "description": "Upgrade button links to billing page"}
      ]
    },
    {
      "id": "group-b",
      "condition": null,
      "acs": [
        {"id": "ac5", "description": "Settings page loads without errors"}
      ]
    }
  ],
  "skipped": [
    {"id": "ac4", "reason": "Requires Stripe payment method — external service"}
  ]
}
```

**Grouping rules:**
- ACs that share setup conditions go in the same group.
- ACs with dependencies between them (ac1 creates webhook, ac2 checks it in UI) go in the same group, ordered.
- ACs with no condition go in their own group (pure UI).
- The orchestrator automatically fans out pure-UI ACs with no dependencies into individual groups for maximum parallelism.

**User checkpoint:** After generation, ACs are displayed to the user. The user confirms, gives feedback ("drop ac3, it needs Stripe"), or says "looks good." The pipeline continues with the confirmed ACs.

### Stage 2: Planner (Opus)

**Job:** Given ACs, produce concrete browser steps and URLs for each one.

**This is the most critical stage in the pipeline.** The Planner gets Opus with full tool access. It reads the codebase — component files, route definitions, the code diff — to ground every step in what actually exists. `app.json` and `learnings.md` provide starting context for where to look.

**Input:** `acs.json`, plus tool access to the full codebase.

**Output:** `.verify/runs/{run-id}/plan.json`

```json
{
  "criteria": [
    {
      "id": "ac1",
      "group": "group-a",
      "description": "Trial alert banner appears on dashboard",
      "url": "/environments/clseedenvprod000000000/settings",
      "steps": [
        "Navigate to the settings page",
        "Wait for page load (up to 5s)",
        "Look for alert banner with text containing 'trial'",
        "Take screenshot of the banner"
      ],
      "screenshot_at": ["trial_banner_visible"],
      "timeout_seconds": 90
    }
  ]
}
```

**Plan Validator:** After the Planner outputs the plan, a deterministic check runs:
- URLs contain no template variables (`{envId}`, `{orgId}`, etc.)
- URLs exist in `app.json` routes
- Every AC has non-empty steps
- Timeouts are set and within bounds (60-300s)

If a check fails, the Planner gets **one targeted retry** with the specific error ("URL `/environments/{envId}` contains a template variable — use real IDs from app.json"). If it fails again, the AC is marked as `plan_error` and skipped.

### Stage 3: Setup Writer (Sonnet, Prisma-specific)

**Job:** For each group with a condition, read the ORM schema and write exact SQL to create the required state.

**Runs per-group.** Only for groups where `condition` is not null.

**Input:** The group's condition from `acs.json`. Agent reads `schema.prisma` (or equivalent) via tool calls.

**Output:** `.verify/runs/{run-id}/setup/{group-id}/commands.json`

```json
{
  "group_id": "group-a",
  "condition": "Organization must be in trialing state",
  "setup_commands": [
    "psql --set ON_ERROR_STOP=1 \"$DATABASE_URL\" -c \"UPDATE \\\"Organization\\\" SET billing = jsonb_set(billing, '{subscriptionStatus}', '\\\"trialing\\\"') WHERE id = 'clseedorgprod000000000';\""
  ],
  "teardown_commands": [
    "psql --set ON_ERROR_STOP=1 \"$DATABASE_URL\" -c \"UPDATE \\\"Organization\\\" SET billing = jsonb_set(billing, '{subscriptionStatus}', '\\\"active\\\"') WHERE id = 'clseedorgprod000000000';\""
  ]
}
```

**ORM detection is deterministic:** The orchestrator checks for `prisma/schema.prisma`, `drizzle.config.ts`, etc. and selects the appropriate Setup Writer prompt. Only Prisma + Postgres is supported in v1. Unsupported ORMs → all setup-dependent ACs in that group are marked `setup_unsupported`.

**No retry on SQL failure.** If the SQL fails, all ACs in that group are marked `setup_failed` with the error. The Learner captures what went wrong.

### Stage 4: Browse Agents (Sonnet)

**Job:** Navigate the app, execute the steps from the plan, take screenshots, report what happened. **No verdict** — just evidence.

**Runs per-AC.** Each agent gets one AC's steps.

**Prompt (~20 lines):**

```
You are a browser agent. Execute the steps and record what you see.

AC: {description}
START URL: {baseUrl}{url}
BROWSE BINARY: {browseBin}

STEPS:
{steps}

After each step, run `{browseBin} snapshot -D` to confirm it worked.
Take screenshots at: {screenshotCheckpoints}
Save screenshots to: {evidenceDir}/screenshot-LABEL.png

When done, write {evidenceDir}/result.json:
{
  "ac_id": "{acId}",
  "observed": "what you saw at each step",
  "screenshots": ["screenshot-before.png", "screenshot-after.png"],
  "commands_run": ["goto ...", "click @e3", ...]
}

If the page shows a login screen, write observed: "Auth redirect" and stop.
```

**Execution model:**
- ACs within a group with setup run **sequentially** (shared browser daemon, shared DB state).
- Different groups run **in parallel** (separate browser daemons).
- Pure-UI ACs with no dependencies are fanned out into individual groups by the orchestrator for maximum parallelism.

### Stage 5: Judge (Opus)

**Job:** Review all evidence across all ACs and decide pass/fail for each.

The Judge is the **only** stage that produces verdicts. It sees all `result.json` files and screenshots together, so it can detect patterns (e.g., every screenshot shows a login page = auth failure, not individual AC failures).

**Input:** All `evidence/{ac-id}/result.json` files and screenshots.

**Output:** `.verify/runs/{run-id}/verdicts.json`

```json
{
  "verdicts": [
    {
      "ac_id": "ac1",
      "verdict": "pass",
      "reasoning": "Screenshot shows trial alert banner with correct text"
    },
    {
      "ac_id": "ac2",
      "verdict": "fail",
      "reasoning": "Trial days count shows 0, expected 14 based on setup"
    }
  ]
}
```

### Stage 6: Learner (Sonnet)

**Job:** Read the verdicts, evidence, and timeline. Update `.verify/learnings.md` with app-specific knowledge.

**Runs after every run — including aborted runs.** An auth failure after 15 minutes is worth logging.

**What it captures:**
- App facts (DB env var, auth method, seed data IDs)
- Setup patterns (working SQL from successful setups)
- Known skips (ACs that can never be tested locally)
- Selector tips (what works, what doesn't in this app's UI framework)
- Timing data (average durations by AC type)

**How it updates:** Reads existing `learnings.md` + current run data, writes a merged version. Corrects stale entries (e.g., if a previous run said "DB var is POSTGRES_URL" but this run succeeded with `DATABASE_URL`).

### Report

**Deterministic.** Reads `verdicts.json` and formats results for the user. Shows pass/fail per AC, skipped ACs with reasons, errors with log file pointers. No LLM needed.

---

## Model Assignments

| Stage | Model | Why |
|-------|-------|-----|
| AC Generator | Opus | Judgment: extracting conditions, grouping, deciding what to skip |
| Planner | Opus | Critical path: mapping ACs to code-grounded browser steps |
| Setup Writer | Sonnet | Reads schema files, writes precise SQL |
| Browse Agents | Sonnet | Agentic browser control via tool calls |
| Judge | Opus | Highest-stakes judgment, weighs evidence across all ACs |
| Learner | Sonnet | Quality of learnings impacts every future run |

---

## Technology Decisions

### TypeScript everywhere

The entire pipeline is TypeScript. Every stage benefits from:
- Structured error handling (no `|| true` swallowing errors)
- Native JSON (no `jq` gymnastics)
- Shared `runClaude()` helper with guaranteed logging
- Testable with vitest (unit test prompt building, output parsing, grouping logic without calling Claude)

**Exception:** `install-browse.sh` stays bash (downloading a platform-specific binary).

### Shared `runClaude()` helper

Every LLM call goes through one function:

```typescript
interface RunClaudeOptions {
  prompt: string;
  model: "opus" | "sonnet" | "haiku";
  timeoutMs: number;
  stage: string;
  runDir: string;
  dangerouslySkipPermissions?: boolean;
}

interface RunClaudeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}
```

**Guarantees (every call, no exceptions):**
1. Writes prompt to `{runDir}/logs/{stage}-prompt.txt`
2. Captures stdout to `{runDir}/logs/{stage}-output.txt`
3. Captures stderr to `{runDir}/logs/{stage}-stderr.txt`
4. Appends event to `{runDir}/logs/timeline.jsonl`
5. Enforces timeout — returns `{timedOut: true}`, never hangs
6. Never throws on non-zero exit — caller decides what's a failure

**Default timeouts (by stage role, not model):**

| Role | Default timeout | Rationale |
|------|----------------|-----------|
| Planning stages (AC Generator, Planner) | 120s | LLM reasoning, no browser waits |
| Browse agents | 300s | Browser actions are slow (page loads, animations, network) |
| Judgment (Judge) | 120s | Reasoning over collected evidence |
| Learning (Learner) | 60s | Lightweight merge of learnings |
| Setup Writer | 90s | Schema reading + SQL generation |

Callers can override. `runClaude()` passes `--model` explicitly to `claude -p` so stage-specific model assignments are enforced (e.g., `claude -p --model opus "prompt"`).

---

## Execution Flow

### Parallelism

```
Groups from AC Generator:
  Group A: {condition: "org in trialing state", acs: [ac1, ac2, ac3]}
  Group B: {condition: "webhook exists", acs: [ac4, ac5]}
  Group C: {condition: null, acs: [ac6, ac7, ac8]}

Orchestrator fans out Group C → ac6, ac7, ac8 each get own group.

Execution (5 parallel tracks):
  Group A daemon:     Group B daemon:     ac6 daemon:   ac7 daemon:   ac8 daemon:
    Setup SQL           Setup SQL           ac6 agent     ac7 agent     ac8 agent
    ac1 agent           ac4 agent
    ac2 agent           ac5 agent
    ac3 agent           Teardown
    Teardown

  ──── all agents done ────
  Judge (one Opus call, sees all evidence)
  Learner (one Sonnet call, updates learnings)
  Report
```

- Groups with setup: agents run **sequentially** within the group (shared daemon, shared DB state).
- Groups without setup: each AC gets its own browse daemon and runs in **parallel**.
- Each parallel track gets its own browse daemon instance (separate port, separate cookies).
- Auth cookies are loaded into each daemon at startup.
- **Concurrency cap:** Maximum 5 parallel groups (configurable via `config.json` key `maxParallelGroups`). Remaining groups queue. Prevents resource exhaustion on laptops.

### Circuit Breaker

If any browse agent writes `observed` matching an auth failure pattern, the circuit breaker trips:
1. Orchestrator aborts all running agents (SIGTERM)
2. All pending agents are skipped with reason "auth session expired"
3. User is prompted: "Session expired. Run /verify-setup to re-authenticate."

**Auth failure patterns** (defined once in `types.ts`, consumed by browse agent prompt builder and orchestrator):
- `observed` contains "Auth redirect" or "Auth failure"
- URL redirected to path containing `/login`, `/signin`, `/auth`
- Page text matches: "session expired", "unauthorized", "please log in", "sign in to continue"
- HTTP 401/403 on main page load

Only auth failures trigger the circuit breaker. Other failures (timeout, crash, setup failure) are contained to their AC or group.

### Error Handling

| Error | Behavior | Ask Human? |
|-------|----------|------------|
| Auth redirect | Circuit breaker → abort all | Yes: "Run /verify-setup, press enter to continue or q to quit" |
| Setup SQL fails | Group ACs → `setup_failed` | Yes: "Setup failed for group-a: [error]. Skip these ACs or provide correct table name?" |
| Browse daemon dies | Abort remaining agents | Yes: "Browse daemon crashed. Restart and retry?" |
| Agent timeout | AC → `timeout`, continue | No |
| Agent crash | AC → `error`, continue | No |
| Claude API error | Stage → `error`, logged | Yes: "Claude API returned [code]. Retry?" |
| Plan validator fails | One targeted Planner retry | No (automatic) |

**Principle:** Infrastructure failures the user can fix → ask. AC-level failures → log and continue.

---

## File System Layout

```
pipeline/                            # TypeScript pipeline code
├── src/
│   ├── orchestrator.ts              # entry point, init, execution DAG
│   ├── run-claude.ts                # shared LLM call helper
│   ├── stages/
│   │   ├── ac-generator.ts
│   │   ├── planner.ts
│   │   ├── plan-validator.ts        # deterministic checks
│   │   ├── setup-writer.ts
│   │   ├── browse-agent.ts
│   │   ├── judge.ts
│   │   └── learner.ts
│   ├── prompts/                     # prompt templates per stage
│   └── lib/
│       ├── config.ts                # .verify/config.json loader
│       ├── browse.ts                # daemon management (start, stop, auth)
│       └── types.ts                 # shared interfaces
├── package.json
└── tsconfig.json

.verify/                             # runtime artifacts (gitignored)
├── config.json                      # global config
├── app.json                         # app surface map (from /verify-setup)
├── learnings.md                     # persistent across runs
└── runs/
    └── {timestamp}-{spec-slug}/     # e.g. 2026-03-18-1425-trial-alerts-spec
        ├── acs.json                 # AC Generator output
        ├── plan.json                # Planner output
        ├── setup/{group-id}/
        │   └── commands.json        # Setup Writer output
        ├── evidence/{ac-id}/
        │   ├── result.json          # browse agent observations (no verdict)
        │   └── screenshot-*.png
        ├── verdicts.json            # Judge output (single source of truth)
        ├── logs/
        │   ├── timeline.jsonl       # unified event log
        │   ├── {stage}-prompt.txt
        │   ├── {stage}-output.txt
        │   └── {stage}-stderr.txt
        └── report.json
```

Run ID format: `YYYY-MM-DD-HHMM-{spec-filename-slug}` — generated deterministically by the orchestrator at init.

---

## What Stays from v1

- `install-browse.sh` — bash, downloads browse binary
- SKILL.md conversational structure — spec intake, clarification, plan display, execution
- `code-review.sh` — separate concern, runs independently
- `.verify/config.json` and `.verify/app.json` — global config from `/verify-setup`

## What Gets Removed

- All bash pipeline scripts (`preflight.sh`, `orchestrate.sh`, `agent.sh`, `planner.sh`, `judge.sh`, `report.sh`)
- All bash prompt templates (`scripts/prompts/`)
- `plan-validator.sh` (was silently re-adding `testability` field)
- `setup-researcher.sh` and `setup-judge.sh`
- `verify-run.ts` / `verify-run.js` (TypeScript orchestrator from worktree)
- Playbook system (`write-playbook.sh`, replay mode)
- All retry loops
- MCP engine (v1 legacy) code paths in `agent.sh`

---

## Defensive Checks

These are cheap one-line checks that prevent silent failures in production:

1. **Browse daemon health check.** After starting a daemon, the orchestrator sends a health-check request (e.g., navigate to `about:blank`). If the daemon doesn't respond within 5s, the group is marked `daemon_failed` and its ACs are skipped. Catches port conflicts and startup crashes.

2. **Judge skips on empty evidence.** If zero `evidence/{ac-id}/result.json` files exist (all agents crashed/timed out), the Judge is not invoked. All ACs are reported as `error` with reason "no evidence collected." Prevents the Judge from hallucinating verdicts on empty input.

3. **Learner backup.** Before the Learner overwrites `learnings.md`, the orchestrator copies it to `learnings.md.bak`. If the Learner's output fails a basic sanity check (e.g., empty file, under 10 bytes), the backup is restored. Prevents a single bad run from corrupting persistent memory.

---

## Test Strategy

### Unit tests (vitest, no Claude calls)

- **plan-validator:** template variable detection, URL existence checks, timeout bounds, empty steps
- **group fan-out:** pure-UI ACs split into individual groups, dependency ordering preserved
- **config loader:** env var override precedence (`VERIFY_*` > `config.json`), missing config handling
- **output parsers:** each stage's JSON parsing with valid input, malformed input, empty input
- **circuit breaker:** auth pattern matching against all defined patterns, non-auth errors don't trip
- **run ID generation:** deterministic from timestamp + spec filename slug
- **concurrency cap:** queue behavior when groups exceed `maxParallelGroups`

### Integration tests (mock child_process)

- **runClaude:** verify prompt/stdout/stderr files written to correct paths
- **runClaude:** timeout enforcement returns `{timedOut: true}` without hanging
- **runClaude:** `--model` flag passed correctly for each stage
- **orchestrator:** sequential-within-group ordering (agent N starts after agent N-1 finishes)
- **orchestrator:** parallel-across-groups (groups start concurrently up to cap)
- **browse daemon:** health check passes/fails correctly

### Eval sets (prompt quality, run periodically)

| Stage | Eval scenarios |
|-------|---------------|
| AC Generator | (1) Known spec with 8 ACs → correct grouping by shared condition, (2) Spec with untestable ACs (Stripe, email) → correctly skipped, (3) Spec with dependent ACs → ordered within group |
| Planner | (1) Known app with 5 ACs → all URLs resolve to real routes in app.json, (2) AC requiring seed data → plan references correct IDs, (3) Ambiguous AC → steps are specific enough for a browse agent |
| Judge | (1) All-auth-failure evidence → single "auth expired" verdict (not per-AC failures), (2) Mixed pass/fail evidence → correct per-AC verdicts, (3) Empty observed fields → conservative fail verdicts |
| Setup Writer | (1) Prisma schema + "org in trialing state" → valid SQL targeting correct table/column, (2) Unknown condition → graceful failure |
| Learner | (1) First run (no existing learnings) → creates valid learnings.md, (2) Run with existing learnings → merges without duplicating |

---

## Open Decisions (Revisit If Needed)

1. **Setup Planner / Writer split.** Currently combined into one Sonnet call per group. If setup SQL reliability remains poor, split into Setup Planner (Haiku: decides approach) + Setup Writer (Sonnet: writes SQL). We tried combining them before and it was unreliable — but the Writer is now ORM-specific, which may be enough.

2. **Validator stage.** Dropped in favor of deterministic plan checks. If plan quality is still an issue after the Planner improvements (full tool access, learnings, code reading), add a dedicated validation stage.

3. **Learnings sharing.** Currently `.verify/learnings.md` is gitignored and local-only. For team use, consider committing it or moving to a shared location. Deferred until multi-user support is needed.

4. **Additional ORM support.** Only Prisma + Postgres in v1. Add Drizzle, TypeORM, etc. as Setup Writer variants when needed. ORM detection is deterministic (check for config files).
