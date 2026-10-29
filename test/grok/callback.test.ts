import { createHmac } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { createApp } from '../../src/server.js';
import { memoryDb } from '../db/helpers.js';

const silent = pino({ level: 'silent' });
const SECRET = 'grok-secret';

function app(secret: string | undefined = SECRET) {
  return createApp({
    channelSecret: 'line-secret',
    repos: createRepos(memoryDb()),
    dispatch: vi.fn(async () => {}),
    grokCallback: { secret, log: silent },
  });
}

function post(a: ReturnType<typeof createApp>, body: string, sig?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig !== undefined) headers['x-linebot-signature'] = sig;
  return a.request('/grok/callback', { method: 'POST', headers, body });
}

describe('POST /grok/callback', () => {
  const body = JSON.stringify({ id: '1', ok: true, text: 'hi' });

  it('rejects a bad or missing signature with 401', async () => {
    expect((await post(app(), body, 'deadbeef')).status).toBe(401);
    expect((await post(app(), body)).status).toBe(401);
  });

  it('answers 501 for a good signature', async () => {
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await post(app(), body, sig);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'callback mode not implemented' });
  });

  it('answers 503 when the app has no deps', async () => {
    const res = await post(createApp(), body);
    expect(res.status).toBe(503);
  });
});
