import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createInternalTicketsRoute } from '../../src/tickets/internalTicketsRoute.js';
import { harness, silent } from '../handlers/helpers.js';
import { ticketRows } from './helpers.js';

const TOKEN = 'internal-test';
const USER = 'U60378731234567890';

function setup(opts: { token?: string | undefined } = {}) {
  const token = 'token' in opts ? opts.token : TOKEN;
  const h = harness();
  const app = new Hono();
  app.route(
    '/internal/tickets',
    createInternalTicketsRoute({ token, repos: h.repos, log: silent }),
  );
  const req = (path: string, method = 'GET', presented: string | null = TOKEN) => {
    const headers: Record<string, string> = {};
    if (presented !== null) headers['x-internal-token'] = presented;
    return app.request(`/internal/tickets${path}`, { method, headers });
  };
  const open = (userId = USER, question = '我的訂單什麼時候出貨') =>
    h.repos.tickets.openOrAppend({
      userId,
      source: 'grok_failed',
      question,
      context: ['昨天訂的', question],
      orderIds: ['#20261029-VXJG7AZY'],
    }).ticket;
  return { ...h, app, req, open };
}

describe('/internal/tickets', () => {
  it('503 without a token, 401 with a wrong or missing one (every route)', async () => {
    const off = setup({ token: undefined });
    expect((await off.req('')).status).toBe(503);
    const s = setup();
    s.open();
    expect((await s.req('', 'GET', 'nope')).status).toBe(401);
    expect((await s.req('/1', 'GET', null)).status).toBe(401);
    expect((await s.req('/1/close', 'POST', null)).status).toBe(401);
    expect(ticketRows(s)[0]!.status).toBe('open');
  });

  it('GET / lists open tickets without PII, honouring limit', async () => {
    const s = setup();
    s.open();
    s.open('Uother');
    const t3 = s.open('Uthird');
    s.repos.tickets.close(t3.id);
    const res = await s.req('?status=open&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tickets: Record<string, unknown>[] };
    expect(body.ok).toBe(true);
    expect(body.tickets).toHaveLength(2);
    expect(body.tickets[0]).toEqual({
      id: 1,
      display: 'T001',
      userIdShort: 'U6037873…',
      question: '我的訂單什麼時候出貨',
      orderIds: ['#20261029-VXJG7AZY'],
      status: 'open',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain(USER);
    const limited = (await (await s.req('?limit=1')).json()) as { tickets: unknown[] };
    expect(limited.tickets).toHaveLength(1);
    expect((await s.req('?status=closed')).status).toBe(400);
  });

  it('GET /:id returns the detail with context and answer; 404 / 400 otherwise', async () => {
    const s = setup();
    const t = s.open();
    s.repos.tickets.markAnswered(t.id, { by: 'Uadmin', answer: '已出貨' });
    const res = await s.req('/T001');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ticket: Record<string, unknown> };
    expect(body.ticket).toMatchObject({
      id: 1,
      display: 'T001',
      userIdShort: 'U6037873…',
      status: 'answered',
      context: ['昨天訂的', '我的訂單什麼時候出貨'],
      answeredBy: 'Uadmin',
      answer: '已出貨',
    });
    expect(body.ticket.answeredAt).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain(USER);
    expect((await s.req('/99')).status).toBe(404);
    expect((await s.req('/abc')).status).toBe(400);
  });

  it('POST /:id/close closes the ticket (idempotent), 404 for unknown', async () => {
    const s = setup();
    s.open();
    const res = await s.req('/1/close', 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ticketId: 1, status: 'closed' });
    expect(ticketRows(s)[0]!.status).toBe('closed');
    expect((await s.req('/1/close', 'POST')).status).toBe(200);
    expect((await s.req('/7/close', 'POST')).status).toBe(404);
  });
});
