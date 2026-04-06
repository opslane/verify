## Stack
- Hono + TypeScript, running on `@hono/node-server`
- postgres.js for DB access (no ORM)
- hono/jwt for HS256 JWT session cookies
- vitest for unit + integration tests
- Docker for production packaging

## Commands
- Dev: `npm run dev` (loads `.env` via `--env-file`)
- Docker smoke test: `bash ../scripts/test-docker.sh`
- Required DB setup: `createdb verify_dev && createdb verify_test`

## Verification (run before every commit)
1. `npx tsc --noEmit` — fix all type errors
2. `node --env-file=.env ./node_modules/.bin/vitest run` — fix all failing tests (`npm test` alone does NOT load `.env`)
3. Check no `any` escapes or eslint-disable without justification

## Conventions
- **Webhook auth**: always verify `X-Hub-Signature-256` with `timingSafeEqual` before processing any webhook payload
- **DB helpers**: use `ON CONFLICT ... DO UPDATE` for all upserts — all writes must be idempotent
- **Env vars at startup**: throw at module load time if required env vars are missing (fail fast)
- **TypeScript strict**: no `any` — use `unknown` and narrow, or use vitest `MockInstance`
- **Tests**: DB integration tests require `TEST_DATABASE_URL`; unit tests mock `../db.js` before imports
- **vitest config**: `singleThread: true` — DB tests must run sequentially to prevent migrate.test.ts from dropping tables while db.test.ts uses them

## Don't
- Don't add bypass paths that skip CSRF state validation — session fixation attacks are real; use the `state` cookie on every OAuth callback
- Don't return internal state in HTTP error responses — log with `console.error`, return generic message
- Don't set `secure: process.env.NODE_ENV === 'production'` on cookies — use `isSecure(c)` for ngrok/staging
- Don't use `tsx watch` directly — use `node --env-file=.env --import tsx/esm --watch`
- Don't commit `server/.env` — use `.env.example` as the template
- Don't skip webhook HMAC verification even in tests — mock the signature, don't disable the check

## GitHub App setup
- "Request user authorization (OAuth) during installation" must be **unchecked**
- Callback URL must match the server's public URL (ngrok in dev, production domain in prod)
- Webhook URL: `<base>/webhooks/github`
