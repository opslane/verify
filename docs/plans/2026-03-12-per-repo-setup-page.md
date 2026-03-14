# Per-Repo Setup Page — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After installing the GitHub App, redirect users to a `/setup` page where they configure each repo (startup command, port, health path) — stored in a `repo_configs` table and used by the webhook pipeline.

**Architecture:** GitHub App "Post Installation Setup URL" redirects to `/setup?installation_id=X`. The page fetches installed repos via our API (which calls GitHub's installation repos endpoint), displays a config form per repo, and saves via `PUT /api/repos/:owner/:repo/config`. The webhook pipeline reads `repo_configs` before dispatching.

**Tech Stack:** Hono, TypeScript, postgres.js, jose (RS256 for GitHub App JWT — already a dependency), vanilla HTML/JS (no React), vitest.

**GitHub App Config Change (manual):** Set "Setup URL" to `https://<your-domain>/setup` and check "Redirect on update".

**Known limitations (v1):**
- No pagination — installations with >100 repos will only show the first 100
- No test credential storage — add `test_email`, `test_password`, `env_vars` columns when the pipeline actually needs them
- No "Save All" button — users click Save per repo (fine for <20 repos)

---

## Task 1: Database Migration for `repo_configs`

**Files:**
- Create: `server/db/migrations/002_repo_configs.sql`

**Step 1: Write the migration**

Minimal table — only columns that have consumers in this plan. Uses `(owner, repo)` as the primary key (natural key, no surrogate UUID needed). The UNIQUE constraint creates an implicit index, so no separate index needed for `(owner, repo)`.

```sql
-- server/db/migrations/002_repo_configs.sql
CREATE TABLE IF NOT EXISTS repo_configs (
  installation_id   bigint REFERENCES github_installations(installation_id),
  owner             text NOT NULL,
  repo              text NOT NULL,
  startup_command   text NOT NULL DEFAULT 'npm run dev',
  port              integer NOT NULL DEFAULT 3000,
  health_path       text NOT NULL DEFAULT '/',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  PRIMARY KEY (owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_repo_configs_installation_id ON repo_configs (installation_id);
```

**Step 2: Verify migration runs**

Run: `cd server && DATABASE_URL=$DATABASE_URL node --import tsx/esm src/migrate.ts`
Expected: no errors, table created

**Step 3: Commit**

```bash
git add server/db/migrations/002_repo_configs.sql
git commit -m "feat: add repo_configs migration"
```

---

## Task 2: DB Helpers — `upsertRepoConfig`, `findRepoConfig`, `findRepoConfigsByInstallation`

**Files:**
- Modify: `server/src/db.ts` — add types + 3 functions at the bottom
- Modify: `server/src/db.test.ts` — add tests

**Step 1: Write failing tests**

Add to `server/src/db.test.ts`. Important: the `beforeAll` cleanup must include `repo_configs` (before `github_installations` due to FK ordering), and tests must create prerequisite `github_installations` rows before inserting `repo_configs`.

First, update the cleanup block. Change the existing `beforeAll` cleanup to:

```typescript
// Clean slate for this test run (FK order: repo_configs → github_installations → users → orgs)
await sql`DELETE FROM repo_configs`;
await sql`DELETE FROM github_installations`;
await sql`DELETE FROM users`;
await sql`DELETE FROM orgs`;
```

Then add a new `describe` block at the bottom, before the closing `});`:

```typescript
describe('repo config helpers', () => {
  it('upserts and finds repo config', async () => {
    const { upsertOrg, upsertInstallation, upsertRepoConfig, findRepoConfig } = await import('./db.js');

    // Prerequisite: installation must exist (FK constraint)
    const org = await upsertOrg('rc-org', 'RC Org');
    await upsertInstallation({ orgId: org.id, installationId: 77001, githubAccountLogin: 'rc-org' });

    await upsertRepoConfig({
      installationId: 77001,
      owner: 'rc-org',
      repo: 'testrepo',
      startupCommand: 'npm run dev',
      port: 3000,
    });

    const config = await findRepoConfig('rc-org', 'testrepo');
    expect(config).not.toBeNull();
    expect(config!.startup_command).toBe('npm run dev');
    expect(config!.port).toBe(3000);
    expect(config!.health_path).toBe('/');
  });

  it('returns null for missing repo config', async () => {
    const { findRepoConfig } = await import('./db.js');
    const config = await findRepoConfig('nonexistent', 'nope');
    expect(config).toBeNull();
  });

  it('updates repo config on conflict', async () => {
    const { upsertRepoConfig, findRepoConfig } = await import('./db.js');

    // Uses installation 77001 created in previous test
    await upsertRepoConfig({
      installationId: 77001,
      owner: 'rc-org',
      repo: 'testrepo',
      startupCommand: 'pnpm dev',
      port: 3001,
      healthPath: '/api/health',
    });

    const config = await findRepoConfig('rc-org', 'testrepo');
    expect(config!.startup_command).toBe('pnpm dev');
    expect(config!.port).toBe(3001);
    expect(config!.health_path).toBe('/api/health');
  });

  it('finds all repo configs by installation id', async () => {
    const { upsertOrg, upsertInstallation, upsertRepoConfig, findRepoConfigsByInstallation } = await import('./db.js');

    const org = await upsertOrg('multi-org', 'Multi Org');
    await upsertInstallation({ orgId: org.id, installationId: 77002, githubAccountLogin: 'multi-org' });

    await upsertRepoConfig({
      installationId: 77002,
      owner: 'multi-org',
      repo: 'repo-a',
      startupCommand: 'npm start',
      port: 3000,
    });
    await upsertRepoConfig({
      installationId: 77002,
      owner: 'multi-org',
      repo: 'repo-b',
      startupCommand: 'yarn dev',
      port: 5173,
    });

    const configs = await findRepoConfigsByInstallation(77002);
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.repo).sort()).toEqual(['repo-a', 'repo-b']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && DATABASE_URL=$DATABASE_URL TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/db.test.ts`
Expected: FAIL — `upsertRepoConfig` not exported

**Step 3: Add types and helpers to `server/src/db.ts`**

Add at the bottom of the file, following the existing patterns:

```typescript
export interface RepoConfig {
  installation_id: number | null;
  owner: string;
  repo: string;
  startup_command: string;
  port: number;
  health_path: string;
  created_at: Date;
  updated_at: Date;
}

export async function upsertRepoConfig(params: {
  installationId: number | null;
  owner: string;
  repo: string;
  startupCommand: string;
  port: number;
  healthPath?: string;
}): Promise<RepoConfig> {
  const rows = await sql<RepoConfig[]>`
    INSERT INTO repo_configs (
      installation_id, owner, repo, startup_command, port, health_path
    ) VALUES (
      ${params.installationId}, ${params.owner}, ${params.repo},
      ${params.startupCommand}, ${params.port},
      ${params.healthPath ?? '/'}
    )
    ON CONFLICT (owner, repo) DO UPDATE SET
      installation_id = EXCLUDED.installation_id,
      startup_command = EXCLUDED.startup_command,
      port = EXCLUDED.port,
      health_path = EXCLUDED.health_path,
      updated_at = now()
    RETURNING *
  `;
  return rows[0];
}

export async function findRepoConfig(owner: string, repo: string): Promise<RepoConfig | null> {
  const rows = await sql<RepoConfig[]>`
    SELECT * FROM repo_configs WHERE owner = ${owner} AND repo = ${repo}
  `;
  return rows[0] ?? null;
}

export async function findRepoConfigsByInstallation(installationId: number): Promise<RepoConfig[]> {
  const rows = await sql<RepoConfig[]>`
    SELECT * FROM repo_configs WHERE installation_id = ${installationId}
    ORDER BY owner, repo
  `;
  return rows;
}

export async function findInstallationWithOrg(installationId: number, orgId: string): Promise<{ installation_id: number } | null> {
  const rows = await sql<{ installation_id: number }[]>`
    SELECT installation_id FROM github_installations
    WHERE installation_id = ${installationId} AND org_id = ${orgId}
  `;
  return rows[0] ?? null;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd server && DATABASE_URL=$DATABASE_URL TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/db.test.ts`
Expected: PASS

**Step 5: Type check**

Run: `cd server && npx tsc --noEmit`

**Step 6: Commit**

```bash
git add server/src/db.ts server/src/db.test.ts
git commit -m "feat: add repo_configs DB helpers"
```

---

## Task 3: GitHub Installation Token + Repo List Helper

Get an installation access token from GitHub (using the App's private key via `jose`, which is already a dependency), then list repos for that installation.

**Files:**
- Create: `server/src/github/installation.ts`
- Create: `server/src/github/installation.test.ts`

**Step 1: Write failing tests**

Mock both `fetch` and `jose` to avoid needing a real RSA private key in tests:

```typescript
// server/src/github/installation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock jose — avoid needing a real RSA key
vi.mock('jose', () => ({
  importPKCS8: vi.fn().mockResolvedValue('mock-private-key'),
  SignJWT: vi.fn().mockImplementation(() => ({
    setProtectedHeader: vi.fn().mockReturnThis(),
    setIssuedAt: vi.fn().mockReturnThis(),
    setExpirationTime: vi.fn().mockReturnThis(),
    sign: vi.fn().mockResolvedValue('mock-app-jwt'),
  })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('getInstallationRepos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'fake-key-mocked-away';
  });

  it('fetches repos for an installation', async () => {
    // Mock token endpoint
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'ghs_test_token', expires_at: '2026-01-01T00:00:00Z' }),
    });

    // Mock repos endpoint
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        repositories: [
          { full_name: 'myorg/repo-a', name: 'repo-a', owner: { login: 'myorg' }, private: false },
          { full_name: 'myorg/repo-b', name: 'repo-b', owner: { login: 'myorg' }, private: true },
        ],
      }),
    });

    const { getInstallationRepos } = await import('./installation.js');
    const repos = await getInstallationRepos(12345);

    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({ owner: 'myorg', repo: 'repo-a', fullName: 'myorg/repo-a', private: false });
    expect(repos[1]).toEqual({ owner: 'myorg', repo: 'repo-b', fullName: 'myorg/repo-b', private: true });

    // Verify token request was made to correct endpoint
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const tokenCall = mockFetch.mock.calls[0];
    expect(tokenCall[0]).toBe('https://api.github.com/app/installations/12345/access_tokens');
  });

  it('throws on token fetch failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const { getInstallationRepos } = await import('./installation.js');
    await expect(getInstallationRepos(99999)).rejects.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/github/installation.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Uses `jose` (already in `package.json`) — no new dependencies needed.

```typescript
// server/src/github/installation.ts
import { SignJWT, importPKCS8 } from 'jose';

interface InstallationRepo {
  owner: string;
  repo: string;
  fullName: string;
  private: boolean;
}

/** Generate a short-lived JWT for GitHub App authentication */
async function generateAppJwt(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required');
  }

  const privateKey = await importPKCS8(privateKeyPem, 'RS256');
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ iss: appId })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 600)
    .sign(privateKey);
}

/** Get an installation access token from GitHub */
async function getInstallationToken(installationId: number): Promise<string> {
  const appJwt = await generateAppJwt();
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status}`);
  }

  const data = await res.json() as { token: string };
  return data.token;
}

/** List all repos accessible to an installation (first page, max 100) */
export async function getInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
  const token = await getInstallationToken(installationId);

  const res = await fetch('https://api.github.com/installation/repositories?per_page=100', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to list installation repos: ${res.status}`);
  }

  const data = await res.json() as {
    repositories: Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
    }>;
  };

  return data.repositories.map((r) => ({
    owner: r.owner.login,
    repo: r.name,
    fullName: r.full_name,
    private: r.private,
  }));
}
```

**Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/github/installation.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/github/installation.ts server/src/github/installation.test.ts
git commit -m "feat: add GitHub installation token + repo list helper (jose)"
```

---

## Task 4: Setup API Routes + Auth

API routes for the setup page. JWT verification is inlined (no separate auth module — test auth through route tests). Includes authorization: verifies the session's `orgId` owns the requested installation.

**Files:**
- Create: `server/src/routes/setup.ts`
- Create: `server/src/routes/setup.test.ts`

**Step 1: Write failing tests**

```typescript
// server/src/routes/setup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB
vi.mock('../db.js', () => ({
  upsertRepoConfig: vi.fn(),
  findRepoConfigsByInstallation: vi.fn(),
  findInstallationWithOrg: vi.fn(),
}));

// Mock GitHub installation helper
vi.mock('../github/installation.js', () => ({
  getInstallationRepos: vi.fn(),
}));

// Mock hono/jwt verify
vi.mock('hono/jwt', () => ({
  verify: vi.fn(),
}));

import { Hono } from 'hono';
import { setupRoutes } from './setup.js';
import { verify } from 'hono/jwt';
import { getInstallationRepos } from '../github/installation.js';
import { upsertRepoConfig, findRepoConfigsByInstallation, findInstallationWithOrg } from '../db.js';
import type { MockInstance } from 'vitest';

const app = new Hono();
app.route('/setup', setupRoutes);

function mockAuthed() {
  (verify as unknown as MockInstance).mockResolvedValue({
    sub: 'user-1', orgId: 'org-1', login: 'testuser',
  });
}

function mockUnauthed() {
  (verify as unknown as MockInstance).mockRejectedValue(new Error('invalid'));
}

function mockInstallationOwned() {
  (findInstallationWithOrg as MockInstance).mockResolvedValue({ installation_id: 123 });
}

function mockInstallationNotOwned() {
  (findInstallationWithOrg as MockInstance).mockResolvedValue(null);
}

describe('setup routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  describe('GET /setup/api/repos', () => {
    it('returns 401 without session', async () => {
      mockUnauthed();
      const res = await app.request('/setup/api/repos?installation_id=123');
      expect(res.status).toBe(401);
    });

    it('returns 400 without installation_id', async () => {
      mockAuthed();
      const res = await app.request('/setup/api/repos', {
        headers: { Cookie: 'session=valid-token' },
      });
      expect(res.status).toBe(400);
    });

    it('returns 403 when user does not own the installation', async () => {
      mockAuthed();
      mockInstallationNotOwned();

      const res = await app.request('/setup/api/repos?installation_id=123', {
        headers: { Cookie: 'session=valid-token' },
      });
      expect(res.status).toBe(403);
    });

    it('returns repos with existing configs merged', async () => {
      mockAuthed();
      mockInstallationOwned();

      (getInstallationRepos as MockInstance).mockResolvedValue([
        { owner: 'myorg', repo: 'repo-a', fullName: 'myorg/repo-a', private: false },
        { owner: 'myorg', repo: 'repo-b', fullName: 'myorg/repo-b', private: true },
      ]);

      (findRepoConfigsByInstallation as MockInstance).mockResolvedValue([
        {
          owner: 'myorg', repo: 'repo-a',
          startup_command: 'npm run dev', port: 3000, health_path: '/',
        },
      ]);

      const res = await app.request('/setup/api/repos?installation_id=123', {
        headers: { Cookie: 'session=valid-token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.repos).toHaveLength(2);

      // repo-a has existing config
      expect(body.repos[0].repo).toBe('repo-a');
      expect(body.repos[0].config.startup_command).toBe('npm run dev');

      // repo-b has no config
      expect(body.repos[1].repo).toBe('repo-b');
      expect(body.repos[1].config).toBeNull();
    });
  });

  describe('PUT /setup/api/repos/:owner/:repo/config', () => {
    it('returns 401 without session', async () => {
      mockUnauthed();

      const res = await app.request('/setup/api/repos/myorg/myrepo/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startupCommand: 'npm run dev', port: 3000, installationId: 123 }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when user does not own the installation', async () => {
      mockAuthed();
      mockInstallationNotOwned();

      const res = await app.request('/setup/api/repos/myorg/myrepo/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: 'session=valid-token' },
        body: JSON.stringify({ installationId: 123, startupCommand: 'npm run dev', port: 3000 }),
      });
      expect(res.status).toBe(403);
    });

    it('returns 400 with missing required fields', async () => {
      mockAuthed();
      mockInstallationOwned();

      const res = await app.request('/setup/api/repos/myorg/myrepo/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: 'session=valid-token' },
        body: JSON.stringify({ installationId: 123 }),
      });
      expect(res.status).toBe(400);
    });

    it('saves repo config', async () => {
      mockAuthed();
      mockInstallationOwned();

      (upsertRepoConfig as MockInstance).mockResolvedValue({
        owner: 'myorg', repo: 'myrepo',
        startup_command: 'npm run dev', port: 3000,
      });

      const res = await app.request('/setup/api/repos/myorg/myrepo/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: 'session=valid-token' },
        body: JSON.stringify({
          installationId: 123,
          startupCommand: 'npm run dev',
          port: 3000,
        }),
      });

      expect(res.status).toBe(200);
      expect(upsertRepoConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'myorg',
          repo: 'myrepo',
          startupCommand: 'npm run dev',
          port: 3000,
          installationId: 123,
        }),
      );
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/setup.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// server/src/routes/setup.ts
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { verify } from 'hono/jwt';
import { getInstallationRepos } from '../github/installation.js';
import {
  upsertRepoConfig,
  findRepoConfigsByInstallation,
  findInstallationWithOrg,
} from '../db.js';

export const setupRoutes = new Hono();

interface SessionPayload {
  sub: string;
  orgId: string;
  login: string;
}

/** Verify JWT session cookie. Returns payload or null. */
async function getSession(cookie: string | undefined): Promise<SessionPayload | null> {
  if (!cookie) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');
  try {
    const payload = await verify(cookie, secret);
    if (!payload.sub || !payload.orgId || !payload.login) return null;
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

// GET /setup/api/repos?installation_id=123
setupRoutes.get('/api/repos', async (c) => {
  const session = await getSession(getCookie(c, 'session'));
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const installationId = c.req.query('installation_id');
  if (!installationId) return c.json({ error: 'installation_id required' }, 400);

  const instId = Number(installationId);
  if (Number.isNaN(instId)) return c.json({ error: 'installation_id must be a number' }, 400);

  // Authorization: verify this user's org owns the installation
  const installation = await findInstallationWithOrg(instId, session.orgId);
  if (!installation) return c.json({ error: 'Forbidden' }, 403);

  const [repos, configs] = await Promise.all([
    getInstallationRepos(instId),
    findRepoConfigsByInstallation(instId),
  ]);

  const configMap = new Map(configs.map((cfg) => [`${cfg.owner}/${cfg.repo}`, cfg]));

  const merged = repos.map((r) => ({
    owner: r.owner,
    repo: r.repo,
    fullName: r.fullName,
    private: r.private,
    config: configMap.get(r.fullName) ?? null,
  }));

  return c.json({ repos: merged });
});

// PUT /setup/api/repos/:owner/:repo/config
setupRoutes.put('/api/repos/:owner/:repo/config', async (c) => {
  const session = await getSession(getCookie(c, 'session'));
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const { owner, repo } = c.req.param();
  const body = await c.req.json() as {
    installationId?: number;
    startupCommand?: string;
    port?: number;
    healthPath?: string;
  };

  // Input validation
  if (!body.installationId || !body.startupCommand || typeof body.port !== 'number') {
    return c.json({ error: 'installationId, startupCommand, and port are required' }, 400);
  }

  // Authorization: verify this user's org owns the installation
  const installation = await findInstallationWithOrg(body.installationId, session.orgId);
  if (!installation) return c.json({ error: 'Forbidden' }, 403);

  const config = await upsertRepoConfig({
    installationId: body.installationId,
    owner,
    repo,
    startupCommand: body.startupCommand,
    port: body.port,
    healthPath: body.healthPath ?? '/',
  });

  return c.json({ config });
});
```

**Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/setup.test.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `cd server && npx tsc --noEmit`

```bash
git add server/src/routes/setup.ts server/src/routes/setup.test.ts
git commit -m "feat: add setup API routes with authz check"
```

---

## Task 5: Setup HTML Page

A single static HTML page with inline JS. Uses `textContent` and `setAttribute` for safe DOM construction (no `innerHTML` with user data — prevents XSS).

**Files:**
- Create: `server/src/public/setup.html`

**Step 1: Write the page**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify — Setup Repos</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117; color: #e6edf3;
      padding: 2rem; max-width: 720px; margin: 0 auto;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    .repo-card {
      border: 1px solid #30363d; border-radius: 8px;
      padding: 1.25rem; margin-bottom: 1rem;
      background: #161b22;
    }
    .repo-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 1rem;
    }
    .repo-name { font-weight: 600; font-size: 1.1rem; }
    .badge {
      font-size: 0.75rem; padding: 2px 8px; border-radius: 12px;
      background: #238636; color: #fff;
    }
    .badge.unconfigured { background: #6e7681; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .form-group { display: flex; flex-direction: column; }
    .form-group.full { grid-column: 1 / -1; }
    label { font-size: 0.8rem; color: #8b949e; margin-bottom: 0.25rem; }
    input {
      background: #0d1117; border: 1px solid #30363d; border-radius: 4px;
      color: #e6edf3; padding: 0.5rem; font-size: 0.9rem;
    }
    input:focus { border-color: #58a6ff; outline: none; }
    .btn {
      background: #238636; color: #fff; border: none; border-radius: 6px;
      padding: 0.5rem 1rem; font-size: 0.9rem; cursor: pointer;
      margin-top: 0.75rem;
    }
    .btn:hover { background: #2ea043; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.saved { background: #1f6feb; }
    .status { font-size: 0.8rem; color: #8b949e; margin-top: 0.5rem; }
    .loading { text-align: center; padding: 3rem; color: #8b949e; }
    .error { color: #f85149; }
  </style>
</head>
<body>
  <h1>Configure your repos</h1>
  <p class="subtitle">Tell us how to start each app so we can test your PRs.</p>

  <div id="repos">
    <div class="loading">Loading repos...</div>
  </div>

  <!-- Template for each repo card (cloned, not innerHTML) -->
  <template id="repo-template">
    <div class="repo-card">
      <div class="repo-header">
        <span class="repo-name"></span>
        <span class="badge unconfigured">Needs setup</span>
      </div>
      <div class="form-grid">
        <div class="form-group full">
          <label>Startup command</label>
          <input type="text" data-field="cmd" placeholder="npm run dev" />
        </div>
        <div class="form-group">
          <label>Port</label>
          <input type="number" data-field="port" />
        </div>
        <div class="form-group">
          <label>Health check path</label>
          <input type="text" data-field="health" placeholder="/" />
        </div>
      </div>
      <button class="btn">Save</button>
      <div class="status"></div>
    </div>
  </template>

  <script>
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get('installation_id');
    const container = document.getElementById('repos');
    const template = document.getElementById('repo-template');

    if (!installationId) {
      container.textContent = '';
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = 'Missing installation_id. Please install the GitHub App first.';
      container.appendChild(p);
    } else {
      loadRepos();
    }

    async function loadRepos() {
      try {
        const res = await fetch('/setup/api/repos?installation_id=' + encodeURIComponent(installationId));
        if (res.status === 401) {
          window.location.href = '/auth/github';
          return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const data = await res.json();
        renderRepos(data.repos);
      } catch (err) {
        container.textContent = '';
        const p = document.createElement('p');
        p.className = 'error';
        p.textContent = 'Failed to load repos: ' + err.message;
        container.appendChild(p);
      }
    }

    function renderRepos(repos) {
      container.textContent = '';

      if (repos.length === 0) {
        const p = document.createElement('p');
        p.textContent = 'No repos found for this installation.';
        container.appendChild(p);
        return;
      }

      repos.forEach(function(r) {
        const card = template.content.cloneNode(true);

        // Safe text insertion — no innerHTML with user data
        card.querySelector('.repo-name').textContent = r.fullName;

        const badge = card.querySelector('.badge');
        if (r.config) {
          badge.textContent = 'Configured';
          badge.classList.remove('unconfigured');
        } else {
          badge.textContent = 'Needs setup';
        }

        const cmdInput = card.querySelector('[data-field="cmd"]');
        cmdInput.value = r.config ? r.config.startup_command : 'npm run dev';

        const portInput = card.querySelector('[data-field="port"]');
        portInput.value = r.config ? r.config.port : 3000;

        const healthInput = card.querySelector('[data-field="health"]');
        healthInput.value = r.config ? r.config.health_path : '/';

        const btn = card.querySelector('.btn');
        const status = card.querySelector('.status');

        btn.addEventListener('click', function() {
          saveConfig(r.owner, r.repo, cmdInput, portInput, healthInput, btn, status, badge);
        });

        container.appendChild(card);
      });
    }

    async function saveConfig(owner, repo, cmdInput, portInput, healthInput, btn, status, badge) {
      btn.disabled = true;
      status.textContent = 'Saving...';
      status.className = 'status';

      var body = {
        installationId: Number(installationId),
        startupCommand: cmdInput.value,
        port: Number(portInput.value),
        healthPath: healthInput.value || '/',
      };

      try {
        var res = await fetch('/setup/api/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        status.textContent = 'Saved!';
        btn.classList.add('saved');
        btn.textContent = 'Saved';
        badge.textContent = 'Configured';
        badge.classList.remove('unconfigured');
      } catch (err) {
        status.textContent = 'Error: ' + err.message;
        status.classList.add('error');
      } finally {
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>
```

**Step 2: Verify it renders (manual)**

Open the file in a browser to check styling. No API calls needed yet.

**Step 3: Commit**

```bash
git add server/src/public/setup.html
git commit -m "feat: add setup page HTML for per-repo config"
```

---

## Task 6: Wire Everything Together

Mount the routes and serve the setup page.

**Files:**
- Modify: `server/src/index.ts` — mount setup routes, serve setup.html

**Step 1: Update `server/src/index.ts`**

Add import at the top (after the existing route imports):

```typescript
import { setupRoutes } from './routes/setup.js';
```

Add the setup HTML cache alongside the existing landing HTML cache (after the `landingHtml` line):

```typescript
const setupHtml = await readFile(join(__dirname, 'public', 'setup.html'), 'utf8');
```

Mount the setup page and API routes (after the webhooks route mount):

```typescript
app.get('/setup', (c) => c.html(setupHtml));
app.route('/setup', setupRoutes);
```

> **Note:** The OAuth callback in `auth.ts` still redirects to the GitHub App install page — no change needed. After installing, **GitHub itself** redirects to the Setup URL (`/setup?installation_id=X`) as configured in the GitHub App settings.

**Step 2: Type check**

Run: `cd server && npx tsc --noEmit`

**Step 3: Manual smoke test**

1. Run: `cd server && npm run dev`
2. Visit `http://localhost:3000/setup?installation_id=123` — should show the HTML page (API call will redirect to sign-in since no session cookie)
3. Sign in via `/auth/github`, install app on a test repo, verify GitHub redirects to `/setup?installation_id=<real-id>`
4. Verify repos load, fill in config, click Save, confirm it persists

**Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat: mount setup page and API routes"
```

---

## Task 7: Update GitHub App Settings (manual, no code)

In the GitHub App settings page:

1. Set **"Setup URL"** to `https://<your-domain>/setup`
2. Check **"Redirect on update"**

This ensures:
- After fresh install → GitHub redirects to `/setup?installation_id=X&setup_action=install`
- After adding/removing repos → GitHub redirects to `/setup?installation_id=X&setup_action=update`

---

## Summary of changes

| Task | What | Files |
|------|------|-------|
| 1 | Migration | `server/db/migrations/002_repo_configs.sql` |
| 2 | DB helpers | `server/src/db.ts`, `server/src/db.test.ts` |
| 3 | GitHub API | `server/src/github/installation.ts`, `server/src/github/installation.test.ts` |
| 4 | API routes + auth | `server/src/routes/setup.ts`, `server/src/routes/setup.test.ts` |
| 5 | Setup UI | `server/src/public/setup.html` |
| 6 | Wiring | `server/src/index.ts` |
| 7 | GitHub config | Manual — App settings page |
