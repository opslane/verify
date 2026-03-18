# Eval Loop Design — Autoresearch-Inspired Verification Improvement

**Date:** 2026-03-16
**Status:** Design complete (post-review v2)

## Problem

When we run verify against merged PRs (which should be clean), we get two kinds of failures:
1. **Real bugs** — actual defects in the merged PR that slipped through human review
2. **Pipeline noise** — flakiness in our planner/agent/judge pipeline

These look identical from the judge's perspective (a failed AC) but mean opposite things. We need to distinguish them automatically, and use the data to improve the pipeline over time.

## Inspiration: Karpathy's autoresearch

The core loop: `modify → run (fixed budget) → measure → keep/discard → repeat forever`

Applied to verify:
- **What gets modified:** prompt templates (planner.txt, agent-browse.txt, judge-browse.txt)
- **What gets measured:** % of ACs correctly classified against frozen ground truth
- **Keep/discard:** if a prompt change improves the score, commit it; if not, revert

## Architecture

### Five repos, 20 PRs each = 100 eval items

| Repo | Stars | Stack | Port |
|------|-------|-------|------|
| cal.com | 40K | Next.js + Tailwind | 3001 |
| formbricks | 12K | Next.js + Tailwind | 3002 |
| documenso | 12K | Next.js + Tailwind | 3003 |
| dub | 23K | Next.js + Tailwind + Prisma | 3004 |
| karakeep | 24K | Next.js + Tailwind + Drizzle | 3005 |

PR selection mix per repo:
- ~12 medium complexity (multi-component, forms, tables)
- ~5 high complexity (multi-page flows, state management)
- ~3 with known bugs (followed by fix PRs)

**v1 scope:** Start with 20 PRs across cal.com + formbricks (already set up). Scale to 100 after the framework is validated.

### Calibration run — how ground truth is established

The planner generates ACs dynamically from specs, so we can't pre-label per-AC expected outcomes. Ground truth is established through a calibration process:

1. **First run (calibration):** Run the full pipeline. This produces ACs and verdicts but is **not scored**.
2. **Human labeling:** Review each AC's evidence. Label each as `expected_pass`, `expected_fail` (real bug found), or `expected_skip`. For bug-shipped PRs, check whether the pipeline found the actual bug that the follow-up PR later fixed.
3. **Freeze labels:** Commit the labeled ground truth alongside the spec. This becomes the scoring baseline.
4. **Subsequent runs (scored):** Compare pipeline output against frozen labels. Compute score as `% ACs matching expected label`.

If a prompt change causes the planner to generate *different* ACs, the new ACs are compared against the frozen spec expectations (not the old AC list). This is why ground truth is tied to the spec, not to specific AC IDs.

### Bug-shipped PRs — expected verdicts

The 15 bug-shipped PRs have `expected_verdict: "mixed"` in the eval set. After calibration:
- ACs that test the *bug-fixed behavior* should be labeled `expected_fail` (verify should catch the bug)
- ACs that test *other behavior in the same PR* should be labeled `expected_pass`

This prevents the score function from rewarding a pipeline that always says "pass."

### Execution model

Parallelism across repos, sequential within. Max `MAX_PARALLEL` repos at once (default 2, configurable):

```
Repo A (port 3001)          Repo B (port 3002)
  PR-1: worktree → eval       PR-1: worktree → eval
  PR-2: worktree → eval       PR-2: worktree → eval
  ...sequential                ...sequential
```

Per-PR flow:
1. `git worktree add /tmp/eval-<repo>-pr-<N> <merge-commit>`
2. `pnpm install --frozen-lockfile` (always — symlinking unreliable in monorepos)
3. Create fresh DB: `createdb eval_<repo>_pr_<N>` + run migrations
4. Start dev server pointing at worktree with `DATABASE_URL` overridden
5. Run full verify pipeline with `VERIFY_BASE_URL=http://localhost:<port>`
6. Collect artifacts (copy `.verify/` to archive)
7. Drop DB: `dropdb eval_<repo>_pr_<N>`
8. `git worktree remove`

**DB isolation:** Fresh database per eval item. No snapshot/restore complexity. `createdb` + migrations takes seconds. This eliminates schema mismatch errors that would otherwise appear as pipeline flakiness.

**Resume/idempotency:** Before running an eval item, check if `evals/runs/<eval_id>/<run_id>/summary.json` exists. If it does, skip. This allows resuming after a crash at PR 47 without re-running 1-46.

### Artifact directory (per eval run)

Copy `.verify/` as-is after each run — no re-organization:

```
evals/runs/                          ← gitignored
  eval-001/
    2026-03-16T14-30-00Z/
      .verify/                       ← direct copy of pipeline output
        config.json
        plan.json
        evidence/
          ac1/
            result.json
            agent.log
            screenshot-*.png
            session.webm
          ac2/
            ...
        report.json
      spec.md                        ← input spec
      diff.patch                     ← code diff fed to planner
      summary.json                   ← score, timing, prompt version
```

### Results index

```
evals/results.jsonl   ← append-only, one JSON per line, gitignored
```

```json
{
  "eval_id": "eval-001",
  "run_id": "2026-03-16T14-30-00Z",
  "prompt_version": "a1b2c3d",
  "score": 0.5,
  "duration_seconds": 187
}
```

`prompt_version` captured via `git rev-parse --short HEAD` at run time. `artifact_dir` is derivable from `eval_id` + `run_id`.

### Failure classification — 3 categories (v1)

The judge outputs a `failure_class` for each failed AC:

| Category | Meaning | Actionable |
|----------|---------|------------|
| `app_bug` | Real defect in the PR | File it, use as case study |
| `pipeline_noise` | Pipeline misfired (bad plan, bad execution, bad judgment, flaky browser) | Investigate, fix prompts or infra |
| `insufficient_evidence` | Agent crashed, timed out, or evidence too thin to judge | Retry or investigate agent reliability |

Classification signals for the judge:

| Signal | Class |
|--------|-------|
| Agent evidence clearly shows a UI defect that matches the spec | `app_bug` |
| Login redirect / blank page / timeout with <2 steps | `pipeline_noise` |
| Agent completed steps but tested the wrong thing | `pipeline_noise` |
| Agent completed steps, evidence clear, but verdict seems wrong | `pipeline_noise` |
| Agent crashed or result.json missing/malformed | `insufficient_evidence` |

When we accumulate 50+ `pipeline_noise` results, we can split into `bad_plan` / `bad_execution` / `bad_judgment` subcategories. Not worth the complexity before then.

### Judge prompt upgrade

Add `failure_class` and `confidence` to the existing judge output schema (additive — keep all existing fields):

```json
{
  "ac_id": "ac1",
  "status": "fail",
  "confidence": "high",
  "failure_class": "app_bug",
  "reasoning": "Button renders but onClick handler doesn't fire — form submits empty payload",
  "evidence": "screenshot-after.png",
  "agent_claimed": "fail",
  "judge_override": false
}
```

When all ACs pass, `failure_class` is omitted. The judge only classifies failures.

**Post-mortem on failures:** When the judge reports failures, `judge.sh` makes a second `claude -p` call with the full evidence + the judge's own verdict, asking specifically for failure attribution. This runs inside `judge.sh` (not a separate script) but uses a separate prompt (`scripts/prompts/failure-classify.txt`) so we can iterate on classification independently of judging.

### The improvement loop

```
1. Run eval set (full pipeline) → artifacts + results.jsonl
2. Human reviews failures, reads evidence
3. Human edits prompts targeting highest-frequency failure patterns
4. Re-run eval set with new prompts
5. Compare score to previous run
6. If improved → commit prompt changes
   If not → revert
7. GOTO 1
```

This is a human-driven loop for now. The scripts automate the run + score + track steps. The human does analysis + prompt editing.

## Eval set v2 — completed

`docs/evals/eval-set-v2.json` — 100 PRs across 5 repos:

| Repo | Total | Bug-shipped | High | Medium |
|------|-------|-------------|------|--------|
| cal.com | 20 | 3 (#27922, #27594, #26292) | 5 | 12 |
| formbricks | 20 | 3 (#7435, #6997, #6996) | 5 | 12 |
| documenso | 20 | 3 (#2538, #2387, #2411) | 8 | 9 |
| dub | 20 | 3 (#3517, #3546, #3562) | 5 | 12 |
| karakeep | 20 | 3 (#2312, #2444, #2559) | 5 | 12 |

15 bug-shipped PRs have `follow_up_prs` references and `expected_verdict: "mixed"`.

## What to build

1. **`scripts/eval-runner.sh`** — runs one eval item end-to-end (worktree, DB, pipeline, artifact collection). Supports `--skip-existing` for resume.
2. **`scripts/eval-loop.sh`** — orchestrates across repos, supports `--repo`, `--limit`, `MAX_PARALLEL`. Writes results.jsonl.
3. **Judge prompt upgrade** — add `confidence` + `failure_class` fields to `scripts/prompts/judge-browse.txt`
4. **`scripts/prompts/failure-classify.txt`** — failure attribution prompt, called from within `judge.sh` on failures
5. **Spec generation** — batch-generate spec.md for the initial 20 PRs (cal.com + formbricks), human reviews, freeze

## Not building yet

- Automatic prompt mutation (human-driven loop for now)
- E2B sandbox execution (local worktrees first)
- Retry logic for `pipeline_noise` classifications
- Per-project knowledge files (app-specific patterns)
- Sub-categories for `pipeline_noise` (need 50+ examples first)
- Full 100-PR runs (validate framework on 20 first)
