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
  delete process.env.GITHUB_APP_SLUG;
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

// --- issue_comment: @mention-triggered reviews ---

describe('POST /github — issue_comment @mention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SVIX_SKIP_VERIFICATION = 'true';
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_APP_SLUG = 'opslane-verify';
  });

  function makePayload(overrides: Record<string, unknown> = {}) {
    return {
      action: 'created',
      comment: {
        body: '@opslane-verify review this PR',
        user: { login: 'alice' },
        author_association: 'COLLABORATOR',
      },
      issue: {
        number: 42,
        pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/42' },
      },
      repository: {
        owner: { login: 'acme' },
        name: 'app',
      },
      ...overrides,
    };
  }

  it('accepts a valid @mention from a collaborator', async () => {
    const app = createWebhookApp();
    const body = JSON.stringify(makePayload());
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'issue_comment',
      },
      body,
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { accepted: boolean; trigger: string };
    expect(json.accepted).toBe(true);
    expect(json.trigger).toBe('mention');
  });

  it('ignores comments without @mention', async () => {
    const app = createWebhookApp();
    const payload = makePayload({
      comment: { body: 'just a regular comment', user: { login: 'alice' }, author_association: 'COLLABORATOR' },
    });
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'issue_comment' },
      body: JSON.stringify(payload),
    });
    const json = await res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe('no mention detected');
  });

  it('rejects unauthorized author_association', async () => {
    const app = createWebhookApp();
    const payload = makePayload({
      comment: { body: '@opslane-verify review', user: { login: 'stranger' }, author_association: 'NONE' },
    });
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'issue_comment' },
      body: JSON.stringify(payload),
    });
    const json = await res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe('unauthorized author');
  });

  it('ignores issue comments (not PR comments)', async () => {
    const app = createWebhookApp();
    const payload = makePayload({ issue: { number: 10 } }); // no pull_request field
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'issue_comment' },
      body: JSON.stringify(payload),
    });
    const json = await res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe('not a PR comment');
  });

  it('ignores non-created actions (edited, deleted)', async () => {
    const app = createWebhookApp();
    const payload = makePayload({ action: 'edited' });
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'issue_comment' },
      body: JSON.stringify(payload),
    });
    const json = await res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe('action ignored');
  });

  it('ignores comments from the bot itself (self-trigger guard)', async () => {
    const app = createWebhookApp();
    const payload = makePayload({
      comment: {
        body: '@opslane-verify here is my review...',
        user: { login: 'opslane-verify[bot]' },
        author_association: 'COLLABORATOR',
      },
    });
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'issue_comment' },
      body: JSON.stringify(payload),
    });
    const json = await res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe('bot comment ignored');
  });

  it('deduplicates deliveries', async () => {
    const app = createWebhookApp();
    const body = JSON.stringify(makePayload());
    const headers = {
      'Content-Type': 'application/json',
      'x-github-event': 'issue_comment',
      'svix-id': 'dedup-mention-123',
    };

    const res1 = await app.request('/github', { method: 'POST', headers, body });
    expect(res1.status).toBe(202);

    const res2 = await app.request('/github', { method: 'POST', headers, body });
    const json2 = await res2.json() as { accepted: boolean; reason: string };
    expect(json2.accepted).toBe(false);
    expect(json2.reason).toBe('Duplicate delivery');
  });

  it('returns accepted:false when GITHUB_APP_SLUG is not set', async () => {
    delete process.env.GITHUB_APP_SLUG;
    const app = createWebhookApp();
    const body = JSON.stringify(makePayload());
    const res = await app.request('/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-event': 'issue_comment' },
      body,
    });
    const json = await res.json() as { accepted: boolean; reason: string };
    expect(json.accepted).toBe(false);
    expect(json.reason).toBe('app slug not configured');
  });
});
