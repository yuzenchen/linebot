import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { GrokTaskRow } from '../db/grokTasks.js';
import type { Repos } from '../db/repos.js';
import { suggestionSummarySchema } from '../jobs/handlers.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { type AdminNotifier, createAdminNotifier } from '../notify/adminNotifier.js';
import { adminServiceQuestionNotice, adminTriageNotice, texts } from '../texts.js';
import type { TicketService } from '../tickets/service.js';
import { looksLikeDeferral } from './deferral.js';
import { CALLBACK_TOKEN_HEADER } from './gateway.js';

export const DEFAULT_GROK_FOLLOWUP_WINDOW_MS = 604800000;
/** A closed service_question task accepts late `done` callbacks while `callbacks <=` this. */
export const MAX_FOLLOWUP_CALLBACKS = 5;

export interface GrokCallbackDeps {
  /** `GROK_CALLBACK_TOKEN`; without it the route answers 503. */
  token?: string;
  /** With `tickets`, a late `done` (§12.4) answers the customer's open / answered ticket. */
  repos: Pick<Repos, 'grokTasks' | 'suggestions'> & Partial<Pick<Repos, 'tickets'>>;
  replier: Pick<Replier, 'push'>;
  config: Pick<Config, 'ADMIN_LINE_USER_ID'> &
    Partial<Pick<Config, 'ADMIN_NOTIFY_URL' | 'INTERNAL_NOTIFY_TOKEN' | 'GROK_FOLLOWUP_WINDOW_MS'>>;
  /** Defaults to one built from `config` + `replier`. */
  adminNotifier?: AdminNotifier;
  /** T15: when present, a failed service_question opens a ticket instead of a plain notice. */
  tickets?: TicketService;
  now?: () => Date;
  log?: Logger;
}

export const callbackBodySchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['received', 'processing', 'done', 'failed', 'needs_human']),
  text: z.string().optional(),
  structured: z.unknown().optional(),
});
export type CallbackBody = z.infer<typeof callbackBodySchema>;

const TERMINAL = new Set<GrokTaskRow['status']>(['done', 'failed', 'expired']);
/** Callbacks may arrive out of order; a status never moves backwards. */
const RANK: Record<string, number> = {
  sent: 0,
  received: 1,
  processing: 2,
  done: 3,
  failed: 3,
  needs_human: 3,
  expired: 3,
};

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface Payload {
  userId?: string;
  text?: string;
  context?: { role: 'user' | 'assistant'; text: string }[];
  incidentId?: number;
  suggestionId?: number;
}

function parsePayload(raw: string | null): Payload {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Payload) : {};
  } catch {
    return {};
  }
}

/**
 * Sub-app with `POST /`; mount at `/grok/callback`. The Cursor agent POSTs here one or more times
 * per task (`received` → `processing` → `done` / `failed` / `needs_human`) with `x-linebot-token`.
 * `needs_human` is service_question only; other task types treat it as `failed`. LINE push
 * failures are logged but still answered 200 so the agent does not retry because of LINE.
 */
export function createGrokCallbackRoute(deps: GrokCallbackDeps): Hono {
  const log = deps.log ?? logger;
  const { repos, replier } = deps;
  const notifier =
    deps.adminNotifier ?? createAdminNotifier({ config: deps.config, replier, log: deps.log });
  const now = deps.now ?? (() => new Date());
  const followUpWindowMs = deps.config.GROK_FOLLOWUP_WINDOW_MS ?? DEFAULT_GROK_FOLLOWUP_WINDOW_MS;
  const app = new Hono();

  async function push(userId: string, text: string, reason: string, meta: object): Promise<void> {
    try {
      await replier.push(userId, [text], reason);
    } catch (err) {
      log.error({ ...meta, reason, err }, 'grok callback push failed');
    }
  }

  async function notifyAdmin(
    kind: 'service_question' | 'triage',
    text: string,
    meta: object,
  ): Promise<void> {
    await notifier.notify({ kind, text, meta: { ...meta } });
  }

  async function applyServiceQuestion(task: GrokTaskRow, body: CallbackBody, meta: object) {
    const userId = task.user_id;
    if (!userId) {
      log.warn(meta, 'service_question task without user_id');
      return;
    }
    const custom = body.text?.trim();
    switch (body.status) {
      case 'received':
      case 'processing': {
        if (task.status === body.status) return; // same status again: no new push
        const fallback =
          body.status === 'received' ? texts.grokStatusReceived : texts.grokStatusProcessing;
        await push(userId, custom || fallback, 'grok_status', meta);
        return;
      }
      case 'done':
        await push(userId, custom as string, 'grok_answer', meta);
        if (looksLikeDeferral(custom as string)) {
          await escalate(task, userId, custom, meta);
          log.info(meta, 'grok done text looks like a deferral; ticket opened');
        }
        return;
      case 'needs_human':
        if (custom) await push(userId, custom, 'grok_needs_human', meta);
        else await push(userId, texts.grokUnavailable, 'grok_unavailable', meta);
        await escalate(task, userId, custom, meta);
        return;
      case 'failed':
        await push(userId, texts.grokUnavailable, 'grok_unavailable', meta);
        await escalate(task, userId, custom, meta);
    }
  }

  /** Hands the customer's original question to a human: a grok_failed ticket, else a notice. */
  async function escalate(
    task: GrokTaskRow,
    userId: string,
    custom: string | undefined,
    meta: object,
  ): Promise<void> {
    const { text, context } = parsePayload(task.payload);
    if (deps.tickets) {
      await deps.tickets.open({
        userId,
        source: 'grok_failed',
        question: text ?? '',
        context: Array.isArray(context) ? context : [],
        grokTaskId: task.id,
      });
      return;
    }
    const notice = adminServiceQuestionNotice({ userId, text: text ?? '' });
    await notifyAdmin('service_question', custom ? `${notice}\n失敗原因：${custom}` : notice, meta);
  }

  /**
   * SPEC-ADMIN §12.4: a `done` with text for an already closed service_question, within the
   * follow-up window and under the callback cap, is delivered as a late answer: it answers the
   * customer's open / answered ticket when there is one, else is pushed directly.
   */
  async function applyLateFollowUp(
    task: GrokTaskRow,
    body: CallbackBody,
    meta: object,
  ): Promise<'followup' | 'push_failed' | undefined> {
    const text = body.text?.trim();
    if (task.type !== 'service_question' || body.status !== 'done' || !text || !task.user_id) {
      return undefined;
    }
    const age = now().getTime() - new Date(task.updated_at).getTime();
    if (age > followUpWindowMs || task.callbacks > MAX_FOLLOWUP_CALLBACKS) return undefined;
    const ticket = repos.tickets?.findActiveByUser(task.user_id);
    repos.grokTasks.recordFollowUp(task.id, text);
    try {
      await replier.push(task.user_id, [text], 'grok_followup');
    } catch (err) {
      log.error({ ...meta, ticketId: ticket?.id, err }, 'grok follow-up push failed');
      return 'push_failed';
    }
    if (ticket && repos.tickets) {
      repos.tickets.markAnswered(ticket.id, { by: 'grok', answer: text });
      log.info({ ...meta, ticketId: ticket.id }, 'grok follow-up answered ticket');
    } else {
      log.info(meta, 'grok follow-up pushed');
    }
    return 'followup';
  }

  async function applyIncidentTriage(task: GrokTaskRow, body: CallbackBody, meta: object) {
    const { incidentId } = parsePayload(task.payload);
    const id = incidentId ?? 0;
    const custom = body.text?.trim();
    if (body.status === 'done') {
      await notifyAdmin(
        'triage',
        adminTriageNotice({ incidentId: id, text: custom as string }),
        meta,
      );
    } else if (body.status === 'failed' || body.status === 'needs_human') {
      await notifyAdmin(
        'triage',
        adminTriageNotice({ incidentId: id, text: `分析失敗：${custom || '未說明原因'}` }),
        meta,
      );
    }
  }

  /** Returns a warning code when `structured` is unusable. */
  function applySummarize(task: GrokTaskRow, body: CallbackBody, meta: object): string | undefined {
    if (body.status === 'failed' || body.status === 'needs_human') {
      log.warn({ ...meta, reason: body.text }, 'grok summarize failed');
      return undefined;
    }
    if (body.status !== 'done') return undefined;
    const { suggestionId } = parsePayload(task.payload);
    const s = suggestionSummarySchema.safeParse(body.structured);
    if (!s.success || suggestionId === undefined) {
      log.warn(meta, 'grok summary has invalid structure; suggestion stays new');
      return 'bad_structured';
    }
    repos.suggestions.updateSummary(suggestionId, {
      title: s.data.title,
      summary: s.data.summary,
      category: s.data.category,
      mergedInto: s.data.mergedInto ?? null,
      status: 'summarized',
    });
    log.info({ ...meta, suggestionId }, 'suggestion summarized');
    return undefined;
  }

  app.post('/', async (c) => {
    if (!deps.token) return c.json({ error: 'callback not configured' }, 503);
    const presented = c.req.header(CALLBACK_TOKEN_HEADER);
    if (!presented || !safeEqual(presented, deps.token)) {
      log.warn({ hasToken: Boolean(presented) }, 'grok callback bad token');
      return c.json({ error: 'unauthorized' }, 401);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const parsed = callbackBodySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid body', issues: parsed.error.issues }, 400);
    const body = parsed.data;
    const meta = { taskId: body.taskId, status: body.status };

    const task = repos.grokTasks.get(body.taskId);
    if (!task) {
      log.warn(meta, 'grok callback for unknown task');
      return c.json({ error: 'unknown task' }, 404);
    }
    if (TERMINAL.has(task.status)) {
      const late = await applyLateFollowUp(task, body, meta);
      if (late === 'followup') return c.json({ ok: true, followup: true });
      if (late === 'push_failed') return c.json({ ok: true, followup: true, warning: late });
      log.info({ ...meta, taskStatus: task.status }, 'grok callback ignored (task closed)');
      return c.json({ ok: true, ignored: true });
    }
    if ((RANK[body.status] ?? 0) < (RANK[task.status] ?? 0)) {
      log.info({ ...meta, taskStatus: task.status }, 'grok callback ignored (stale status)');
      return c.json({ ok: true, ignored: true });
    }
    const needsText = body.status === 'done' && task.type !== 'summarize_suggestion';
    if (needsText && !body.text?.trim()) {
      return c.json({ error: 'text required for status done' }, 400);
    }

    log.info({ ...meta, type: task.type, from: task.status }, 'grok callback');
    let warning: string | undefined;
    switch (task.type) {
      case 'service_question':
        await applyServiceQuestion(task, body, meta);
        break;
      case 'incident_triage':
        await applyIncidentTriage(task, body, meta);
        break;
      case 'summarize_suggestion':
        warning = applySummarize(task, body, meta);
        break;
      default:
        log.warn({ ...meta, type: task.type }, 'grok callback for unknown task type');
    }
    const finalStatus = body.status === 'needs_human' ? 'failed' : body.status;
    repos.grokTasks.setStatus(body.taskId, finalStatus, body.text?.trim() || undefined);
    return c.json(warning ? { ok: true, warning } : { ok: true });
  });

  return app;
}
