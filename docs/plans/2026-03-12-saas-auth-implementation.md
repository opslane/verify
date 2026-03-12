# SaaS Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add GitHub OAuth sign-up + Postgres user storage to the verify code reviewer server so teams can self-serve install the GitHub App.

**Architecture:** Hono server in `server/` with four routes: landing page, `/auth/github`, `/auth/callback`, and `POST /webhooks/github`. Postgres via `postgres.js` with numbered SQL migrations run at boot. Session is a JWT in an httpOnly cookie (90-day expiry). GitHub OAuth App handles sign-in; GitHub App handles PR webhooks — two separate GitHub entities.

**Tech Stack:** TypeScript, Hono, `@hono/node-server`, `postgres` (postgres.js), `hono/jwt`, `vitest`

**Design doc:** `docs/plans/2026-03-12-saas-auth-design.md` — read this if anything below is unclear.

---

## Task 1: Server Scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "verify-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "NODE_OPTIONS=--experimental-vm-modules vitest run",
    "test:watch": "NODE_OPTIONS=--experimental-vm-modules vitest"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.7",
    "hono": "^4.7.4",
    "postgres": "^3.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "tsx": "^4.19.3",
    "typescript": "^5.8.2",
    "vitest": "^3.0.8"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

**Step 3: Create src/index.ts (minimal — routes added in later tasks)**

```typescript
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on port ${port}`);
});

export { app };
```

**Step 4: Install dependencies**

```bash
cd server && npm install
```

Expected: `node_modules/` created, no errors.

**Step 5: Verify server starts**

```bash
cd server && npm run dev
```

Expected: `Server running on port 3000`

**Step 6: Commit**

```bash
git add server/package.json server/tsconfig.json server/src/index.ts
git commit -m "feat(server): scaffold Hono server"
```

---

## Task 2: DB Connection + Migrations

**Files:**
- Create: `server/src/db.ts`
- Create: `server/src/migrate.ts`
- Create: `server/db/migrations/001_foundation.sql`

**Step 1: Write failing test for migrate**

Create `server/src/migrate.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { runMigrations } from './migrate.js';

// Requires TEST_DATABASE_URL env var pointing to a real Postgres instance
// e.g. postgres://localhost:5432/verify_test
const TEST_DB = process.env.TEST_DATABASE_URL;

describe('runMigrations', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
    sql = postgres(TEST_DB);
    // Clean slate
    await sql`DROP TABLE IF EXISTS github_installations, users, orgs CASCADE`;
    await sql`DROP EXTENSION IF EXISTS pgcrypto CASCADE`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it('creates all three tables', async () => {
    await runMigrations(TEST_DB!);

    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename IN ('orgs', 'users', 'github_installations')
      ORDER BY tablename
    `;
    expect(tables.map((r) => r.tablename)).toEqual([
      'github_installations',
      'orgs',
      'users',
    ]);
  });

  it('is idempotent — running twice does not error', async () => {
    await expect(runMigrations(TEST_DB!)).resolves.not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && TEST_DATABASE_URL=postgres://localhost:5432/verify_test npm test -- migrate
```

Expected: FAIL — `Cannot find module './migrate.js'`

**Step 3: Create db/migrations/001_foundation.sql**

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS orgs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_org_login TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id),
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  email TEXT,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES orgs(id),
  installation_id BIGINT NOT NULL UNIQUE,
  github_account_login TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login);
```

**Step 4: Create src/migrate.ts**

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl);
  try {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const content = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await sql.unsafe(content);
      console.log(`Migration applied: ${file}`);
    }
  } finally {
    await sql.end();
  }
}
```

**Step 5: Create src/db.ts**

```typescript
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

export const sql = postgres(DATABASE_URL);

export interface Org {
  id: string;
  github_org_login: string;
  name: string;
  created_at: Date;
}

export interface User {
  id: string;
  org_id: string;
  github_id: string;
  github_login: string;
  email: string | null;
  name: string | null;
  created_at: Date;
}

export async function upsertOrg(login: string, name: string): Promise<Org> {
  const [org] = await sql<Org[]>`
    INSERT INTO orgs (github_org_login, name)
    VALUES (${login}, ${name})
    ON CONFLICT (github_org_login)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING *
  `;
  return org;
}

export async function upsertUser(params: {
  orgId: string;
  githubId: string;
  githubLogin: string;
  email: string | null;
  name: string | null;
}): Promise<User> {
  const [user] = await sql<User[]>`
    INSERT INTO users (org_id, github_id, github_login, email, name)
    VALUES (${params.orgId}, ${params.githubId}, ${params.githubLogin}, ${params.email}, ${params.name})
    ON CONFLICT (github_id)
    DO UPDATE SET
      github_login = EXCLUDED.github_login,
      email = EXCLUDED.email,
      name = EXCLUDED.name
    RETURNING *
  `;
  return user;
}

export async function upsertInstallation(params: {
  orgId: string | null;
  installationId: number;
  githubAccountLogin: string;
}): Promise<void> {
  await sql`
    INSERT INTO github_installations (org_id, installation_id, github_account_login)
    VALUES (${params.orgId}, ${params.installationId}, ${params.githubAccountLogin})
    ON CONFLICT (installation_id)
    DO UPDATE SET
      org_id = COALESCE(EXCLUDED.org_id, github_installations.org_id),
      github_account_login = EXCLUDED.github_account_login
  `;
}

export async function findUserByLogin(githubLogin: string): Promise<User | null> {
  const [user] = await sql<User[]>`
    SELECT * FROM users WHERE github_login = ${githubLogin}
  `;
  return user ?? null;
}
```

**Step 6: Run test to verify it passes**

```bash
cd server && TEST_DATABASE_URL=postgres://localhost:5432/verify_test npm test -- migrate
```

Expected: PASS — both tests green.

**Step 7: Wire migrations into server startup**

Edit `server/src/index.ts` — add migration call before `serve()`:

```typescript
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { runMigrations } from './migrate.js';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);

const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  await runMigrations(DATABASE_URL);
}

serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on port ${port}`);
});

export { app };
```

**Step 8: Commit**

```bash
git add server/src/db.ts server/src/migrate.ts server/src/migrate.test.ts server/db/migrations/001_foundation.sql server/src/index.ts
git commit -m "feat(server): add postgres connection, migrations, and db helpers"
```

---

## Task 3: Landing Page

**Files:**
- Create: `server/src/public/index.html`
- Modify: `server/src/index.ts`

**Step 1: Create the landing page**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify — AI Code Reviewer</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0d1117;
      color: #e6edf3;
    }
    .card {
      text-align: center;
      max-width: 400px;
      padding: 2rem;
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    p { color: #8b949e; margin-bottom: 2rem; }
    a.btn {
      display: inline-block;
      background: #238636;
      color: #fff;
      text-decoration: none;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      font-size: 1rem;
      font-weight: 500;
    }
    a.btn:hover { background: #2ea043; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Verify</h1>
    <p>Automated AI code review on every pull request.</p>
    <a class="btn" href="/auth/github">Sign in with GitHub</a>
  </div>
</body>
</html>
```

**Step 2: Serve it from index.ts**

Add to `server/src/index.ts` before the `serve()` call:

```typescript
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

app.get('/', async (c) => {
  const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf8');
  return c.html(html);
});
```

**Step 3: Manually verify**

```bash
cd server && npm run dev
# open http://localhost:3000 in browser
```

Expected: Dark page with "Sign in with GitHub" green button.

**Step 4: Commit**

```bash
git add server/src/public/index.html server/src/index.ts
git commit -m "feat(server): add landing page"
```

---

## Task 4: Auth Routes — /auth/github and /auth/callback

**Files:**
- Create: `server/src/routes/auth.ts`
- Create: `server/src/routes/auth.test.ts`
- Modify: `server/src/index.ts`

**Background — what these routes do:**

`GET /auth/github`:
1. Generate a random 32-byte hex `state` token
2. Set it as an httpOnly cookie `oauth_state` with 10-minute TTL
3. Redirect to `https://github.com/login/oauth/authorize?client_id=...&scope=read:user+user:email&state=<value>`

`GET /auth/callback`:
1. Read `state` query param + `oauth_state` cookie — return 400 if mismatch or missing
2. Clear the `oauth_state` cookie
3. POST to `https://github.com/login/oauth/access_token` with `code` + client credentials → get `access_token`
4. GET `https://api.github.com/user` with `Authorization: Bearer <access_token>` → get user info
5. GET `https://api.github.com/user/emails` → get primary verified email
6. `upsertOrg(user.login, user.name ?? user.login)` — 1:1 org per user
7. `upsertUser({ orgId, githubId: String(user.id), ... })`
8. Sign a JWT: `{ sub: user.id, orgId, login: user.login }`, 90-day expiry, HS256
9. Set JWT as httpOnly cookie `session` (Secure in prod, SameSite=Lax)
10. Redirect to `GITHUB_APP_INSTALL_URL`

**Step 1: Write failing tests**

Create `server/src/routes/auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock db.ts before any import of auth.ts — importing auth.ts imports db.ts,
// which throws at module load time if DATABASE_URL is not set.
vi.mock('../db.js', () => ({
  upsertOrg: vi.fn().mockResolvedValue({ id: 'org-uuid', github_org_login: 'jsmith', name: 'jsmith' }),
  upsertUser: vi.fn().mockResolvedValue({ id: 'user-uuid', org_id: 'org-uuid', github_login: 'jsmith' }),
  sql: {},
}));

describe('/auth/github', () => {
  it('redirects to GitHub OAuth with state param', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-ok!';
    process.env.GITHUB_APP_INSTALL_URL = 'https://github.com/apps/test/installations/new';

    const { authRouter } = await import('./auth.js');
    const app = new Hono();
    app.route('/auth', authRouter);

    const res = await app.request('/auth/github');

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('state=');

    // Should set oauth_state cookie
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('oauth_state=');
    expect(cookie).toContain('HttpOnly');
  });
});

describe('/auth/callback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-ok!';
    process.env.GITHUB_APP_INSTALL_URL = 'https://github.com/apps/test/installations/new';
  });

  it('returns 400 when state cookie is missing', async () => {
    const { authRouter } = await import('./auth.js');
    const app = new Hono();
    app.route('/auth', authRouter);

    const res = await app.request('/auth/callback?code=abc&state=xyz');
    expect(res.status).toBe(400);
  });

  it('returns 400 when state param does not match cookie', async () => {
    const { authRouter } = await import('./auth.js');
    const app = new Hono();
    app.route('/auth', authRouter);

    const res = await app.request('/auth/callback?code=abc&state=wrong', {
      headers: { Cookie: 'oauth_state=correct' },
    });
    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
cd server && npm test -- auth
```

Expected: FAIL — `Cannot find module './auth.js'`

**Step 3: Create src/routes/auth.ts**

```typescript
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';
import { randomBytes } from 'node:crypto';
import { upsertOrg, upsertUser } from '../db.js';

export const authRouter = new Hono();

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

authRouter.get('/github', (c) => {
  const state = randomBytes(32).toString('hex');

  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 60 * 10, // 10 minutes
    path: '/',
  });

  const params = new URLSearchParams({
    client_id: env('GITHUB_OAUTH_CLIENT_ID'),
    scope: 'read:user user:email',
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

authRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const stateParam = c.req.query('state');
  const stateCookie = getCookie(c, 'oauth_state');

  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return c.text('Invalid state', 400);
  }

  deleteCookie(c, 'oauth_state', { path: '/' });

  // User denied OAuth or code is missing
  if (!code) {
    return c.redirect('/?error=cancelled');
  }

  // Exchange code for access token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('GITHUB_OAUTH_CLIENT_ID'),
      client_secret: env('GITHUB_OAUTH_CLIENT_SECRET'),
      code,
    }),
  });

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.text('GitHub OAuth failed', 502);
  }

  const accessToken = tokenData.access_token;
  const ghHeaders = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
  };

  // Fetch user info
  const userRes = await fetch('https://api.github.com/user', { headers: ghHeaders });
  const ghUser = await userRes.json() as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
  };

  // Fetch emails (in case primary email is private)
  let email = ghUser.email;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', { headers: ghHeaders });
    const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
    email = emails.find((e) => e.primary && e.verified)?.email ?? null;
  }

  // Upsert org (1:1 with user for v1)
  const org = await upsertOrg(ghUser.login, ghUser.name ?? ghUser.login);

  // Upsert user
  const user = await upsertUser({
    orgId: org.id,
    githubId: String(ghUser.id),
    githubLogin: ghUser.login,
    email,
    name: ghUser.name,
  });

  // Sign JWT (90-day expiry)
  const jwtSecret = env('JWT_SECRET');
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
  const token = await sign(
    { sub: user.id, orgId: org.id, login: ghUser.login, exp: expiresAt },
    jwtSecret,
  );

  setCookie(c, 'session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 90,
    path: '/',
  });

  return c.redirect(env('GITHUB_APP_INSTALL_URL'));
});
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npm test -- auth
```

Expected: PASS — 3 tests green. (The DB-touching parts of callback are not unit-tested here; they're covered by the manual smoke test in Task 6.)

**Step 5: Register auth router in index.ts**

Add to `server/src/index.ts`:

```typescript
import { authRouter } from './routes/auth.js';
// ...
app.route('/auth', authRouter);
```

**Step 6: Commit**

```bash
git add server/src/routes/auth.ts server/src/routes/auth.test.ts server/src/index.ts
git commit -m "feat(server): add GitHub OAuth sign-in with CSRF state protection"
```

---

## Task 5: Webhook Route + Installation Handler

**Files:**
- Create: `server/src/routes/webhooks.ts`
- Create: `server/src/routes/webhooks.test.ts`
- Modify: `server/src/index.ts`

**Background:** The webhook route handles two event types:
- `pull_request` (opened/synchronize) → PR review (stub for now — full implementation in code-reviewer plan)
- `installation` (created) → link GitHub App installation to the user's org

**Step 1: Write failing test**

Create `server/src/routes/webhooks.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Single vi.mock at file top — Vitest hoists all vi.mock calls regardless of where
// they appear in source. Multiple vi.mock calls for the same module in different
// describe blocks only use the first factory. Use vi.mocked() per-test instead.
vi.mock('../db.js', () => ({
  findUserByLogin: vi.fn(),
  upsertInstallation: vi.fn(),
  upsertOrg: vi.fn(),
  upsertUser: vi.fn(),
  sql: {},
}));

import { findUserByLogin, upsertInstallation } from '../db.js';
import { webhooksRouter } from './webhooks.js';

describe('POST /webhooks/github — installation.created', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links installation to existing user by sender.login', async () => {
    vi.mocked(findUserByLogin).mockResolvedValue({
      id: 'user-uuid',
      org_id: 'org-uuid',
      github_id: '123',
      github_login: 'jsmith',
      email: null,
      name: null,
      created_at: new Date(),
    });
    vi.mocked(upsertInstallation).mockResolvedValue(undefined);

    const app = new Hono();
    app.route('/webhooks', webhooksRouter);

    const payload = {
      action: 'created',
      installation: { id: 12345, account: { login: 'acme-corp' } },
      sender: { login: 'jsmith' },
    };

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'installation' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(findUserByLogin).toHaveBeenCalledWith('jsmith');
    expect(upsertInstallation).toHaveBeenCalledWith({
      orgId: 'org-uuid',
      installationId: 12345,
      githubAccountLogin: 'acme-corp',
    });
  });

  it('stores installation without org_id when sender has no account', async () => {
    vi.mocked(findUserByLogin).mockResolvedValue(null);
    vi.mocked(upsertInstallation).mockResolvedValue(undefined);

    const app = new Hono();
    app.route('/webhooks', webhooksRouter);

    const payload = {
      action: 'created',
      installation: { id: 99999, account: { login: 'unknown-org' } },
      sender: { login: 'unknown-user' },
    };

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'installation' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    expect(upsertInstallation).toHaveBeenCalledWith({
      orgId: null,
      installationId: 99999,
      githubAccountLogin: 'unknown-org',
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd server && npm test -- webhooks
```

Expected: FAIL — `Cannot find module './webhooks.js'`

**Step 3: Create src/routes/webhooks.ts**

```typescript
import { Hono } from 'hono';
import { findUserByLogin, upsertInstallation } from '../db.js';

export const webhooksRouter = new Hono();

webhooksRouter.post('/github', async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const payload = await c.req.json<Record<string, unknown>>();

  if (event === 'installation' && payload.action === 'created') {
    const installation = payload.installation as { id: number; account: { login: string } };
    const sender = payload.sender as { login: string };

    const user = await findUserByLogin(sender.login);

    await upsertInstallation({
      orgId: user?.org_id ?? null,
      installationId: installation.id,
      githubAccountLogin: installation.account.login,
    });

    return c.json({ accepted: true, event: 'installation.created' });
  }

  if (event === 'pull_request') {
    const pr = payload.pull_request as { number: number };
    const action = payload.action as string;

    if (action !== 'opened' && action !== 'synchronize') {
      return c.json({ accepted: false, reason: 'action ignored' });
    }

    // TODO: PR review pipeline (see docs/plans/2026-03-12-code-reviewer-design.md)
    console.log(`PR review triggered for PR #${pr.number} — stub`);
    return c.json({ accepted: true, event: 'pull_request' });
  }

  return c.json({ accepted: false, reason: 'event ignored' });
});
```

**Step 4: Run tests to verify they pass**

```bash
cd server && npm test -- webhooks
```

Expected: PASS — 2 tests green.

**Step 5: Register webhooks router in index.ts**

Add to `server/src/index.ts`:

```typescript
import { webhooksRouter } from './routes/webhooks.js';
// ...
app.route('/webhooks', webhooksRouter);
```

**Step 6: Commit**

```bash
git add server/src/routes/webhooks.ts server/src/routes/webhooks.test.ts server/src/index.ts
git commit -m "feat(server): add webhook route with installation.created handler"
```

---

## Task 6: Dockerfile + env.example

**Files:**
- Create: `server/Dockerfile`
- Create: `.env.example` (repo root)

**Step 1: Create Dockerfile**

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production=false

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node_modules/.bin/tsx", "src/index.ts"]
```

**Step 2: Create .env.example at repo root**

```bash
# verify server — copy to .env and fill in values
# Never commit .env

# GitHub OAuth App (for user sign-in)
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=

# GitHub App (for PR webhooks)
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=          # base64-encoded PEM
GITHUB_APP_INSTALL_URL=          # https://github.com/apps/<your-app>/installations/new

# Svix (webhook delivery)
SVIX_WEBHOOK_SECRET=

# E2B (sandbox for PR review)
E2B_API_KEY=

# Database
DATABASE_URL=                    # postgres://user:pass@host:5432/dbname

# Auth
JWT_SECRET=                      # random 32+ char secret: openssl rand -hex 32

# Server
PORT=3000
```

**Step 3: Verify .env is gitignored**

```bash
grep -q "^\.env$" .gitignore || echo ".env" >> .gitignore
grep -q "^\.env\.local$" .gitignore || echo ".env.local" >> .gitignore
```

**Step 4: Commit**

```bash
git add server/Dockerfile .env.example .gitignore
git commit -m "feat(server): add Dockerfile and env.example"
```

---

## Task 7: Smoke Test (manual)

This task verifies the full sign-up flow end-to-end. You need:
- A local Postgres instance (`postgres://localhost:5432/verify_dev`)
- A GitHub OAuth App with callback URL `http://localhost:3000/auth/callback`
- The GitHub App install URL

**Step 1: Create local .env**

```bash
cp .env.example .env
# Fill in GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET,
# GITHUB_APP_INSTALL_URL, DATABASE_URL, JWT_SECRET
```

**Step 2: Create the test database**

```bash
createdb verify_dev
```

**Step 3: Start the server**

```bash
cd server && npm run dev
```

Expected: `Migration applied: 001_foundation.sql` then `Server running on port 3000`

**Step 4: Verify landing page**

Open `http://localhost:3000` — should see dark landing page with "Sign in with GitHub" button.

**Step 5: Complete sign-in flow**

Click "Sign in with GitHub" → authorize → should redirect to GitHub App install page.

**Step 6: Verify DB records were created**

```bash
psql verify_dev -c "SELECT github_org_login FROM orgs;"
psql verify_dev -c "SELECT github_login, email FROM users;"
```

Expected: Your GitHub username in both tables.

**Step 7: Run all tests**

```bash
cd server && npm test
```

Expected: All tests pass.

**Step 8: Final commit**

```bash
git add -A
git commit -m "chore(server): verify smoke test complete"
```
