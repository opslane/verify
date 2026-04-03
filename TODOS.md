# TODOS

Deferred work captured from plan reviews. Each item includes enough context to pick up in 3 months.

---

## P1 — Upstream: gstack browse stop hangs ~30s

**What:** `browse stop` and `browse restart` hang for ~30 seconds when the daemon won't shut down cleanly, then time out. This causes orphaned daemon accumulation.

**Why:** This is the root cause of the ETIMEDOUT errors in verify-login. The verify pipeline works around it by not calling stop/restart, but the underlying browse bug remains. Orphaned daemons accumulate over time and compete for the port.

**Context:** Reproduced consistently: `time ~/.cache/verify/gstack/browse/dist/browse stop` → 31s, exit 1, "The operation timed out". This happens when multiple browse daemons are running (common when multiple Claude sessions use browse). The `startDaemon` function in `browse.ts` also calls `stop` and is affected. File upstream on gstack.

**Depends on:** Nothing — this is an upstream gstack issue.

**Effort:** XS human (file issue) → XS with CC+gstack

---

## P2 — Demo PR auto-close

**What:** After a user's first real (non-demo) PR gets a successful review, automatically close the `opslane/demo` PR with a note.

**Why:** Keeps user repos clean. A lingering open demo PR looks unprofessional and may confuse new contributors.

**Context:** The `reviews` table (added in migration 004) tracks every review run. The `demo_pr_triggered` flag and `trigger_event = 'demo'` in the reviews table gives you the data you need. Trigger: first review with `status = 'passed'` and `trigger_event != 'demo'` for a repo that has `demo_pr_triggered = true`. Use `GitHubAppService` + GitHub Issues API (`PATCH /repos/{owner}/{repo}/pulls/{pull_number}` with `state: 'closed'`).

**Depends on:** Task 1 (reviews table, demo_pr_triggered column) — must be shipped first.

**Effort:** M human → S with CC+gstack

---

## P2 — /config command for ongoing config edits

**What:** Allow users to run `/config` on any PR at any time (not just as a reply to the failure/confirmation comment) to update their `repo_configs`.

**Why:** v1 only supports config correction on failure or first detection. Users who want to proactively change settings (different port for a PR branch, update after refactor) have no self-serve path.

**Context:** The `/config` command parsing infrastructure will exist after Task 6b ships. This TODO is about making it available on any PR, not just the first-run or failure path. Implementation: remove the gate that restricts `/config` to the failure-path context.

**Depends on:** Task 6b (/config command implementation).

**Data to gather first:** See how often auto-detection is wrong post-launch (2-4 weeks). If <5% of installs trigger a /config, the full always-on command may not be worth the complexity.

**Effort:** S human → XS with CC+gstack

---

## P3 — org_id-based ownership check on POST /auth/installed

**What:** Strengthen the POST /auth/installed authorization to also accept users whose `org_id` in the `users` table matches the `org_id` stored on the `github_installations` row.

**Why:** v1 uses `sender_login` match only. Users who joined an existing org installation (installed by a colleague) won't match on `sender_login` and won't be able to trigger the demo PR from the post-install page.

**Context:** `github_installations.org_id` references `orgs.id`. `users.org_id` references `orgs.id`. The check is: `SELECT 1 FROM users WHERE github_login = $session_user AND org_id = (SELECT org_id FROM github_installations WHERE installation_id = $id AND org_id IS NOT NULL)`. Add this as a fallback after the `sender_login` check in `POST /auth/installed`.

**Depends on:** Task 3 (POST /auth/installed).

**Effort:** S human → XS with CC+gstack

---

## P3 — Rate limiting on /auth/status and POST /auth/installed

**What:** Add per-IP or per-session rate limits on `GET /auth/status` (the polling endpoint) and `POST /auth/installed` (the demo PR trigger).

**Why:** `GET /auth/status` has no rate limit — a client could hammer it thousands of times, generating unnecessary DB load. `POST /auth/installed` has no rate limit — a user can submit multiple demo PR requests rapidly (idempotency via `claimDemoPrSlot` prevents duplicate PRs, but the extra requests still hit the server and fire-and-forget promises).

**Context:** At launch scale this is not urgent — `claimDemoPrSlot` already prevents the worst outcome (duplicate PRs). Rate limiting becomes relevant when the product gets wider adoption. Implementation: use a simple in-process sliding window (e.g., `hono-rate-limiter` or a lightweight Map-based counter) keyed on IP or installation_id. For `GET /auth/status`, 30 req/min per IP is reasonable. For `POST /auth/installed`, 5 req/min per installation_id.

**Depends on:** Task 3 (POST /auth/installed, GET /auth/status) — must be shipped first.

**Effort:** S human → XS with CC+gstack

---

## P2 — Auto-extract seed credentials during index-app

**What:** During `index-app`, scan seed files for email/password pairs and store them in `app.json` as `seed_accounts`. `/verify-setup` could then offer these as defaults instead of asking the user.

**Why:** Currently users manually provide credentials during `/verify-setup`. Most apps with seed data already have test accounts defined in their seed files (e.g., `prisma.user.create({ data: { email: 'admin@example.com', password: 'test123' } })`). Auto-extraction would make setup nearly zero-input.

**Context:** `seed-extractor.ts` already scans seed files for IDs (CUIDs/UUIDs). Extending it to capture email+password pairs near `user.create`/`user.upsert` calls would follow the same pattern. Passwords in seed files are usually plaintext (pre-hashing). Store as `AppIndex.seed_accounts: Array<{email: string, password: string, role?: string}>`. The setup skill would read these and pre-fill the credential prompt.

**Depends on:** Login recipe auth plan (docs/plans/2026-03-20-login-recipe-auth.md) must ship first.

**Effort:** S human → XS with CC+gstack

---

## ~~P2 — Multi-ORM Setup Writer support~~ SUPERSEDED

> Removed: v1 removes setup-writer entirely. If setup-writer is re-added in v2, this TODO becomes relevant again.

---

## P2 — Create eval cases for v1 stages (AC Extractor + Executor)

**What:** Create eval cases for the 2 LLM stages in the v1 pipeline: AC Extractor and Executor. 2-3 golden input/output pairs per stage.

**Why:** The v1 pipeline has only 2 LLM stages (down from 6). Eval coverage is simpler but still needed to catch prompt regressions. The spikes will produce initial eval data, but structured eval cases should be formalized.

**Context:** AC Extractor eval: known spec → expected AC structure (correct will_verify/out_of_scope classification, correct field extraction). Executor eval: known AC + evidence dir → expected verdict (pass/fail/blocked matches human judgment). Use spike results from Documenso as the first eval cases. Existing eval infrastructure in `pipeline/evals/` was deleted on this branch — build fresh with vitest.

**Depends on:** v1 pipeline shipping first + spike results.

**Effort:** S human → XS with CC+gstack

---

## ~~P3 — Multi-condition entity graph merging~~ SUPERSEDED

> Removed: v1 removes setup-writer and graph-setup entirely. If setup-writer is re-added in v2, this TODO becomes relevant again.

---

## P2 — Optional Judge stage for executor accuracy

**What:** If executor self-judgment accuracy is <85% after 5 real runs, re-add a separate judge stage that reviews evidence independently from the executor.

**Why:** v1 merges navigation + interaction + judgment into a single executor LLM call. This is simpler but the prompt is doing a lot. A separate judge looking only at screenshots + step traces vs AC descriptions can catch false passes and false fails that the executor (which is also navigating) might miss.

**Context:** The original pipeline had a separate judge stage at `stages/judge.ts` (41 LOC) + `prompts/judge.txt`. The judge received evidence paths and AC descriptions, then emitted verdicts. Re-adding it means: (1) keep executor verdicts as "first-pass", (2) run judge on evidence for ACs where executor said pass/fail, (3) use judge verdict as final. Config flag: `config.useJudge: boolean`. Measure accuracy by human review of evidence vs verdict on 5 real spec runs.

**Depends on:** v1 pipeline shipping first + 5 real test runs to measure accuracy.

**Effort:** S human → XS with CC+gstack

---

## P2 — Conditional parallelism for independent ACs

**What:** After v1 proves sequential execution works, add back optional parallel execution for ACs that don't share page state or navigation context.

**Why:** 10+ ACs running sequentially at ~25s each = 4+ minutes. Parallel execution for independent ACs (e.g., checking text on different pages) could cut runtime to ~1-2 minutes. The current pipeline already has parallel execution infrastructure (per-group browse daemons).

**Context:** The v1 pipeline runs all ACs sequentially in one browser session. To add parallelism: (1) classify ACs as "independent" (different pages, no shared state) vs "dependent" (same page, sequential interaction), (2) run independent groups in parallel with separate browse daemons, (3) run dependent ACs sequentially within each group. Reuse existing `startGroupDaemon`/`stopGroupDaemon` from `lib/browse.ts`.

**Depends on:** v1 stability proven over 10+ real runs.

**Effort:** M human → S with CC+gstack

---

## P3 — CI mode with GitHub comment reporting

**What:** Add a `--ci` flag to the pipeline CLI that outputs JSON results and posts a GitHub PR comment with the verdict summary and evidence links.

**Why:** The research doc explicitly defers CI-first workflow, but it's the natural next step after local verification works. The server/src/verify/ code already has PR comment posting (`comment.ts`) and spec discovery from PR descriptions (`spec-discovery.ts`) that can be adapted.

**Context:** The server pipeline (`server/src/verify/pipeline.ts`) already runs a similar flow in E2B sandboxes with PR webhook triggers. The local pipeline could add: (1) `--ci` flag that skips interactive prompts, (2) JSON output to stdout, (3) optional `--pr owner/repo#123` flag that posts a comment using `gh api`. This bridges the local and remote verify paths.

**Depends on:** v1 local pipeline shipping first.

**Effort:** M human → S with CC+gstack
