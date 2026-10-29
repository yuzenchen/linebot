import { existsSync, readFileSync } from 'node:fs';
import type { webhook } from '@line/bot-sdk';
import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { texts } from '../texts.js';

export interface TextMessageContext {
  userId: string;
  text: string;
  replyToken: string | undefined;
  /** Row id of the stored inbound message. */
  messageId: number;
  event: webhook.MessageEvent;
}

export interface DispatcherDeps {
  repos: Pick<Repos, 'users' | 'messages'>;
  replier: Replier;
  handleText: (ctx: TextMessageContext) => Promise<void>;
  welcomeText: () => string;
  log?: Logger;
}

// Resolves from both src/handlers (tsx) and dist/handlers (node). Owned by T4; may not exist yet.
const welcomeUrl = new URL('../../knowledge/welcome.md', import.meta.url);

/** Reads `knowledge/welcome.md` at call time; falls back to the built-in copy. */
export function defaultWelcomeText(): string {
  try {
    if (existsSync(welcomeUrl)) {
      const text = readFileSync(welcomeUrl, 'utf8').trim();
      if (text.length > 0) return text;
    }
  } catch (err) {
    logger.warn({ err }, 'failed to read welcome.md');
  }
  return texts.welcomeFallback;
}

/** Routes one webhook event by source and type. Only `source.type === 'user'` is handled. */
export function createDispatcher(deps: DispatcherDeps) {
  const { repos, replier, handleText, welcomeText } = deps;
  const log = deps.log ?? logger;

  return async function dispatch(event: webhook.Event): Promise<void> {
    const source = event.source;
    if (source?.type !== 'user') {
      log.info({ type: event.type, sourceType: source?.type }, 'ignored non-user source');
      return;
    }
    const userId = source.userId;
    if (!userId) {
      log.info({ type: event.type }, 'ignored event without userId');
      return;
    }

    switch (event.type) {
      case 'message': {
        repos.users.upsert({ userId });
        const replyToken = event.replyToken;
        const message = event.message;
        if (message.type === 'text') {
          const messageId = repos.messages.insert({
            userId,
            direction: 'in',
            type: 'text',
            text: message.text,
            replyToken,
          });
          await handleText({ userId, text: message.text, replyToken, messageId, event });
          return;
        }
        repos.messages.insert({ userId, direction: 'in', type: message.type, replyToken });
        await replier.replyOrPush(replyToken, userId, [texts.nonTextMessage], 'non_text');
        return;
      }
      case 'follow': {
        repos.users.upsert({ userId });
        repos.users.setFollowed(userId, true);
        await replier.replyOrPush(event.replyToken, userId, [welcomeText()], 'welcome');
        return;
      }
      case 'unfollow': {
        repos.users.setFollowed(userId, false);
        return;
      }
      default:
        log.info({ type: event.type, userId }, 'ignored event type');
    }
  };
}

export type Dispatch = ReturnType<typeof createDispatcher>;
