# Self-Serve Onboarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user installs the GitHub App, automatically create a demo PR in their repo and run the first review — no manual setup required.

**Architecture:**
- `installation.created` webhook (HMAC-verified) stores installation + repo list in DB. No side effects.
- `GET /auth/installed` renders a repo picker (multi-repo installs) or auto-confirm (single-repo), with real-time polling UI showing progress steps.
- `POST /auth/installed` (JWT-authenticated, org ownership check) atomically claims the demo PR slot, fires `createDemoPr` and `detectAndStoreRepoConfig` as fire-and-forget.
- `GET /auth/status?installation_id=X` is a polling endpoint returning `{ step, demo_pr_url, review_url }` — no auth required (returns only public-safe status).
- `pull_request.opened` checks `repo_configs` before running a review; dispatches detection if missing.
- Unified pipeline posts both a PR comment and a GitHub Check Run for every review result.
- `issue_comment` handler parses `/config` YAML replies and updates `repo_configs`.
- Admin page at `/admin/reviews` (JWT-gated) shows the reviews table for operational visibility.

**Tech Stack:** Hono + TypeScript, postgres.js, Trigger.dev `@trigger.dev/sdk`, vitest, GitHub REST API (`https://api.github.com`), `GitHubAppService` for installation tokens (`server/src/github/app-service.ts`)

---

### Task 1: DB Migrations + DB Helpers

**Files:**
- Create: `server/db/migrations/004_onboarding.sql`
- Modify: `server/src/db.ts`
- Modify: `server/src/db.test.ts`

**Step 1: Write the migration**

Create `server/db/migrations/004_onboarding.sql`:

```sql
-- 004_onboarding.sql
-- Add reviews table, repo_configs.status, and github_installations.demo_pr_triggered

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Track every review triggered
CREATE TABLE IF NOT EXISTS reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL REFERENCES github_installations(installation_id),
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  pr_title        TEXT,
  -- trigger_event avoids the PostgreSQL reserved word "trigger"
  trigger_event   TEXT NOT NULL,
  status          TEXT NOT NULL,
  result          JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add CHECK constraints separately so the migration is idempotent on replay
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'reviews' AND constraint_name = 'reviews_trigger_event_check'
  ) THEN
    ALTER TABLE reviews ADD CONSTRAINT reviews_trigger_event_check
      CHECK (trigger_event IN (
        'pull_request.opened',
        'pull_request.synchronize',
        'issue_comment.verify',
        'issue_comment.mention',
        'demo'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'reviews' AND constraint_name = 'reviews_status_check'
  ) THEN
    ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
      CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reviews_pr
  ON reviews (repo_owner, repo_name, pr_number);

CREATE INDEX IF NOT EXISTS idx_reviews_started
  ON reviews (started_at DESC);

-- Coordinate auto-detection with the review pipeline
ALTER TABLE repo_configs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'repo_configs' AND constraint_name = 'repo_configs_status_check'
  ) THEN
    ALTER TABLE repo_configs ADD CONSTRAINT repo_configs_status_check
      CHECK (status IN ('pending', 'ready', 'failed'));
  END IF;
END $$;

-- Idempotency: prevent duplicate demo PRs on POST /auth/installed replay
ALTER TABLE github_installations
  ADD COLUMN IF NOT EXISTS demo_pr_triggered BOOLEAN NOT NULL DEFAULT FALSE;

-- Store repos from installation.created payload for the post-install repo picker
ALTER TABLE github_installations
  ADD COLUMN IF NOT EXISTS repos JSONB;

-- Store sender login so users who install before signing in can still authorize POST /auth/installed
ALTER TABLE github_installations
  ADD COLUMN IF NOT EXISTS sender_login TEXT;

-- Store the repo the user selected on the post-install page; used by GET /auth/status polling
ALTER TABLE github_installations
  ADD COLUMN IF NOT EXISTS selected_repo TEXT;
```

**Step 2: Add TypeScript types and DB helpers to `server/src/db.ts`**

First, update the existing `upsertInstallation` function to accept `repos` and `senderLogin` (these are optional so existing callers are not broken):

```typescript
export async function upsertInstallation(params: {
  orgId: string | null;
  installationId: number;
  githubAccountLogin: string;
  senderLogin?: string;
  repos?: Array<{ name: string }>;
}): Promise<void> {
  await sql`
    INSERT INTO github_installations (org_id, installation_id, github_account_login, sender_login, repos)
    VALUES (
      ${params.orgId}, ${params.installationId}, ${params.githubAccountLogin},
      ${params.senderLogin ?? null},
      ${params.repos ? sql.json(params.repos) : null}
    )
    ON CONFLICT (installation_id)
    DO UPDATE SET
      org_id = COALESCE(EXCLUDED.org_id, github_installations.org_id),
      github_account_login = EXCLUDED.github_account_login,
      sender_login = COALESCE(EXCLUDED.sender_login, github_installations.sender_login),
      repos = COALESCE(EXCLUDED.repos, github_installations.repos)
  `;
}
```

Also add a new `findInstallation` helper for the POST /auth/installed ownership check:

```typescript
export async function findInstallation(installationId: number): Promise<{
  installation_id: number;
  org_id: string | null;
  github_account_login: string;
  sender_login: string | null;
  repos: Array<{ name: string }> | null;
  demo_pr_triggered: boolean;
  selected_repo: string | null;
} | null> {
  const [row] = await sql`
    SELECT installation_id, org_id, github_account_login, sender_login, repos,
           demo_pr_triggered, selected_repo
    FROM github_installations
    WHERE installation_id = ${installationId}
  `;
  return row ?? null;
}
```

Then, add `status` to the existing `RepoConfig` interface (after `sandbox_template`):

```typescript
  status: 'pending' | 'ready' | 'failed';
```

Then add these functions after `findRepoConfig`:

```typescript
export interface Review {
  id: string;
  installation_id: number;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  pr_title: string | null;
  trigger_event: string;
  status: string;
  result: Record<string, unknown> | null;
  started_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export async function insertReview(params: {
  installationId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prTitle?: string | null;
  triggerEvent: 'pull_request.opened' | 'pull_request.synchronize' | 'issue_comment.verify' | 'issue_comment.mention' | 'demo';
}): Promise<Review> {
  const [review] = await sql<Review[]>`
    INSERT INTO reviews (installation_id, repo_owner, repo_name, pr_number, pr_title, trigger_event, status)
    VALUES (${params.installationId}, ${params.repoOwner}, ${params.repoName},
            ${params.prNumber}, ${params.prTitle ?? null}, ${params.triggerEvent}, 'pending')
    RETURNING *
  `;
  return review;
}

export async function updateReviewStatus(params: {
  id: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error';
  result?: Record<string, unknown>;  // only updated when explicitly provided
  completedAt?: Date;
}): Promise<void> {
  if (params.result !== undefined) {
    await sql`
      UPDATE reviews
      SET status = ${params.status},
          result = ${sql.json(params.result)},
          completed_at = ${params.completedAt ?? null},
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  } else {
    await sql`
      UPDATE reviews
      SET status = ${params.status},
          completed_at = ${params.completedAt ?? null},
          updated_at = NOW()
      WHERE id = ${params.id}
    `;
  }
}

/**
 * Atomically claim the demo PR slot for an installation.
 * Returns true if this caller won the slot (should create the PR).
 * Returns false if another caller already claimed it (skip).
 * Eliminates TOCTOU race between check and mark.
 */
export async function claimDemoPrSlot(installationId: number): Promise<boolean> {
  const rows = await sql<Array<{ installation_id: number }>>`
    UPDATE github_installations
    SET demo_pr_triggered = TRUE
    WHERE installation_id = ${installationId}
      AND demo_pr_triggered = FALSE
    RETURNING installation_id
  `;
  return rows.length > 0;
}

export async function setRepoConfigStatus(
  owner: string,
  repo: string,
  status: 'pending' | 'ready' | 'failed',
): Promise<void> {
  await sql`
    UPDATE repo_configs SET status = ${status}, updated_at = NOW()
    WHERE owner = ${owner} AND repo = ${repo}
  `;
}

export async function upsertPendingRepoConfig(params: {
  installationId: number;
  owner: string;
  repo: string;
}): Promise<void> {
  await sql`
    INSERT INTO repo_configs (installation_id, owner, repo, dev_command, port, status)
    VALUES (${params.installationId}, ${params.owner}, ${params.repo}, 'npm run dev', 3000, 'pending')
    ON CONFLICT (owner, repo) DO NOTHING
  `;
}

export async function setInstallationSelectedRepo(installationId: number, repo: string): Promise<void> {
  await sql`
    UPDATE github_installations SET selected_repo = ${repo}
    WHERE installation_id = ${installationId}
  `;
}

export async function findLatestReview(owner: string, repo: string): Promise<{
  status: string;
  result: Record<string, unknown> | null;
} | null> {
  const [row] = await sql<Array<{ status: string; result: Record<string, unknown> | null }>>`
    SELECT status, result FROM reviews
    WHERE repo_owner = ${owner} AND repo_name = ${repo}
    ORDER BY started_at DESC LIMIT 1
  `;
  return row ?? null;
}
```

**Step 3: Write the DB integration tests**

In `server/src/db.test.ts`, update the `beforeAll` cleanup to include the reviews table:

```typescript
    await sql`DELETE FROM reviews`;  // add before repo_configs delete
    await sql`DELETE FROM repo_configs`;
```

Then add these describe blocks at the end of the integration test file:

```typescript
  describe('reviews', () => {
    it('inserts a review with pending status', async () => {
      const { insertReview } = await import('./db.js');
      const review = await insertReview({
        installationId: 55001,
        repoOwner: 'testorg',
        repoName: 'testrepo',
        prNumber: 1,
        prTitle: 'Test PR',
        triggerEvent: 'pull_request.opened',
      });
      expect(review.id).toBeTruthy();
      expect(review.status).toBe('pending');
      expect(review.trigger_event).toBe('pull_request.opened');
    });

    it('updateReviewStatus transitions to passed', async () => {
      const { insertReview, updateReviewStatus } = await import('./db.js');
      const review = await insertReview({
        installationId: 55001,
        repoOwner: 'testorg',
        repoName: 'testrepo',
        prNumber: 2,
        triggerEvent: 'demo',
      });
      await updateReviewStatus({
        id: review.id,
        status: 'passed',
        result: { passed: 3, failed: 0 },
        completedAt: new Date(),
      });
      const [updated] = await sql`SELECT * FROM reviews WHERE id = ${review.id}`;
      expect(updated.status).toBe('passed');
      expect(updated.result).toEqual({ passed: 3, failed: 0 });
      expect(updated.completed_at).not.toBeNull();
    });

    it('updateReviewStatus without result does not wipe existing result', async () => {
      const { insertReview, updateReviewStatus } = await import('./db.js');
      const review = await insertReview({
        installationId: 55001,
        repoOwner: 'testorg',
        repoName: 'testrepo',
        prNumber: 3,
        triggerEvent: 'demo',
      });
      await updateReviewStatus({ id: review.id, status: 'running', result: { note: 'initial' } });
      await updateReviewStatus({ id: review.id, status: 'passed' }); // no result
      const [updated] = await sql`SELECT * FROM reviews WHERE id = ${review.id}`;
      // result should be preserved from the previous call
      expect(updated.result).toEqual({ note: 'initial' });
      expect(updated.status).toBe('passed');
    });
  });

  describe('claimDemoPrSlot', () => {
    it('returns true on first call', async () => {
      const { claimDemoPrSlot } = await import('./db.js');
      // install 55001 was set to true in earlier tests; use a fresh one
      const { upsertInstallation } = await import('./db.js');
      await upsertInstallation({ orgId: null, installationId: 66001, githubAccountLogin: 'slot-test' });
      const claimed = await claimDemoPrSlot(66001);
      expect(claimed).toBe(true);
    });

    it('returns false on second call (already claimed)', async () => {
      const { claimDemoPrSlot } = await import('./db.js');
      const claimed = await claimDemoPrSlot(66001);
      expect(claimed).toBe(false);
    });
  });
```

**Step 4: Run migration test**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/migrate.test.ts
```

Expected: PASS

**Step 5: Run DB integration tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/db.test.ts
```

Expected: All tests pass including new ones

**Step 6: Commit**

```bash
cd server && git add db/migrations/004_onboarding.sql src/db.ts src/db.test.ts
git commit -m "feat: add reviews table, repo_config status, atomic demo PR claim"
```

---

### Task 2: Shared GitHub Headers + Repo API Helper

**Files:**
- Modify: `server/src/github/pr.ts`
- Create: `server/src/github/repo-api.ts`
- Create: `server/src/github/repo-api.test.ts`

**Step 1: Export shared constants from `server/src/github/pr.ts`**

The `GITHUB_API` constant and `githubHeaders` function already exist in `pr.ts`. Export them so `repo-api.ts` can import them instead of duplicating:

Change:
```typescript
const GITHUB_API = "https://api.github.com";
```
To:
```typescript
export const GITHUB_API = "https://api.github.com";
```

Change:
```typescript
function githubHeaders(token: string): Record<string, string> {
```
To:
```typescript
export function githubHeaders(token: string): Record<string, string> {
```

**Step 2: Write the failing tests**

Create `server/src/github/repo-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFileContent, getDefaultBranch, branchExists } from './repo-api.js';

const TOKEN = 'ghs_test_token';

// Clean up global.fetch mock after each test
afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchFileContent', () => {
  it('returns null for 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    const result = await fetchFileContent('owner', 'repo', 'README.md', TOKEN);
    expect(result).toBeNull();
  });

  it('returns decoded content and sha on success', async () => {
    const encoded = Buffer.from('hello world').toString('base64');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: encoded + '\n', encoding: 'base64', sha: 'abc123' }), { status: 200 }),
    );
    const result = await fetchFileContent('owner', 'repo', 'README.md', TOKEN);
    expect(result?.content).toBe('hello world');
    expect(result?.sha).toBe('abc123');
  });

  it('throws on non-404 error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 500 }),
    );
    await expect(fetchFileContent('owner', 'repo', 'file.txt', TOKEN)).rejects.toThrow('500');
  });
});

describe('getDefaultBranch', () => {
  it('returns default_branch from repo metadata', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 }),
    );
    const branch = await getDefaultBranch('owner', 'repo', TOKEN);
    expect(branch).toBe('main');
  });
});

describe('branchExists', () => {
  it('returns true when branch exists (200)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await branchExists('owner', 'repo', 'opslane/demo', TOKEN)).toBe(true);
  });

  it('returns false on 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    expect(await branchExists('owner', 'repo', 'opslane/demo', TOKEN)).toBe(false);
  });

  it('URL-encodes branch names with slashes', async () => {
    const spy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    await branchExists('owner', 'repo', 'opslane/demo', TOKEN);
    const calledUrl = (spy.mock.calls[0][0] as string);
    expect(calledUrl).toContain('opslane%2Fdemo');
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/github/repo-api.test.ts
```

Expected: FAIL with "Cannot find module './repo-api.js'"

**Step 4: Implement `server/src/github/repo-api.ts`**

```typescript
import { GITHUB_API, githubHeaders } from './pr.js';

export interface FileContent {
  content: string;
  sha: string;
}

export async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  token: string,
): Promise<FileContent | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { headers: githubHeaders(token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error fetching ${path}: ${res.status}`);
  const data = await res.json() as { content: string; sha: string };
  const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

export async function getDefaultBranch(owner: string, repo: string, token: string): Promise<string> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) throw new Error(`GitHub API error fetching repo metadata: ${res.status}`);
  const data = await res.json() as { default_branch: string };
  return data.default_branch;
}

export async function branchExists(owner: string, repo: string, branch: string, token: string): Promise<boolean> {
  const encoded = encodeURIComponent(branch);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encoded}`,
    { headers: githubHeaders(token) },
  );
  // Consume response body to avoid resource leaks
  await res.text().catch(() => {});
  return res.ok;
}

export async function getBranchSha(owner: string, repo: string, branch: string, token: string): Promise<string> {
  const encoded = encodeURIComponent(branch);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${encoded}`,
    { headers: githubHeaders(token) },
  );
  if (!res.ok) throw new Error(`GitHub API error getting branch SHA: ${res.status}`);
  const data = await res.json() as { object: { sha: string } };
  return data.object.sha;
}

export async function createBranch(
  owner: string,
  repo: string,
  branch: string,
  fromSha: string,
  token: string,
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs`,
    {
      method: 'POST',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error creating branch: ${res.status} ${body}`);
  }
  await res.text().catch(() => {});
}

export async function putFile(params: {
  owner: string;
  repo: string;
  path: string;
  message: string;
  content: string;
  branch: string;
  sha?: string;
  token: string;
}): Promise<void> {
  const body: Record<string, string> = {
    message: params.message,
    content: Buffer.from(params.content).toString('base64'),
    branch: params.branch,
  };
  if (params.sha) body.sha = params.sha;

  const res = await fetch(
    `${GITHUB_API}/repos/${params.owner}/${params.repo}/contents/${params.path}`,
    {
      method: 'PUT',
      headers: { ...githubHeaders(params.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error writing file: ${res.status} ${errBody}`);
  }
  await res.text().catch(() => {});
}

export async function createPullRequest(params: {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  token: string;
}): Promise<{ number: number; url: string }> {
  const res = await fetch(
    `${GITHUB_API}/repos/${params.owner}/${params.repo}/pulls`,
    {
      method: 'POST',
      headers: { ...githubHeaders(params.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      }),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub API error creating PR: ${res.status} ${errBody}`);
  }
  const data = await res.json() as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}
```

**Step 5: Run tests to verify they pass**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/github/repo-api.test.ts
```

Expected: PASS (7 tests including URL-encoding test)

**Step 6: Type check**

```bash
cd server && npx tsc --noEmit
```

**Step 7: Commit**

```bash
cd server && git add src/github/pr.ts src/github/repo-api.ts src/github/repo-api.test.ts
git commit -m "feat: add repo API helpers (file read/write, branch, PR); export shared headers"
```

---

### Task 2.5: Shared GitHubAppService Singleton

Both `auth.ts` and `webhooks.ts` currently create module-level `GitHubAppService` instances, each parsing the RSA private key separately. This task extracts a single shared instance to avoid duplicate key parsing.

**Files:**
- Create: `server/src/github/app-instance.ts`
- Modify: `server/src/routes/auth.ts` (remove local instance, import shared one)
- Modify: `server/src/routes/webhooks.ts` (remove local instance, import shared one)

**Step 1: Create `server/src/github/app-instance.ts`**

```typescript
import { GitHubAppService } from './app-service.js';

/**
 * Shared GitHubAppService singleton.
 * Parsing the RSA private key is expensive — do it once at module load.
 * Returns null if env vars are not set (so routes can handle the degraded case gracefully).
 */
export const githubApp: GitHubAppService | null =
  process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
    ? new GitHubAppService(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY)
    : null;
```

**Step 2: Update `auth.ts` to remove its local instance and import from app-instance**

Remove:
```typescript
// Module-level GitHub App service (reuses RSA key parse across requests)
const githubAppForAuth = process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
  ? new GitHubAppService(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY)
  : null;
```

Replace with:
```typescript
import { githubApp as githubAppForAuth } from '../github/app-instance.js';
```

**Step 3: Update `webhooks.ts` to remove its local instance and import from app-instance**

Remove (or replace) the existing `const githubApp = ...` initialization and import:
```typescript
import { githubApp } from '../github/app-instance.js';
```

**Step 4: Type check**

```bash
cd server && npx tsc --noEmit
```

**Step 5: Commit**

```bash
cd server && git add src/github/app-instance.ts src/routes/auth.ts src/routes/webhooks.ts
git commit -m "refactor: shared GitHubAppService singleton in app-instance.ts"
```

---

### Task 3: Post-Install Page (GET + POST /auth/installed) + Status Polling

This task is larger than others because it owns all three new user-facing interactions: repo picker, demo PR trigger, and real-time progress.

**Files:**
- Modify: `server/src/routes/auth.ts`
- Create: `server/src/public/installed.html`
- Modify: `server/src/routes/auth.test.ts`

**Step 1: Write the failing tests**

In `server/src/routes/auth.test.ts`, add at the bottom:

```typescript
// Mock DB helpers used by the new /auth/installed routes
vi.mock('../db.js', async (importActual) => {
  const actual = await importActual<typeof import('../db.js')>();
  return {
    ...actual,
    findInstallation: vi.fn(),
    claimDemoPrSlot: vi.fn(),
    upsertPendingRepoConfig: vi.fn(),
    setInstallationSelectedRepo: vi.fn(),
    findRepoConfig: vi.fn(),
    findLatestReview: vi.fn(),
  };
});

// Mock onboarding modules (fire-and-forget paths)
vi.mock('../onboarding/demo-pr.js', () => ({ createDemoPr: vi.fn().mockResolvedValue(null) }));
vi.mock('../onboarding/detect-config.js', () => ({ detectAndStoreRepoConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../github/app-service.js', () => ({
  GitHubAppService: vi.fn().mockImplementation(() => ({
    getTokenForRepo: vi.fn().mockResolvedValue({ token: 'ghs_mock', installationId: 12345 }),
  })),
}));

describe('GET /auth/installed', () => {
  it('returns 200 with HTML for any installation_id (read-only)', async () => {
    const app = new Hono();
    app.route('/auth', authRouter);
    const res = await app.request('/auth/installed?installation_id=12345');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Opslane');
  });

  it('returns 200 with no installation_id (graceful fallback)', async () => {
    const app = new Hono();
    app.route('/auth', authRouter);
    const res = await app.request('/auth/installed');
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/installed', () => {
  it('returns 401 without JWT session', async () => {
    const app = new Hono();
    app.route('/auth', authRouter);
    const res = await app.request('/auth/installed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: 12345, repo_name: 'myrepo' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when installation not found or user does not own it', async () => {
    const { findInstallation } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue(null);

    const app = new Hono();
    app.route('/auth', authRouter);
    // Sign a fake JWT for the test — use the same JWT_SECRET as the app
    const jwt = sign({ login: 'testuser' }, process.env.JWT_SECRET ?? 'test-secret');
    const res = await app.request('/auth/installed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `session=${jwt}`,
      },
      body: JSON.stringify({ installation_id: 99999, repo_name: 'myrepo' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 when slot already claimed (idempotent)', async () => {
    const { findInstallation, claimDemoPrSlot } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue({
      installation_id: 12345, org_id: 'org-uuid', github_account_login: 'myorg',
      sender_login: 'testuser', repos: [{ name: 'myrepo' }], demo_pr_triggered: true,
    });
    vi.mocked(claimDemoPrSlot).mockResolvedValue(false);

    const app = new Hono();
    app.route('/auth', authRouter);
    const jwt = sign({ login: 'testuser' }, process.env.JWT_SECRET ?? 'test-secret');
    const res = await app.request('/auth/installed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': `session=${jwt}` },
      body: JSON.stringify({ installation_id: 12345, repo_name: 'myrepo' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already_started).toBe(true);
  });
});

describe('GET /auth/status', () => {
  // Shared mock for findRepoConfig and findLatestReview — set per test
  it('returns installing when installation not found yet', async () => {
    const { findInstallation } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue(null);

    const app = new Hono();
    app.route('/auth', authRouter);
    const res = await app.request('/auth/status?installation_id=99999');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step).toBe('installing');
  });

  it('returns setup_started when installation found but demo_pr_triggered is false', async () => {
    const { findInstallation } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue({
      installation_id: 12345, org_id: null, github_account_login: 'myorg',
      sender_login: 'testuser', repos: [{ name: 'myrepo' }],
      demo_pr_triggered: false, selected_repo: null,
    });

    const app = new Hono();
    app.route('/auth', authRouter);
    const res = await app.request('/auth/status?installation_id=12345');
    expect((await res.json()).step).toBe('setup_started');
  });

  it('returns demo_pr_created when demo PR triggered but config not ready', async () => {
    const { findInstallation, findRepoConfig } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue({
      installation_id: 12345, org_id: null, github_account_login: 'myorg',
      sender_login: 'testuser', repos: [{ name: 'myrepo' }],
      demo_pr_triggered: true, selected_repo: 'myrepo',
    });
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg', installation_id: 12345, owner: 'myorg', repo: 'myrepo',
      dev_command: 'npm run dev', port: 3000, install_command: null,
      health_path: '/', test_email: null, test_password: null,
      env_vars: null, compose_file: null, schema_command: null,
      seed_command: null, login_script: null, sandbox_template: null,
      status: 'pending', created_at: new Date(), updated_at: new Date(),
    });

    const app = new Hono();
    app.route('/auth', authRouter);
    expect((await (await app.request('/auth/status?installation_id=12345')).json()).step).toBe('demo_pr_created');
  });

  it('returns config_detected when config is ready but no review yet', async () => {
    const { findInstallation, findRepoConfig, findLatestReview } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue({
      installation_id: 12345, org_id: null, github_account_login: 'myorg',
      sender_login: 'testuser', repos: [{ name: 'myrepo' }],
      demo_pr_triggered: true, selected_repo: 'myrepo',
    });
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg', installation_id: 12345, owner: 'myorg', repo: 'myrepo',
      dev_command: 'npm run dev', port: 3000, install_command: null,
      health_path: '/', test_email: null, test_password: null,
      env_vars: null, compose_file: null, schema_command: null,
      seed_command: null, login_script: null, sandbox_template: null,
      status: 'ready', created_at: new Date(), updated_at: new Date(),
    });
    vi.mocked(findLatestReview).mockResolvedValue(null);

    const app = new Hono();
    app.route('/auth', authRouter);
    expect((await (await app.request('/auth/status?installation_id=12345')).json()).step).toBe('config_detected');
  });

  it('returns review_complete with review_url when review is done', async () => {
    const { findInstallation, findRepoConfig, findLatestReview } = await import('../db.js');
    vi.mocked(findInstallation).mockResolvedValue({
      installation_id: 12345, org_id: null, github_account_login: 'myorg',
      sender_login: 'testuser', repos: [{ name: 'myrepo' }],
      demo_pr_triggered: true, selected_repo: 'myrepo',
    });
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg', installation_id: 12345, owner: 'myorg', repo: 'myrepo',
      dev_command: 'npm run dev', port: 3000, install_command: null,
      health_path: '/', test_email: null, test_password: null,
      env_vars: null, compose_file: null, schema_command: null,
      seed_command: null, login_script: null, sandbox_template: null,
      status: 'ready', created_at: new Date(), updated_at: new Date(),
    });
    vi.mocked(findLatestReview).mockResolvedValue({
      status: 'passed',
      result: { comment_url: 'https://github.com/myorg/myrepo/pull/1#issuecomment-123' },
    });

    const app = new Hono();
    app.route('/auth', authRouter);
    const body = await (await app.request('/auth/status?installation_id=12345')).json();
    expect(body.step).toBe('review_complete');
    expect(body.review_url).toBe('https://github.com/myorg/myrepo/pull/1#issuecomment-123');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/auth.test.ts -t "POST /auth/installed|GET /auth/status"
```

Expected: FAIL with 404

**Step 3: Create `server/src/public/installed.html`**

This page serves as both the single-repo confirmation and multi-repo picker. It reads the repo list from the URL-embedded JSON (passed by the server via template substitution) and shows a radio picker if multiple repos are present. It polls `GET /auth/status` every 3 seconds and shows live progress.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Opslane — Setting up</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      min-height: 100vh; display: flex; align-items: center;
      justify-content: center; padding: 2rem;
    }
    .card {
      max-width: 520px; width: 100%;
      background: #161b22; border: 1px solid #30363d;
      border-radius: 12px; padding: 2.5rem;
    }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 0.5rem; }
    .sub { color: #8b949e; margin-bottom: 1.5rem; font-size: 0.9rem; line-height: 1.5; }
    .repo-list { margin-bottom: 1.5rem; }
    .repo-option {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.75rem; border: 1px solid #30363d; border-radius: 8px;
      margin-bottom: 0.5rem; cursor: pointer;
    }
    .repo-option:has(input:checked) { border-color: #388bfd; background: #0d2044; }
    .repo-option input { accent-color: #388bfd; }
    .repo-name { font-size: 0.95rem; font-weight: 500; }
    button.primary {
      width: 100%; padding: 0.75rem; background: #238636;
      color: #fff; border: none; border-radius: 6px;
      font-size: 0.95rem; font-weight: 500; cursor: pointer;
      margin-bottom: 1.5rem;
    }
    button.primary:hover { background: #2ea043; }
    button.primary:disabled { background: #21262d; color: #8b949e; cursor: default; }
    .steps { list-style: none; }
    .steps li {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.5rem 0; color: #8b949e; font-size: 0.9rem;
    }
    .steps li.done { color: #3fb950; }
    .steps li.active { color: #e6edf3; }
    .step-icon { font-size: 1rem; width: 1.2rem; text-align: center; }
    .commands {
      margin-top: 1.5rem; background: #0d1117;
      border: 1px solid #30363d; border-radius: 8px; padding: 1.25rem;
    }
    .commands h2 {
      font-size: 0.8rem; color: #8b949e; margin-bottom: 0.75rem;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .cmd { font-family: monospace; font-size: 0.9rem; color: #79c0ff; margin-bottom: 0.2rem; }
    .cmd-desc { font-size: 0.8rem; color: #8b949e; margin-bottom: 0.75rem; }
    a.gh-link {
      display: inline-block; margin-top: 1rem;
      color: #388bfd; text-decoration: none; font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Setting up Opslane</h1>
    <p class="sub">We'll create a demo PR and run your first automated review.</p>

    <div id="picker-section">
      <div class="repo-list" id="repo-list"></div>
      <button class="primary" id="start-btn" onclick="start()">Start demo →</button>
    </div>

    <ul class="steps" id="steps" style="display:none">
      <li id="step-pr"><span class="step-icon">○</span> Creating demo PR</li>
      <li id="step-detect"><span class="step-icon">○</span> Detecting repo config</li>
      <li id="step-review"><span class="step-icon">○</span> Running first review</li>
      <li id="step-done" style="display:none">
        <span class="step-icon">✓</span>
        <span>Done! <a class="gh-link" id="review-link" href="#">View review →</a></span>
      </li>
    </ul>

    <div class="commands" id="commands-section" style="display:none">
      <h2>Trigger reviews anytime</h2>
      <div class="cmd">/verify</div>
      <div class="cmd-desc">Run acceptance criteria check</div>
      <div class="cmd">@opslane review</div>
      <div class="cmd-desc">Ask for a code review</div>
    </div>
  </div>

  <script>
    const installationId = new URLSearchParams(location.search).get('installation_id');
    const repos = __REPOS_JSON__;  // replaced by server-side template substitution

    // Render repo picker
    const list = document.getElementById('repo-list');
    if (repos.length === 0) {
      list.innerHTML = '<p style="color:#8b949e;font-size:0.9rem">No repos found. Visit GitHub to add repos to Opslane.</p>';
      document.getElementById('start-btn').disabled = true;
    } else if (repos.length === 1) {
      list.innerHTML = `<div class="repo-option"><input type="radio" name="repo" value="${repos[0].name}" checked><span class="repo-name">${repos[0].name}</span></div>`;
    } else {
      list.innerHTML = repos.map((r, i) =>
        `<label class="repo-option"><input type="radio" name="repo" value="${r.name}" ${i===0?'checked':''}><span class="repo-name">${r.name}</span></label>`
      ).join('');
    }

    async function start() {
      const selected = document.querySelector('input[name="repo"]:checked')?.value;
      if (!selected) return;
      document.getElementById('start-btn').disabled = true;
      document.getElementById('picker-section').style.display = 'none';
      document.getElementById('steps').style.display = 'block';

      await fetch('/auth/installed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installation_id: Number(installationId), repo_name: selected }),
      });

      poll();
    }

    let pollInterval;
    function poll() {
      pollInterval = setInterval(async () => {
        const res = await fetch(`/auth/status?installation_id=${installationId}`);
        const data = await res.json();
        updateSteps(data);
      }, 3000);
      // Timeout after 5 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
      }, 300_000);
    }

    function updateSteps({ step, demo_pr_url, review_url }) {
      const steps = { pr: 'step-pr', detect: 'step-detect', review: 'step-review' };
      const order = ['setup_started', 'demo_pr_created', 'config_detected', 'review_running', 'review_complete'];
      const idx = order.indexOf(step);

      if (idx >= 1) mark('step-pr', 'done');
      if (idx >= 3) mark('step-detect', 'done');
      if (idx >= 4) {
        mark('step-review', 'done');
        const doneEl = document.getElementById('step-done');
        doneEl.style.display = 'flex';
        if (review_url) document.getElementById('review-link').href = review_url;
        document.getElementById('commands-section').style.display = 'block';
        clearInterval(pollInterval);
      } else if (idx >= 1) mark('step-detect', 'active');
      else mark('step-pr', 'active');
    }

    function mark(id, cls) {
      const el = document.getElementById(id);
      el.className = cls;
      el.querySelector('.step-icon').textContent = cls === 'done' ? '✓' : '●';
    }
  </script>
</body>
</html>
```

**Step 4: Add `GET /auth/installed`, `POST /auth/installed`, and `GET /auth/status` to `server/src/routes/auth.ts`**

Add at the top of the file:

```typescript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign, verify } from 'hono/jwt';
import { findInstallation, claimDemoPrSlot, upsertPendingRepoConfig, findRepoConfig,
         setInstallationSelectedRepo, findLatestReview } from '../db.js';
import { createDemoPr } from '../onboarding/demo-pr.js';
import { detectAndStoreRepoConfig } from '../onboarding/detect-config.js';
import { GitHubAppService } from '../github/app-service.js';
```

Add after the imports:

```typescript
const __dirnameAuth = dirname(fileURLToPath(import.meta.url));
const installedHtmlTemplate = readFileSync(join(__dirnameAuth, '../public/installed.html'), 'utf8');

// Module-level GitHub App service (reuses RSA key parse across requests)
const githubAppForAuth = process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY
  ? new GitHubAppService(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY)
  : null;
```

Add the three routes after the `/callback` handler:

```typescript
// GET /auth/installed — repo picker or single-repo confirmation page
// Read-only: renders HTML. No side effects.
authRouter.get('/installed', async (c) => {
  const installationId = c.req.query('installation_id');
  let repos: Array<{ name: string }> = [];

  if (installationId) {
    const installation = await findInstallation(Number(installationId)).catch(() => null);
    repos = installation?.repos ?? [];
  }

  // Inject repo list as JSON into the HTML template
  const html = installedHtmlTemplate.replace('__REPOS_JSON__', JSON.stringify(repos));
  return c.html(html);
});

// POST /auth/installed — authenticated: fires demo PR for selected repo
authRouter.post('/installed', async (c) => {
  // Require JWT session
  const sessionCookie = getCookie(c, 'session');
  if (!sessionCookie) return c.json({ error: 'Authentication required' }, 401);

  let sessionUser: string;
  try {
    const payload = await verify(sessionCookie, env('JWT_SECRET'));
    sessionUser = payload.login as string;
  } catch {
    return c.json({ error: 'Invalid session' }, 401);
  }

  let body: { installation_id?: number; repo_name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const { installation_id: installationId, repo_name: repoName } = body;
  if (!installationId || !repoName) {
    return c.json({ error: 'Missing installation_id or repo_name' }, 400);
  }

  // Verify the session user owns this installation
  // (org_id match OR sender_login match for users who installed before signing in)
  const installation = await findInstallation(installationId);
  if (!installation) {
    return c.json({ error: 'Installation not found' }, 403);
  }

  // Check ownership: sender_login must match the session user.
  // NOTE: org_id-based check for users who joined an existing installation is deferred.
  // See TODOS.md: "P3 — org_id-based ownership check on POST /auth/installed"
  const sessionUserOwns = installation.sender_login === sessionUser;
  if (!sessionUserOwns) {
    console.error(`[auth/installed] ownership check failed: installation=${installationId} user=${sessionUser}`);
    return c.json({ error: 'Not authorized' }, 403);
  }

  // Atomically claim the demo PR slot
  const claimed = await claimDemoPrSlot(installationId);
  if (!claimed) {
    return c.json({ accepted: true, already_started: true }, 200);
  }

  // Store selected repo so GET /auth/status can track progress for the right repo
  await setInstallationSelectedRepo(installationId, repoName);

  // Fire demo PR and config detection — non-blocking
  const owner = installation.github_account_login;
  if (githubAppForAuth) {
    githubAppForAuth.getTokenForRepo(owner, repoName)
      .then(({ token, installationId: iid }) => Promise.all([
        createDemoPr(owner, repoName, token)
          .then((pr) => {
            if (pr) console.log(`[onboarding] demo PR created: ${owner}/${repoName}#${pr.number}`);
          }),
        upsertPendingRepoConfig({ installationId: iid, owner, repo: repoName })
          .then(() => detectAndStoreRepoConfig({ owner, repo: repoName, installationId: iid, token })),
      ]))
      .catch((err) => {
        console.error(`[onboarding] failed for ${owner}/${repoName}:`, err);
      });
  }

  console.log(`[onboarding] demo PR initiated for ${owner}/${repoName} by ${sessionUser}`);
  return c.json({ accepted: true }, 202);
});

// GET /auth/status — polling endpoint for real-time post-install page
// No auth required — returns only public-safe status fields
authRouter.get('/status', async (c) => {
  const installationIdStr = c.req.query('installation_id');
  if (!installationIdStr) return c.json({ step: 'installing' });

  const installationId = Number(installationIdStr);
  const installation = await findInstallation(installationId).catch(() => null);
  if (!installation) return c.json({ step: 'installing' });

  if (!installation.demo_pr_triggered) {
    return c.json({ step: 'setup_started' });
  }

  // Use the repo the user selected on the post-install page (stored by POST /auth/installed)
  const selectedRepo = installation.selected_repo;
  if (!selectedRepo) return c.json({ step: 'demo_pr_created' });

  const config = await findRepoConfig(installation.github_account_login, selectedRepo).catch(() => null);
  if (!config || config.status === 'pending') {
    return c.json({ step: 'demo_pr_created' });
  }

  // Check if a review has completed for the selected repo
  const latestReview = await findLatestReview(installation.github_account_login, selectedRepo).catch(() => null);

  if (!latestReview) return c.json({ step: 'config_detected' });
  if (latestReview.status === 'running' || latestReview.status === 'pending') {
    return c.json({ step: 'review_running' });
  }

  // Review complete — return the PR URL from the review result
  const reviewUrl = latestReview.result?.comment_url as string | undefined;
  return c.json({ step: 'review_complete', review_url: reviewUrl });
});
```

**Step 5: Run auth tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/auth.test.ts
```

Expected: All tests pass

**Step 6: Type check**

```bash
cd server && npx tsc --noEmit
```

**Step 7: Commit**

```bash
cd server && git add src/routes/auth.ts src/public/installed.html
git commit -m "feat: GET/POST /auth/installed repo picker + GET /auth/status polling endpoint"
```

---

### Task 4: Demo PR Creation

**Files:**
- Create: `server/src/onboarding/demo-pr.ts`
- Create: `server/src/onboarding/demo-pr.test.ts`
- Modify: `server/src/routes/webhooks.ts`
- Modify: `server/src/routes/webhooks.test.ts`

**Step 1: Write the failing tests**

Create `server/src/onboarding/demo-pr.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../github/repo-api.js', () => ({
  getDefaultBranch: vi.fn(),
  branchExists: vi.fn(),
  getBranchSha: vi.fn(),
  createBranch: vi.fn(),
  fetchFileContent: vi.fn(),
  putFile: vi.fn(),
  createPullRequest: vi.fn(),
}));

import {
  getDefaultBranch, branchExists, getBranchSha,
  createBranch, fetchFileContent, putFile, createPullRequest,
} from '../github/repo-api.js';
import { createDemoPr } from './demo-pr.js';

beforeEach(() => vi.clearAllMocks());

describe('createDemoPr', () => {
  it('creates branch and PR when opslane/demo does not exist', async () => {
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(getBranchSha).mockResolvedValue('abc123');
    vi.mocked(fetchFileContent).mockResolvedValue({ content: '# My Project\n', sha: 'readme-sha' });
    vi.mocked(putFile).mockResolvedValue(undefined);
    vi.mocked(createBranch).mockResolvedValue(undefined);
    vi.mocked(createPullRequest).mockResolvedValue({ number: 1, url: 'https://github.com/owner/repo/pull/1' });

    const result = await createDemoPr('owner', 'repo', 'ghs_token');
    expect(result).toEqual({ number: 1, url: 'https://github.com/owner/repo/pull/1' });
    expect(createBranch).toHaveBeenCalledWith('owner', 'repo', 'opslane/demo', 'abc123', 'ghs_token');
    expect(createPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      head: 'opslane/demo', base: 'main',
    }));
  });

  it('returns null when opslane/demo branch already exists', async () => {
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
    vi.mocked(branchExists).mockResolvedValue(true);

    const result = await createDemoPr('owner', 'repo', 'ghs_token');
    expect(result).toBeNull();
    expect(createBranch).not.toHaveBeenCalled();
  });

  it('creates a new README.md when none exists', async () => {
    vi.mocked(getDefaultBranch).mockResolvedValue('main');
    vi.mocked(branchExists).mockResolvedValue(false);
    vi.mocked(getBranchSha).mockResolvedValue('abc123');
    vi.mocked(fetchFileContent).mockResolvedValue(null);
    vi.mocked(putFile).mockResolvedValue(undefined);
    vi.mocked(createBranch).mockResolvedValue(undefined);
    vi.mocked(createPullRequest).mockResolvedValue({ number: 2, url: 'https://github.com/owner/repo/pull/2' });

    await createDemoPr('owner', 'repo', 'ghs_token');
    const putCall = vi.mocked(putFile).mock.calls[0][0];
    expect(putCall.path).toBe('README.md');
    expect(putCall.sha).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/onboarding/demo-pr.test.ts
```

Expected: FAIL with "Cannot find module './demo-pr.js'"

**Step 3: Implement `server/src/onboarding/demo-pr.ts`**

```typescript
import {
  getDefaultBranch, branchExists, getBranchSha,
  createBranch, fetchFileContent, putFile, createPullRequest,
} from '../github/repo-api.js';

const DEMO_BRANCH = 'opslane/demo';
const BADGE = '[![Opslane](https://img.shields.io/badge/Opslane-enabled-brightgreen)](https://opslane.dev)';

const PR_BODY = `## Demo: Opslane is set up ✓

This PR was automatically created to show Opslane in action.

Opslane will now automatically:
- Review every PR for code quality
- Run acceptance criteria checks when you comment \`/verify\`

You can close or merge this PR — it's just a demo.`;

export async function createDemoPr(
  owner: string,
  repo: string,
  token: string,
): Promise<{ number: number; url: string } | null> {
  const defaultBranch = await getDefaultBranch(owner, repo, token);

  if (await branchExists(owner, repo, DEMO_BRANCH, token)) {
    console.log(`[demo-pr] ${DEMO_BRANCH} already exists in ${owner}/${repo}, skipping`);
    return null;
  }

  const baseSha = await getBranchSha(owner, repo, defaultBranch, token);
  await createBranch(owner, repo, DEMO_BRANCH, baseSha, token);

  const readme = await fetchFileContent(owner, repo, 'README.md', token);

  if (readme) {
    await putFile({
      owner, repo,
      path: 'README.md',
      message: 'Add Opslane badge',
      content: `${BADGE}\n\n${readme.content}`,
      branch: DEMO_BRANCH,
      sha: readme.sha,
      token,
    });
  } else {
    await putFile({
      owner, repo,
      path: 'README.md',
      message: 'Add README with Opslane badge',
      content: `${BADGE}\n\n# ${repo}\n`,
      branch: DEMO_BRANCH,
      token,
    });
  }

  return createPullRequest({
    owner, repo,
    title: 'Add Opslane badge',
    body: PR_BODY,
    head: DEMO_BRANCH,
    base: defaultBranch,
    token,
  });
}
```

**Step 4: Run tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/onboarding/demo-pr.test.ts
```

Expected: PASS (3 tests)

**Step 5: Update `installation.created` webhook handler to store repos + sender_login**

The demo PR no longer fires from the webhook — `POST /auth/installed` handles that. The webhook handler just needs to persist the repo list and sender login for the post-install page picker.

In `server/src/routes/webhooks.ts`, replace the existing `if (payload.action === 'created')` block's `upsertInstallation` call:

```typescript
        const repositories = payload.repositories as Array<{ name: string }> | undefined;

        await upsertInstallation({
          orgId: user?.org_id ?? null,
          installationId: installation.id,
          githubAccountLogin: installation.account.login,
          senderLogin: sender.login,
          repos: repositories ?? [],
        });

        return c.json({ accepted: true, event: 'installation.created' });
```

**Step 6: Update `webhooks.test.ts` — update DB mock and add a test for repos storage**

Update the `vi.mock('../db.js', ...)` factory (add any new helpers used in webhooks.ts):

```typescript
vi.mock('../db.js', () => ({
  findUserByLogin: vi.fn(),
  upsertInstallation: vi.fn(),
  upsertOrg: vi.fn(),
  upsertUser: vi.fn(),
  findRepoConfig: vi.fn(),
  upsertPendingRepoConfig: vi.fn(),
  insertReview: vi.fn(),
  sql: {},
}));
```

Add a test verifying repos and sender_login are passed to `upsertInstallation`:

```typescript
  it('stores repos and sender_login on installation.created', async () => {
    vi.mocked(findUserByLogin).mockResolvedValue(null);
    vi.mocked(upsertInstallation).mockResolvedValue(undefined);

    const app = createWebhookApp();
    const payload = {
      action: 'created',
      installation: { id: 11111, account: { login: 'myorg' } },
      sender: { login: 'jsmith' },
      repositories: [{ name: 'myrepo' }, { name: 'otherrepo' }],
    };
    const body = JSON.stringify(payload);
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(upsertInstallation).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 11111,
      senderLogin: 'jsmith',
      repos: [{ name: 'myrepo' }, { name: 'otherrepo' }],
    }));
  });
```

**Step 7: Update existing `RepoConfig` mock in `webhooks.test.ts` with `status` field**

Find the existing mock of `findRepoConfig` that returns a full `RepoConfig` object and add the `status` field:

```typescript
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg-uuid', installation_id: 1, owner: 'org', repo: 'repo',
      dev_command: 'npm run dev', port: 3000, install_command: null,
      health_path: '/', test_email: null, test_password: null,
      env_vars: null, compose_file: null, schema_command: null,
      seed_command: null, login_script: null, sandbox_template: null,
      status: 'ready',  // add this field
      created_at: new Date(), updated_at: new Date(),
    });
```

**Step 8: Run all webhook tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/webhooks.test.ts
```

Expected: All tests pass

**Step 9: Type check**

```bash
cd server && npx tsc --noEmit
```

**Step 10: Commit**

```bash
cd server && git add src/onboarding/demo-pr.ts src/onboarding/demo-pr.test.ts src/routes/webhooks.ts src/routes/webhooks.test.ts
git commit -m "feat: store repos + sender_login on installation.created; demo PR now via POST /auth/installed"
```

---

### Task 5: Auto-Detect Repo Config

**Files:**
- Create: `server/src/onboarding/detect-config.ts`
- Create: `server/src/onboarding/detect-config.test.ts`
- Create: `server/src/onboarding/detect-config-prompt.txt`

**Step 1: Write the prompt template**

Create `server/src/onboarding/detect-config-prompt.txt`:

```
You are analyzing a GitHub repository to detect how to run it locally in a development sandbox.

Here are the key configuration files found in the repository:

<files>
{FILES}
</files>

Your job: output a JSON object describing how to run this repo. Use only what you can determine from the files above. For anything you cannot determine, use the defaults listed below.

Output ONLY a JSON object — no explanation, no markdown fences. The object must match this exact schema:

{
  "dev_command": string,            // command to start the dev server (default: "npm run dev")
  "port": number,                   // port the dev server listens on (default: 3000)
  "install_command": string | null, // dependency install command, null if not needed
  "health_path": string,            // HTTP path to check if server is healthy (default: "/")
  "compose_file": string | null,    // relative path to docker-compose file, null if not using Docker
  "schema_command": string | null,  // command to apply DB schema/migrations, null if none
  "seed_command": string | null,    // command to seed test data, null if none
  "env_vars": object | null         // required env vars (keys from .env.example, empty-string values)
}

Rules:
- dev_command must be the command a developer runs to start the app locally
- port must be a number (integer), not a string
- If using docker-compose, set compose_file to the path (e.g. "docker-compose.yml")
- env_vars should only include keys from .env.example — do not guess values
- Output ONLY the JSON object, nothing else
```

**Step 2: Write the failing tests**

Create `server/src/onboarding/detect-config.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseDetectOutput } from './detect-config.js';

vi.mock('../github/repo-api.js', () => ({ fetchFileContent: vi.fn() }));
vi.mock('../db.js', () => ({
  upsertRepoConfig: vi.fn(),
  setRepoConfigStatus: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => vi.clearAllMocks());

describe('parseDetectOutput', () => {
  it('parses a clean JSON response', () => {
    const output = JSON.stringify({
      dev_command: 'npm run dev', port: 3000,
      install_command: 'npm install', health_path: '/',
      compose_file: null, schema_command: null,
      seed_command: null, env_vars: null,
    });
    const result = parseDetectOutput(output);
    expect(result?.dev_command).toBe('npm run dev');
    expect(result?.port).toBe(3000);
  });

  it('returns null for unparseable output', () => {
    expect(parseDetectOutput('I cannot determine the config')).toBeNull();
  });

  it('extracts JSON embedded in explanatory prose', () => {
    const output = 'Based on the files:\n{"dev_command":"yarn dev","port":3000,"install_command":null,"health_path":"/","compose_file":null,"schema_command":null,"seed_command":null,"env_vars":null}';
    const result = parseDetectOutput(output);
    expect(result?.dev_command).toBe('yarn dev');
  });

  it('truncation boundary: accepts content up to 4000 chars per file (tested via prompt)', () => {
    // parseDetectOutput is pure — this just checks it does not fail on large JSON
    const bigResult = JSON.stringify({
      dev_command: 'a'.repeat(100),
      port: 3000, install_command: null, health_path: '/',
      compose_file: null, schema_command: null, seed_command: null, env_vars: null,
    });
    expect(parseDetectOutput(bigResult)?.dev_command).toHaveLength(100);
  });
});

describe('detectAndStoreRepoConfig — failure path', () => {
  it('calls setFailed when all file fetches fail (rate limit or auth error)', async () => {
    const { fetchFileContent } = await import('../github/repo-api.js');
    const { setRepoConfigStatus } = await import('../db.js');
    // All 9 file fetches reject
    vi.mocked(fetchFileContent).mockRejectedValue(new Error('403 Forbidden'));
    vi.mocked(setRepoConfigStatus).mockResolvedValue(undefined);

    const { detectAndStoreRepoConfig } = await import('./detect-config.js');
    await detectAndStoreRepoConfig({
      owner: 'org', repo: 'repo', installationId: 12345, token: 'ghs_token',
    });

    expect(setRepoConfigStatus).toHaveBeenCalledWith('org', 'repo', 'failed');
  });
});

describe('detectAndStoreRepoConfig — config confirmation comment', () => {
  it('posts confirmation comment on the PR when prNumber is provided', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { fetchFileContent } = await import('../github/repo-api.js');
    const { upsertRepoConfig, setRepoConfigStatus } = await import('../db.js');

    vi.mocked(fetchFileContent).mockResolvedValueOnce({ content: '{"scripts":{"dev":"node server.js"}}', sha: 'abc' });
    vi.mocked(fetchFileContent).mockResolvedValue(null);  // remaining files not found
    vi.mocked(upsertRepoConfig).mockResolvedValue(undefined);
    vi.mocked(setRepoConfigStatus).mockResolvedValue(undefined);

    // Mock claude -p subprocess output
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockReturnValue({
      stdout: { on: (e: string, cb: (d: Buffer) => void) => e === 'data' && cb(Buffer.from(JSON.stringify({ dev_command: 'node server.js', port: 3000, install_command: null, health_path: '/', compose_file: null, schema_command: null, seed_command: null, env_vars: null }))) },
      stderr: { on: () => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (e: string, cb: (code: number) => void) => e === 'close' && cb(0),
    } as unknown as ReturnType<typeof spawn>);

    // Mock the GitHub comment POST
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({}), text: async () => '' } as Response);

    const { detectAndStoreRepoConfig } = await import('./detect-config.js');
    await detectAndStoreRepoConfig({
      owner: 'org', repo: 'repo', installationId: 12345, token: 'ghs_token', prNumber: 42,
    });

    const commentCall = fetchSpy.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/issues/42/comments'),
    );
    expect(commentCall).toBeDefined();
  });
});
```

**Step 3: Run test to verify it fails**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/onboarding/detect-config.test.ts
```

Expected: FAIL with "Cannot find module './detect-config.js'"

**Step 4: Implement `server/src/onboarding/detect-config.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fetchFileContent } from '../github/repo-api.js';
import { upsertRepoConfig, setRepoConfigStatus } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPT_TEMPLATE = readFileSync(
  join(__dirname, 'detect-config-prompt.txt'),
  'utf8',
);

const CANDIDATE_FILES = [
  'package.json',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Makefile',
  '.env.example',
  'pyproject.toml',
  'Cargo.toml',
];

export interface DetectedConfig {
  dev_command: string;
  port: number;
  install_command: string | null;
  health_path: string;
  compose_file: string | null;
  schema_command: string | null;
  seed_command: string | null;
  env_vars: Record<string, string> | null;
}

/**
 * Parse the JSON output from the Claude detection agent.
 * Handles cases where Claude wraps JSON in explanatory prose.
 */
export function parseDetectOutput(output: string): DetectedConfig | null {
  try {
    return JSON.parse(output.trim()) as DetectedConfig;
  } catch {
    const match = output.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as DetectedConfig;
    } catch {
      return null;
    }
  }
}

function buildPrompt(files: Record<string, string>): string {
  const filesSections = CANDIDATE_FILES.map((path) => {
    const content = files[path];
    if (!content) return `--- ${path} ---\nnot found\n`;
    const truncated = content.length > 4000 ? content.slice(0, 4000) + '\n[truncated]' : content;
    return `--- ${path} ---\n${truncated}\n`;
  }).join('\n');
  return PROMPT_TEMPLATE.replace('{FILES}', filesSections);
}

/**
 * Run claude -p via stdin to avoid ARG_MAX limits and shell injection.
 */
async function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 90_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on('error', reject);

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

export async function detectAndStoreRepoConfig(params: {
  owner: string;
  repo: string;
  installationId: number;
  token: string;
  prNumber?: number;  // if provided, posts config confirmation comment after successful detection
}): Promise<void> {
  const { owner, repo, installationId, token, prNumber } = params;

  const fileResults = await Promise.allSettled(
    CANDIDATE_FILES.map(async (path) => {
      const file = await fetchFileContent(owner, repo, path, token);
      return { path, content: file?.content ?? null };
    }),
  );

  // If ALL file fetches failed (likely a rate limit or auth error), abort rather than
  // detect from empty input — the model would just return defaults, which is misleading.
  const succeeded = fileResults.filter((r) => r.status === 'fulfilled');
  if (succeeded.length === 0) {
    console.error(`[detect-config] All file fetches failed for ${owner}/${repo} — possible rate limit or auth error`);
    await setRepoConfigStatus(owner, repo, 'failed');
    return;
  }

  const files: Record<string, string> = {};
  for (const result of fileResults) {
    if (result.status === 'fulfilled' && result.value.content) {
      files[result.value.path] = result.value.content;
    }
  }

  const prompt = buildPrompt(files);

  let output: string;
  try {
    output = await runClaude(prompt);
  } catch (err) {
    console.error(`[detect-config] claude -p failed for ${owner}/${repo}:`, err);
    await setRepoConfigStatus(owner, repo, 'failed');
    return;
  }

  const config = parseDetectOutput(output);
  if (!config) {
    console.error(`[detect-config] Failed to parse output for ${owner}/${repo}:`, output.slice(0, 300));
    await setRepoConfigStatus(owner, repo, 'failed');
    return;
  }

  // upsertRepoConfig uses ON CONFLICT DO UPDATE — updates the existing pending row
  await upsertRepoConfig({
    installationId,
    owner,
    repo,
    devCommand: config.dev_command,
    port: config.port,
    installCommand: config.install_command,
    healthPath: config.health_path,
    composeFile: config.compose_file,
    schemaCommand: config.schema_command,
    seedCommand: config.seed_command,
    envVars: config.env_vars,
  });
  // Set status to 'ready' (upsertRepoConfig resets to default 'ready' via the migration default)
  // No additional setRepoConfigStatus call needed.

  console.log(`[detect-config] Config stored for ${owner}/${repo}: dev_command=${config.dev_command} port=${config.port}`);

  // Post config confirmation comment on the PR that triggered detection
  if (prNumber) {
    await postConfigConfirmation({ owner, repo, prNumber, config, token });
  }
}

const CONFIRMATION_COMMENT_TEMPLATE = `**Opslane detected your repo config**

| Field | Detected |
|-------|----------|
| Port | \`{port}\` |
| Dev command | \`{dev_command}\` |
| Health path | \`{health_path}\` |
{schema_row}{seed_row}
Looks wrong? Reply with corrections before the review runs:
\`\`\`
/config
port: {port}
dev_command: {dev_command}
\`\`\``;

async function postConfigConfirmation(params: {
  owner: string; repo: string; prNumber: number;
  config: DetectedConfig; token: string;
}): Promise<void> {
  const { owner, repo, prNumber, config, token } = params;
  const schemaRow = config.schema_command ? `| Schema command | \`${config.schema_command}\` |\n` : '';
  const seedRow = config.seed_command ? `| Seed command | \`${config.seed_command}\` |\n` : '';
  const body = CONFIRMATION_COMMENT_TEMPLATE
    .replace(/\{port\}/g, String(config.port))
    .replace(/\{dev_command\}/g, config.dev_command)
    .replace(/\{health_path\}/g, config.health_path)
    .replace('{schema_row}', schemaRow)
    .replace('{seed_row}', seedRow);

  const { GITHUB_API, githubHeaders } = await import('../github/pr.js');
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[detect-config] Failed to post confirmation comment on ${owner}/${repo}#${prNumber}: ${res.status} ${text.slice(0, 200)}`);
  } else {
    await res.json().catch(() => {});
  }
}
```

**Step 5: Run tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/onboarding/detect-config.test.ts
```

Expected: PASS (7 tests: 4 parseDetectOutput + 1 failure path + 1 confirmation comment + 1 previously-written)

**Step 6: Type check**

```bash
cd server && npx tsc --noEmit
```

**Step 7: Commit**

```bash
cd server && git add src/onboarding/detect-config.ts src/onboarding/detect-config.test.ts src/onboarding/detect-config-prompt.txt
git commit -m "feat: auto-detect repo config via claude -p (stdin), store in repo_configs"
```

---

### Task 6: First-Run Check in pull_request.opened Handler

**Files:**
- Modify: `server/src/routes/webhooks.ts`
- Modify: `server/src/routes/webhooks.test.ts`

When `pull_request.opened` fires for a repo with no config:
1. Insert a pending `repo_configs` row (so `setRepoConfigStatus` has a row to update)
2. Dispatch `detectAndStoreRepoConfig` fire-and-forget
3. Insert a review row (for tracking)
4. Return 202 — review runs on next PR or `/verify` command once config is ready

If config exists with `status = 'pending'`, skip and post a brief PR comment. If `status = 'ready'`, proceed normally.

**Step 1: Add imports to `server/src/routes/webhooks.ts`**

Add to existing imports:

```typescript
import { upsertPendingRepoConfig, insertReview } from '../db.js';
import { detectAndStoreRepoConfig } from '../onboarding/detect-config.js';
```

**Step 2: Write the failing tests**

Add a new mock at the top of `server/src/routes/webhooks.test.ts`:

```typescript
vi.mock('../onboarding/detect-config.js', () => ({
  detectAndStoreRepoConfig: vi.fn().mockResolvedValue(undefined),
}));
```

Also update the `vi.mock('../db.js', ...)` factory to add the new helpers:

```typescript
vi.mock('../db.js', () => ({
  findUserByLogin: vi.fn(),
  upsertInstallation: vi.fn(),
  upsertOrg: vi.fn(),
  upsertUser: vi.fn(),
  findRepoConfig: vi.fn(),
  claimDemoPrSlot: vi.fn(),
  upsertPendingRepoConfig: vi.fn(),
  insertReview: vi.fn(),
  sql: {},
}));
```

Add a test:

```typescript
describe('POST /github — pull_request: first-run config detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SVIX_SKIP_VERIFICATION = 'true';
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_APP_ID = 'app123';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key';
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it('returns 202 and dispatches detect-config when no repo_configs', async () => {
    const { findRepoConfig, upsertPendingRepoConfig } = await import('../db.js');
    const { detectAndStoreRepoConfig } = await import('../onboarding/detect-config.js');
    vi.mocked(findRepoConfig).mockResolvedValue(null);
    vi.mocked(upsertPendingRepoConfig).mockResolvedValue(undefined);

    const app = createWebhookApp();
    const body = JSON.stringify({
      action: 'opened', number: 5,
      repository: { owner: { login: 'acme' }, name: 'api' },
    });
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request' },
      body,
    });
    expect(res.status).toBe(202);
    expect(upsertPendingRepoConfig).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'acme', repo: 'api',
    }));
    // fire-and-forget: tick the event loop
    await new Promise((r) => setTimeout(r, 10));
    expect(detectAndStoreRepoConfig).toHaveBeenCalled();
  });

  it('proceeds normally when repo_configs exists with status ready', async () => {
    const { findRepoConfig } = await import('../db.js');
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg-uuid', installation_id: 1, owner: 'acme', repo: 'api',
      dev_command: 'npm run dev', port: 3000, install_command: null,
      health_path: '/', test_email: null, test_password: null,
      env_vars: null, compose_file: null, schema_command: null,
      seed_command: null, login_script: null, sandbox_template: null,
      status: 'ready',
      created_at: new Date(), updated_at: new Date(),
    });

    const app = createWebhookApp();
    const body = JSON.stringify({
      action: 'opened', number: 6,
      repository: { owner: { login: 'acme' }, name: 'api' },
    });
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request' },
      body,
    });
    // should pass through to normal pipeline (202)
    expect(res.status).toBe(202);
  });
});
```

**Step 3: Run tests to verify they fail**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/webhooks.test.ts -t "first-run"
```

Expected: FAIL

**Step 4: Add the first-run check to the `pull_request` handler in `server/src/routes/webhooks.ts`**

First, update the payload type for the `pull_request` event to include the installation field (GitHub App webhooks always include it):

```typescript
      let payload: {
        action?: string;
        number?: number;
        repository?: { owner?: { login?: string }; name?: string };
        installation?: { id?: number };  // present on all GitHub App webhook deliveries
      };
```

In the `pull_request` event handler, after `validateOwnerRepo(owner, repo)` passes and the dedup check is done, add before the `if (process.env.TRIGGER_SECRET_KEY)` dispatch block:

```typescript
      // First-run: detect repo config if missing
      const existingConfig = await findRepoConfig(owner, repo);

      if (!existingConfig) {
        // Extract installation ID from the webhook payload (GitHub App webhooks always include it)
        const installId = payload.installation?.id ?? 0;

        // Insert a placeholder row so setRepoConfigStatus has a target to update
        await upsertPendingRepoConfig({
          installationId: installId,
          owner,
          repo,
        });

        // Fire-and-forget detection — must not block the 202 response
        if (githubApp) {
          githubApp.getTokenForRepo(owner, repo)
            .then(({ token, installationId }) =>
              detectAndStoreRepoConfig({ owner, repo, installationId, token })
            )
            .catch((err) => {
              console.error(`[detect-config] Failed for ${owner}/${repo}:`, err);
            });
        }

        return c.json({ accepted: true, reason: 'first-run: detecting config', owner, repo }, 202);
      }

      if (existingConfig.status === 'pending') {
        return c.json({ accepted: true, reason: 'config detection in progress', owner, repo }, 202);
      }
      // status === 'ready': fall through to normal review dispatch
```

**Step 5: Run all webhook tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/webhooks.test.ts
```

Expected: All tests pass

**Step 6: Run full test suite**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run
```

Expected: All tests pass

**Step 7: Final type check**

```bash
cd server && npx tsc --noEmit
```

Expected: No errors

**Step 8: Set GitHub App Post-installation URL**

In GitHub App settings (`https://github.com/settings/apps/<your-app>`):
- Set **Post-installation URL** to `https://<your-domain>/auth/installed`
- Save. This is a one-time settings change — no code required.

**Step 9: Commit**

```bash
cd server && git add src/routes/webhooks.ts src/routes/webhooks.test.ts
git commit -m "feat: first-run config detection on pull_request.opened"
```

---

## Environment Variables Required

Add to `.env.example` if not already present:

```
GITHUB_APP_ID=          # GitHub App's numeric ID (Settings → About → App ID)
GITHUB_APP_PRIVATE_KEY= # PEM or base64-encoded PEM from GitHub App private key settings
```

Both are consumed by `GitHubAppService` which already exists. Just need to be set in production.

---

### Task 6b: /config Command in issue_comment Handler

**Files:**
- Create: `server/src/onboarding/config-command.ts`
- Create: `server/src/onboarding/config-command.test.ts`
- Modify: `server/src/routes/webhooks.ts`
- Modify: `server/src/routes/webhooks.test.ts`

When a user replies to the config confirmation comment (or failure comment) with a `/config` block, parse the YAML and update `repo_configs`.

**Step 1: Write the failing test**

Create `server/src/onboarding/config-command.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseConfigCommand } from './config-command.js';

describe('parseConfigCommand', () => {
  it('parses a valid /config YAML reply', () => {
    const body = '/config\nport: 3000\ndev_command: npm run dev';
    const result = parseConfigCommand(body);
    expect(result).toEqual({ port: 3000, dev_command: 'npm run dev' });
  });

  it('returns null for a comment that does not start with /config', () => {
    expect(parseConfigCommand('just a comment')).toBeNull();
  });

  it('returns error message for malformed YAML after /config', () => {
    const result = parseConfigCommand('/config\n: invalid: yaml:');
    expect(result).toHaveProperty('parseError');
  });

  it('ignores unknown fields (only updates known repo_config fields)', () => {
    const result = parseConfigCommand('/config\nport: 8080\nunknown_field: foo');
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).unknown_field).toBeUndefined();
    expect((result as Record<string, unknown>).port).toBe(8080);
  });

  it('coerces port to number', () => {
    const result = parseConfigCommand('/config\nport: "4000"');
    expect((result as Record<string, unknown>).port).toBe(4000);
  });

  it('handles dev_command with colons in value (e.g. docker run -p 8080:3000)', () => {
    const result = parseConfigCommand('/config\ndev_command: docker run -p 8080:3000 myapp\nport: 3000');
    expect((result as Record<string, unknown>).dev_command).toBe('docker run -p 8080:3000 myapp');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/onboarding/config-command.test.ts
```

Expected: FAIL

First, install js-yaml:

```bash
cd server && npm install js-yaml
cd server && npm install --save-dev @types/js-yaml
```

**Step 3: Implement `server/src/onboarding/config-command.ts`**

```typescript
import * as yaml from 'js-yaml';

// Known fields that users can override via /config command
const ALLOWED_FIELDS = new Set([
  'port', 'dev_command', 'install_command', 'health_path',
  'compose_file', 'schema_command', 'seed_command',
]);

export interface ConfigUpdate {
  port?: number;
  dev_command?: string;
  install_command?: string | null;
  health_path?: string;
  compose_file?: string | null;
  schema_command?: string | null;
  seed_command?: string | null;
}

export interface ConfigParseError {
  parseError: string;
}

/**
 * Parse a /config command from a PR comment body.
 * Returns null if the comment is not a /config command.
 * Returns ConfigParseError if the YAML is malformed.
 * Returns ConfigUpdate with only the known, changed fields.
 *
 * Uses js-yaml so values with colons (e.g., `docker run -p 8080:3000`) parse correctly.
 */
export function parseConfigCommand(body: string): ConfigUpdate | ConfigParseError | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/config')) return null;

  const yamlPart = trimmed.slice('/config'.length).trim();
  if (!yamlPart) return {};  // /config with no body — acknowledge but no-op

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlPart);
  } catch (err) {
    return { parseError: (err as Error).message };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { parseError: 'Expected a YAML key: value mapping' };
  }

  const input = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of ALLOWED_FIELDS) {
    if (!(key in input)) continue;
    const value = input[key];

    if (key === 'port') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        return { parseError: `Invalid port: "${value}" — must be a positive integer` };
      }
      result[key] = n;
    } else {
      result[key] = value === undefined ? null : value;
    }
  }

  return result as ConfigUpdate;
}
```

**Step 4: Run tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/onboarding/config-command.test.ts
```

Expected: PASS (6 tests — includes colon-in-value test)

**Step 5: Wire /config parsing into the `issue_comment` handler in `webhooks.ts`**

Add import at the top:

```typescript
import { parseConfigCommand } from '../onboarding/config-command.js';
import { upsertRepoConfig } from '../db.js';
```

In the `issue_comment` event handler, after the existing `isMention` / `isVerifyCommand` check, add handling for `/config`:

```typescript
      const isConfigCommand = commentBody.startsWith('/config');

      if (!isMention && !isVerifyCommand && !isConfigCommand) {
        return c.json({ accepted: false, reason: 'not a recognized command' });
      }
```

Then add a new block for config command handling, before the existing `/verify` block:

```typescript
      if (isConfigCommand) {
        // Authorization: only collaborators/members/owners
        if (!ALLOWED_ASSOCIATIONS.has(association)) {
          return c.json({ accepted: false, reason: 'unauthorized' });
        }

        const parsed = parseConfigCommand(commentBody);
        if (parsed === null) {
          return c.json({ accepted: false, reason: 'not a config command' });
        }
        if ('parseError' in parsed) {
          // Reply with parse error — fire-and-forget
          if (githubApp) {
            githubApp.getTokenForRepo(owner, repo)
              .then(({ token }) =>
                fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
                  method: 'POST',
                  headers: githubHeaders(token),
                  body: JSON.stringify({ body: `⚠️ Config parse error: ${parsed.parseError}\n\nSee format in the config comment above.` }),
                })
              )
              .catch((err) => console.error(`[config-cmd] Failed to post parse error:`, err));
          }
          return c.json({ accepted: false, reason: 'config parse error' });
        }

        // Update repo_configs
        const existing = await findRepoConfig(owner, repo);
        if (existing) {
          await upsertRepoConfig({
            installationId: existing.installation_id,
            owner, repo,
            devCommand: (parsed as ConfigUpdate).dev_command ?? existing.dev_command,
            port: (parsed as ConfigUpdate).port ?? existing.port,
            installCommand: (parsed as ConfigUpdate).install_command ?? existing.install_command,
            healthPath: (parsed as ConfigUpdate).health_path ?? existing.health_path,
            composeFile: (parsed as ConfigUpdate).compose_file ?? existing.compose_file,
            schemaCommand: (parsed as ConfigUpdate).schema_command ?? existing.schema_command,
            seedCommand: (parsed as ConfigUpdate).seed_command ?? existing.seed_command,
            envVars: existing.env_vars,
          });
          console.log(`[config-cmd] Updated config for ${owner}/${repo} by ${commenter}`);

          // Re-trigger review fire-and-forget
          if (githubApp) {
            githubApp.getTokenForRepo(owner, repo)
              .then(({ token }) =>
                fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
                  method: 'POST',
                  headers: githubHeaders(token),
                  body: JSON.stringify({ body: '✓ Config updated — re-running review...' }),
                })
              )
              .catch(() => {});
          }

          dedup.markSeen(deliveryId);
          if (process.env.TRIGGER_SECRET_KEY) {
            const unifiedPayload: UnifiedPayload = { owner, repo, prNumber, deliveryId };
            await tasks.trigger<typeof unifiedPrTask>('unified-pr', unifiedPayload);
          } else {
            runUnifiedPipeline({ owner, repo, prNumber }, { log: (step, msg, data) => console.log(`[${step}]`, msg, data ?? '') })
              .catch((err) => console.error(`[inline] Config re-run failed:`, err));
          }
        }

        return c.json({ accepted: true, event: 'issue_comment.config', prNumber, owner, repo }, 202);
      }
```

**Step 6: Add webhook test for /config command**

In `webhooks.test.ts`, add mock for `config-command.js`:

```typescript
vi.mock('../onboarding/config-command.js', () => ({
  parseConfigCommand: vi.fn(),
}));
```

Add a test:

```typescript
describe('POST /github — issue_comment: /config command', () => {
  it('updates repo config and re-triggers review', async () => {
    const { parseConfigCommand } = await import('../onboarding/config-command.js');
    const { findRepoConfig, upsertRepoConfig } = await import('../db.js');
    vi.mocked(parseConfigCommand).mockReturnValue({ port: 8080 });
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg-uuid', installation_id: 1, owner: 'org', repo: 'repo',
      dev_command: 'npm run dev', port: 3000, install_command: null,
      health_path: '/', test_email: null, test_password: null,
      env_vars: null, compose_file: null, schema_command: null,
      seed_command: null, login_script: null, sandbox_template: null,
      status: 'ready', created_at: new Date(), updated_at: new Date(),
    });
    vi.mocked(upsertRepoConfig).mockResolvedValue(undefined);

    const app = createWebhookApp();
    const body = JSON.stringify({
      action: 'created',
      comment: { body: '/config\nport: 8080', user: { login: 'dev' }, author_association: 'MEMBER' },
      issue: { number: 7, pull_request: { url: 'https://...' } },
      repository: { owner: { login: 'org' }, name: 'repo' },
    });
    const sig = sign(body);
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'issue_comment', 'X-Hub-Signature-256': sig },
      body,
    });
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.event).toBe('issue_comment.config');
  });
});
```

**Step 7: Run all tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run
```

Expected: All tests pass

**Step 8: Commit**

```bash
cd server && git add src/onboarding/config-command.ts src/onboarding/config-command.test.ts src/routes/webhooks.ts src/routes/webhooks.test.ts
git commit -m "feat: /config command in issue_comment — parse YAML, update repo_configs, re-trigger review"
```

---

### Task 7: GitHub Check Runs Integration

Post review results as GitHub Check Runs (in addition to existing PR comments). This makes pass/fail visible in the PR status checks area.

**Files:**
- Create: `server/src/github/check-runs.ts`
- Create: `server/src/github/check-runs.test.ts`
- Modify: `server/src/unified/pipeline.ts` (or wherever results are posted)

**Step 1: Write the failing test**

Create `server/src/github/check-runs.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('postCheckRun', () => {
  it('posts a check run with success conclusion', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: 123 }),
      text: async () => '',
    } as Response);

    const { postCheckRun } = await import('./check-runs.js');
    await postCheckRun({
      owner: 'org', repo: 'repo', sha: 'abc123', token: 'ghs_token',
      conclusion: 'success',
      title: 'All checks passed',
      summary: '3 criteria passed, 0 failed.',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/repos/org/repo/check-runs'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('logs error and does not throw when GitHub returns non-2xx', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({}),
      text: async () => 'Forbidden',
    } as Response);

    const { postCheckRun } = await import('./check-runs.js');
    // Should not throw — Check Run failure is non-fatal
    await expect(
      postCheckRun({ owner: 'org', repo: 'repo', sha: 'abc123', token: 'ghs_token',
        conclusion: 'failure', title: '1 check failed', summary: 'details' }),
    ).resolves.not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/github/check-runs.test.ts
```

Expected: FAIL

**Step 3: Implement `server/src/github/check-runs.ts`**

```typescript
import { GITHUB_API, githubHeaders } from './pr.js';

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';

export async function postCheckRun(params: {
  owner: string;
  repo: string;
  sha: string;
  token: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
}): Promise<void> {
  const { owner, repo, sha, token, conclusion, title, summary, detailsUrl } = params;

  const body: Record<string, unknown> = {
    name: 'Opslane Review',
    head_sha: sha,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title, summary },
  };
  if (detailsUrl) body.details_url = detailsUrl;

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      ...githubHeaders(token),
      // Check Runs API requires the checks preview header
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[check-run] Failed to post for ${owner}/${repo}@${sha}: ${res.status} ${text.slice(0, 200)}`);
    return;  // non-fatal: PR comment already posted
  }
  await res.json().catch(() => {});
}
```

**Step 4: Run tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/github/check-runs.test.ts
```

Expected: PASS (2 tests)

**Step 5: Integrate into unified pipeline**

Find where the unified pipeline posts its PR comment result. Look in `server/src/unified/pipeline.ts` for the final result posting step.

Add `postCheckRun` call immediately after the existing comment is posted:

```typescript
import { postCheckRun } from '../github/check-runs.js';

// After posting the PR comment (existing code), add:
// Note: Check Runs require an installation token (not GITHUB_TOKEN env var)
// Pass the installation token through the pipeline or fetch it here
if (installationToken) {
  const passed = result.criteria.filter((c: { passed: boolean }) => c.passed).length;
  const failed = result.criteria.filter((c: { passed: boolean }) => !c.passed).length;
  const conclusion: CheckConclusion = failed === 0 ? 'success' : 'failure';
  await postCheckRun({
    owner, repo, sha: prHeadSha, token: installationToken,
    conclusion,
    title: failed === 0 ? `All ${passed} checks passed` : `${failed} check(s) failed`,
    summary: result.criteria.map((c: { name: string; passed: boolean }) =>
      `${c.passed ? '✓' : '✗'} ${c.name}`
    ).join('\n'),
    detailsUrl: commentUrl,
  }).catch((err) => console.error('[check-run] post failed:', err));
}
```

**Note for implementer:** You'll need to look at `server/src/unified/pipeline.ts` to find the exact variable names for `owner`, `repo`, `prHeadSha`, `installationToken`, `result`, and `commentUrl`. The pipeline currently uses `GITHUB_TOKEN` — you'll need to thread the installation token through the pipeline function signature or fetch it inside the pipeline using `GitHubAppService`.

**Step 6: Run full test suite**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run
```

Expected: All tests pass

**Step 7: Commit**

```bash
cd server && git add src/github/check-runs.ts src/github/check-runs.test.ts src/unified/pipeline.ts
git commit -m "feat: post GitHub Check Run alongside PR comment for every review result"
```

---

### Task 8: Admin /admin/reviews Page

A simple read-only page listing all reviews. JWT-gated (same session cookie as the rest of the app).

**Files:**
- Create: `server/src/routes/admin.ts`
- Create: `server/src/routes/admin.test.ts`
- Modify: `server/src/index.ts` (mount the admin router)

**Step 1: Write the failing test**

Create `server/src/routes/admin.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db.js', () => ({
  sql: vi.fn(),
}));

describe('GET /admin/reviews', () => {
  it('returns 401 without a session cookie', async () => {
    const { adminRouter } = await import('./admin.js');
    const app = new Hono();
    app.route('/admin', adminRouter);

    const res = await app.request('/admin/reviews');
    expect(res.status).toBe(401);
  });

  it('returns HTML table with reviews when authenticated', async () => {
    const { sql } = await import('../db.js');
    vi.mocked(sql).mockResolvedValue([
      {
        id: 'uuid-1', repo_owner: 'org', repo_name: 'repo', pr_number: 1,
        trigger_event: 'pull_request.opened', status: 'passed',
        started_at: new Date('2026-03-17T10:00:00Z'), completed_at: new Date('2026-03-17T10:01:00Z'),
      },
    ]);

    const { adminRouter } = await import('./admin.js');
    const app = new Hono();
    app.route('/admin', adminRouter);

    // Sign a valid session JWT
    const jwt = sign({ login: 'admin' }, process.env.JWT_SECRET ?? 'test-secret');
    const res = await app.request('/admin/reviews', {
      headers: { Cookie: `session=${jwt}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('org/repo');
    expect(text).toContain('passed');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/admin.test.ts
```

Expected: FAIL

**Step 3: Implement `server/src/routes/admin.ts`**

```typescript
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verify } from 'hono/jwt';
import { sql } from '../db.js';

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const adminRouter = new Hono();

adminRouter.get('/reviews', async (c) => {
  // Require JWT session
  const sessionCookie = getCookie(c, 'session');
  if (!sessionCookie) return c.text('Authentication required', 401);

  try {
    await verify(sessionCookie, env('JWT_SECRET'));
  } catch {
    return c.text('Invalid session', 401);
  }

  const reviews = await sql`
    SELECT id, repo_owner, repo_name, pr_number, pr_title,
           trigger_event, status, started_at, completed_at
    FROM reviews
    ORDER BY started_at DESC
    LIMIT 200
  `;

  const rows = reviews.map((r: Record<string, unknown>) => `
    <tr>
      <td>${r.repo_owner}/${r.repo_name}</td>
      <td>#${r.pr_number}${r.pr_title ? ` — ${String(r.pr_title).slice(0, 60)}` : ''}</td>
      <td>${r.trigger_event}</td>
      <td class="status-${r.status}">${r.status}</td>
      <td>${new Date(r.started_at as string).toISOString().slice(0, 19).replace('T', ' ')}</td>
      <td>${r.completed_at ? new Date(r.completed_at as string).toISOString().slice(11, 19) : '—'}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Opslane — Reviews</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #e6edf3; padding: 2rem; }
    h1 { font-size: 1.2rem; margin-bottom: 1rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th { text-align: left; padding: 0.5rem; border-bottom: 1px solid #30363d; color: #8b949e; }
    td { padding: 0.5rem; border-bottom: 1px solid #21262d; }
    .status-passed { color: #3fb950; }
    .status-failed { color: #f85149; }
    .status-running { color: #d29922; }
    .status-error { color: #f85149; }
    .status-pending { color: #8b949e; }
  </style>
</head>
<body>
  <h1>Reviews (last 200)</h1>
  <table>
    <thead><tr>
      <th>Repo</th><th>PR</th><th>Trigger</th><th>Status</th><th>Started</th><th>Duration</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="6" style="color:#8b949e;padding:1rem">No reviews yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`;

  return c.html(html);
});
```

**Step 4: Mount admin router in `server/src/index.ts`**

```typescript
import { adminRouter } from './routes/admin.js';
// ...existing route mounts...
app.route('/admin', adminRouter);
```

**Step 5: Run admin tests**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run src/routes/admin.test.ts
```

Expected: PASS (2 tests)

**Step 6: Run full test suite**

```bash
cd server && node --env-file=.env ./node_modules/.bin/vitest run
```

Expected: All tests pass

**Step 7: Type check**

```bash
cd server && npx tsc --noEmit
```

**Step 8: Commit**

```bash
cd server && git add src/routes/admin.ts src/routes/admin.test.ts src/index.ts
git commit -m "feat: /admin/reviews page — JWT-gated read-only view of all review runs"
```

---

## Verification Checklist

Run in this order before merging:

1. `cd server && npm install` — confirms js-yaml is installed
2. `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/migrate.test.ts` — migrations idempotent
3. `cd server && node --env-file=.env ./node_modules/.bin/vitest run src/db.test.ts` — DB helpers correct (covers selected_repo + findLatestReview)
4. `cd server && node --env-file=.env ./node_modules/.bin/vitest run` — all tests pass
5. `cd server && npx tsc --noEmit` — zero type errors
6. Set GitHub App **Post-installation URL** to `https://<your-domain>/auth/installed`
7. Verify `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set in production env
8. Verify `checks:write` permission is enabled on the GitHub App (required for Check Runs)
9. Manual smoke: install app on test repo → `/auth/installed` shows confirmation page → pick repo → POST /auth/installed fires → GET /auth/status cycles through all 5 steps → demo PR appears → first real PR gets a review
