import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';

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

const WEBHOOK_SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function makeApp() {
  const app = new Hono();
  app.route('/webhooks', webhooksRouter);
  return app;
}

describe('POST /webhooks/github — HMAC verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it('returns 401 when signature header is missing', async () => {
    const app = makeApp();
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'ping' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature is wrong', async () => {
    const app = makeApp();
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': 'sha256=badhash',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /webhooks/github — installation.created', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
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

    const app = makeApp();

    const payload = {
      action: 'created',
      installation: { id: 12345, account: { login: 'acme-corp' } },
      sender: { login: 'jsmith' },
    };
    const body = JSON.stringify(payload);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': sign(body),
      },
      body,
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

    const app = makeApp();

    const payload = {
      action: 'created',
      installation: { id: 99999, account: { login: 'unknown-org' } },
      sender: { login: 'unknown-user' },
    };
    const body = JSON.stringify(payload);

    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(upsertInstallation).toHaveBeenCalledWith({
      orgId: null,
      installationId: 99999,
      githubAccountLogin: 'unknown-org',
    });
  });
});
