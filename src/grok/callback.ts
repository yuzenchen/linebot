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
import { adminServiceQuestionNotice, adminTriageNotice, texts } from '../texts.js';
import { CALLBACK_TOKEN_HEADER } from './gateway.js';

export interface GrokCallbackDeps {
  /** `GROK_CALLBACK_TOKEN`; without it the route answers 503. */
  token?: string;
  repos: Pick<Repos, 'grokTasks' | 'suggestions'>;
  replier: Pick<Replier, 'push'>;
  config: Pick<Config, 'ADMIN_LINE_USER_ID'>;
  log?: Logger;
}

export const callbackBodySchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['received', 'processing', 'done', 'failed']),
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
 * per task (`received` → `processing` → `done` / `failed`) with `x-linebot-token`. LINE push
 * failures are logged but still answered 200 so the agent does not retry because of LINE.
 */
export function createGrokCallbackRoute(deps: GrokCallbackDeps): Hono {
  const log = deps.log ?? logger;
  const { repos, replier } = deps;
  const admin = deps.config.ADMIN_LINE_USER_ID;
  const app = new Hono();

  async function push(userId: string, text: string, reason: string, meta: object): Promise<void> {
    try {
      await replier.push(userId, [text], reason);
    } catch (err) {
      log.error({ ...meta, reason, err }, 'grok callback push failed');
    }
  }

  async function pushAdmin(text: string, reason: string, meta: object): Promise<void> {
    if (!admin) {
      log.warn({ ...meta, reason }, 'ADMIN_LINE_USER_ID not set; admin notice not sent');
      return;
    }
    await push(admin, text, reason, meta);
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
        return;
      case 'failed': {
        const { text } = parsePayload(task.payload);
        await push(userId, texts.grokUnavailable, 'grok_unavailable', meta);
        const notice = adminServiceQuestionNotice({ userId, text: text ?? '' });
        await pushAdmin(
          custom ? `${notice}\n失敗原因：${custom}` : notice,
          'admin_service_question',
          meta,
        );
      }
    }
  }

  async function applyIncidentTriage(task: GrokTaskRow, body: CallbackBody, meta: object) {
    const { incidentId } = parsePayload(task.payload);
    const id = incidentId ?? 0;
    const custom = body.text?.trim();
    if (body.status === 'done') {
      await pushAdmin(
        adminTriageNotice({ incidentId: id, text: custom as string }),
        'admin_triage',
        meta,
      );
    } else if (body.status === 'failed') {
      await pushAdmin(
        adminTriageNotice({ incidentId: id, text: `分析失敗：${custom || '未說明原因'}` }),
        'admin_triage',
        meta,
      );
    }
  }

  /** Returns a warning code when `structured` is unusable. */
  function applySummarize(task: GrokTaskRow, body: CallbackBody, meta: object): string | undefined {
    if (body.status === 'failed') {
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
    repos.grokTasks.setStatus(body.taskId, body.status, body.text?.trim() || undefined);
    return c.json(warning ? { ok: true, warning } : { ok: true });
  });

  return app;
}
