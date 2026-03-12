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
