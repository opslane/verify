# Formbricks E2E Spike

**Date:** 2026-03-14
**Status:** Design
**Review:** 3.4/5 — APPROVE WITH CHANGES (applied)

## Goal

A single runnable script that proves the sandbox v2 pipeline works end-to-end against a real formbricks PR. Not a production path — a diagnostic tool that exercises the real code (`setupSandbox()`, `loginAndInjectAuth()`, `runBrowserAgent()`) with hardcoded config and real encryption.

## Prerequisites

1. **Test PR on `abhishekray07/formbricks`** — a small UI change (e.g., change button text on `/auth/login`). The script hardcodes this PR's owner/repo/branch.
2. **E2B template `opslane-verify-v2` built and published** — the updated Dockerfile from sandbox v2 (Docker CE 29.3, Compose v5.1, 8GB/4CPU, no baked-in services).
3. **Environment variables** in `server/.env`:
   - `E2B_API_KEY` — E2B sandbox API key
   - `ANTHROPIC_API_KEY` — for browser agent (Claude Sonnet)
   - `ENCRYPTION_KEY` — for encrypting/decrypting env vars (real crypto path)

## Script

**Location:** `server/src/verify/test-e2e-formbricks.ts`

**Run:** `cd server && node --env-file=.env --import tsx/esm src/verify/test-e2e-formbricks.ts`

## Execution Flow

A flat `async function main()` in `try/finally`. No phases, no classes — just sequential steps with timestamped logging.

```
1.  Create E2B sandbox (template: opslane-verify-v2)
2.  Wait for Docker daemon (poll `docker info` until ready)
3.  Clone fork:
    git clone --depth=1 --branch={PR_BRANCH} \
      https://github.com/abhishekray07/formbricks.git /home/user/repo
4.  Call setupSandbox(provider, sandboxId, config, log)
    → writes .env, docker compose up, pnpm install, prisma push, seed, start dev server, health check
5.  Call ensureBrowserRunning(provider, sandboxId)
6.  Call loginAndInjectAuth(provider, sandboxId, config.login_script, testEmail, testPassword)
7.  Call runBrowserAgent() with one hardcoded AC
    → "Navigate to /auth/login and verify {changed element} says '{expected text}'"
8.  Print agent result (pass/fail)
9.  Destroy sandbox (in finally block)
```

All output goes to stdout. No evidence directory.

## RepoConfig

Hardcoded in the script with real encryption:

| Field | Value |
|-------|-------|
| `dev_command` | `pnpm --filter @formbricks/web dev` |
| `port` | `3000` |
| `compose_file` | `docker-compose.dev.yml` |
| `install_command` | `pnpm install` |
| `schema_command` | `npx prisma db push --schema=packages/database/schema.prisma --accept-data-loss` |
| `seed_command` | `ALLOW_SEED=true pnpm --filter @formbricks/database db:seed` |
| `health_path` | `/auth/login` |
| `test_email` | seeded test user email (encrypted) |
| `test_password` | seeded test user password (encrypted) |
| `login_script` | Playwright snippet: navigate to /auth/login, fill email/password, submit (encrypted is N/A — stored as plaintext in config) |
| `env_vars` | formbricks dev vars (each value encrypted — see below) |

### Encryption Pattern

`setupSandbox()` calls `decrypt()` on every `env_vars` value, `test_email`, and `test_password`. The spike must encrypt before constructing the config:

```typescript
import { encrypt } from '../crypto.js';

const envVars: Record<string, string> = {};
for (const [key, value] of Object.entries(FORMBRICKS_ENV)) {
  envVars[key] = encrypt(value);
}

const config: RepoConfig = {
  // ...
  env_vars: envVars,
  test_email: encrypt('test@example.com'),
  test_password: encrypt('testpassword123'),
  // ...
};
```

### Environment Variables

Generated at runtime with `crypto.randomBytes(32).toString('hex')` for secrets, hardcoded for service URLs:

```
WEBAPP_URL=http://localhost:3000
NEXTAUTH_URL=http://localhost:3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/formbricks?schema=public
NEXTAUTH_SECRET={generated}
ENCRYPTION_KEY={generated}
CRON_SECRET={generated}
REDIS_URL=redis://localhost:6379
EMAIL_VERIFICATION_DISABLED=1
PASSWORD_RESET_DISABLED=1
MAIL_FROM=noreply@example.com
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE_ENABLED=0
```

## Error Handling

```typescript
try {
  // Steps 1-8
} finally {
  await provider.destroy(sandboxId);
  console.log(`Sandbox ${sandboxId} destroyed`);
}
```

If any step fails, the log callback provides timestamped visibility. `setupSandbox()` returns `{ success: false, error, serverLog }` on failure — the script prints both and exits.

## Expected Timing

~8-12 minutes total (base template, cold Docker image pull, full pnpm install from scratch).

## Notes

- **Health check timeout:** `setupSandbox()` polls for 120s. Formbricks Next.js dev mode compiles on-demand — first request to `/auth/login` may take 30-60s. Monitor this in spike output; increase timeout if needed.
- **Playwright in sandbox:** Base template installs Playwright globally. `ensureBrowserRunning()` checks `require('playwright')` and falls back to local install if needed.

## What This Proves

If the spike passes:
- Sandbox v2 template works (Docker + Compose in E2B)
- `setupSandbox()` handles formbricks correctly (compose, prisma, pnpm dev)
- Real encryption/decryption path works end-to-end
- Browser agent can authenticate via `loginAndInjectAuth()` and verify UI changes
- The full production code path works (minus clone auth + webhook trigger)

## What This Doesn't Cover

- **Clone authentication** — spike clones a public fork directly; production injects a GitHub access token into the clone URL. Clone path testing is out of scope.
- **Webhook-triggered flow** — manual script, not via PR event
- **PR comment posting** — no GitHub token / installation context
- **Spec parsing from PR body** — AC is hardcoded
- **Custom formbricks template** — using base template
- **Multi-AC parallel execution** — single AC only

These are follow-ups after the spike proves the core path works.
