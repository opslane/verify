# /verify-eval Skill Design

> Automated eval runner inspired by Karpathy's autoresearch. Runs the full `/verify` pipeline against real merged PRs to discover failure modes at scale.

## Goal

Run ~20 PRs per eval repo (3 repos initially, scaling to 5-6), collect pass/fail results, and auto-classify failures as **real** (PR doesn't satisfy AC) vs **pipeline** (our tooling broke). Build a failure mode distribution to prioritize pipeline hardening.

## Prerequisites

- Target repo is already forked, cloned, and set up locally
- `.verify/config.json` exists with `baseUrl`, `repo`, and `healthCheck` fields
- App indexed (`/verify-setup` already run)
- Auth set up if app requires login
- Dev server running

## Skill Interface

```
/verify-eval                  # run all unprocessed PRs in a loop
/verify-eval 28011            # run one specific PR (for debugging)
```

## Config Extension

`.verify/config.json` adds two fields:

```json
{
  "baseUrl": "http://localhost:3000",
  "repo": "calcom/cal.com",
  "healthCheck": {
    "readyUrl": "http://localhost:3000",
    "readyTimeout": 120000,
    "pollInterval": 3000
  },
  "auth": { "..." : "existing auth config" }
}
```

- `repo` — GitHub `owner/repo` used for `gh` commands
- `healthCheck.readyUrl` — URL to poll with curl (200 = healthy)
- `healthCheck.readyTimeout` — max ms to wait before marking health check failed
- `healthCheck.pollInterval` — ms between curl polls

## Flow: Single PR

```
┌─────────────────────────────────────────────────────┐
│                   /verify-eval                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. Load config + results file                      │
│  2. Discover or select PR                           │
│  3. gh pr checkout <number>                         │
│  4. Health check (poll readyUrl)                    │
│     ├─ FAIL → log failure_stage: health_check       │
│     │         git checkout main, continue loop      │
│     └─ PASS ↓                                       │
│  5. Extract spec from PR description                │
│     gh pr view <number> --json body -q .body        │
│  6. Write spec to .verify/spec.md                   │
│  7. Run pipeline:                                   │
│     npx tsx pipeline/src/cli.ts run                  │
│       --spec .verify/spec.md                        │
│       --verify-dir .verify                          │
│  8. Read verdicts from .verify/runs/*/verdicts.json │
│  9. Introspection: classify any failed ACs          │
│ 10. Append JSONL entry to results file              │
│ 11. git checkout main                               │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Flow: Batch Loop

```
load config
load processed PRs from results file
discover unprocessed PRs via gh

for each PR:
  run single PR flow (above)
  print running tally
  if 3 consecutive auth_expired → stop loop, suggest /verify-setup

print final summary
```

## PR Discovery

1. Read `docs/evals/<repo-id>/eval-results.jsonl` to get already-processed PR numbers
2. Query: `gh pr list --repo <owner/repo> --state merged --limit 50 --json number,title,url,body,files`
3. Filter to PRs touching frontend files (`.tsx`, `.jsx`, `.css`, `.scss`)
4. Exclude already-processed PRs
5. Pick PRs in order (oldest first)

If no unprocessed PRs remain, print "All discovered PRs processed" with final tally.

## Results File

**Location:** `docs/evals/<repo-id>/eval-results.jsonl`

Each line is one PR run:

```json
{
  "pr": 28011,
  "title": "fix: inconsistent hover width on Settings nav",
  "url": "https://github.com/calcom/cal.com/pull/28011",
  "timestamp": "2026-03-23T14:30:00Z",
  "health_check": "pass",
  "pipeline_exit": 0,
  "duration_ms": 45000,
  "spec_source": "pr_description",
  "spec_length": 342,
  "verdicts": [
    {"ac_id": "ac1", "verdict": "pass", "confidence": "high", "reasoning": "..."},
    {"ac_id": "ac2", "verdict": "fail", "confidence": "medium", "reasoning": "..."}
  ],
  "introspection": [
    {
      "ac_id": "ac2",
      "classification": "pipeline",
      "confidence": "high",
      "failed_stage": "browse_agent",
      "root_cause": "nav_timeout",
      "detail": "Browse agent timed out waiting for modal after clicking Send. Element behind loading spinner.",
      "suggested_fix": "Add wait-for-visible before interacting with modal content"
    }
  ],
  "failure_stage": null,
  "failure_reason": null
}
```

**Field notes:**
- `health_check`: `"pass"` or `"fail"` — if fail, `verdicts` and `introspection` are empty
- `failure_stage` / `failure_reason`: set when the pipeline itself errors out (non-zero exit, crash) before producing verdicts
- `introspection`: only populated for ACs with non-pass verdicts

## Introspection Step

After the pipeline completes, for each failed AC:

1. Read the evidence: screenshots, browse logs, `result.json`, `verdicts.json` reasoning
2. Read the PR diff: `gh pr diff <number>`
3. Call Claude to classify:

**Classification values:**
- `real` — the PR genuinely doesn't satisfy this AC
- `pipeline` — our pipeline caused the failure

**For `pipeline` failures, root cause by stage:**

| `failed_stage` | Common `root_cause` values |
|---|---|
| `ac_generator` | `ambiguous_ac`, `missed_ac`, `hallucinated_ac` |
| `planner` | `wrong_url`, `wrong_element`, `missing_precondition` |
| `setup_writer` | `sql_error`, `missing_data`, `wrong_table` |
| `browse_agent` | `nav_timeout`, `element_not_found`, `auth_redirect`, `wrong_page` |
| `judge` | `misread_evidence`, `too_strict`, `too_lenient` |

**Confidence values:** `high`, `medium`, `low` — written to the file, no human review gate.

## Terminal Output

After each PR:

```
PR #28011: fix: inconsistent hover width on Settings nav
  ✓ ac1: pass
  ✗ ac2: fail [pipeline/browse_agent: nav_timeout]
Progress: 8/20 — 5 pass, 2 fail, 1 error
```

After full batch:

```
══════════════════════════════════════════
calcom eval complete: 20/20 PRs processed
══════════════════════════════════════════

Verdicts:
  pass: 31   fail: 14   error: 3   skipped: 2

Failure classification:
  real:     6
  pipeline: 8

Pipeline failures by stage:
  browse_agent:  4  (nav_timeout: 2, element_not_found: 1, auth_redirect: 1)
  planner:       2  (wrong_url: 1, wrong_element: 1)
  setup_writer:  1  (sql_error: 1)
  judge:         1  (misread_evidence: 1)

Results: docs/evals/calcom/eval-results.jsonl
```

## Early Stop Conditions

- **3 consecutive `auth_expired`** → stop loop, print "Auth cookies expired — re-run /verify-setup"
- **3 consecutive `health_check` failures** → stop loop, print "Dev server unresponsive — check server"
- User interrupt (Ctrl+C) → write partial results, print tally so far

## What This Skill Does NOT Do

- Start/stop the dev server (assumes running)
- Run `/verify-setup` (assumes already done)
- Fork or clone repos (assumes already set up)
- Modify the target repo's code
- Run the clarification loop from `/verify` (specs are used as-is from PR description)

## Existing Code Reuse

| Component | Reuse |
|---|---|
| `pipeline/src/cli.ts run` | Invoke directly — full pipeline |
| `.verify/config.json` schema | Extend with `repo` and `healthCheck` |
| `verdicts.json` format | Read as-is |
| `report.json` format | Read `total_duration_ms` from it |
| `runPreflight()` in orchestrator | Runs inside pipeline — we add external health check as a gate before |
