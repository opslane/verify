# Self-Serve Onboarding Design

## Goal

Get a new user from "installed the GitHub App" to "saw a real review on a real PR in their repo" in under 5 minutes, with zero manual setup steps.

## Principles

- **No dashboard for setup** — configuration is auto-detected by an agent, not entered by a human
- **Aha moment = first review result** — the payoff is a review comment in GitHub, not a confirmation screen
- **Webhook owns all side effects** — the post-install redirect page is read-only; all writes happen in the verified webhook handler
- **Best-guess defaults, not conversational retry** — auto-detect stores its best guess; if the pipeline fails, the user sees it in the PR comment

---

## Flow

### 1. Installation

User installs the GitHub App via GitHub. GitHub redirects back to `GET /auth/installed?installation_id=<id>`.

### 2. Post-Install Page (read-only)

The `GET /auth/installed` route:
- Looks up the installation from DB (read-only — no writes, no async triggers)
- Renders a confirmation page: "You're all set. Check back here or watch your GitHub repo for the demo PR."
- Links to repo and trigger command docs (`/verify`, `/review`, `@opslane`)

**No side effects on this route.** Installation IDs are sequential integers and this redirect carries no HMAC signature — it cannot be trusted to authorize writes. The webhook is the trusted signal.

### 3. Auto Demo PR (via webhook)

On `installation.created` webhook (HMAC-verified):

**Repo selection:** Use the first entry in `payload.repositories`, or the repo with the most recent push if multiple exist. If the installation covers an entire org with no explicit repo list, skip the demo PR and log a warning.

**Idempotency:** Before any write, check if the branch `opslane/demo` already exists via the GitHub Contents API. If it does, skip creation. Store a `demo_pr_triggered` flag on the `github_installations` row to prevent replay on webhook retries.

**PR creation:**
1. Check if `README.md` exists in the repo root. If yes, add the Opslane badge. If not, create a minimal `README.md`.
2. Create branch `opslane/demo`, commit the change, open a PR titled "Add Opslane badge".
3. If branch protection rules block creation, post an issue comment explaining and link to docs.

This PR triggers the normal `pull_request.opened` webhook path.

### 4. First-Time Config Detection (background task)

On `pull_request.opened`, before kicking off a review, check if `repo_configs` exists for this repo. If not:

- Dispatch a `detect-repo-config` Trigger.dev background task immediately (do not block the webhook handler — it must return 202 within the GitHub timeout window)
- The background task runs `claude -p` with a prompt that reads key repo files via GitHub API:
  - `package.json` / `pyproject.toml` / `Cargo.toml`
  - `docker-compose.yml` / `compose.yaml`
  - `Makefile`
  - `.env.example`
- Agent outputs best-guess JSON matching `repo_configs` schema — no confidence tiers, just the best answer with sensible defaults (port 3000, `npm run dev`, health path `/`)
- Store the result in `repo_configs`
- If the pipeline fails because config was wrong, the PR comment will show the error — the user can comment `/config` (future) or contact support

**`repo_configs.status` column:** Add `status TEXT NOT NULL DEFAULT 'ready'` with values `pending | ready | failed`. The review pipeline checks this before running — if `pending`, post a "detection in progress" comment and exit; if `failed`, post a config help comment.

### 5. Review Runs

Normal pipeline runs on the demo PR. User sees results in the PR comment within ~60 seconds of installation.

---

## Reviews Table

Track every review triggered for admin visibility and future user dashboards.

```sql
CREATE TABLE reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL REFERENCES github_installations(installation_id),
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  pr_title        TEXT,
  trigger         TEXT NOT NULL CHECK (trigger IN (
                    'pull_request.opened',
                    'pull_request.synchronize',
                    'issue_comment.verify',
                    'issue_comment.mention',
                    'demo'
                  )),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error')),
  result          JSONB,                  -- judge output: { passed, failed, criteria }
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query pattern: look up reviews for a PR
CREATE INDEX idx_reviews_pr ON reviews (repo_owner, repo_name, pr_number);
-- Admin view: sort by recency
CREATE INDEX idx_reviews_started ON reviews (started_at DESC);
```

Notes:
- UUID for consistency with all other tables
- `trigger` and `status` are CHECK-constrained to prevent typos and enable clean queries
- No compound unique on PR + timestamp — uniqueness is handled by UUID; PR can have multiple review runs
- `updated_at` lets you track status transitions for debugging

---

## Schema Changes to `repo_configs`

Add a `status` column to coordinate between auto-detection and the review pipeline:

```sql
ALTER TABLE repo_configs ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
  CHECK (status IN ('pending', 'ready', 'failed'));
```

Add a `demo_pr_triggered` flag to `github_installations` for idempotency:

```sql
ALTER TABLE github_installations ADD COLUMN demo_pr_triggered BOOLEAN NOT NULL DEFAULT FALSE;
```

---

## Work Required

1. **DB migrations** — `reviews` table, `repo_configs.status` column, `github_installations.demo_pr_triggered` flag
2. **`GET /auth/installed` route + page** — read-only confirmation page; no side effects
3. **Auto-detect Trigger.dev task** — `detect-repo-config` task: reads repo files via GitHub API, outputs best-guess `repo_configs` JSON, stores with `status = 'ready'`
4. **First-run check + dispatch in webhook handler** — on `pull_request.opened`, if no `repo_configs`: dispatch `detect-repo-config`, set `status = 'pending'`; review pipeline checks status before running
5. **Demo PR creation** — in `installation.created` webhook handler: idempotency check, README detection, branch + commit + PR via GitHub API
6. **GitHub App config** — set Post-installation URL to `https://<domain>/auth/installed`

## Out of Scope (v1)

- Web-based config editor / dashboard (build when users report auto-detect failures)
- Conversational config retry via PR comments (v2 after seeing auto-detect accuracy data)
- Admin observability dashboard (use `SELECT * FROM reviews` directly for now)
- LangFuse or LLM tracing
- Rate limiting on demo PR creation
