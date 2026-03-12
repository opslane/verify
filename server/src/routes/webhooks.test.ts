import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock DB for installation handler tests
vi.mock('../db.js', () => ({
  findUserByLogin: vi.fn(),
  upsertInstallation: vi.fn(),
  upsertOrg: vi.fn(),
  upsertUser: vi.fn(),
  sql: {},
}));

import { findUserByLogin, upsertInstallation } from '../db.js';
import { createWebhookApp } from './webhooks.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

afterEach(() => {
  delete process.env.SVIX_WEBHOOK_SECRET;
  delete process.env.SVIX_SKIP_VERIFICATION;
  delete process.env.NODE_ENV;
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

// --- Installation handler tests (HMAC verification) ---

describe('POST /github — HMAC verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  it('returns 401 when signature header is missing', async () => {
    const app = createWebhookApp();
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'installation' },
      body: JSON.stringify({ action: 'created' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature is wrong', async () => {
    const app = createWebhookApp();
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'installation',
        'X-Hub-Signature-256': 'sha256=badhash',
      },
      body: JSON.stringify({ action: 'created' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /github — installation.created', () => {
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

    const app = createWebhookApp();

    const payload = {
      action: 'created',
      installation: { id: 12345, account: { login: 'acme-corp' } },
      sender: { login: 'jsmith' },
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

    const app = createWebhookApp();

    const payload = {
      action: 'created',
      installation: { id: 99999, account: { login: 'unknown-org' } },
      sender: { login: 'unknown-user' },
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
    expect(upsertInstallation).toHaveBeenCalledWith({
      orgId: null,
      installationId: 99999,
      githubAccountLogin: 'unknown-org',
    });
  });
});

// --- PR dispatch tests (Svix verification) ---

describe('POST /github — missing body fields', () => {
  it('returns 400 for PR event with missing owner', async () => {
    process.env.SVIX_SKIP_VERIFICATION = 'true';
    process.env.NODE_ENV = 'test';
    const app = createWebhookApp();
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'pull_request',
      },
      body: JSON.stringify({ action: 'opened', number: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /github — Svix + PR dispatch', () => {
  it('returns 401 when Svix verification fails', async () => {
    process.env.SVIX_WEBHOOK_SECRET = 'whsec_test_secret_at_least_32_chars_long!!';
    process.env.NODE_ENV = 'production';
    const app = createWebhookApp();
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'pull_request' },
      body: JSON.stringify({ action: 'opened' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 accepted:false for non-PR events when verification skipped', async () => {
    process.env.SVIX_SKIP_VERIFICATION = 'true';
    process.env.NODE_ENV = 'test';
    const app = createWebhookApp();
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'push',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: boolean };
    expect(body.accepted).toBe(false);
  });
});
