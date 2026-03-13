import { task, logger } from "@trigger.dev/sdk/v3";
import { runReviewPipeline } from "./pipeline.js";
import { runMentionPipeline } from "./mention-pipeline.js";

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

    if (!result.reviewUrl) {
      logger.warn("Empty review output — skipping comment");
      return { skipped: true };
    }

    return { reviewUrl: result.reviewUrl };
  },
});

export interface MentionPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
  mentionComment: string;
}

export const mentionPrTask = task({
  id: "mention-pr",
  maxDuration: 300,

  run: async (payload: MentionPayload) => {
    const { owner, repo, prNumber, mentionComment } = payload;
    logger.info("Starting mention response", { owner, repo, prNumber });

    const result = await runMentionPipeline(
      { owner, repo, prNumber, mentionComment },
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
      logger.warn("Empty mention response — skipping comment");
      return { skipped: true };
    }

    return { commentUrl: result.commentUrl };
  },
});
