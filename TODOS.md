# TODOS

Deferred work captured from plan reviews. Each item includes enough context to pick up in 3 months.

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

## P2 — Multi-ORM Setup Writer support

**What:** Add Setup Writer prompt variants for Drizzle, TypeORM, and raw SQL (no ORM) so setup-dependent ACs work beyond Prisma + Postgres.

**Why:** v2 pipeline only supports Prisma + Postgres for setup SQL generation. Users with Drizzle or TypeORM will see all setup-dependent ACs marked as `setup_unsupported` with no way to fix it. This silently reduces pipeline coverage for non-Prisma projects.

**Context:** ORM detection is deterministic in the orchestrator — check for `prisma/schema.prisma`, `drizzle.config.ts`, `ormconfig.ts`, etc. Each ORM variant needs: (1) a stage prompt that reads the ORM's schema format, (2) SQL generation tuned to that ORM's conventions (e.g., Drizzle uses camelCase columns, Prisma uses PascalCase tables). The `setup-writer.ts` stage already accepts `ormType` — adding a variant means a new prompt template + schema file path.

**Depends on:** Pipeline v2 shipping first.

**Effort:** M human → S with CC+gstack

---

## P2 — Migrate eval sets to v2 stage boundaries

**What:** Create v2-compatible eval cases for each LLM stage (AC Generator, Planner, Setup Writer, Browse Agent, Judge, Learner), informed by but not constrained by `docs/evals/eval-set-v1.json`.

**Why:** eval-set-v1.json assumes combined AC extraction + plan generation in a single planner call. v2 splits this into two stages with different inputs and outputs. The old eval set won't work with the new stage interfaces, and attempting to port it 1:1 would miss the new stage boundaries (e.g., AC grouping logic, plan validator checks).

**Context:** For each stage, define 2-3 eval scenarios: known input → expected output shape + key assertions. Priority stages: (1) Planner — most failure-prone in v1, (2) Judge — highest-stakes verdicts, (3) AC Generator — grouping logic is new. Setup Writer and Learner are lower priority (deterministic checks catch most issues).

**Depends on:** Pipeline v2 shipping first. Eval infrastructure (how to run evals) should be decided during implementation.

**Effort:** M human → S with CC+gstack
