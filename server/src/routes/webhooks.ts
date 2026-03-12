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
