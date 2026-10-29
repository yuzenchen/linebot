import { createHmac } from 'node:crypto';
import type { webhook } from '@line/bot-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { createApp } from '../../src/server.js';
import { memoryDb } from '../db/helpers.js';

const SECRET = 'test-secret';
const flush = () => new Promise((r) => setImmediate(r));

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function textEvent(id: string): webhook.MessageEvent {
  return {
    type: 'message',
    webhookEventId: id,
    timestamp: 1700000000000,
    mode: 'active',
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId: 'Utest' },
    replyToken: 'tok-' + id,
    message: { type: 'text', id: 'm-' + id, text: 'hi', quoteToken: 'q' },
  };
}

describe('POST /webhook', () => {
  let dispatch: ReturnType<typeof vi.fn<(e: webhook.Event) => Promise<void>>>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dispatch = vi.fn(async () => {});
    app = createApp({ channelSecret: SECRET, repos: createRepos(memoryDb()), dispatch });
  });

  const post = (body: string, sig?: string) =>
    app.request('/webhook', {
      method: 'POST',
      body,
      headers: sig === undefined ? {} : { 'x-line-signature': sig },
    });

  it('rejects missing signature with 401', async () => {
    const body = JSON.stringify({ destination: 'U', events: [textEvent('e1')] });
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad signature' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects wrong signature with 401', async () => {
    const body = JSON.stringify({ destination: 'U', events: [textEvent('e1')] });
    const res = await post(body, sign(body, 'other-secret'));
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('accepts a valid signature and dispatches once asynchronously', async () => {
    const body = JSON.stringify({ destination: 'U', events: [textEvent('e1')] });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].webhookEventId).toBe('e1');
  });

  it('dedupes a redelivered body', async () => {
    const body = JSON.stringify({ destination: 'U', events: [textEvent('e1')] });
    expect((await post(body, sign(body))).status).toBe(200);
    expect((await post(body, sign(body))).status).toBe(200);
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for invalid JSON with a valid signature', async () => {
    const body = '{not json';
    const res = await post(body, sign(body));
    expect(res.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still returns 200 when dispatch throws', async () => {
    dispatch.mockRejectedValue(new Error('boom'));
    const body = JSON.stringify({ destination: 'U', events: [textEvent('e1')] });
    const res = await post(body, sign(body));
    expect(res.status).toBe(200);
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the app has no deps', async () => {
    const res = await createApp().request('/webhook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });
});
