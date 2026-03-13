import { Hono } from 'hono';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { tasks } from '@trigger.dev/sdk/v3';
import type { verifyPrTask } from '../verify/runner.js';
import type { unifiedPrTask, UnifiedPayload } from '../unified/runner.js';
import { shouldSkipVerification, verifySvixWebhook } from '../webhook/verify.js';
import { DeduplicationSet } from '../webhook/dedup.js';
import type { VerifyPayload } from '../verify/runner.js';
import { validateOwnerRepo } from '../github/validation.js';
import { findUserByLogin, upsertInstallation, findRepoConfig } from '../db.js';

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

export function createWebhookApp(): Hono {
  const app = new Hono();
  const dedup = new DeduplicationSet();

  app.post('/github', async (c) => {
    const rawBody = await c.req.text();
    const event = c.req.header('X-GitHub-Event') ?? '';

    // --- installation.created: uses GitHub HMAC verification ---
    if (event === 'installation') {
      const signature = c.req.header('X-Hub-Signature-256');
      if (!(await verifyGitHubSignature(rawBody, signature))) {
        return c.text('Invalid signature', 401);
      }

      const payload = JSON.parse(rawBody) as Record<string, unknown>;

      if (payload.action === 'created') {
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

      return c.json({ accepted: false, reason: 'action ignored' });
    }

    // --- pull_request: uses Svix verification + Trigger.dev dispatch ---
    if (event === 'pull_request') {
      const deliveryId = c.req.header('svix-id') ?? crypto.randomUUID();

      const skipVerification = shouldSkipVerification(
        process.env.NODE_ENV,
        process.env.SVIX_SKIP_VERIFICATION
      );

      if (!skipVerification) {
        const secret = process.env.SVIX_WEBHOOK_SECRET;
        if (!secret) {
          return c.json({ error: 'Webhook secret not configured' }, 503);
        }
        try {
          verifySvixWebhook(rawBody, Object.fromEntries(c.req.raw.headers.entries()), secret);
        } catch {
          return c.json({ error: 'Invalid signature' }, 401);
        }
      }

      let payload: { action?: string; number?: number; repository?: { owner?: { login?: string }; name?: string } };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }

      if (payload.action !== 'opened' && payload.action !== 'synchronize') {
        return c.json({ accepted: false, reason: 'Ignoring non-review action' });
      }

      const owner = payload.repository?.owner?.login;
      const repo = payload.repository?.name;
      const prNumber = payload.number;

      if (!owner || !repo || !prNumber) {
        return c.json({ error: 'Missing owner, repo, or PR number' }, 400);
      }

      try {
        validateOwnerRepo(owner, repo);
      } catch {
        return c.json({ error: 'Invalid owner or repo' }, 400);
      }

      if (dedup.isDuplicate(deliveryId)) {
        return c.json({ accepted: false, reason: 'Duplicate delivery' }, 200);
      }

      if (process.env.TRIGGER_SECRET_KEY) {
        // Unified pipeline: code review + AC verification in one task, one comment
        const unifiedPayload: UnifiedPayload = { owner, repo, prNumber, deliveryId };
        await tasks.trigger<typeof unifiedPrTask>('unified-pr', unifiedPayload);
      } else {
        console.warn('TRIGGER_SECRET_KEY not set — skipping task dispatch');
      }
      dedup.markSeen(deliveryId);

      return c.json({ accepted: true, prNumber, owner, repo }, 202);
    }

    // --- issue_comment: /verify command triggers verify pipeline ---
    if (event === 'issue_comment') {
      const signature = c.req.header('X-Hub-Signature-256');
      if (!(await verifyGitHubSignature(rawBody, signature))) {
        return c.text('Invalid signature', 401);
      }

      const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

      let payload: {
        action?: string;
        comment?: { body?: string; user?: { login?: string }; author_association?: string };
        issue?: { number?: number; pull_request?: { url?: string } };
        repository?: { owner?: { login?: string }; name?: string };
      };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }

      // Only process newly created comments
      if (payload.action !== 'created') {
        return c.json({ accepted: false, reason: 'action ignored' });
      }

      // Only respond to /verify command
      const commentBody = payload.comment?.body?.trim() ?? '';
      if (commentBody !== '/verify') {
        return c.json({ accepted: false, reason: 'not a verify command' });
      }

      // Only PR comments (not plain issue comments)
      if (!payload.issue?.pull_request?.url) {
        return c.json({ accepted: false, reason: 'not a pull request' });
      }

      const owner = payload.repository?.owner?.login;
      const repo = payload.repository?.name;
      const prNumber = payload.issue?.number;
      const commenter = payload.comment?.user?.login;

      if (!owner || !repo || !prNumber || !commenter) {
        return c.json({ error: 'Missing required fields' }, 400);
      }

      // Only allow repo collaborators/members/owners to trigger verify
      const association = payload.comment?.author_association ?? '';
      if (!ALLOWED_ASSOCIATIONS.has(association)) {
        return c.json({ accepted: false, reason: 'unauthorized' });
      }

      try {
        validateOwnerRepo(owner, repo);
      } catch {
        return c.json({ error: 'Invalid owner or repo' }, 400);
      }

      // Dedup before DB query
      const deliveryId = c.req.header('X-GitHub-Delivery') ?? crypto.randomUUID();
      if (dedup.isDuplicate(deliveryId)) {
        return c.json({ accepted: false, reason: 'Duplicate delivery' }, 200);
      }

      // Check repo config exists
      const repoConfig = await findRepoConfig(owner, repo);
      if (!repoConfig) {
        return c.json({ accepted: false, reason: 'no repo config' });
      }

      if (process.env.TRIGGER_SECRET_KEY) {
        const verifyPayload: VerifyPayload = { owner, repo, prNumber, deliveryId };
        await tasks.trigger<typeof verifyPrTask>('verify-pr', verifyPayload);
      } else {
        console.warn('TRIGGER_SECRET_KEY not set — skipping verify dispatch');
      }
      dedup.markSeen(deliveryId);

      return c.json({ accepted: true, event: 'issue_comment.verify', prNumber, owner, repo }, 202);
    }

    // --- all other events ---
    return c.json({ accepted: false, reason: 'event ignored' });
  });

  return app;
}

export const webhookRoutes = createWebhookApp();
