# Formbricks PR Automation — From Spike to Webhook-Triggered Verify

**Date:** 2026-03-14
**Status:** Design
**Depends on:** Formbricks E2E spike passing (`test-e2e-formbricks.ts`)

## Goal

After the spike proves sandbox v2 works with formbricks, wire it up so that opening a PR (or commenting `/verify`) on `abhishekray07/formbricks` automatically runs the verify pipeline and posts results as a PR comment.

## Current State

The code is 95% wired. The webhook handler, Trigger.dev tasks, verify pipeline, sandbox setup, browser agent, and PR comment posting all exist. What's missing is **configuration and deployment**.

## Architecture

```
PR opened on abhishekray07/formbricks
  → GitHub sends webhook to our server
  → /webhooks/github handler validates signature
  → Dispatches 'unified-pr' Trigger.dev task (or runs inline if no TRIGGER_SECRET_KEY)
  → runUnifiedPipeline():
      - runReviewPipeline() → inline code review comments
      - runVerifyPipeline() → sandbox + browser agent → AC verification
  → Posts combined PR comment with results
```

## What Needs to Happen

### 1. Fix trigger.config.ts — verify tasks not registered

**Problem:** `trigger.config.ts` has `dirs: ["src/review"]` but verify tasks live in `src/verify/` and unified tasks in `src/unified/`. The `verify-pr` and `unified-pr` Trigger.dev tasks will silently fail to register.

**Fix:** Add `src/verify` and `src/unified` to the dirs array.

**File:** `server/trigger.config.ts`

```typescript
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_placeholder",
  dirs: ["src/review", "src/verify", "src/unified"],
  maxDuration: 300,
});
```

### 2. Fix task maxDuration mismatch

**Problem:** `verifyPrTask` has `maxDuration: 600` (10 min) but `VERIFY_TIMEOUT_MS` in `pipeline.ts` is 900,000ms (15 min). The Trigger.dev task will be killed before the pipeline completes.

**Note:** `unifiedPrTask` already has `maxDuration: 900` (15 min), which is correct. But the webhook handler dispatches `unified-pr` for PR open/sync and `verify-pr` for `/verify` comments. The `verify-pr` task is the one with the wrong timeout.

**Fix:** Increase `verifyPrTask.maxDuration` to 900.

**File:** `server/src/verify/runner.ts`

```typescript
export const verifyPrTask = task({
  id: 'verify-pr',
  maxDuration: 900,  // 15 min — matches VERIFY_TIMEOUT_MS in pipeline.ts
  ...
});
```

### 3. Build and publish the E2B template

The sandbox v2 Dockerfile changed significantly (Docker CE instead of baked-in Postgres/Redis, 8GB/4CPU). The template must be rebuilt.

```bash
cd server/e2b-templates/verify
e2b template build
```

This publishes `opslane-verify-v2` to E2B's registry. Verify with `e2b template list`.

### 4. Seed the formbricks repo config in the database

The verify pipeline checks `findRepoConfig('abhishekray07', 'formbricks')`. If it returns null, the pipeline exits with `{mode: 'no-config'}` and no verification happens.

Write a one-off seed script:

**File:** `server/src/verify/seed-formbricks-config.ts`

```typescript
/**
 * One-off: seed repo config for abhishekray07/formbricks.
 * Run: cd server && node --env-file=.env --import tsx/esm src/verify/seed-formbricks-config.ts
 */
import { upsertRepoConfig } from '../db.js';
import { encrypt } from '../crypto.js';
import { randomBytes } from 'node:crypto';

const secret = () => randomBytes(32).toString('hex');

async function main() {
  const config = await upsertRepoConfig({
    installationId: null,  // will be set when GitHub App is installed
    owner: 'abhishekray07',
    repo: 'formbricks',
    devCommand: 'pnpm --filter @formbricks/web dev',
    port: 3000,
    installCommand: 'pnpm install',
    healthPath: '/auth/login',
    testEmail: encrypt('test@test.com'),
    testPassword: encrypt('testtest1234'),
    envVars: {
      WEBAPP_URL: encrypt('http://localhost:3000'),
      NEXTAUTH_URL: encrypt('http://localhost:3000'),
      DATABASE_URL: encrypt('postgresql://postgres:postgres@localhost:5432/formbricks?schema=public'),
      NEXTAUTH_SECRET: encrypt(secret()),
      ENCRYPTION_KEY: encrypt(secret()),
      CRON_SECRET: encrypt(secret()),
      REDIS_URL: encrypt('redis://localhost:6379'),
      EMAIL_VERIFICATION_DISABLED: encrypt('1'),
      PASSWORD_RESET_DISABLED: encrypt('1'),
      MAIL_FROM: encrypt('noreply@example.com'),
      SMTP_HOST: encrypt('localhost'),
      SMTP_PORT: encrypt('1025'),
      SMTP_SECURE_ENABLED: encrypt('0'),
    },
    composeFile: 'docker-compose.dev.yml',
    schemaCommand: 'npx prisma db push --schema=packages/database/schema.prisma --accept-data-loss',
    seedCommand: 'ALLOW_SEED=true pnpm --filter @formbricks/database db:seed',
    loginScript: [
      "await page.getByRole('button', { name: 'Login with Email' }).click();",
      "await page.getByPlaceholder('work@email.com').fill(EMAIL);",
      "await page.getByPlaceholder('*******').fill(PASSWORD);",
      "await page.getByRole('button', { name: 'Login with Email' }).nth(1).click();",
    ].join('\n'),
    sandboxTemplate: null,  // use base template
  });

  console.log(`Repo config seeded: ${config.owner}/${config.repo} (id: ${config.id})`);
  process.exit(0);
}

main().catch(err => {
  console.error('Failed to seed:', err.message);
  process.exit(1);
});
```

Run against the deployed database (or local dev):
```bash
cd server && node --env-file=.env --import tsx/esm src/verify/seed-formbricks-config.ts
```

### 5. Deploy the server

The server needs migration 003 (sandbox v2 schema) + all the new code. Deploy to wherever it runs (Railway, etc.).

**Pre-deploy checklist:**
- [ ] `DATABASE_URL` points to production Postgres
- [ ] `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` configured
- [ ] `GITHUB_WEBHOOK_SECRET` matches GitHub App settings
- [ ] `SVIX_WEBHOOK_SECRET` configured (or use `GITHUB_WEBHOOK_SECRET` for all events)
- [ ] `E2B_API_KEY` configured
- [ ] `ANTHROPIC_API_KEY` configured
- [ ] `ENCRYPTION_KEY` configured (same key used to seed repo config)
- [ ] `TRIGGER_SECRET_KEY` + `TRIGGER_PROJECT_REF` configured (or omit for inline mode)

**After deploy:** Migration 003 runs automatically at startup via `runMigrations()` in `index.ts`.

### 6. Install the GitHub App on the fork

1. Go to the GitHub App settings page
2. Install it on `abhishekray07/formbricks` (or all repos on the account)
3. The `installation.created` webhook fires → our server stores the installation record
4. Verify: check `github_installations` table for the new row

**After installation:** The pipeline can now get GitHub App tokens via `GitHubAppService.getTokenForRepo('abhishekray07', 'formbricks')`.

### 7. Update the installation_id on repo config

After step 6, the installation record exists but `repo_configs.installation_id` is still null (we seeded it before installing). The verify pipeline doesn't use `installation_id` directly (it looks up the installation via the GitHub API), so this is **not blocking** — but for correctness, update it:

```sql
UPDATE repo_configs
SET installation_id = (
  SELECT installation_id FROM github_installations
  WHERE github_account_login = 'abhishekray07'
  LIMIT 1
)
WHERE owner = 'abhishekray07' AND repo = 'formbricks';
```

### 8. End-to-end test — open a PR

1. Push a new commit to the test branch on `abhishekray07/formbricks`
2. Open (or reopen) a PR
3. Watch the server logs for:
   - `POST /webhooks/github` with `pull_request` event
   - Trigger.dev task dispatched (or inline pipeline started)
   - Sandbox creation, clone, setupSandbox logs
   - Browser agent turns
   - PR comment posted
4. Check the PR for the verify comment

If using inline mode (no Trigger.dev), the webhook handler will run the pipeline synchronously. Watch for timeout issues — the webhook response will be delayed until the pipeline completes (~8-12 min).

## Execution Order

| Step | What | Blocking? | Time |
|------|------|-----------|------|
| 1 | Fix trigger.config.ts dirs | Yes (code change) | 1 min |
| 2 | Fix verifyPrTask maxDuration | Yes (code change) | 1 min |
| 3 | Build E2B template | Yes (infra) | 5-10 min |
| 4 | Seed formbricks repo config | Yes (data) | 1 min |
| 5 | Deploy server | Yes (infra) | 5-10 min |
| 6 | Install GitHub App on fork | Yes (config) | 2 min |
| 7 | Update installation_id | No (correctness only) | 1 min |
| 8 | Open test PR | Validation | 10-15 min |

Steps 1-2 are code changes (commit together). Steps 3-7 are config/infra (manual). Step 8 is validation.

## Dev Mode Alternative (No Deployment)

If you want to test locally before deploying:

1. Run the server locally: `cd server && npm run dev`
2. Use ngrok to expose it: `ngrok http 3000`
3. Update GitHub App webhook URL to the ngrok URL
4. Set `SVIX_SKIP_VERIFICATION=true` in `.env` (dev only)
5. Don't set `TRIGGER_SECRET_KEY` — pipeline runs inline
6. Open a PR → webhook hits ngrok → local server runs pipeline

This avoids deploying but blocks the webhook response for ~10 min. Fine for testing.

## What Could Go Wrong

| Issue | Symptom | Fix |
|-------|---------|-----|
| No repo config | Pipeline exits with `{mode: 'no-config'}`, no comment posted | Run seed script (step 4) |
| GitHub App not installed | `getTokenForRepo()` fails with 404 | Install app (step 6) |
| E2B template not published | `provider.create()` fails | Build template (step 3) |
| Wrong ENCRYPTION_KEY | `decrypt()` throws on env vars | Use same key for seed + server |
| Trigger.dev dirs stale | Task dispatch succeeds but nothing runs | Fix trigger.config.ts (step 1) |
| Task timeout | Pipeline killed at 10 min | Fix maxDuration (step 2) |
| Login selectors changed | `loginAndInjectAuth()` fails | Update login_script in repo config |
| Compose file not found | `docker compose -f` fails | Verify compose file name in formbricks repo |
