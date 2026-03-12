import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { MockInstance } from 'vitest';

vi.mock('../db.js', () => ({
  upsertOrg: vi.fn().mockResolvedValue({ id: 'org-uuid', github_org_login: 'jsmith', name: 'jsmith' }),
  upsertUser: vi.fn().mockResolvedValue({ id: 'user-uuid', org_id: 'org-uuid', github_login: 'jsmith' }),
  sql: {},
}));

import { upsertOrg, upsertUser } from '../db.js';

const BASE_ENV = {
  GITHUB_OAUTH_CLIENT_ID: 'test-client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
  JWT_SECRET: 'test-secret-32-chars-minimum-ok!',
  GITHUB_APP_SLUG: 'test-app',
};

async function createTestApp() {
  const { authRouter } = await import('./auth.js');
  const app = new Hono();
  app.route('/auth', authRouter);
  return app;
}

describe('/auth/github', () => {
  it('redirects to GitHub OAuth with state param', async () => {
    Object.assign(process.env, BASE_ENV);

    const app = await createTestApp();
    const res = await app.request('/auth/github');

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('state=');

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('oauth_state=');
    expect(cookie).toContain('HttpOnly');
  });
});

describe('/auth/callback', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, BASE_ENV);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('redirects to cancelled when code is missing (checked before state)', async () => {
    const app = await createTestApp();
    const res = await app.request('/auth/callback');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?error=cancelled');
  });

  it('returns 400 when state cookie is missing', async () => {
    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=abc&state=xyz');
    expect(res.status).toBe(400);
  });

  it('returns 400 when state param does not match cookie', async () => {
    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=abc&state=wrong', {
      headers: { Cookie: 'oauth_state=correct' },
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 when GitHub token exchange fails', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }),
    );

    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=bad&state=s', {
      headers: { Cookie: 'oauth_state=s' },
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when GitHub token exchange returns non-200', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));

    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=abc&state=s', {
      headers: { Cookie: 'oauth_state=s' },
    });
    expect(res.status).toBe(502);
  });

  it('returns 502 when GitHub user API returns non-200', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'gho_token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('', { status: 401 }));

    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=abc&state=s', {
      headers: { Cookie: 'oauth_state=s' },
    });
    expect(res.status).toBe(502);
  });

  it('happy path: exchanges code, upserts user, sets session cookie, redirects to app install', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'gho_token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 123, login: 'jsmith', name: 'J Smith', email: 'j@example.com' }),
          { status: 200 },
        ),
      );

    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=goodcode&state=s', {
      headers: { Cookie: 'oauth_state=s' },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/apps/test-app/installations/new',
    );

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('session=');
    expect(cookie).toContain('HttpOnly');

    expect(upsertOrg).toHaveBeenCalledWith('jsmith', 'J Smith');
    expect(upsertUser).toHaveBeenCalledWith({
      orgId: 'org-uuid',
      githubId: '123',
      githubLogin: 'jsmith',
      email: 'j@example.com',
      name: 'J Smith',
    });
  });

  it('fetches emails when user email is null', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'gho_token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 456, login: 'private-user', name: null, email: null }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { email: 'private@example.com', primary: true, verified: true },
            { email: 'other@example.com', primary: false, verified: true },
          ]),
          { status: 200 },
        ),
      );

    const app = await createTestApp();
    const res = await app.request('/auth/callback?code=abc&state=s', {
      headers: { Cookie: 'oauth_state=s' },
    });

    expect(res.status).toBe(302);
    expect(upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'private@example.com' }),
    );
  });
});
