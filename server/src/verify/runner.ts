import { task, logger } from '@trigger.dev/sdk/v3';
import { runVerifyPipeline } from './pipeline.js';

export interface VerifyPayload {
  owner: string;
  repo: string;
  prNumber: number;
  deliveryId: string;
}

export const verifyPrTask = task({
  id: 'verify-pr',
  maxDuration: 900,  // 15 min — matches VERIFY_TIMEOUT_MS in pipeline.ts
  run: async (payload: VerifyPayload) => {
    const log = (step: string, message: string, data?: unknown) => {
      logger.info(`[${step}] ${message}`, data ? { data } : undefined);
    };

    const result = await runVerifyPipeline(
      { owner: payload.owner, repo: payload.repo, prNumber: payload.prNumber },
      { log },
    );

    return result;
  },
});
