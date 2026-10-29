import { HTTPFetchError } from '@line/bot-sdk';
import { pino } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepos, type Repos } from '../../src/db/repos.js';
import type { LineApi } from '../../src/line/client.js';
import { isReplyTokenError, Replier } from '../../src/line/replier.js';
import { memoryDb } from '../db/helpers.js';

const silent = pino({ level: 'silent' });

function httpError(status: number): HTTPFetchError {
  return new HTTPFetchError(`HTTP ${status}`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{"message":"Invalid reply token"}',
  });
}

describe('Replier', () => {
  let db: ReturnType<typeof memoryDb>;
  let repos: Repos;
  let api: { [K in keyof LineApi]: ReturnType<typeof vi.fn<LineApi[K]>> };
  let replier: Replier;

  beforeEach(() => {
    db = memoryDb();
    repos = createRepos(db);
    api = {
      replyMessage: vi.fn(async () => ({})),
      pushMessage: vi.fn(async () => ({})),
      showLoadingAnimation: vi.fn(async () => ({})),
    };
    replier = new Replier(api, repos, silent);
  });

  it('isReplyTokenError matches the SDK error with status 400', () => {
    expect(isReplyTokenError(httpError(400))).toBe(true);
    expect(isReplyTokenError(httpError(500))).toBe(false);
    expect(isReplyTokenError(new Error('x'))).toBe(false);
  });

  it('reply ok records one out message and no push_log', async () => {
    const result = await replier.reply('tok', 'U1', ['hello']);
    expect(result).toBe('replied');
    expect(api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok',
      messages: [{ type: 'text', text: 'hello' }],
    });
    const rows = repos.messages.recent('U1', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', type: 'text', text: 'hello' });
    expect(repos.pushLog.countMonth()).toBe(0);
  });

  it('reply 400 falls back to push and logs the push', async () => {
    api.replyMessage.mockRejectedValue(httpError(400));
    const result = await replier.reply('tok', 'U1', ['hello']);
    expect(result).toBe('pushed');
    expect(api.pushMessage).toHaveBeenCalledWith({
      to: 'U1',
      messages: [{ type: 'text', text: 'hello' }],
    });
    expect(repos.pushLog.countMonth()).toBe(1);
    expect(lastPush(db).reason).toBe('reply_fallback');
    expect(repos.messages.recent('U1', 10)).toHaveLength(1);
  });

  it('reply 500 rethrows and does not push', async () => {
    api.replyMessage.mockRejectedValue(httpError(500));
    await expect(replier.reply('tok', 'U1', ['hello'])).rejects.toBeInstanceOf(HTTPFetchError);
    expect(api.pushMessage).not.toHaveBeenCalled();
    expect(repos.pushLog.countMonth()).toBe(0);
    expect(repos.messages.recent('U1', 10)).toHaveLength(0);
  });

  it('a reused token goes straight to push', async () => {
    await replier.reply('tok', 'U1', ['first']);
    const result = await replier.reply('tok', 'U1', ['second']);
    expect(result).toBe('pushed');
    expect(api.replyMessage).toHaveBeenCalledTimes(1);
    expect(api.pushMessage).toHaveBeenCalledTimes(1);
    expect(repos.pushLog.countMonth()).toBe(1);
  });

  it('truncates to 5 messages and 5000 chars', async () => {
    const long = 'x'.repeat(6000);
    await replier.reply('tok', 'U1', ['1', '2', '3', '4', { type: 'text', text: long }, '6', '7']);
    const sent = api.replyMessage.mock.calls[0][0].messages;
    expect(sent).toHaveLength(5);
    expect(sent[4].text).toHaveLength(5000);
    expect(repos.messages.recent('U1', 10)).toHaveLength(5);
  });

  it('push failure rethrows and writes nothing', async () => {
    api.pushMessage.mockRejectedValue(httpError(429));
    await expect(replier.push('U1', ['x'], 'r')).rejects.toBeInstanceOf(HTTPFetchError);
    expect(repos.pushLog.countMonth()).toBe(0);
    expect(repos.messages.recent('U1', 10)).toHaveLength(0);
  });

  it('replyOrPush pushes when no token is given', async () => {
    expect(await replier.replyOrPush(undefined, 'U1', ['x'], 'welcome')).toBe('pushed');
    expect(api.replyMessage).not.toHaveBeenCalled();
    expect(lastPush(db).reason).toBe('welcome');
  });

  it('recordAs stores the substitute text instead of the sent text (reply, push, 400 fallback)', async () => {
    const opts = { recordAs: ['（placeholder）'] };
    await replier.reply('tok', 'U1', ['secret 0912345678'], opts);
    expect(api.replyMessage).toHaveBeenCalledWith({
      replyToken: 'tok',
      messages: [{ type: 'text', text: 'secret 0912345678' }],
    });
    await replier.push('U1', ['secret 2'], 'late', opts);
    api.replyMessage.mockRejectedValue(httpError(400));
    expect(await replier.reply('tok2', 'U1', ['secret 3', 'secret 4'], opts)).toBe('pushed');
    expect(api.pushMessage).toHaveBeenLastCalledWith({
      to: 'U1',
      messages: [
        { type: 'text', text: 'secret 3' },
        { type: 'text', text: 'secret 4' },
      ],
    });
    const texts = repos.messages.recent('U1', 10).map((r) => r.text);
    expect(texts).toEqual(['（placeholder）', '（placeholder）', '（placeholder）']);
    expect(texts.join()).not.toContain('secret');
    expect(lastPush(db).reason).toBe('reply_fallback');
  });

  it('swallows showLoading failures', async () => {
    api.showLoadingAnimation.mockRejectedValue(httpError(500));
    await expect(replier.showLoading('U1')).resolves.toBeUndefined();
    expect(api.showLoadingAnimation).toHaveBeenCalledWith({ chatId: 'U1', loadingSeconds: 60 });
  });
});

function lastPush(db: ReturnType<typeof memoryDb>): { reason: string } {
  return db.prepare('SELECT reason FROM push_log ORDER BY id DESC LIMIT 1').get() as {
    reason: string;
  };
}
