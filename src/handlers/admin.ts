import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import {
  EnduserClientError,
  enduserErrorMessage,
  type EnduserClient,
} from '../admin/enduserClient.js';
import { type AdminModelClient, runAdminQuery, type AdminRunResult } from '../admin/loop.js';
import { createToolExecutor, MAX_REPLY_TEXT } from '../admin/tools.js';
import { buildMessages } from '../classifier/anthropic.js';
import type { ContextMessage } from '../classifier/types.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { EshopClient } from '../eshop/index.js';
import type { GrokGateway } from '../grok/gateway.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import { MAX_MESSAGES, MAX_TEXT_LENGTH, type Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import {
  adminReplyConfirm,
  adminReplyFailed,
  adminReplySent,
  adminTicketClosedDone,
  adminTicketDetail,
  adminTicketList,
  texts,
} from '../texts.js';
import { displayId } from '../tickets/ids.js';
import type { TextMessageContext } from './dispatcher.js';

export type { AdminRunResult };

export interface AdminHandlerDeps {
  repos: Pick<Repos, 'messages' | 'adminQueries' | 'incidents' | 'pendingConfirmations'>;
  replier: Replier;
  health: HealthChecker;
  jobs: Pick<JobQueue, 'enqueue'>;
  grok: Pick<GrokGateway, 'configured'>;
  eshop: EshopClient;
  /** T16: tickets live in the enduser bot; all ticket operations go over HTTP. */
  enduser: EnduserClient;
  model: AdminModelClient;
  config: Pick<
    Config,
    | 'ADMIN_USER_IDS'
    | 'ADMIN_MODEL'
    | 'ADMIN_MAX_TOOL_ROUNDS'
    | 'REPLY_DEADLINE_MS'
    | 'CONTEXT_MESSAGES'
    | 'CONFIRMATION_TTL_MS'
  >;
  now?: () => Date;
  log?: Logger;
  /** Tests: per-request model timeout. */
  requestTimeoutMs?: number;
}

const DEADLINE = Symbol('deadline');

/** SPEC-ADMIN §12.3 intercepts (checked before the model, in this order). */
export const CONFIRM_RE = /^(y|yes|是|確認)$/i;
export const REPLY_RE = /^回覆\s*T?(\d+)\s*[:：]?\s*([\s\S]+)$/i;
/**
 * Ticket-list quick command: the whole (trimmed) message is at most 16 chars AND contains
 * 待回覆 / 工單列表 / 工單清單 / 有工單 (「待回覆」「有待回覆的工單嗎」「目前有客戶待回覆訊息嗎？」).
 * Longer sentences go to the model, which has the `list_tickets` tool.
 */
export const LIST_RE = /^(?=[\s\S]{1,16}$)[\s\S]*(待回覆|工單列表|工單清單|有工單)/;
export const DETAIL_RE = /^工單\s*T?(\d+)$/i;
export const CLOSE_RE = /^關閉\s*T?(\d+)$/i;

/** One audit entry for an intercepted command (`admin_queries.tools`). */
interface InterceptRecord {
  name: 'reply_customer' | 'list_tickets' | 'get_ticket' | 'close_ticket';
  ticketId?: number;
  result: string;
  count?: number;
}

interface Intercepted {
  reply: string;
  tools: InterceptRecord[];
}

/**
 * Splits a reply into LINE messages: ≤5000 chars → one message; otherwise cut at newlines (a
 * single over-long line is hard-cut), at most 5 messages, the last one truncated with a marker.
 */
export function splitReply(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > MAX_TEXT_LENGTH) {
      flush();
      chunks.push(rest.slice(0, MAX_TEXT_LENGTH));
      rest = rest.slice(MAX_TEXT_LENGTH);
    }
    const candidate = current.length === 0 ? rest : `${current}\n${rest}`;
    if (candidate.length > MAX_TEXT_LENGTH) {
      flush();
      current = rest;
    } else {
      current = candidate;
    }
  }
  flush();
  if (chunks.length <= MAX_MESSAGES) return chunks;
  const kept = chunks.slice(0, MAX_MESSAGES);
  const last = kept[MAX_MESSAGES - 1];
  const room = MAX_TEXT_LENGTH - texts.adminTruncated.length;
  kept[MAX_MESSAGES - 1] = `${last.slice(0, room)}${texts.adminTruncated}`;
  return kept;
}

function errorKind(err: unknown): string {
  if (err instanceof EnduserClientError) return err.kind;
  return err instanceof Error ? err.name : 'error';
}

/** ADMIN-HANDLER-DESIGN §5 + SPEC-ADMIN §12.3. The returned handler never rejects. */
export function createAdminTextHandler(
  deps: AdminHandlerDeps,
): (ctx: TextMessageContext) => Promise<void> {
  const { repos, replier, config, enduser } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());
  const allow = new Set(config.ADMIN_USER_IDS);

  function buildContext(userId: string, messageId: number): ContextMessage[] {
    const rows = repos.messages.recent(userId, config.CONTEXT_MESSAGES + 1);
    return rows
      .filter((r) => r.id !== messageId && r.type === 'text' && r.text !== null)
      .slice(-config.CONTEXT_MESSAGES)
      .map((r) => ({ role: r.direction === 'in' ? 'user' : 'assistant', text: r.text as string }));
  }

  function raceDeadline<T>(p: Promise<T>): Promise<T | typeof DEADLINE> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), config.REPLY_DEADLINE_MS);
    });
    return Promise.race([p, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /** Step 1 (pending + Y): sends the staged reply; the pending item is cleared either way. */
  async function confirmSend(
    userId: string,
    pending: { ticket_id: number; text: string },
  ): Promise<Intercepted> {
    const ticketId = pending.ticket_id;
    const display = displayId(ticketId);
    repos.pendingConfirmations.clear(userId);
    try {
      const res = await enduser.replyTicket(ticketId, pending.text, userId);
      log.info({ userId, ticketId }, 'ticket reply sent');
      return {
        reply: adminReplySent(display, res.userIdShort),
        tools: [{ name: 'reply_customer', ticketId, result: 'sent' }],
      };
    } catch (err) {
      const kind = errorKind(err);
      log.warn({ userId, ticketId, kind, err }, 'ticket reply send failed');
      return {
        reply: adminReplyFailed(enduserErrorMessage(err)),
        tools: [{ name: 'reply_customer', ticketId, result: `failed:${kind}` }],
      };
    }
  }

  /** Step 2 (`回覆 T042 …`): validates the ticket and stages the reply for `Y`. */
  async function stageReply(userId: string, ticketId: number, raw: string): Promise<Intercepted> {
    const rec: InterceptRecord = { name: 'reply_customer', ticketId, result: 'staged' };
    const fail = (reply: string, result: string): Intercepted => ({
      reply,
      tools: [{ ...rec, result }],
    });
    const text = raw.trim();
    if (text.length > MAX_REPLY_TEXT) return fail(texts.adminReplyTooLong, 'too_long');
    try {
      const t = await enduser.getTicket(ticketId);
      if (t.status === 'closed') return fail(texts.adminTicketClosed, 'closed');
      repos.pendingConfirmations.set({
        adminUserId: userId,
        ticketId,
        text,
        now: now(),
        ttlMs: config.CONFIRMATION_TTL_MS,
      });
      log.info({ userId, ticketId }, 'ticket reply staged');
      return { reply: adminReplyConfirm(t.display, text), tools: [rec] };
    } catch (err) {
      if (err instanceof EnduserClientError && err.kind === 'not_found') {
        return fail(texts.adminTicketNotFound, 'not_found');
      }
      log.warn({ userId, ticketId, err }, 'ticket lookup failed');
      return fail(enduserErrorMessage(err), `failed:${errorKind(err)}`);
    }
  }

  async function listTickets(userId: string): Promise<Intercepted> {
    try {
      const rows = await enduser.listOpenTickets(10);
      return {
        reply: adminTicketList(rows),
        tools: [{ name: 'list_tickets', result: 'ok', count: rows.length }],
      };
    } catch (err) {
      log.warn({ userId, err }, 'ticket list failed');
      return {
        reply: enduserErrorMessage(err),
        tools: [{ name: 'list_tickets', result: `failed:${errorKind(err)}` }],
      };
    }
  }

  async function ticketDetail(userId: string, ticketId: number): Promise<Intercepted> {
    try {
      const t = await enduser.getTicket(ticketId);
      return {
        reply: adminTicketDetail(t),
        tools: [{ name: 'get_ticket', ticketId, result: 'ok' }],
      };
    } catch (err) {
      const notFound = err instanceof EnduserClientError && err.kind === 'not_found';
      if (!notFound) log.warn({ userId, ticketId, err }, 'ticket detail failed');
      return {
        reply: notFound ? texts.adminTicketNotFound : enduserErrorMessage(err),
        tools: [{ name: 'get_ticket', ticketId, result: `failed:${errorKind(err)}` }],
      };
    }
  }

  async function closeTicket(userId: string, ticketId: number): Promise<Intercepted> {
    try {
      await enduser.closeTicket(ticketId);
      log.info({ userId, ticketId }, 'ticket closed by admin');
      return {
        reply: adminTicketClosedDone(displayId(ticketId)),
        tools: [{ name: 'close_ticket', ticketId, result: 'closed' }],
      };
    } catch (err) {
      const notFound = err instanceof EnduserClientError && err.kind === 'not_found';
      if (!notFound) log.warn({ userId, ticketId, err }, 'ticket close failed');
      return {
        reply: notFound ? texts.adminTicketNotFound : enduserErrorMessage(err),
        tools: [{ name: 'close_ticket', ticketId, result: `failed:${errorKind(err)}` }],
      };
    }
  }

  /** Steps 2–5; null when the message is for the model. */
  async function intercept(userId: string, text: string): Promise<Intercepted | null> {
    const trimmed = text.trim();
    let m = REPLY_RE.exec(trimmed);
    if (m) return stageReply(userId, Number(m[1]), m[2]);
    if (LIST_RE.test(trimmed)) return listTickets(userId);
    m = DETAIL_RE.exec(trimmed);
    if (m) return ticketDetail(userId, Number(m[1]));
    m = CLOSE_RE.exec(trimmed);
    if (m) return closeTicket(userId, Number(m[1]));
    return null;
  }

  return async function handleText(ctx: TextMessageContext): Promise<void> {
    const { userId, messageId, replyToken } = ctx;
    let replied = replyToken === undefined;
    try {
      if (!allow.has(userId)) {
        log.info({ userId }, 'admin bot: rejected non-allowlisted user');
        replied = true;
        await replier.replyOrPush(replyToken, userId, [texts.adminOnly], 'admin_only');
        return;
      }

      const started = now().getTime();
      const trimmed = ctx.text.trim();

      // Step 1: a staged reply waiting for Y.
      let cancelledNote: string | undefined;
      const pending = repos.pendingConfirmations.get(userId, now());
      if (pending) {
        if (CONFIRM_RE.test(trimmed)) {
          const out = await confirmSend(userId, pending);
          await finishIntercept(ctx, out, started);
          return;
        }
        repos.pendingConfirmations.clear(userId);
        log.info({ userId, ticketId: pending.ticket_id }, 'ticket reply draft cancelled');
        cancelledNote = texts.adminReplyCancelled;
      }

      // Steps 2–5: ticket commands never reach the model.
      const direct = await intercept(userId, ctx.text);
      if (direct) {
        const out = cancelledNote
          ? {
              reply: `${cancelledNote}\n${direct.reply}`,
              tools: [
                { name: 'reply_customer', ticketId: pending?.ticket_id, result: 'cancelled' },
                ...direct.tools,
              ] as InterceptRecord[],
            }
          : direct;
        await finishIntercept(ctx, out, started);
        return;
      }

      void replier.showLoading(userId, 60);
      const context = buildContext(userId, messageId);
      const messages: Anthropic.Beta.BetaMessageParam[] = buildMessages({
        text: ctx.text,
        context,
      }).map((m) => ({ role: m.role, content: m.content as string }));
      const executor = createToolExecutor({
        eshop: deps.eshop,
        health: deps.health,
        repos,
        jobs: deps.jobs,
        grok: deps.grok,
        enduser,
        confirmationTtlMs: config.CONFIRMATION_TTL_MS,
        userId,
        userText: ctx.text,
        messageId,
        context,
        now,
        log,
      });
      const run = runAdminQuery({
        client: deps.model,
        executor,
        messages,
        config,
        userId,
        now,
        log,
        requestTimeoutMs: deps.requestTimeoutMs,
      });

      const raced = await raceDeadline(run);
      let result: AdminRunResult;
      if (raced === DEADLINE) {
        log.info({ userId, messageId, deadlineMs: config.REPLY_DEADLINE_MS }, 'reply deadline hit');
        if (replyToken !== undefined) {
          replied = true;
          await replier.reply(replyToken, userId, [texts.adminAckPending]);
        }
        result = await run;
      } else {
        result = raced;
      }

      // The Y prompt must always be visible when the model staged a reply.
      let text = result.text;
      if (executor.staged)
        text = `${text}\n${adminReplyConfirm(executor.staged.display, executor.staged.text)}`;
      if (cancelledNote) text = `${cancelledNote}\n${text}`;
      const tools: unknown[] = cancelledNote
        ? [
            { name: 'reply_customer', ticketId: pending?.ticket_id, result: 'cancelled' },
            ...result.tools,
          ]
        : result.tools;

      const latencyMs = now().getTime() - started;
      repos.adminQueries.insert({
        userId,
        text: ctx.text,
        tools: JSON.stringify(tools),
        reply: result.piiRevealed ? texts.adminPiiRecordPlaceholder : text,
        piiRevealed: result.piiRevealed,
        latencyMs,
      });
      log.info(
        {
          userId,
          messageId,
          outcome: result.outcome,
          rounds: result.rounds,
          tools: result.tools.map((t) => t.name),
          piiRevealed: result.piiRevealed,
          staged: executor.staged !== null,
          latencyMs,
          servedBy: result.servedBy,
        },
        'admin query done',
      );

      const msgs = splitReply(text);
      const opts = result.piiRevealed ? { recordAs: [texts.adminPiiRecordPlaceholder] } : undefined;
      if (!replied && replyToken !== undefined) {
        replied = true;
        await replier.reply(replyToken, userId, msgs, opts);
      } else {
        await replier.push(userId, msgs, 'admin_late_reply', opts);
      }
    } catch (err) {
      log.error({ userId, messageId, err }, 'admin message handling failed');
      try {
        const token = replied ? undefined : replyToken;
        replied = true;
        await replier.replyOrPush(token, userId, [texts.fallbackError], 'fallback_error');
      } catch (fallbackErr) {
        log.error({ userId, messageId, err: fallbackErr }, 'fallback reply failed');
      }
    }

    /** Audits and sends an intercepted command's reply (reply token first, push otherwise). */
    async function finishIntercept(
      c: TextMessageContext,
      out: Intercepted,
      startedAt: number,
    ): Promise<void> {
      const latencyMs = now().getTime() - startedAt;
      repos.adminQueries.insert({
        userId: c.userId,
        text: c.text,
        tools: JSON.stringify(out.tools),
        reply: out.reply,
        piiRevealed: false,
        latencyMs,
      });
      log.info(
        { userId: c.userId, messageId: c.messageId, tools: out.tools, latencyMs },
        'admin ticket command done',
      );
      replied = true;
      await replier.replyOrPush(
        c.replyToken,
        c.userId,
        splitReply(out.reply),
        'admin_ticket_reply',
      );
    }
  };
}
