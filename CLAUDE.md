## Project
opslane/verify — automated acceptance criteria verification for Claude Code changes. Runs browser agents against a spec, judges pass/fail, and reports results before you push.

Also contains `server/` — a SaaS backend (Hono + TypeScript + Postgres) for GitHub OAuth sign-in, GitHub App installation tracking, and PR webhook handling.

## Stack

### Pipeline (scripts/)
- Bash (3-compatible — macOS + Linux)
- `claude -p` — non-interactive Claude CLI (OAuth, no API key needed)
- Playwright MCP — browser automation for each AC check
- `jq` — JSON processing throughout
- `gtimeout` (macOS coreutils) / `timeout` (Linux)

### Server (server/)
- Hono + TypeScript, running on `@hono/node-server`
- postgres.js for DB access (no ORM)
- hono/jwt for HS256 JWT session cookies
- vitest for unit + integration tests
- Docker for production packaging

## Structure
- `scripts/` — pipeline stages: `preflight.sh`, `planner.sh`, `orchestrate.sh`, `agent.sh`, `judge.sh`, `report.sh`
- `scripts/prompts/` — Claude prompt templates for each stage
- `tests/` — test scripts (one per stage)
- `server/` — SaaS backend
  - `src/routes/auth.ts` — GitHub OAuth routes (CSRF state, JWT session cookie)
  - `src/routes/webhooks.ts` — GitHub App webhook handler (HMAC verification)
  - `src/db.ts` — postgres.js helpers (upsertOrg, upsertUser, upsertInstallation, findUserByLogin)
  - `src/migrate.ts` — runs SQL migrations at startup
  - `src/index.ts` — app entry point, caches landing HTML, graceful shutdown
  - `migrations/` — SQL migration files
- `skills/verify/SKILL.md` — the `/verify` Claude Code skill (**source of truth**)
- `skills/verify-setup/SKILL.md` — the `/verify-setup` skill (**source of truth**)
- `.verify/` — runtime output (gitignored): `config.json`, `plan.json`, `evidence/`, `auth.json`
- `docs/evals/` — eval sets for prompt quality testing

## Skill sync
The skills in `skills/` are the source of truth. A `PostToolUse` hook (`.claude/hooks/sync-skill.sh`) automatically copies them to `~/.claude/skills/` after every Write or Edit. Never edit `~/.claude/skills/verify/SKILL.md` directly — edit the project copy instead.

## Architecture

### Pipeline
```
spec + PR → preflight → planner → orchestrate (parallel agents) → judge → report
```
Config lives in `.verify/config.json`. Env vars always override config.

### Server
```
/auth/github → GitHub OAuth → /auth/callback → JWT session cookie → GitHub App install page
GitHub App webhook → /webhooks/github → HMAC verify → installation.created handler
```

## Commands

### Pipeline
- Test a single stage: `bash tests/test_preflight.sh`
- Test all: `for f in tests/test_*.sh; do bash "$f"; done`
- Full run (needs dev server): `bash scripts/preflight.sh && bash scripts/planner.sh "$SPEC_PATH"`

### Server
- Dev: `cd server && npm run dev` (loads `.env` via `--env-file`)
- Tests (all, with .env): `cd server && node --env-file=.env ./node_modules/.bin/vitest run`
- Docker smoke test: `bash scripts/test-docker.sh`
- Required DB setup: `createdb verify_dev && createdb verify_test`

## Verification (run in this order before every commit)
For server changes:
1. `cd server && npx tsc --noEmit` — fix all type errors
2. `cd server && node --env-file=.env ./node_modules/.bin/vitest run` — fix all failing tests (loads .env for DB + secrets)
3. Check no `any` escapes or eslint-disable without justification

**Important:** Always run tests with `.env` loaded. `npm test` alone does NOT load `.env`, so DB integration and webhook tests will fail with misleading errors (skipped tests, missing secrets). Use `node --env-file=.env` as shown above.

## Conventions

### Pipeline
- **Bash 3 compat**: use `while read` not `mapfile`. No bash 4+ features.
- **Env vars override config**: `VERIFY_BASE_URL`, `VERIFY_AUTH_CHECK_URL`, `VERIFY_SPEC_PATH`
- **Non-interactive Claude**: always use `claude -p`, never interactive mode
- **`--dangerouslySkipPermissions`**: only pass when the guard check in `preflight.sh` explicitly allows it

### Server
- **CSRF protection**: every OAuth callback must validate the `state` cookie — no exceptions, no bypass paths
- **Cookie security**: use `isSecure(c)` which trusts `x-forwarded-proto` from proxies; assumes server always runs behind a trusted reverse proxy (ngrok, ALB) — never exposed directly
- **Webhook auth**: always verify `X-Hub-Signature-256` with `timingSafeEqual` before processing any webhook payload
- **Error responses**: never return internal state (cookie values, param values) in error response bodies — log server-side, return generic message to client
- **DB helpers**: use `ON CONFLICT ... DO UPDATE` for all upserts — all writes must be idempotent
- **Env vars at startup**: throw at module load time if required env vars are missing (fail fast on deploy)
- **Tests**: DB integration tests require `TEST_DATABASE_URL`; unit tests mock `../db.js` at the top of the file before any imports
- **vitest config**: `singleThread: true` — DB tests must run sequentially to prevent migrate.test.ts from dropping tables while db.test.ts uses them

## Don't

### Pipeline
- Don't use `mapfile` — use `while read -r line` for bash 3 compat
- Don't hardcode URLs — use `VERIFY_BASE_URL` or `.verify/config.json`
- Don't call `claude` interactively — always `claude -p "prompt"`
- Don't commit `.verify/` contents — auth, evidence, and plans are gitignored

### Server
- Don't add bypass paths that skip CSRF state validation — session fixation attacks are real (an attacker can craft a callback URL with their own valid code to log a victim into the attacker's account)
- Don't use `any` in TypeScript — use `unknown` and narrow, or use the correct vitest type (`MockInstance`)
- Don't leak diagnostic info in HTTP error responses — log with `console.error`, return generic message
- Don't run DB tests in parallel — vitest `singleThread: true` is mandatory
- Don't set `secure: process.env.NODE_ENV === 'production'` directly on cookies — use `isSecure(c)` so ngrok/staging environments work correctly
- Don't use `tsx watch` directly in dev scripts — use `node --env-file=.env --import tsx/esm --watch` for reliable `.env` loading
- Don't commit `server/.env` — use `server/.env.example` as the template
- Don't skip webhook HMAC verification even in tests — mock the signature, don't disable the check

## GitHub App setup
- "Request user authorization (OAuth) during installation" must be **unchecked** — users sign in via `/auth/github` first, then install the app; the `installation.created` webhook handles the rest
- Callback URL must match the server's public URL (ngrok in dev, production domain in prod)
- Webhook URL: `<base>/webhooks/github`

## References
- Pipeline design: `docs/plans/2026-03-08-verify-implementation.md`
- Server design: `docs/plans/2026-03-12-saas-auth-design.md`
- Server implementation plan: `docs/plans/2026-03-12-saas-auth-implementation.md`
- Eval sets: `docs/evals/eval-set-v1.json`
- Prompt templates: `scripts/prompts/`
