import type { webhook } from '@line/bot-sdk';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepos, type Repos } from '../../src/db/repos.js';
import { createDispatcher, type TextMessageContext } from '../../src/handlers/dispatcher.js';
import type { LineApi } from '../../src/line/client.js';
import { Replier } from '../../src/line/replier.js';
import { texts } from '../../src/texts.js';
import { memoryDb } from '../db/helpers.js';

const silent = pino({ level: 'silent' });

const base = {
  timestamp: 1700000000000,
  mode: 'active' as const,
  deliveryContext: { isRedelivery: false },
  webhookEventId: 'e1',
};

function messageEvent(
  message: webhook.MessageContent,
  source: webhook.Source = { type: 'user', userId: 'U1' },
): webhook.MessageEvent {
  return { ...base, type: 'message', replyToken: 'tok', source, message };
}

describe('dispatcher', () => {
  let repos: Repos;
  let api: { [K in keyof LineApi]: ReturnType<typeof vi.fn<LineApi[K]>> };
  let handleText: ReturnType<typeof vi.fn<(ctx: TextMessageContext) => Promise<void>>>;
  let dispatch: ReturnType<typeof createDispatcher>;

  beforeEach(() => {
    repos = createRepos(memoryDb());
    api = {
      replyMessage: vi.fn(async () => ({})),
      pushMessage: vi.fn(async () => ({})),
      showLoadingAnimation: vi.fn(async () => ({})),
    };
    handleText = vi.fn(async () => {});
    dispatch = createDispatcher({
      repos,
      replier: new Replier(api, repos, silent),
      handleText,
      welcomeText: () => texts.welcomeFallback,
      log: silent,
    });
  });

  it('stores a text message and calls handleText with context', async () => {
    const ev = messageEvent({ type: 'text', id: 'm1', text: '你好', quoteToken: 'q' });
    await dispatch(ev);
    const rows = repos.messages.recent('U1', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'in',
      type: 'text',
      text: '你好',
      reply_token: 'tok',
    });
    expect(handleText).toHaveBeenCalledTimes(1);
    expect(handleText.mock.calls[0][0]).toMatchObject({
      userId: 'U1',
      text: '你好',
      replyToken: 'tok',
      messageId: rows[0].id,
      event: ev,
    });
    expect(repos.users.get('U1')?.followed).toBe(1);
    expect(api.replyMessage).not.toHaveBeenCalled();
  });

  it('answers a sticker with the non-text copy and stores the type', async () => {
    await dispatch(messageEvent({ type: 'sticker', id: 'm2', packageId: '1', stickerId: '2' }));
    expect(handleText).not.toHaveBeenCalled();
    expect(api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok',
      messages: [{ type: 'text', text: texts.nonTextMessage }],
    });
    const rows = repos.messages.recent('U1', 10);
    expect(rows.map((r) => [r.direction, r.type])).toEqual([
      ['in', 'sticker'],
      ['out', 'text'],
    ]);
    expect(rows[0].text).toBeNull();
  });

  it('welcomes on follow with the fallback text', async () => {
    const ev: webhook.FollowEvent = {
      ...base,
      type: 'follow',
      replyToken: 'tok',
      source: { type: 'user', userId: 'U1' },
      follow: { isUnblocked: false },
    };
    await dispatch(ev);
    expect(api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok',
      messages: [{ type: 'text', text: texts.welcomeFallback }],
    });
    expect(repos.users.get('U1')?.followed).toBe(1);
  });

  it('ignores group sources entirely', async () => {
    await dispatch(
      messageEvent(
        { type: 'text', id: 'm1', text: 'hi', quoteToken: 'q' },
        { type: 'group', groupId: 'G1', userId: 'U1' },
      ),
    );
    expect(handleText).not.toHaveBeenCalled();
    expect(api.replyMessage).not.toHaveBeenCalled();
    expect(repos.users.get('U1')).toBeUndefined();
    expect(repos.messages.recent('U1', 10)).toHaveLength(0);
  });

  it('marks the user unfollowed on unfollow', async () => {
    repos.users.upsert({ userId: 'U1' });
    const ev: webhook.UnfollowEvent = {
      ...base,
      type: 'unfollow',
      source: { type: 'user', userId: 'U1' },
    };
    await dispatch(ev);
    expect(repos.users.get('U1')?.followed).toBe(0);
  });
});
