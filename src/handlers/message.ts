import type { Logger } from 'pino';
import type { Classifier, ClassifyResult, ContextMessage } from '../classifier/index.js';
import { MIN_CONFIDENCE } from '../classifier/index.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { HealthChecker } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import { MAX_MESSAGES, type Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';
import type { TextMessageContext } from './dispatcher.js';
import { createFeatureHandler } from './feature.js';
import type { HandoffService } from './handoff.js';
import { createIncidentHandler } from './incident.js';

export interface HandoffHook {
  isActive(userId: string): boolean | Promise<boolean>;
  forward(ctx: TextMessageContext): Promise<void>;
}

export interface MessageDeps {
  repos: Repos;
  replier: Replier;
  classifier: Classifier;
  health: HealthChecker;
  jobs: Pick<JobQueue, 'enqueue'>;
  config: Pick<
    Config,
    'REPLY_DEADLINE_MS' | 'CONTEXT_MESSAGES' | 'ADMIN_LINE_USER_ID' | 'GROK_WEBHOOK_URL'
  >;
  /** T7: human handoff. When absent the check is skipped. */
  handoff?: HandoffHook;
  /** T7: full handoff service (admin commands, keyword / low-confidence entry); its hook wins over `handoff`. */
  handoffService?: HandoffService;
  now?: () => Date;
  log?: Logger;
}

const DEADLINE = Symbol('deadline');

/** SPEC 5.2 text-message main flow. The returned handler never rejects. */
export function createTextMessageHandler(
  deps: MessageDeps,
): (ctx: TextMessageContext) => Promise<void> {
  const { repos, replier, classifier, jobs, config } = deps;
  const log = deps.log ?? logger;
  const handleIncident = createIncidentHandler(deps);
  const handleFeatureRequest = createFeatureHandler(deps);
  const handoffService = deps.handoffService;
  const handoff = handoffService?.hook ?? deps.handoff;

  function buildContext(userId: string, messageId: number): ContextMessage[] {
    const rows = repos.messages.recent(userId, config.CONTEXT_MESSAGES + 1);
    return rows
      .filter((r) => r.id !== messageId && r.type === 'text' && r.text !== null)
      .slice(-config.CONTEXT_MESSAGES)
      .map((r) => ({ role: r.direction === 'in' ? 'user' : 'assistant', text: r.text as string }));
  }

  async function messagesFor(
    ctx: TextMessageContext,
    c: ClassifyResult,
    context: ContextMessage[],
  ): Promise<string[]> {
    switch (c.category) {
      case 'kb_answer':
        return [c.answer ?? texts.serviceForwarded];
      case 'service_related':
        jobs.enqueue('service_question', {
          userId: ctx.userId,
          messageId: ctx.messageId,
          text: ctx.text,
          context,
        });
        return [texts.serviceForwarded];
      case 'incident_report':
        return handleIncident(ctx, context);
      case 'feature_request':
        return handleFeatureRequest(ctx);
      case 'off_topic':
        return [texts.offTopic];
    }
  }

  /** Resolves with the classification, or DEADLINE if the timer fires first. */
  function raceDeadline(
    classification: Promise<ClassifyResult>,
  ): Promise<ClassifyResult | typeof DEADLINE> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), config.REPLY_DEADLINE_MS);
    });
    return Promise.race([classification, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  return async function handleText(ctx: TextMessageContext): Promise<void> {
    const { userId, messageId, replyToken } = ctx;
    // Set once the reply token has been handed to the Replier; after that only push is used.
    let replied = replyToken === undefined;

    try {
      if (handoffService?.isAdmin(userId) && ctx.text.trimStart().startsWith('/')) {
        await handoffService.handleAdminCommand(ctx);
        return;
      }

      if (handoff && (await handoff.isActive(userId))) {
        await handoff.forward(ctx);
        return;
      }

      if (handoffService?.shouldEnterByKeyword(ctx.text)) {
        const entered = await handoffService.enter(userId, '使用者要求真人');
        replied = true;
        await replier.replyOrPush(replyToken, userId, entered, 'handoff_entered');
        return;
      }

      void replier.showLoading(userId, 60);

      const context = buildContext(userId, messageId);
      const classification = classifier.classify({ text: ctx.text, context });
      // Attach a no-op catch so a rejection after the deadline is not reported as unhandled;
      // the awaited `classification` below still rejects.
      classification.catch(() => {});

      const raced = await raceDeadline(classification);
      let result: ClassifyResult;
      if (raced === DEADLINE) {
        log.info({ userId, messageId, deadlineMs: config.REPLY_DEADLINE_MS }, 'reply deadline hit');
        if (replyToken !== undefined) {
          replied = true;
          await replier.reply(replyToken, userId, [texts.ackPending]);
        }
        result = await classification;
      } else {
        result = raced;
      }

      repos.classifications.insert({
        messageId,
        category: result.category,
        confidence: result.confidence,
        reason: result.reason,
        classifier: result.classifier,
        latencyMs: result.latencyMs,
      });
      log.info(
        {
          userId,
          messageId,
          category: result.category,
          confidence: result.confidence,
          classifier: result.classifier,
          latencyMs: result.latencyMs,
        },
        'message classified',
      );

      if (result.confidence < MIN_CONFIDENCE) repos.users.incrementLowConf(userId);
      else repos.users.resetLowConf(userId);

      let msgs = await messagesFor(ctx, result, context);
      if (handoffService) {
        const extra = await handoffService.afterClassification(userId);
        if (extra.length > 0) msgs = [...msgs.slice(0, MAX_MESSAGES - extra.length), ...extra];
      }
      if (!replied && replyToken !== undefined) {
        replied = true;
        await replier.reply(replyToken, userId, msgs);
      } else {
        await replier.push(userId, msgs, 'late_reply');
      }
    } catch (err) {
      log.error({ userId, messageId, err }, 'text message handling failed');
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
