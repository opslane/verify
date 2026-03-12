import { Hono } from "hono";
import { tasks } from "@trigger.dev/sdk/v3";
import type { reviewPrTask } from "../review/runner.js";
import { shouldSkipVerification, verifySvixWebhook } from "../webhook/verify.js";
import { DeduplicationSet } from "../webhook/dedup.js";
import type { ReviewPayload } from "../review/runner.js";
import { validateOwnerRepo } from "../github/validation.js";

export function createWebhookApp(): Hono {
  const app = new Hono();
  const dedup = new DeduplicationSet(); // fresh per factory call (production uses singleton via webhookRoutes)

  app.post("/github", async (c) => {
    const rawBody = await c.req.text();
    const deliveryId = c.req.header("svix-id") ?? crypto.randomUUID();
    const eventType = c.req.header("x-github-event") ?? "";

    // Svix signature verification
    const skipVerification = shouldSkipVerification(
      process.env.NODE_ENV,
      process.env.SVIX_SKIP_VERIFICATION
    );

    if (!skipVerification) {
      const secret = process.env.SVIX_WEBHOOK_SECRET;
      if (!secret) {
        return c.json({ error: "Webhook secret not configured" }, 503);
      }
      try {
        verifySvixWebhook(rawBody, Object.fromEntries(c.req.raw.headers.entries()), secret);
      } catch {
        return c.json({ error: "Invalid signature" }, 401);
      }
    }

    // Only handle PR events
    if (eventType !== "pull_request") {
      return c.json({ accepted: false, reason: "Not a pull_request event" });
    }

    let payload: { action?: string; number?: number; repository?: { owner?: { login?: string }; name?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only handle opened + synchronize
    if (payload.action !== "opened" && payload.action !== "synchronize") {
      return c.json({ accepted: false, reason: "Ignoring non-review action" });
    }

    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const prNumber = payload.number;

    if (!owner || !repo || !prNumber) {
      return c.json({ error: "Missing owner, repo, or PR number" }, 400);
    }

    // Validate owner/repo at the boundary before dispatching the task
    try {
      validateOwnerRepo(owner, repo);
    } catch {
      return c.json({ error: "Invalid owner or repo" }, 400);
    }

    // Deduplicate
    if (dedup.isDuplicate(deliveryId)) {
      return c.json({ accepted: false, reason: "Duplicate delivery" }, 200);
    }

    // Trigger background task — respond 202 immediately
    // markSeen is called AFTER successful dispatch so Svix retries still work if trigger fails
    const reviewPayload: ReviewPayload = { owner, repo, prNumber, deliveryId };

    if (process.env.TRIGGER_SECRET_KEY) {
      await tasks.trigger<typeof reviewPrTask>("review-pr", reviewPayload);
    } else {
      console.warn("TRIGGER_SECRET_KEY not set — skipping task dispatch");
    }
    dedup.markSeen(deliveryId);

    return c.json({ accepted: true, prNumber, owner, repo }, 202);
  });

  return app;
}

// Export default Hono instance for server entry point
export const webhookRoutes = createWebhookApp();
