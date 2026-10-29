import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { JobQueue } from '../jobs/queue.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';
import type { TextMessageContext } from './dispatcher.js';

export interface FeatureDeps {
  repos: Pick<Repos, 'suggestions'>;
  jobs: Pick<JobQueue, 'enqueue'>;
  log?: Logger;
}

export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

/** SPEC 5.5 steps 1–4: store the suggestion (hashed user), enqueue summarize, thank once. No push. */
export function createFeatureHandler(deps: FeatureDeps) {
  const log = deps.log ?? logger;
  return async function handleFeatureRequest(ctx: TextMessageContext): Promise<string[]> {
    const userHash = hashUserId(ctx.userId);
    const suggestionId = deps.repos.suggestions.insert({ userHash, text: ctx.text });
    const jobId = deps.jobs.enqueue('summarize_suggestion', {
      suggestionId,
      text: ctx.text,
      userHash,
    });
    log.info({ suggestionId, jobId, messageId: ctx.messageId }, 'feature request stored');
    return [texts.featureThanks];
  };
}

export type FeatureHandler = ReturnType<typeof createFeatureHandler>;
