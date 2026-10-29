import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import {
  createEnduserClient,
  EnduserClientError,
  enduserErrorMessage,
} from '../../src/admin/enduserClient.js';

type Call = { url: string; init: RequestInit };

function setup(responder: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return responder(c);
  }) as unknown as typeof fetch;
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => void lines.push(s) });
  const client = createEnduserClient({
    baseUrl: 'http://enduser:8090/',
    token: 'secret-token',
    fetchImpl,
    timeoutMs: 50,
    log,
  });
  return { client, calls, lines };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('enduser client', () => {
  it('listOpenTickets: GET with the token header, returns the tickets', async () => {
    const s = setup(() => json(200, { ok: true, tickets: [{ id: 1, display: 'T001' }] }));
    const out = await s.client.listOpenTickets(5);
    expect(out).toEqual([{ id: 1, display: 'T001' }]);
    expect(s.calls[0].url).toBe('http://enduser:8090/internal/tickets?status=open&limit=5');
    expect(s.calls[0].init.method).toBe('GET');
    expect((s.calls[0].init.headers as Record<string, string>)['x-internal-token']).toBe(
      'secret-token',
    );
    expect(s.lines.join('')).not.toContain('secret-token');
  });

  it('getTicket: 404 → not_found; 200 → the ticket', async () => {
    const s = setup((c) =>
      c.url.endsWith('/7')
        ? json(404, { error: 'unknown ticket' })
        : json(200, { ok: true, ticket: { id: 1, display: 'T001', status: 'open' } }),
    );
    await expect(s.client.getTicket(7)).rejects.toMatchObject({ kind: 'not_found', status: 404 });
    expect(await s.client.getTicket(1)).toMatchObject({ display: 'T001' });
  });

  it('replyTicket: POST body, 200 → userIdShort; 404 / 409 / 502 → typed errors', async () => {
    let status = 200;
    const s = setup(() =>
      status === 200
        ? json(200, { ok: true, pushed: true, ticketId: 1, userId: 'U60378731234567' })
        : json(status, { ok: false, error: 'http_401: blocked' }),
    );
    const out = await s.client.replyTicket(1, '已出貨', 'Uadmin');
    expect(out).toEqual({ ok: true, pushed: true, ticketId: 1, userIdShort: 'U6037873…' });
    expect(s.calls[0].url).toBe('http://enduser:8090/internal/reply');
    expect(JSON.parse(s.calls[0].init.body as string)).toEqual({
      ticketId: 1,
      text: '已出貨',
      by: 'Uadmin',
    });
    for (const [st, kind] of [
      [404, 'not_found'],
      [409, 'closed'],
      [502, 'push_failed'],
    ] as const) {
      status = st;
      await expect(s.client.replyTicket(1, 'x', 'a')).rejects.toMatchObject({ kind, status: st });
    }
  });

  it('closeTicket: POST /:id/close', async () => {
    const s = setup(() => json(200, { ok: true }));
    await s.client.closeTicket(3);
    expect(s.calls[0].url).toBe('http://enduser:8090/internal/tickets/3/close');
    expect(s.calls[0].init.method).toBe('POST');
  });

  it('401 / 503 → unauthorized; other statuses → http; bad body → bad_response', async () => {
    let res: Response = json(401, { error: 'unauthorized' });
    const s = setup(() => res);
    await expect(s.client.listOpenTickets()).rejects.toMatchObject({ kind: 'unauthorized' });
    res = json(503, {});
    await expect(s.client.listOpenTickets()).rejects.toMatchObject({ kind: 'unauthorized' });
    res = json(500, { error: 'boom' });
    await expect(s.client.listOpenTickets()).rejects.toMatchObject({ kind: 'http', status: 500 });
    res = new Response('not json', { status: 200 });
    await expect(s.client.listOpenTickets()).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('network failure and timeout map to their kinds with zh-TW messages', async () => {
    const down = setup(() => {
      throw new TypeError('fetch failed');
    });
    const err = await down.client.listOpenTickets().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnduserClientError);
    expect((err as EnduserClientError).kind).toBe('network');
    expect(enduserErrorMessage(err)).toBe('客服端服務無法連線');

    const slow = setup(
      (c) =>
        new Promise((_, reject) => {
          c.init.signal?.addEventListener('abort', () => reject(c.init.signal?.reason));
        }),
    );
    const t = await slow.client.listOpenTickets().catch((e: unknown) => e);
    expect((t as EnduserClientError).kind).toBe('timeout');
    expect(enduserErrorMessage(new Error('x'))).toBe('客服端服務無法連線');
  });
});
