import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock DB for installation handler tests
vi.mock('../db.js', () => ({
  findUserByLogin: vi.fn(),
  upsertInstallation: vi.fn(),
  upsertOrg: vi.fn(),
  upsertUser: vi.fn(),
  findRepoConfig: vi.fn(),
  sql: {},
}));

import { findUserByLogin, upsertInstallation, findRepoConfig } from '../db.js';
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

// --- issue_comment: /verify command ---

describe('POST /github — issue_comment (/verify)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  function makeIssueCommentPayload(overrides: Record<string, unknown> = {}) {
    return {
      action: 'created',
      comment: { body: '/verify', user: { login: 'jsmith' } },
      issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/42' } },
      repository: { owner: { login: 'org' }, name: 'repo' },
      ...overrides,
    };
  }

  it('returns 401 with missing signature', async () => {
    const app = createWebhookApp();
    const body = JSON.stringify(makeIssueCommentPayload());
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issue_comment',
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('accepts /verify comment when repo config exists', async () => {
    vi.mocked(findRepoConfig).mockResolvedValue({
      id: 'cfg-uuid', installation_id: 1, owner: 'org', repo: 'repo',
      startup_command: 'npm start', port: 3000, install_command: null,
      pre_start_script: null, health_path: '/', test_email: null,
      test_password: null, env_vars: null, detected_infra: [],
      created_at: new Date(), updated_at: new Date(),
    });

    const app = createWebhookApp();
    const payload = makeIssueCommentPayload();
    const body = JSON.stringify(payload);
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issue_comment',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { accepted: boolean; event: string };
    expect(json.accepted).toBe(true);
    expect(json.event).toBe('issue_comment.verify');
  });

  it('ignores non-/verify comments', async () => {
    const app = createWebhookApp();
    const payload = makeIssueCommentPayload({
      comment: { body: 'looks good to me', user: { login: 'jsmith' } },
    });
    const body = JSON.stringify(payload);
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issue_comment',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { reason: string };
    expect(json.reason).toBe('not a verify command');
  });

  it('rejects when no repo config exists', async () => {
    vi.mocked(findRepoConfig).mockResolvedValue(null);

    const app = createWebhookApp();
    const payload = makeIssueCommentPayload();
    const body = JSON.stringify(payload);
    const res = await app.request('/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issue_comment',
        'X-Hub-Signature-256': sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { reason: string };
    expect(json.reason).toBe('no repo config');
  });
});
