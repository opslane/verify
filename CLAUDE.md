## Project
opslane/verify — automated acceptance criteria verification for Claude Code changes. Runs browser agents against a spec, judges pass/fail, and reports results before you push.

Also contains `server/` — a SaaS backend (Hono + TypeScript + Postgres) for GitHub OAuth sign-in, GitHub App installation tracking, and PR webhook handling.

## Stack

### Pipeline (pipeline/)
- TypeScript 5, Node 22 ESM, tsx
- `claude -p` — non-interactive Claude CLI (OAuth, no API key needed)
- gstack browse — headless browser for each AC check
- vitest for unit + integration tests

### Pipeline legacy (scripts/)
- Bash (3-compatible — macOS + Linux) — being replaced by `pipeline/`

### Server (server/)
- Hono + TypeScript, running on `@hono/node-server`
- postgres.js for DB access (no ORM)
- hono/jwt for HS256 JWT session cookies
- vitest for unit + integration tests
- Docker for production packaging

## Structure
- `pipeline/` — TypeScript pipeline v2
  - `src/lib/` — shared types, config, app-index, prisma-parser, seed-extractor
  - `src/stages/` — ac-generator, browse-agent
  - `src/prompts/` — `ac-generator.txt`, `browse-agent.txt`, `browse-replan.txt`, `executor-session.txt`, `index/`
  - `src/cli.ts` — CLI entry point (`run`, `index-app`, `run-stage`)
  - `src/orchestrator.ts` — full pipeline orchestration
  - `test/` — vitest tests
- `scripts/` — legacy bash pipeline (being replaced by `pipeline/`)
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

## Skill sync
The skills in `skills/` are the source of truth. A `PostToolUse` hook (`.claude/hooks/sync-skill.sh`) automatically copies them to `~/.claude/skills/` after every Write or Edit. It also syncs `pipeline/` to `~/.claude/tools/verify/pipeline/` when pipeline files change. Never edit `~/.claude/skills/verify/SKILL.md` directly — edit the project copy instead.

## Architecture

### Pipeline
```
/verify-setup → index-app (Prisma parser + seed IDs + 4 LLM agents → app.json)
/verify → ac-generator → single-session executor → report
```
Config lives in `.verify/config.json`. App index lives in `.verify/app.json`. Env vars always override config.

### Server
```
/auth/github → GitHub OAuth → /auth/callback → JWT session cookie → GitHub App install page
GitHub App webhook → /webhooks/github → HMAC verify → installation.created handler
```

## Commands

### Pipeline
- Typecheck: `cd pipeline && npx tsc --noEmit`
- Tests: `cd pipeline && npx vitest run`
- Single test: `cd pipeline && npx vitest run test/prisma-parser.test.ts`
- Run a stage: `cd pipeline && npx tsx src/cli.ts run-stage ac-generator --verify-dir .verify`
- Run browse-agent: `cd pipeline && npx tsx src/cli.ts run-stage browse-agent --verify-dir .verify`
- Verify login: `cd pipeline && npx tsx src/cli.ts run-stage verify-login --verify-dir .verify`
- Full run: `cd pipeline && npx tsx src/cli.ts run --spec .verify/spec.md`
- Index app: `cd pipeline && npx tsx src/cli.ts index-app --project-dir /path/to/project`

### Server
- Dev: `cd server && npm run dev` (loads `.env` via `--env-file`)
- Tests (all, with .env): `cd server && node --env-file=.env ./node_modules/.bin/vitest run`
- Docker smoke test: `bash scripts/test-docker.sh`
- Required DB setup: `createdb verify_dev && createdb verify_test`

## Verification (run in this order before every commit)
For pipeline changes:
1. `cd pipeline && npx tsc --noEmit` — fix all type errors
2. `cd pipeline && npx vitest run` — fix all failing tests

For server changes:
1. `cd server && npx tsc --noEmit` — fix all type errors
2. `cd server && node --env-file=.env ./node_modules/.bin/vitest run` — fix all failing tests (loads .env for DB + secrets)
3. Check no `any` escapes or eslint-disable without justification

**Important:** Always run tests with `.env` loaded. `npm test` alone does NOT load `.env`, so DB integration and webhook tests will fail with misleading errors (skipped tests, missing secrets). Use `node --env-file=.env` as shown above.

## Conventions

### Pipeline
- **TypeScript strict**: no `any`, use `unknown` and narrow
- **Node 22 ESM**: use `import`, not `require`
- **Non-interactive Claude**: always use `claude -p`, never interactive mode
- **Stage permissions**: each stage gets minimal tool access via `STAGE_PERMISSIONS` in types.ts

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
- Don't use `any` in TypeScript — use `unknown` and narrow
- Don't hardcode URLs — use config or env vars
- Don't call `claude` interactively — always `claude -p`
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
- Pipeline v2 design: `docs/plans/2026-03-18-pipeline-v2-implementation.md`
- WS6 integration plan: `docs/plans/2026-03-18-ws6-integration.md`
- Pipeline v1 design: `docs/plans/2026-03-08-verify-implementation.md`
- Server design: `docs/plans/2026-03-12-saas-auth-design.md`
- Server implementation plan: `docs/plans/2026-03-12-saas-auth-implementation.md`
- Prompt templates: `pipeline/src/prompts/`
