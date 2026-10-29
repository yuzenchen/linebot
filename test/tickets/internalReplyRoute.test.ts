import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createInternalReplyRoute } from '../../src/tickets/internalReplyRoute.js';
import { harness, pushReasons, silent } from '../handlers/helpers.js';
import { ticketRows } from './helpers.js';

const TOKEN = 'internal-test';
const USER = 'Uuser1234567';

function setup(opts: { token?: string | undefined } = {}) {
  const token = 'token' in opts ? opts.token : TOKEN;
  const h = harness();
  const app = new Hono();
  app.route(
    '/internal/reply',
    createInternalReplyRoute({ token, repos: h.repos, replier: h.replier, log: silent }),
  );
  const post = (body: unknown, presented: string | null = TOKEN) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (presented !== null) headers['x-internal-token'] = presented;
    return app.request('/internal/reply', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  };
  const open = () =>
    h.repos.tickets.openOrAppend({ userId: USER, source: 'handoff', question: 'q', context: ['q'] })
      .ticket;
  return { ...h, app, post, open };
}

const reply = { ticketId: 1, text: '已出貨', by: 'Uadmin' };

describe('POST /internal/reply', () => {
  it('503 without a token, 401 with a wrong or missing one', async () => {
    const off = setup({ token: undefined });
    expect((await off.post(reply)).status).toBe(503);
    const s = setup();
    s.open();
    expect((await s.post(reply, 'nope')).status).toBe(401);
    expect((await s.post(reply, null)).status).toBe(401);
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('400 on bad json or body (text 1..1000, by required)', async () => {
    const s = setup();
    s.open();
    expect((await s.post('nope')).status).toBe(400);
    expect((await s.post({ ticketId: '1', text: 'x', by: 'a' })).status).toBe(400);
    expect((await s.post({ ticketId: 1, text: '', by: 'a' })).status).toBe(400);
    expect((await s.post({ ticketId: 1, text: 'x'.repeat(1001), by: 'a' })).status).toBe(400);
    expect((await s.post({ ticketId: 1, text: 'x' })).status).toBe(400);
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('404 for an unknown ticket, 409 for a closed one', async () => {
    const s = setup();
    expect((await s.post(reply)).status).toBe(404);
    const t = s.open();
    s.repos.tickets.close(t.id);
    const res = await s.post(reply);
    expect(res.status).toBe(409);
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('200: pushes the customer (reason ticket_reply), records the out message, marks answered', async () => {
    const s = setup();
    s.open();
    const res = await s.post(reply);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, pushed: true, ticketId: 1, userId: USER });
    expect(s.api.pushMessage).toHaveBeenCalledWith({
      to: USER,
      messages: [{ type: 'text', text: '已出貨' }],
    });
    expect(pushReasons(s.db)).toEqual(['ticket_reply']);
    expect(s.repos.messages.recent(USER, 5)).toEqual([
      expect.objectContaining({ direction: 'out', type: 'text', text: '已出貨' }),
    ]);
    expect(ticketRows(s)[0]).toMatchObject({
      status: 'answered',
      answered_by: 'Uadmin',
      answer: '已出貨',
    });
    expect(ticketRows(s)[0]!.answered_at).not.toBeNull();

    // An answered ticket may be replied to again.
    const again = await s.post({ ...reply, text: '補充：明天到' });
    expect(again.status).toBe(200);
    expect(ticketRows(s)[0]).toMatchObject({ status: 'answered', answer: '補充：明天到' });
  });

  it('502 when the push fails; the ticket stays open and nothing is recorded', async () => {
    const s = setup();
    s.open();
    s.api.pushMessage.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status 401'), { status: 401 }),
    );
    const res = await s.post(reply);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: 'http_401: Request failed with status 401',
    });
    expect(ticketRows(s)[0]!.status).toBe('open');
    expect(pushReasons(s.db)).toEqual([]);
    expect(s.repos.messages.recent(USER, 5)).toEqual([]);
  });
});
