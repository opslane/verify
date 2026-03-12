import { task, logger } from "@trigger.dev/sdk/v3";
import { runReviewPipeline } from "./pipeline.js";

export interface ReviewPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
}

export const reviewPrTask = task({
  id: "review-pr",
  maxDuration: 300, // Trigger.dev max seconds

  run: async (payload: ReviewPayload) => {
    const { owner, repo, prNumber } = payload;
    logger.info("Starting PR review", { owner, repo, prNumber });

    const result = await runReviewPipeline(
      { owner, repo, prNumber },
      {
        log: (step, message, data) => {
          if (data) {
            logger.info(`[${step}] ${message}`, data as Record<string, unknown>);
          } else {
            logger.info(`[${step}] ${message}`);
          }
        },
      }
    );

    if (!result.commentUrl) {
      logger.warn("Empty review output — skipping comment");
      return { skipped: true };
    }

    return { commentUrl: result.commentUrl };
  },
});
