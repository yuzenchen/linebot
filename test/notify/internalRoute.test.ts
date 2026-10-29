import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createInternalNotifyRoute, tagNotice } from '../../src/notify/internalRoute.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';

const ADMINS = ['Uadmin1', 'Uadmin2'];

function setup(token: string | null = 'tkn') {
  const h = harness();
  const app = new Hono();
  app.route(
    '/internal/notify',
    createInternalNotifyRoute({
      token: token ?? undefined,
      adminUserIds: ADMINS,
      replier: h.replier,
      log: silent,
    }),
  );
  const post = (body: unknown, hdr: string | null = 'tkn') => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (hdr !== null) headers['x-internal-token'] = hdr;
    return app.request('/internal/notify', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  };
  return { ...h, post };
}

describe('POST /internal/notify', () => {
  it('answers 503 without a configured token', async () => {
    const s = setup(null);
    expect((await s.post({ kind: 'incident', text: 'x' })).status).toBe(503);
  });

  it('answers 401 for a missing or wrong token', async () => {
    const s = setup();
    expect((await s.post({ kind: 'incident', text: 'x' }, null)).status).toBe(401);
    expect((await s.post({ kind: 'incident', text: 'x' }, 'nope')).status).toBe(401);
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('answers 400 for invalid JSON or body', async () => {
    const s = setup();
    expect((await s.post('not json')).status).toBe(400);
    expect((await s.post({ kind: 'incident', text: '' })).status).toBe(400);
    expect((await s.post({ kind: 'incident', text: 'a'.repeat(5001) })).status).toBe(400);
    expect((await s.post({ text: 'x' })).status).toBe(400);
  });

  it('pushes to every admin with relay_<kind> and reports counts', async () => {
    const s = setup();
    const res = await s.post({ kind: 'incident', text: '網站異常', meta: { userId: 'U1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, delivered: ADMINS.length, failed: 0 });
    expect(pushReasons(s.db)).toEqual(['relay_incident', 'relay_incident']);
    expect(sentTexts(s.api).map((t) => t.text)).toEqual([
      '[客服 bot] 網站異常',
      '[客服 bot] 網站異常',
    ]);
  });

  it('counts per-recipient failures and still answers 200', async () => {
    const s = setup();
    s.api.pushMessage.mockRejectedValueOnce(new Error('line down'));
    const res = await s.post({ kind: 'handoff', text: 'x' });
    expect(await res.json()).toEqual({ ok: true, delivered: 1, failed: 1 });
    expect(pushReasons(s.db)).toEqual(['relay_handoff']);
  });

  it('does not double-tag text that already starts with [', () => {
    expect(tagNotice('[異常] 網站')).toBe('[異常] 網站');
    expect(tagNotice('網站')).toBe('[客服 bot] 網站');
  });
});
