# Webhook Delivery & PR Review Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist webhook deliveries and PR review lifecycle in the database, replacing the in-memory dedup set and providing an audit trail for all reviews.

**Architecture:** Add two tables (`webhook_deliveries`, `pr_reviews`) via a new migration. Add DB helper functions following the existing pattern in `db.ts`. Replace the in-memory `DeduplicationSet` with a DB-backed dedup query. Update the webhook handler to record deliveries and track review status. Update the review pipeline to set status transitions (pending → running → completed/failed).

**Tech Stack:** postgres.js (existing), vitest for tests, same patterns as `001_foundation.sql` / `db.ts`

---

### Task 1: Migration — Create webhook_deliveries and pr_reviews Tables

**Files:**
- Create: `server/db/migrations/002_webhook_tracking.sql`

**Step 1: Write the migration**

```sql
-- Stores every verified webhook delivery for dedup + audit
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  action TEXT,
  owner TEXT,
  repo TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_delivery_id ON webhook_deliveries(delivery_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_type ON webhook_deliveries(event_type);

-- Tracks the lifecycle of each PR review
CREATE TABLE IF NOT EXISTS pr_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  comment_url TEXT,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_reviews_status ON pr_reviews(status);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_owner_repo_pr ON pr_reviews(owner, repo, pr_number);
```

**Step 2: Verify migration applies locally**

Run: `cd server && node -e "import('./src/migrate.js').then(m => m.runMigrations(process.env.DATABASE_URL))" --env-file=.env`
Expected: `Migration applied: 002_webhook_tracking.sql`

**Step 3: Commit**

```bash
git add server/db/migrations/002_webhook_tracking.sql
git commit -m "feat(db): add webhook_deliveries and pr_reviews tables"
```

---

### Task 2: DB Helpers — insertDelivery, isDuplicateDelivery, insertReview, updateReviewStatus

**Files:**
- Modify: `server/src/db.ts`
- Test: `server/src/db.test.ts` (integration tests — skipped without `TEST_DATABASE_URL`)

**Step 1: Write the failing tests**

Add to the bottom of `server/src/db.test.ts`:

```typescript
describe('insertDelivery', () => {
  it('inserts a webhook delivery and returns it', async () => {
    const { insertDelivery } = await import('./db.js');
    const delivery = await insertDelivery({
      deliveryId: 'del-001',
      eventType: 'pull_request',
      action: 'opened',
      owner: 'acme',
      repo: 'widgets',
      payload: { action: 'opened', number: 42 },
    });
    expect(delivery.delivery_id).toBe('del-001');
    expect(delivery.event_type).toBe('pull_request');
  });

  it('rejects duplicate delivery_id', async () => {
    const { insertDelivery } = await import('./db.js');
    await expect(insertDelivery({
      deliveryId: 'del-001',
      eventType: 'pull_request',
      action: 'opened',
      owner: 'acme',
      repo: 'widgets',
      payload: { action: 'opened', number: 42 },
    })).rejects.toThrow();
  });
});

describe('isDuplicateDelivery', () => {
  it('returns true for existing delivery_id', async () => {
    const { isDuplicateDelivery } = await import('./db.js');
    expect(await isDuplicateDelivery('del-001')).toBe(true);
  });

  it('returns false for unknown delivery_id', async () => {
    const { isDuplicateDelivery } = await import('./db.js');
    expect(await isDuplicateDelivery('del-unknown')).toBe(false);
  });
});

describe('insertReview', () => {
  it('inserts a pending review linked to a delivery', async () => {
    const { insertReview } = await import('./db.js');
    const review = await insertReview({
      deliveryId: 'del-001',
      owner: 'acme',
      repo: 'widgets',
      prNumber: 42,
    });
    expect(review.status).toBe('pending');
    expect(review.pr_number).toBe(42);
    expect(review.delivery_id).toBe('del-001');
  });
});

describe('updateReviewStatus', () => {
  it('transitions review to completed with comment_url', async () => {
    const { insertDelivery, insertReview, updateReviewStatus } = await import('./db.js');
    await insertDelivery({
      deliveryId: 'del-status-test',
      eventType: 'pull_request',
      action: 'opened',
      owner: 'acme',
      repo: 'widgets',
      payload: { action: 'opened', number: 99 },
    });
    const review = await insertReview({
      deliveryId: 'del-status-test',
      owner: 'acme',
      repo: 'widgets',
      prNumber: 99,
    });
    const updated = await updateReviewStatus(review.id, {
      status: 'completed',
      commentUrl: 'https://github.com/acme/widgets/pull/99#issuecomment-123',
    });
    expect(updated.status).toBe('completed');
    expect(updated.comment_url).toBe('https://github.com/acme/widgets/pull/99#issuecomment-123');
    expect(updated.completed_at).toBeTruthy();
  });

  it('transitions review to failed with error', async () => {
    const { insertDelivery, insertReview, updateReviewStatus } = await import('./db.js');
    await insertDelivery({
      deliveryId: 'del-fail-test',
      eventType: 'pull_request',
      action: 'opened',
      owner: 'acme',
      repo: 'widgets',
      payload: { action: 'opened', number: 100 },
    });
    const review = await insertReview({
      deliveryId: 'del-fail-test',
      owner: 'acme',
      repo: 'widgets',
      prNumber: 100,
    });
    const updated = await updateReviewStatus(review.id, {
      status: 'failed',
      error: 'E2B sandbox timeout',
    });
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('E2B sandbox timeout');
    expect(updated.completed_at).toBeTruthy();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && DATABASE_URL=... TEST_DATABASE_URL=... npm test`
Expected: FAIL — `insertDelivery` is not exported from `./db.js`

**Step 3: Write the implementation**

Add to `server/src/db.ts`:

```typescript
export interface WebhookDelivery {
  id: string;
  delivery_id: string;
  event_type: string;
  action: string | null;
  owner: string | null;
  repo: string | null;
  payload: unknown;
  received_at: Date;
}

export interface PrReview {
  id: string;
  delivery_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  status: string;
  comment_url: string | null;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

export async function insertDelivery(params: {
  deliveryId: string;
  eventType: string;
  action: string | null;
  owner: string | null;
  repo: string | null;
  payload: unknown;
}): Promise<WebhookDelivery> {
  const [row] = await sql<WebhookDelivery[]>`
    INSERT INTO webhook_deliveries (delivery_id, event_type, action, owner, repo, payload)
    VALUES (${params.deliveryId}, ${params.eventType}, ${params.action}, ${params.owner}, ${params.repo}, ${JSON.stringify(params.payload)})
    RETURNING *
  `;
  return row;
}

export async function isDuplicateDelivery(deliveryId: string): Promise<boolean> {
  const [row] = await sql`
    SELECT 1 FROM webhook_deliveries WHERE delivery_id = ${deliveryId} LIMIT 1
  `;
  return !!row;
}

export async function insertReview(params: {
  deliveryId: string;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<PrReview> {
  const [row] = await sql<PrReview[]>`
    INSERT INTO pr_reviews (delivery_id, owner, repo, pr_number, status)
    VALUES (${params.deliveryId}, ${params.owner}, ${params.repo}, ${params.prNumber}, 'pending')
    RETURNING *
  `;
  return row;
}

export async function updateReviewStatus(
  reviewId: string,
  update: {
    status: 'running' | 'completed' | 'failed';
    commentUrl?: string;
    error?: string;
  }
): Promise<PrReview> {
  const now = (update.status === 'completed' || update.status === 'failed') ? new Date() : null;
  const startedAt = update.status === 'running' ? new Date() : null;

  const [row] = await sql<PrReview[]>`
    UPDATE pr_reviews SET
      status = ${update.status},
      comment_url = COALESCE(${update.commentUrl ?? null}, comment_url),
      error = COALESCE(${update.error ?? null}, error),
      started_at = COALESCE(${startedAt}, started_at),
      completed_at = COALESCE(${now}, completed_at)
    WHERE id = ${reviewId}
    RETURNING *
  `;
  return row;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd server && DATABASE_URL=... TEST_DATABASE_URL=... npm test`
Expected: All new tests PASS

**Step 5: Commit**

```bash
git add server/src/db.ts server/src/db.test.ts
git commit -m "feat(db): add webhook delivery and PR review helpers"
```

---

### Task 3: Wire Up Webhook Handler — Record Deliveries, Replace In-Memory Dedup

**Files:**
- Modify: `server/src/routes/webhooks.ts`
- Modify: `server/src/routes/webhooks.test.ts`

**Step 1: Update the webhook test mocks**

In `server/src/routes/webhooks.test.ts`, update the mock at the top of the file:

```typescript
vi.mock('../db.js', () => ({
  findUserByLogin: vi.fn(),
  upsertInstallation: vi.fn(),
  upsertOrg: vi.fn(),
  upsertUser: vi.fn(),
  insertDelivery: vi.fn(),
  isDuplicateDelivery: vi.fn().mockResolvedValue(false),
  insertReview: vi.fn().mockResolvedValue({ id: 'review-uuid' }),
  updateReviewStatus: vi.fn(),
  sql: {},
}));
```

Add import for the new mocks after the existing import:

```typescript
import { findUserByLogin, upsertInstallation, insertDelivery, isDuplicateDelivery, insertReview } from '../db.js';
```

Add a new test in the `POST /github — installation.created` describe block:

```typescript
it('records the webhook delivery in the database', async () => {
  vi.mocked(findUserByLogin).mockResolvedValue(null);
  vi.mocked(upsertInstallation).mockResolvedValue(undefined);
  vi.mocked(insertDelivery).mockResolvedValue({} as any);

  const app = createWebhookApp();
  const payload = {
    action: 'created',
    installation: { id: 55555, account: { login: 'test-org' } },
    sender: { login: 'test-user' },
  };
  const body = JSON.stringify(payload);

  await app.request('/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'installation',
      'X-Hub-Signature-256': sign(body),
      'X-GitHub-Delivery': 'gh-del-001',
    },
    body,
  });

  expect(insertDelivery).toHaveBeenCalledWith(expect.objectContaining({
    deliveryId: 'gh-del-001',
    eventType: 'installation',
    action: 'created',
  }));
});
```

Add a new test in the `POST /github — Svix + PR dispatch` describe block:

```typescript
it('records delivery and creates pending review on valid PR event', async () => {
  process.env.SVIX_SKIP_VERIFICATION = 'true';
  process.env.NODE_ENV = 'test';
  vi.mocked(insertDelivery).mockResolvedValue({} as any);
  vi.mocked(insertReview).mockResolvedValue({ id: 'review-uuid' } as any);

  const app = createWebhookApp();
  const res = await app.request('/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': 'pull_request',
      'svix-id': 'svix-del-001',
    },
    body: JSON.stringify({
      action: 'opened',
      number: 42,
      repository: { owner: { login: 'acme' }, name: 'widgets' },
    }),
  });

  expect(res.status).toBe(202);
  expect(insertDelivery).toHaveBeenCalledWith(expect.objectContaining({
    deliveryId: 'svix-del-001',
    eventType: 'pull_request',
    action: 'opened',
    owner: 'acme',
    repo: 'widgets',
  }));
  expect(insertReview).toHaveBeenCalledWith({
    deliveryId: 'svix-del-001',
    owner: 'acme',
    repo: 'widgets',
    prNumber: 42,
  });
});

it('returns 200 duplicate for already-seen delivery_id', async () => {
  process.env.SVIX_SKIP_VERIFICATION = 'true';
  process.env.NODE_ENV = 'test';
  vi.mocked(isDuplicateDelivery).mockResolvedValue(true);

  const app = createWebhookApp();
  const res = await app.request('/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': 'pull_request',
      'svix-id': 'svix-dup-001',
    },
    body: JSON.stringify({
      action: 'opened',
      number: 42,
      repository: { owner: { login: 'acme' }, name: 'widgets' },
    }),
  });

  expect(res.status).toBe(200);
  const body = await res.json() as { accepted: boolean; reason: string };
  expect(body.accepted).toBe(false);
  expect(body.reason).toContain('Duplicate');
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npm test`
Expected: FAIL — `insertDelivery` not called, dedup still uses in-memory Set

**Step 3: Update webhook handler**

Replace the handler in `server/src/routes/webhooks.ts`:

1. Add imports:
```typescript
import { findUserByLogin, upsertInstallation, insertDelivery, isDuplicateDelivery, insertReview, updateReviewStatus } from '../db.js';
```

2. Remove the `DeduplicationSet` import and `const dedup = new DeduplicationSet();` line.

3. Extract the delivery ID early (fix the `X-GitHub-Delivery` fallback from the code review):
```typescript
const deliveryId = c.req.header('svix-id') ?? c.req.header('X-GitHub-Delivery') ?? crypto.randomUUID();
```

4. For **all events** (after verification, before event-specific handling), record the delivery:
```typescript
const parsedPayload = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
if (!parsedPayload) return c.json({ error: 'Invalid JSON' }, 400);

await insertDelivery({
  deliveryId,
  eventType: event,
  action: (parsedPayload as Record<string, unknown>).action as string ?? null,
  owner: null, // filled in for PR events below
  repo: null,
  payload: parsedPayload,
});
```

5. For the **installation** handler: remove the duplicate `JSON.parse` — use `parsedPayload` directly.

6. For the **pull_request** handler:
   - Replace `dedup.isDuplicate(deliveryId)` with `await isDuplicateDelivery(deliveryId)`
   - Remove `dedup.markSeen(deliveryId)` (the `insertDelivery` call handles this via UNIQUE constraint)
   - After validation, create the review record:
     ```typescript
     const review = await insertReview({ deliveryId, owner, repo, prNumber });
     ```
   - Pass `review.id` to the pipeline/trigger so it can update status.

7. For the **inline fallback** path, update status transitions:
```typescript
updateReviewStatus(review.id, { status: 'running' }).catch(() => {});

runReviewPipeline({ owner, repo, prNumber }, { log }).then(async (result) => {
  if (result.commentUrl) {
    await updateReviewStatus(review.id, { status: 'completed', commentUrl: result.commentUrl });
    console.log(`[review] Posted comment: ${result.commentUrl}`);
  } else {
    await updateReviewStatus(review.id, { status: 'failed', error: 'Empty review output' });
    console.warn(`[review] No review output for ${owner}/${repo}#${prNumber}`);
  }
}).catch(async (err) => {
  await updateReviewStatus(review.id, { status: 'failed', error: String(err) }).catch(() => {});
  console.error(`[review] Pipeline failed for ${owner}/${repo}#${prNumber}:`, err);
});
```

8. For the **Trigger.dev** path, the runner will need the `reviewId` — add it to the payload:
```typescript
const reviewPayload: ReviewPayload = { owner, repo, prNumber, deliveryId, reviewId: review.id };
```

**Step 4: Run tests to verify they pass**

Run: `cd server && npm test`
Expected: All tests PASS

**Step 5: Type check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add server/src/routes/webhooks.ts server/src/routes/webhooks.test.ts
git commit -m "feat(webhooks): record deliveries in DB, replace in-memory dedup"
```

---

### Task 4: Update ReviewPayload and Trigger.dev Runner to Track Status

**Files:**
- Modify: `server/src/review/runner.ts`

**Step 1: Update ReviewPayload interface**

Add `reviewId` to the interface in `server/src/review/runner.ts`:

```typescript
export interface ReviewPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
  reviewId: string;
}
```

**Step 2: Update the Trigger.dev task to call updateReviewStatus**

```typescript
import { task, logger } from "@trigger.dev/sdk/v3";
import { runReviewPipeline } from "./pipeline.js";
import { updateReviewStatus } from "../db.js";

export interface ReviewPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
  reviewId: string;
}

export const reviewPrTask = task({
  id: "review-pr",
  maxDuration: 300,

  run: async (payload: ReviewPayload) => {
    const { owner, repo, prNumber, reviewId } = payload;
    logger.info("Starting PR review", { owner, repo, prNumber, reviewId });

    await updateReviewStatus(reviewId, { status: 'running' });

    try {
      const result = await runReviewPipeline(
        { owner, repo, prNumber },
        {
          log: (step, message, data) => {
            if (data) {
              logger.info(`[${step}] ${message}`, data as Record<string, unknown>);
            } else {
              logger.info(`[${step}] ${message}`);
            }
          },
        }
      );

      if (!result.commentUrl) {
        await updateReviewStatus(reviewId, { status: 'failed', error: 'Empty review output' });
        logger.warn("Empty review output — skipping comment");
        return { skipped: true };
      }

      await updateReviewStatus(reviewId, { status: 'completed', commentUrl: result.commentUrl });
      return { commentUrl: result.commentUrl };
    } catch (err) {
      await updateReviewStatus(reviewId, { status: 'failed', error: String(err) }).catch(() => {});
      throw err; // re-throw so Trigger.dev marks the task as failed
    }
  },
});
```

**Step 3: Type check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add server/src/review/runner.ts
git commit -m "feat(runner): track review status in DB via updateReviewStatus"
```

---

### Task 5: Remove In-Memory DeduplicationSet (Dead Code Cleanup)

**Files:**
- Delete: `server/src/webhook/dedup.ts`
- Delete: `server/src/webhook/dedup.test.ts`
- Modify: `server/src/routes/webhooks.ts` (remove import if not already done in Task 3)

**Step 1: Verify no remaining references to DeduplicationSet**

Run: `cd server && grep -r "DeduplicationSet\|dedup" src/ --include="*.ts" | grep -v node_modules`
Expected: Only the files being deleted and possibly the test

**Step 2: Delete dead files**

```bash
rm server/src/webhook/dedup.ts server/src/webhook/dedup.test.ts
```

**Step 3: Run tests**

Run: `cd server && npm test`
Expected: All tests PASS (dedup tests are gone, webhook tests use DB-backed dedup)

**Step 4: Type check**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add -A server/src/webhook/dedup.ts server/src/webhook/dedup.test.ts
git commit -m "chore: remove in-memory DeduplicationSet (replaced by DB dedup)"
```

---

### Task 6: Add GITHUB_WEBHOOK_SECRET to .env.example

**Files:**
- Modify: `server/.env.example`

**Step 1: Add the variable**

Add after the `GITHUB_APP_PRIVATE_KEY` line:

```
GITHUB_WEBHOOK_SECRET=  # webhook secret set on GitHub App — used when Svix is not configured
```

**Step 2: Commit**

```bash
git add server/.env.example
git commit -m "docs: add GITHUB_WEBHOOK_SECRET to .env.example"
```

---

### Task 7: Deploy and Verify

**Step 1: Deploy to Railway**

```bash
cd /path/to/verify && railway up
```

Expected: Build succeeds, migration 002 applied on startup.

**Step 2: Deploy Trigger.dev worker**

```bash
cd server && npx trigger.dev@3.3.17 deploy
```

**Step 3: Redeliver webhook from Svix and verify**

- Check Railway logs: delivery recorded, review created
- Check Trigger.dev dashboard: task runs with status transitions
- Check database: `webhook_deliveries` and `pr_reviews` rows exist
- Check PR: comment posted

```sql
-- Verify via railway connect or psql
SELECT * FROM webhook_deliveries ORDER BY received_at DESC LIMIT 5;
SELECT * FROM pr_reviews ORDER BY created_at DESC LIMIT 5;
```

---

Plan complete and saved to `docs/plans/2026-03-12-webhook-delivery-tracking.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
