# Remote Verify Pipeline — Design

## Problem

The verify CLI pipeline (spec → planner → browser agents → judge → report) only runs locally today. A developer needs a running dev server, local auth setup, and manual invocation. We want this to run automatically when a PR is opened — spinning up the target app in a cloud sandbox, running browser-based acceptance testing against it, and posting results as a PR comment.

## Architecture

```
PR webhook
  → Server receives pull_request event
  → Spec discovery (plan file in PR → PR body → code-review only)
  → Fetch repo config from DB (startup cmd, port, creds, env vars)
  → Spin up E2B sandbox
  → Setup: install infra, deps, start app
  → Run verify pipeline (planner → browser agents → judge)
  → Post PR comment with results
  → Destroy sandbox
```

Two modes:
- **Full verification** — spec found, app running, browser agents test each AC
- **Code review only** — no spec found, Claude reviews the diff (existing behavior)

## Spec Discovery

Checked in order:

1. **Plan file in the PR** — fetch changed files from GitHub API, look for added/modified `docs/plans/*.md`. If multiple, use the one from the latest commit.
2. **PR body** — scan description for acceptance criteria (bullet points, checkboxes, "should" statements). Linked Linear/Jira ticket fetching deferred to v2.
3. **Fallback** — no spec found. Run code-review only. PR comment notes: "No spec found — add a plan file to `docs/plans/` for full acceptance testing."

## Repo Configuration

### Setup flow (one-time per repo)

1. User signs in via GitHub OAuth (existing)
2. User installs GitHub App (existing)
3. User lands on repo config page in the dashboard
4. User fills out config form (startup command, port, etc.)
5. Save — stored in DB, used for every PR

Auto-detection via Claude (cloning the repo and analyzing it to pre-fill the form) is deferred to v2. See `docs/plans/2026-03-12-remote-verify-v2-backlog.md`.

### User-editable config fields

- **Startup command** — what launches the app (required)
- **Port** — which port the browser targets (required)
- **Install command** — e.g. `pnpm install` (optional, default: auto-detect from lockfile)
- **Pre-start script** — migrations, seeding, etc. (optional)
- **Health path** — endpoint to poll for readiness, e.g. `/api/health` (optional, default: `/`)
- **Test credentials** — email + password for login (optional, encrypted)
- **Env vars** — key-value pairs injected into `.env` (optional, encrypted)
- **Infra services** — checkboxes for what the app needs beyond Postgres+Redis (optional, e.g. MinIO, mail server)

### Encryption strategy

Secrets (test credentials, env var values) are encrypted at the application level before writing to the database.

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key**: single `ENCRYPTION_KEY` env var (hex-encoded 32-byte key) on the server
- **Helpers**: `encrypt(plaintext): string` / `decrypt(ciphertext): string` in a `server/src/crypto.ts` module
- **Storage**: encrypted columns store `iv:ciphertext:authTag` as a single string
- **Key rotation**: out of scope for v1 (single key, manual rotation by re-encrypting)

### Database schema

```sql
CREATE TABLE repo_configs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id   integer REFERENCES github_installations(installation_id),
  owner             text NOT NULL,
  repo              text NOT NULL,
  startup_command   text NOT NULL,
  port              integer NOT NULL DEFAULT 3000,
  install_command   text,
  pre_start_script  text,
  health_path       text DEFAULT '/',
  test_email        text,          -- encrypted via AES-256-GCM
  test_password     text,          -- encrypted via AES-256-GCM
  env_vars          jsonb,         -- values encrypted via AES-256-GCM
  detected_infra    jsonb,         -- e.g. ["postgres", "redis", "minio"]
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (owner, repo)
);
```

No `opslane.verify.yml` for v1. Everything lives in the dashboard. Config-as-code can be added later as an optional override.

## E2B Sandbox

### Template (baked in)

Pre-installed and started by entrypoint.sh:
- **Postgres 16** (with pgvector extension) — covers most apps
- **Redis/Valkey** — common cache/queue dependency
- **Node.js 22**, pnpm, yarn, bun, tsx
- **Playwright + Chromium** at `/ms-playwright`

### Runtime-installed (on demand)

Detected from `detected_infra` in repo config. Installed and started during sandbox setup:
- **MinIO** — S3-compatible storage (needed by Formbricks, Documenso)
- **Mail server** (Mailhog/Inbucket) — for email-dependent flows
- **Other services** — added as we encounter them

This keeps the template lean (~10s faster boot) while supporting apps that need more.

### Reference: eval app requirements

| Service | Formbricks | Documenso |
|---------|-----------|-----------|
| Postgres | v18 + pgvector | v15 |
| Redis | Yes (Valkey) | No |
| MinIO | Yes | Yes |
| Mail server | Mailhog | Inbucket |
| Other | Hub API (port 8080) | — |

## Sandbox Pipeline (per PR)

### Step 1 — Spec discovery
Runs on the server (no sandbox yet). Fetch PR changed files from GitHub API, check for plan files, then PR body, then fallback.

### Step 2 — Spin up E2B sandbox
Create sandbox from verify template. Postgres + Redis already running. Clone the PR's head branch.

### Step 3 — Install runtime infra
Check `detected_infra` from repo config. For each additional service: install, start, run readiness probe (retry until healthy or 30s timeout).

### Step 4 — Start the app
1. Write env vars from DB into `.env`
2. Run install command (e.g. `pnpm install`)
3. Run pre-start script if configured (e.g. `pnpm db:migrate && pnpm db:seed`)
4. Inject test credentials as env vars if configured
5. Run startup command in background (`nohup pnpm dev > /tmp/server.log 2>&1 &`)
6. Poll health endpoint until 2xx or 60s timeout

### Step 5 — Run verify pipeline
- **Planner**: spec → structured acceptance criteria + test plan
- **Browser agents**: Claude headless with Playwright MCP, one agent per AC, run in parallel. If test credentials configured, agent uses them to log in.
- **Judge**: review all evidence, pass/fail each AC

### Step 6 — Report
Post PR comment with results. Destroy sandbox.

**Total sandbox lifetime:** ~3-5 minutes typical.

## PR Comment Format

### Full verification (spec found)

```markdown
## Verify Report

**Spec:** `docs/plans/2026-03-12-user-settings-redesign.md`
**App:** Started on port 3000 (Next.js)

### Acceptance Criteria

| | AC | Result |
|---|---|---|
| ✅ | AC1: Settings page loads with user profile pre-filled | Pass |
| ✅ | AC2: Changing display name shows success toast | Pass |
| ❌ | AC3: Uploading avatar > 5MB shows error message | Fail |
| ⊘ | AC4: Admin role sees "Manage Team" tab | Skipped (setup failed) |

### Details

**AC3 — Fail**
> Expected: Error message when uploading oversized avatar
> Observed: Page crashed with unhandled exception

---

*3 of 4 criteria passed · Powered by Opslane Verify*
```

v1 posts text-only results (no screenshots). Screenshot evidence via S3/R2 upload + linked images is deferred to v2. See `docs/plans/2026-03-12-remote-verify-v2-backlog.md`.

### Code review only (no spec)

```markdown
## Code Review

No spec found for this PR. Reviewed code changes only.

[Code review content...]

> Add a plan file to `docs/plans/` for full acceptance testing.
```

## Concurrency Guard

Rapid pushes to a PR branch fire multiple `pull_request.synchronize` events. Without a guard, each triggers a new sandbox run — expensive and produces competing PR comments.

**Solution**: Use Trigger.dev's `concurrencyKey` on the verify task:

```typescript
export const verifyPrTask = task({
  id: "verify-pr",
  concurrencyKey: ({ payload }) => `${payload.owner}/${payload.repo}#${payload.prNumber}`,
  maxDuration: 600, // 10 minutes — covers sandbox boot + infra + app start + verify pipeline
  run: async (payload) => { ... }
});
```

This ensures only one verify run per PR at a time. If a new push arrives while a run is in progress, it queues behind the current one (Trigger.dev's default behavior).

## Startup Failure Handling

If the app fails to start (health check times out after 60s), the pipeline:

1. Reads the last 30 lines of `/tmp/server.log` from the sandbox
2. Posts a PR comment with actionable feedback:

```markdown
## Verify Report

**Status:** App failed to start

The app did not respond on port 3000 within 60 seconds.

**Server log (last 30 lines):**
```
[error output here]
```

**Common fixes:**
- Check your startup command in the Opslane dashboard
- Ensure required env vars are configured
- Verify your pre-start script (migrations, etc.) succeeds
```

3. Destroys the sandbox
4. Does NOT fall back to code-review-only — the user explicitly configured AC verification for this repo, so a silent fallback would hide a real problem.

## Re-run Support

A `/verify` comment on the PR triggers a re-run.

### Trigger
The server subscribes to `issue_comment` webhook events. When received:

1. Check event is `issue_comment.created` and the issue is a PR (GitHub includes `pull_request` URL in the payload)
2. Check comment body is exactly `/verify` (trimmed, case-insensitive)
3. **Authorization**: Check the commenter has `write` or `admin` permission on the repo via GitHub's collaborators API. Reject with no action if they don't — prevents abuse on public repos.
4. Dispatch the same verify pipeline with `owner`, `repo`, `prNumber` extracted from the payload

### GitHub App setup
The GitHub App's webhook subscription must include the `issue_comment` event. Document this as a setup prerequisite.

### Concurrency
Same `concurrencyKey` applies — if a run is already in progress for this PR, the re-run queues behind it.

## What We're Porting from opslane-v2

Simplified versions of:
- **Sandbox interface** (`VerifySandbox` abstraction over E2B SDK)
- **E2B provider** (create/destroy sandbox, file ops, command execution)
- **App startup** (install deps, run pre-start, launch server, health check)
- **Browser agent** (Claude tool-use loop with Playwright)
- **Runtime detection** (simplified — user provides config via UI instead of auto-detection)

What we're NOT porting:
- Blueprint/node abstraction
- Session service
- Evidence repository
- Vault system (replaced by encrypted DB columns)
- `opslane.verify.yml` parsing (deferred)

## Out of Scope for v1

Deferred items are tracked in `docs/plans/2026-03-12-remote-verify-v2-backlog.md`.

- Auto-detection via Claude (repo analysis to pre-fill config form)
- Screenshot evidence in PR comments (S3/R2 upload + linked images)
- Linear/Jira ticket fetching for spec discovery
- `opslane.verify.yml` config-as-code
- Per-environment configs (staging, production)
- Video recording of browser sessions
- Trace file storage
- Re-run with custom spec (always uses what's in the PR)
