import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { GrokGateway, GrokResult, GrokTask } from '../grok/gateway.js';
import type { HealthResult } from '../health/check.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { type AdminNotifier, createAdminNotifier } from '../notify/adminNotifier.js';
import { adminServiceQuestionNotice, texts } from '../texts.js';
import type { TicketService } from '../tickets/service.js';
import { type Job, type JobHandlers, SkipJob } from './queue.js';

export interface JobHandlerDeps {
  repos: Pick<Repos, 'suggestions' | 'grokTasks'>;
  replier: Pick<Replier, 'push'>;
  grok: GrokGateway;
  config: Pick<Config, 'ADMIN_LINE_USER_ID' | 'GROK_TASK_TIMEOUT_MS'> &
    Partial<Pick<Config, 'ADMIN_NOTIFY_URL' | 'INTERNAL_NOTIFY_TOKEN'>>;
  /** Defaults to one built from `config` + `replier`. */
  adminNotifier?: AdminNotifier;
  /** T15: when present, an unanswerable service question opens a ticket instead of a plain notice. */
  tickets?: TicketService;
  /** Must match the JobQueue's maxAttempts. Default 5. */
  maxAttempts?: number;
  now?: () => Date;
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

/** Shape the agent must send as `structured` in the `done` callback of summarize_suggestion. */
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

/** 5xx and network / timeout are worth retrying; 4xx (bad token, bad request) is not. */
export function isTransient(res: GrokResult): boolean {
  if (res.ok) return false;
  if (res.transient !== undefined) return res.transient;
  return (res.error ?? '').startsWith('http_5');
}

class TransientGrokError extends Error {
  constructor(error: string | undefined) {
    super(`grok transient failure: ${error ?? 'unknown'}`);
    this.name = 'TransientGrokError';
  }
}

type Dispatch = { taskId: string } & (
  { status: 'accepted' } | { status: 'transient' } | { status: 'failed' }
);

/**
 * SPEC 5.4–5.6 background jobs. Each handler only *dispatches* to the Cursor agent; the answer
 * arrives later through `/grok/callback`, and `grok_tasks` tracks the wait (expired by the
 * sweeper). Throw SkipJob → `skipped`; other throws → queue retry.
 */
export function createJobHandlers(deps: JobHandlerDeps): JobHandlers {
  const { repos, replier, grok, config } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const maxAttempts = deps.maxAttempts ?? 5;
  const notifier = deps.adminNotifier ?? createAdminNotifier({ config, replier, log: deps.log });
  const timeoutMs = config.GROK_TASK_TIMEOUT_MS;

  /** User gets `grokUnavailable`; the admin side gets a ticket (T15) or, without one, a notice. */
  async function notifyServiceQuestionFallback(
    p: z.infer<typeof serviceQuestionPayload>,
    source: 'grok_unconfigured' | 'grok_failed',
    grokTaskId?: string,
  ): Promise<void> {
    // Open the ticket (or notify) BEFORE pushing the user: a blocked bot must not lose the ticket.
    // On a push failure the job retries and openOrAppend dedupes the identical question.
    if (deps.tickets) {
      await deps.tickets.open({
        userId: p.userId,
        source,
        question: p.text,
        context: p.context,
        grokTaskId,
      });
    } else {
      await notifier.notify({
        kind: 'service_question',
        text: adminServiceQuestionNotice({ userId: p.userId, text: p.text }),
        meta: { userId: p.userId },
      });
    }
    await replier.push(p.userId, [texts.grokUnavailable], 'grok_unavailable');
  }

  /**
   * Inserts the grok_tasks row *before* the HTTP call so a callback racing the response already
   * finds it, then dispatches. On failure the row is marked `failed`.
   */
  async function dispatch(
    job: Job,
    userId: string | null,
    task: Omit<GrokTask, 'id'>,
  ): Promise<Dispatch> {
    const id = randomUUID();
    repos.grokTasks.insert({
      id,
      jobId: job.id,
      type: task.type,
      userId,
      payload: job.payload,
      expiresAt: new Date(now().getTime() + timeoutMs),
    });
    const res = await grok.run({ id, ...task });
    const ctx = { jobId: job.id, taskId: id, type: task.type, attempts: job.attempts };
    if (res.ok) {
      log.info(ctx, 'grok task dispatched; waiting for callback');
      return { taskId: id, status: 'accepted' };
    }
    repos.grokTasks.setStatus(id, 'failed', res.error);
    if (isTransient(res)) {
      log.warn({ ...ctx, error: res.error }, 'grok dispatch failed (transient)');
      return { taskId: id, status: 'transient' };
    }
    log.error({ ...ctx, error: res.error }, 'grok dispatch rejected');
    return { taskId: id, status: 'failed' };
  }

  return {
    async service_question(job) {
      const p = parsePayload(serviceQuestionPayload, job);
      if (!grok.configured) {
        log.warn({ jobId: job.id }, 'grok not configured; service question goes to admin');
        await notifyServiceQuestionFallback(p, 'grok_unconfigured');
        throw new SkipJob('grok_not_configured');
      }
      const d = await dispatch(job, p.userId, {
        type: 'service_question',
        userMessage: p.text,
        context: p.context,
      });
      if (d.status === 'accepted') return;
      if (d.status === 'transient' && job.attempts < maxAttempts) {
        throw new TransientGrokError('dispatch');
      }
      // Final attempt of a transient failure, or a hard rejection: tell user + admin.
      await notifyServiceQuestionFallback(p, 'grok_failed', d.taskId);
      if (d.status === 'transient') throw new TransientGrokError('dispatch');
    },

    async incident_triage(job) {
      const p = parsePayload(incidentTriagePayload, job);
      if (!grok.configured) throw new SkipJob('grok_not_configured');
      const d = await dispatch(job, p.userId, {
        type: 'incident_triage',
        userMessage: p.text,
        context: p.context,
        health: p.health as HealthResult,
      });
      if (d.status === 'transient') throw new TransientGrokError('dispatch');
      if (d.status === 'failed') {
        log.warn({ jobId: job.id, incidentId: p.incidentId }, 'grok triage not dispatched');
      }
    },

    async summarize_suggestion(job) {
      const p = parsePayload(summarizeSuggestionPayload, job);
      if (!grok.configured) throw new SkipJob('grok_not_configured');
      const d = await dispatch(job, null, {
        type: 'summarize_suggestion',
        userMessage: p.text,
        context: [],
        existingSuggestions: repos.suggestions.listTitles(),
      });
      if (d.status === 'transient') throw new TransientGrokError('dispatch');
      if (d.status === 'failed') {
        log.warn(
          { jobId: job.id, suggestionId: p.suggestionId },
          'grok summarize not dispatched; suggestion stays new',
        );
      }
    },
  };
}
