import { task, logger } from '@trigger.dev/sdk/v3';
import { runUnifiedPipeline } from './pipeline.js';

export interface UnifiedPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
}

export const unifiedPrTask = task({
  id: 'unified-pr',
  maxDuration: 900, // 15 min — review (~3 min) + verify (~3 min) + buffer
  run: async (payload: UnifiedPayload) => {
    const { owner, repo, prNumber } = payload;
    logger.info('Starting unified pipeline', { owner, repo, prNumber });

    const result = await runUnifiedPipeline(
      { owner, repo, prNumber },
      {
        log: (step, message, data) => {
          if (data) {
            logger.info(`[${step}] ${message}`, data as Record<string, unknown>);
          } else {
            logger.info(`[${step}] ${message}`);
          }
        },
      },
    );

    return {
      reviewUrl: result.reviewUrl,
      commentUrl: result.commentUrl,
      verifyMode: result.verifyResult?.mode ?? 'skipped',
    };
  },
});
