import type { Logger } from 'pino';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { GrokGateway, GrokResult } from '../grok/gateway.js';
import type { HealthResult } from '../health/check.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { adminServiceQuestionNotice, adminTriageNotice, texts } from '../texts.js';
import { type Job, type JobHandlers, SkipJob } from './queue.js';

export interface JobHandlerDeps {
  repos: Pick<Repos, 'suggestions'>;
  replier: Pick<Replier, 'push'>;
  grok: GrokGateway;
  config: Pick<Config, 'ADMIN_LINE_USER_ID'>;
  /** Must match the JobQueue's maxAttempts. Default 5. */
  maxAttempts?: number;
  log?: Logger;
}

const contextSchema = z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() }));

const serviceQuestionPayload = z.object({
  userId: z.string().min(1),
  messageId: z.number().optional(),
  text: z.string(),
  context: contextSchema.default([]),
});

const incidentTriagePayload = z.object({
  userId: z.string().min(1),
  incidentId: z.number(),
  messageId: z.number().optional(),
  text: z.string(),
  health: z.looseObject({
    status: z.enum(['healthy', 'degraded', 'down']),
    latencyMs: z.number(),
    checkedAt: z.string(),
  }),
  context: contextSchema.default([]),
});

const summarizeSuggestionPayload = z.object({
  suggestionId: z.number(),
  text: z.string(),
  userHash: z.string().optional(),
});

/** Shape Grok must return in `structured` for summarize_suggestion (provisional). */
export const suggestionSummarySchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  category: z.string(),
  mergedInto: z.number().int().nullable().optional(),
});

function parsePayload<T>(schema: z.ZodType<T>, job: Job): T {
  const r = schema.safeParse(job.payload);
  if (!r.success) throw new SkipJob('bad_payload');
  return r.data;
}

/** 5xx, network / timeout and async_pending are worth retrying; Grok's own refusals are not. */
export function isTransient(res: GrokResult): boolean {
  if (res.ok) return false;
  if (res.transient !== undefined) return res.transient;
  const e = res.error ?? '';
  return e === 'async_pending' || e.startsWith('http_5');
}

class TransientGrokError extends Error {
  constructor(error: string | undefined) {
    super(`grok transient failure: ${error ?? 'unknown'}`);
    this.name = 'TransientGrokError';
  }
}

/** SPEC 5.4–5.6 background jobs. Throw SkipJob → `skipped`; other throws → queue retry. */
export function createJobHandlers(deps: JobHandlerDeps): JobHandlers {
  const { repos, replier, grok, config } = deps;
  const log = deps.log ?? logger;
  const maxAttempts = deps.maxAttempts ?? 5;
  const admin = config.ADMIN_LINE_USER_ID;

  return {
    async service_question(job) {
      const p = parsePayload(serviceQuestionPayload, job);
      const res = await grok.run({
        id: String(job.id),
        type: 'service_question',
        userMessage: p.text,
        context: p.context,
      });
      if (res.ok && res.text) {
        await replier.push(p.userId, [res.text], 'grok_answer');
        return;
      }

      const transient = grok.configured && isTransient(res);
      const finalAttempt = job.attempts >= maxAttempts;
      log.warn(
        { jobId: job.id, error: res.error, transient, attempts: job.attempts },
        'grok could not answer service question',
      );
      if (transient && !finalAttempt) throw new TransientGrokError(res.error);

      await replier.push(p.userId, [texts.grokUnavailable], 'grok_unavailable');
      if (admin) {
        await replier.push(
          admin,
          [adminServiceQuestionNotice({ userId: p.userId, text: p.text })],
          'admin_service_question',
        );
      }
      if (!grok.configured) throw new SkipJob('grok_not_configured');
      // Final attempt of a transient failure: let the queue mark it failed.
      if (transient) throw new TransientGrokError(res.error);
    },

    async incident_triage(job) {
      const p = parsePayload(incidentTriagePayload, job);
      if (!grok.configured) throw new SkipJob('grok_not_configured');
      const res = await grok.run({
        id: String(job.id),
        type: 'incident_triage',
        userMessage: p.text,
        context: p.context,
        health: p.health as HealthResult,
      });
      if (res.ok && res.text) {
        if (admin) {
          await replier.push(
            admin,
            [adminTriageNotice({ incidentId: p.incidentId, text: res.text })],
            'admin_triage',
          );
        } else {
          log.warn({ jobId: job.id, incidentId: p.incidentId }, 'triage ready but no admin id');
        }
        return;
      }
      if (isTransient(res)) throw new TransientGrokError(res.error);
      log.warn({ jobId: job.id, incidentId: p.incidentId, error: res.error }, 'grok triage failed');
    },

    async summarize_suggestion(job) {
      const p = parsePayload(summarizeSuggestionPayload, job);
      if (!grok.configured) throw new SkipJob('grok_not_configured');
      const res = await grok.run({
        id: String(job.id),
        type: 'summarize_suggestion',
        userMessage: p.text,
        context: [],
        existingSuggestions: repos.suggestions.listTitles(),
      });
      if (!res.ok) {
        if (isTransient(res)) throw new TransientGrokError(res.error);
        log.warn(
          { jobId: job.id, suggestionId: p.suggestionId, error: res.error },
          'grok summarize failed',
        );
        return;
      }
      const s = suggestionSummarySchema.safeParse(res.structured);
      if (!s.success) {
        log.warn(
          { jobId: job.id, suggestionId: p.suggestionId },
          'grok summary has invalid structure; suggestion stays new',
        );
        return;
      }
      repos.suggestions.updateSummary(p.suggestionId, {
        title: s.data.title,
        summary: s.data.summary,
        category: s.data.category,
        mergedInto: s.data.mergedInto ?? null,
        status: 'summarized',
      });
      log.info({ jobId: job.id, suggestionId: p.suggestionId }, 'suggestion summarized');
    },
  };
}
