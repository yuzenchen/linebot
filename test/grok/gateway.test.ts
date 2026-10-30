import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  bearerHeader,
  callbackUrlFor,
  createGrokGateway,
  GROK_INSTRUCTIONS,
  NullGrokGateway,
  WebhookGrokGateway,
  type GrokTask,
} from '../../src/grok/gateway.js';

const silent = pino({ level: 'silent' });
const URL = 'https://api2.cursor.sh/automations/webhook/abc';
const CALLBACK_URL = 'https://linebot.example.test/grok/callback';
const CALLBACK_TOKEN = 'cb-token';

const task: GrokTask = {
  id: 'task-7',
  type: 'service_question',
  userMessage: '運費多少？',
  context: [{ role: 'user', text: '你好' }],
};

function gateway(fetchImpl: typeof fetch, secret?: string) {
  return new WebhookGrokGateway({
    url: URL,
    secret,
    callbackUrl: CALLBACK_URL,
    callbackToken: CALLBACK_TOKEN,
    fetchImpl,
    log: silent,
  });
}

const ok = () => vi.fn<typeof fetch>(async () => new Response('{"ok":true}', { status: 200 }));
const status = (s: number) => vi.fn<typeof fetch>(async () => new Response('x', { status: s }));

describe('NullGrokGateway', () => {
  it('is not configured and never succeeds', async () => {
    const g = new NullGrokGateway();
    expect(g.configured).toBe(false);
    expect(await g.run()).toEqual({ ok: false, error: 'grok_not_configured' });
  });
});

describe('bearerHeader / callbackUrlFor', () => {
  it('normalises with or without an existing Bearer prefix', () => {
    expect(bearerHeader('crsr_x')).toBe('Bearer crsr_x');
    expect(bearerHeader('Bearer crsr_x')).toBe('Bearer crsr_x');
    expect(bearerHeader('bearer  crsr_x ')).toBe('Bearer crsr_x');
  });
  it('builds the callback URL without a double slash', () => {
    expect(callbackUrlFor('https://a.test')).toBe('https://a.test/grok/callback');
    expect(callbackUrlFor('https://a.test/')).toBe('https://a.test/grok/callback');
  });
});

describe('createGrokGateway', () => {
  it('picks Null without URL and Webhook with URL', () => {
    const base = {
      GROK_WEBHOOK_SECRET: 's',
      PUBLIC_BASE_URL: 'https://a.test',
      GROK_CALLBACK_TOKEN: 't',
    };
    expect(createGrokGateway({ ...base, GROK_WEBHOOK_URL: undefined }, silent).configured).toBe(
      false,
    );
    expect(createGrokGateway({ ...base, GROK_WEBHOOK_URL: URL }, silent).configured).toBe(true);
  });
});

describe('WebhookGrokGateway', () => {
  it.each(['crsr_x', 'Bearer crsr_x'])(
    'sends authorization: Bearer crsr_x for secret %j',
    async (secret) => {
      const fetchImpl = ok();
      expect(await gateway(fetchImpl, secret).run(task)).toEqual({ ok: true, accepted: true });
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(URL);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer crsr_x');
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-linebot-signature']).toBeUndefined();
    },
  );

  it('body carries the task, callback contract and instructions', async () => {
    const fetchImpl = ok();
    await gateway(fetchImpl, 'crsr_x').run(task);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      ...task,
      callback: {
        url: CALLBACK_URL,
        method: 'POST',
        header: 'x-linebot-token',
        token: CALLBACK_TOKEN,
        body: { taskId: 'task-7' },
      },
      instructions: GROK_INSTRUCTIONS,
    });
    expect(typeof body.sentAt).toBe('string');
    expect(GROK_INSTRUCTIONS).toContain('status=received');
    expect(GROK_INSTRUCTIONS).toContain('status=needs_human');
    expect(JSON.stringify(body.callback)).toContain('needs_human');
  });

  it('treats any 2xx as accepted, even with a non-JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('queued', { status: 202 }));
    expect(await gateway(fetchImpl).run(task)).toEqual({ ok: true, accepted: true });
  });

  it('maps 401 / 403 / other 4xx to non-transient and 5xx to transient', async () => {
    expect(await gateway(status(401)).run(task)).toEqual({
      ok: false,
      error: 'http_401',
      transient: false,
    });
    expect(await gateway(status(403)).run(task)).toMatchObject({
      error: 'http_403',
      transient: false,
    });
    expect(await gateway(status(404)).run(task)).toMatchObject({
      error: 'http_404',
      transient: false,
    });
    expect(await gateway(status(500)).run(task)).toMatchObject({
      error: 'http_500',
      transient: true,
    });
  });

  it('never throws on network errors and marks them transient', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await gateway(fetchImpl).run(task);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('fetch failed');
    expect(res.transient).toBe(true);
  });
});
