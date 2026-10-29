import type { Logger } from 'pino';
import type { Repos } from '../db/repos.js';
import { logger } from '../logger.js';
import type { LineApi, TextMessage } from './client.js';

export type TextMessageInput = string | { type: 'text'; text: string };

export const MAX_MESSAGES = 5;
export const MAX_TEXT_LENGTH = 5000;

export interface SendOptions {
  /**
   * Texts to store in `messages` (direction out) instead of what was actually sent, e.g. a
   * placeholder when the reply contains unmasked PII (SPEC-ADMIN §6). Absent: store the sent text.
   */
  recordAs?: string[];
}

/** True for an HTTPFetchError-shaped error with status 400 (invalid / expired reply token). */
export function isReplyTokenError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (status === 400) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('Invalid reply token');
}

/**
 * Sole user of reply tokens. reply() falls back to push() on 400; push() always writes push_log;
 * every sent text is recorded in messages (direction 'out').
 */
export class Replier {
  private readonly usedTokens = new Set<string>();
  private readonly log: Logger;

  constructor(
    private readonly api: LineApi,
    private readonly repos: Pick<Repos, 'pushLog' | 'messages'>,
    log: Logger = logger,
  ) {
    this.log = log;
  }

  async reply(
    replyToken: string,
    userId: string,
    messages: TextMessageInput[],
    opts?: SendOptions,
  ): Promise<'replied' | 'pushed'> {
    if (this.usedTokens.has(replyToken)) {
      this.log.warn({ userId }, 'reply token already used, pushing instead');
      await this.push(userId, messages, 'reply_token_reused', opts);
      return 'pushed';
    }
    this.usedTokens.add(replyToken);
    const normalized = this.normalize(messages);
    if (normalized.length === 0) return 'replied';
    try {
      await this.api.replyMessage({ replyToken, messages: normalized });
    } catch (err) {
      if (isReplyTokenError(err)) {
        this.log.warn({ userId, err: describe(err) }, 'reply rejected (400), falling back to push');
        await this.push(userId, messages, 'reply_fallback', opts);
        return 'pushed';
      }
      this.log.error({ userId, err: describe(err) }, 'reply failed');
      throw err;
    }
    this.recordOut(userId, normalized, opts);
    return 'replied';
  }

  async push(
    userId: string,
    messages: TextMessageInput[],
    reason: string,
    opts?: SendOptions,
  ): Promise<void> {
    const normalized = this.normalize(messages);
    if (normalized.length === 0) return;
    try {
      await this.api.pushMessage({ to: userId, messages: normalized });
    } catch (err) {
      this.log.error({ userId, reason, err: describe(err) }, 'push failed');
      throw err;
    }
    this.repos.pushLog.insert({ userId, reason });
    this.recordOut(userId, normalized, opts);
  }

  /** Best effort; never throws. */
  async showLoading(userId: string, seconds = 60): Promise<void> {
    try {
      await this.api.showLoadingAnimation({ chatId: userId, loadingSeconds: seconds });
    } catch (err) {
      this.log.debug({ userId, err: describe(err) }, 'showLoading failed');
    }
  }

  async replyOrPush(
    replyToken: string | undefined,
    userId: string,
    messages: TextMessageInput[],
    reason: string,
    opts?: SendOptions,
  ): Promise<'replied' | 'pushed'> {
    if (replyToken !== undefined) return this.reply(replyToken, userId, messages, opts);
    await this.push(userId, messages, reason, opts);
    return 'pushed';
  }

  private normalize(messages: TextMessageInput[]): TextMessage[] {
    let list = messages;
    if (list.length > MAX_MESSAGES) {
      this.log.warn(
        { count: list.length, max: MAX_MESSAGES },
        'too many messages, dropping extras',
      );
      list = list.slice(0, MAX_MESSAGES);
    }
    return list.map((m) => {
      const text = typeof m === 'string' ? m : m.text;
      return {
        type: 'text',
        text: text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text,
      };
    });
  }

  private recordOut(userId: string, messages: TextMessage[], opts?: SendOptions): void {
    const texts = opts?.recordAs ?? messages.map((m) => m.text);
    for (const text of texts) {
      this.repos.messages.insert({ userId, direction: 'out', type: 'text', text });
    }
  }
}

/** Compact, token-free error summary for logs. */
function describe(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const e = err as { name?: string; message?: string; status?: number; body?: string };
  return { name: e.name, message: e.message, status: e.status, body: e.body };
}
