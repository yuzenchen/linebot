import { createHmac } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createGrokGateway,
  NullGrokGateway,
  WebhookGrokGateway,
  type GrokTask,
} from '../../src/grok/gateway.js';

const silent = pino({ level: 'silent' });
const URL = 'https://grok.example.test/hook';

const task: GrokTask = {
  id: '7',
  type: 'service_question',
  userMessage: '運費多少？',
  context: [{ role: 'user', text: '你好' }],
};

function gateway(fetchImpl: typeof fetch, secret?: string) {
  return new WebhookGrokGateway({ url: URL, secret, fetchImpl, log: silent });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('NullGrokGateway', () => {
  it('is not configured and never succeeds', async () => {
    const g = new NullGrokGateway();
    expect(g.configured).toBe(false);
    expect(await g.run()).toEqual({ ok: false, error: 'grok_not_configured' });
  });
});

describe('createGrokGateway', () => {
  it('picks Null without URL and Webhook with URL', () => {
    expect(
      createGrokGateway({ GROK_WEBHOOK_URL: undefined, GROK_WEBHOOK_SECRET: undefined }, silent)
        .configured,
    ).toBe(false);
    expect(
      createGrokGateway({ GROK_WEBHOOK_URL: URL, GROK_WEBHOOK_SECRET: 's' }, silent).configured,
    ).toBe(true);
  });
});

describe('WebhookGrokGateway', () => {
  it('POSTs the task as JSON with an HMAC signature of the raw body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, text: '60 元' }));
    const res = await gateway(fetchImpl, 'grok-secret').run(task);
    expect(res).toEqual({ ok: true, text: '60 元' });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    const body = init?.body as string;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-linebot-signature']).toBe(
      createHmac('sha256', 'grok-secret').update(body).digest('hex'),
    );
    expect(headers['x-linebot-timestamp']).toMatch(/^\d+$/);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ...task });
    expect(typeof parsed.sentAt).toBe('string');
  });

  it('omits signature headers without a secret', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, text: 'x' }));
    await gateway(fetchImpl).run(task);
    const headers = fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['x-linebot-signature']).toBeUndefined();
  });

  it('passes through structured and error fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: false, error: 'refused', structured: { a: 1 } }),
    );
    expect(await gateway(fetchImpl).run(task)).toEqual({
      ok: false,
      error: 'refused',
      structured: { a: 1 },
    });
  });

  it('maps non-2xx to http_<status>', async () => {
    const r500 = await gateway(
      vi.fn<typeof fetch>(async () => new Response('x', { status: 500 })),
    ).run(task);
    expect(r500).toMatchObject({ ok: false, error: 'http_500', transient: true });
    const r404 = await gateway(
      vi.fn<typeof fetch>(async () => new Response('x', { status: 404 })),
    ).run(task);
    expect(r404).toMatchObject({ ok: false, error: 'http_404', transient: false });
  });

  it('maps 202 and {async:true} to async_pending', async () => {
    const r202 = await gateway(
      vi.fn<typeof fetch>(async () => new Response(null, { status: 202 })),
    ).run(task);
    expect(r202).toMatchObject({ ok: false, error: 'async_pending' });
    const rAsync = await gateway(
      vi.fn<typeof fetch>(async () => jsonResponse({ async: true })),
    ).run(task);
    expect(rAsync).toMatchObject({ ok: false, error: 'async_pending' });
  });

  it('maps a non-JSON or shapeless 2xx body to bad_response', async () => {
    const r1 = await gateway(vi.fn<typeof fetch>(async () => new Response('hello'))).run(task);
    expect(r1).toEqual({ ok: false, error: 'bad_response' });
    const r2 = await gateway(vi.fn<typeof fetch>(async () => jsonResponse({ text: 'no ok' }))).run(
      task,
    );
    expect(r2).toEqual({ ok: false, error: 'bad_response' });
  });

  it('never throws on network errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await gateway(fetchImpl).run(task);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('fetch failed');
    expect(res.transient).toBe(true);
  });
});
