import { Hono } from 'hono';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { findUserByLogin, upsertInstallation } from '../db.js';

export const webhooksRouter = new Hono();

function env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

async function verifyGitHubSignature(body: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  const secret = env('GITHUB_WEBHOOK_SECRET');
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

webhooksRouter.post('/github', async (c) => {
  // Read raw body first — must happen before any .json() call
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Hub-Signature-256');

  if (!(await verifyGitHubSignature(rawBody, signature))) {
    return c.text('Invalid signature', 401);
  }

  const event = c.req.header('X-GitHub-Event');
  const payload = JSON.parse(rawBody) as Record<string, unknown>;

  if (event === 'installation' && payload.action === 'created') {
    const installation = payload.installation as { id: number; account: { login: string } } | undefined;
    const sender = payload.sender as { login: string } | undefined;

    if (!installation?.id || !installation.account?.login || !sender?.login) {
      return c.json({ accepted: false, reason: 'malformed payload' }, 400);
    }

    const user = await findUserByLogin(sender.login);

    await upsertInstallation({
      orgId: user?.org_id ?? null,
      installationId: installation.id,
      githubAccountLogin: installation.account.login,
    });

    return c.json({ accepted: true, event: 'installation.created' });
  }

  if (event === 'pull_request') {
    const pr = payload.pull_request as { number: number } | undefined;
    const action = payload.action as string;

    if (action !== 'opened' && action !== 'synchronize') {
      return c.json({ accepted: false, reason: 'action ignored' });
    }

    if (!pr?.number) {
      return c.json({ accepted: false, reason: 'malformed payload' }, 400);
    }

    // TODO: PR review pipeline (see docs/plans/2026-03-12-code-reviewer-design.md)
    console.log(`PR review triggered for PR #${pr.number} — stub`);
    return c.json({ accepted: true, event: 'pull_request' });
  }

  return c.json({ accepted: false, reason: 'event ignored' });
});
