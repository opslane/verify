import { Webhook } from "svix";

export const REVIEW_COMMENT_MARKER = "<!-- opslane-code-review -->";

/**
 * Svix skip flag: only honoured outside production.
 * Guards against accidental production bypass.
 */
export function shouldSkipVerification(
  nodeEnv: string | undefined,
  skipFlag: string | undefined
): boolean {
  if (nodeEnv === "production") return false;
  return skipFlag === "true";
}

/**
 * Verify a Svix-forwarded webhook. Throws if invalid.
 */
export function verifySvixWebhook(
  payload: string,
  headers: Record<string, string>,
  secret: string
): void {
  const wh = new Webhook(secret);
  wh.verify(payload, headers);
}
