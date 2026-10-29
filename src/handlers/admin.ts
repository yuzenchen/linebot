import type Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { type AdminModelClient, runAdminQuery, type AdminRunResult } from '../admin/loop.js';
import { createToolExecutor } from '../admin/tools.js';
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
import { texts } from '../texts.js';
import type { TextMessageContext } from './dispatcher.js';

export type { AdminRunResult };

export interface AdminHandlerDeps {
  repos: Pick<Repos, 'messages' | 'adminQueries' | 'incidents'>;
  replier: Replier;
  health: HealthChecker;
  jobs: Pick<JobQueue, 'enqueue'>;
  grok: Pick<GrokGateway, 'configured'>;
  eshop: EshopClient;
  model: AdminModelClient;
  config: Pick<
    Config,
    | 'ADMIN_USER_IDS'
    | 'ADMIN_MODEL'
    | 'ADMIN_MAX_TOOL_ROUNDS'
    | 'REPLY_DEADLINE_MS'
    | 'CONTEXT_MESSAGES'
  >;
  now?: () => Date;
  log?: Logger;
  /** Tests: per-request model timeout. */
  requestTimeoutMs?: number;
}

const DEADLINE = Symbol('deadline');

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

/** ADMIN-HANDLER-DESIGN §5. The returned handler never rejects. */
export function createAdminTextHandler(
  deps: AdminHandlerDeps,
): (ctx: TextMessageContext) => Promise<void> {
  const { repos, replier, config } = deps;
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

      void replier.showLoading(userId, 60);
      const started = now().getTime();
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

      const latencyMs = now().getTime() - started;
      repos.adminQueries.insert({
        userId,
        text: ctx.text,
        tools: JSON.stringify(result.tools),
        reply: result.piiRevealed ? texts.adminPiiRecordPlaceholder : result.text,
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
          latencyMs,
          servedBy: result.servedBy,
        },
        'admin query done',
      );

      const msgs = splitReply(result.text);
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
  };
}
