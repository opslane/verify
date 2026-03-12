import { describe, it, expect, afterEach } from "vitest";
import { createWebhookApp } from "./webhooks.js";

afterEach(() => {
  delete process.env.SVIX_WEBHOOK_SECRET;
  delete process.env.SVIX_SKIP_VERIFICATION;
  delete process.env.NODE_ENV;
});

describe("POST /webhooks/github — missing body fields", () => {
  it("returns 400 for PR event with missing owner", async () => {
    process.env.SVIX_SKIP_VERIFICATION = "true";
    process.env.NODE_ENV = "test";
    const app = createWebhookApp();
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
      },
      body: JSON.stringify({ action: "opened", number: 42 }), // missing repository
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /webhooks/github", () => {
  it("returns 401 when Svix verification fails", async () => {
    process.env.SVIX_WEBHOOK_SECRET = "whsec_test_secret_at_least_32_chars_long!!";
    process.env.NODE_ENV = "production";
    const app = createWebhookApp();
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 accepted:false for non-PR events when verification skipped", async () => {
    process.env.SVIX_SKIP_VERIFICATION = "true";
    process.env.NODE_ENV = "test";
    const app = createWebhookApp();
    const res = await app.request("/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted: boolean };
    expect(body.accepted).toBe(false);
  });
});
