import { describe, expect, it } from 'vitest';
import type { TokenProvider } from '../../src/eshop/auth.js';
import {
  buildPath,
  clampLimit,
  createEshopClient,
  normaliseOrderId,
} from '../../src/eshop/client.js';
import { EshopBadResponse, EshopHttpError, EshopRateLimited } from '../../src/eshop/errors.js';
import { paymentStatusLabel, statusLabel } from '../../src/eshop/types.js';
import { BASE, json, recordingFetch, sampleOrder, silent } from './helpers.js';

function fakeTokens(tokens: string[] = ['t1', 't2', 't3']) {
  let i = 0;
  let current: string | undefined;
  const tp: TokenProvider & { logins: number; invalidations: number } = {
    logins: 0,
    invalidations: 0,
    async getToken() {
      if (current === undefined) {
        current = tokens[i++] ?? `t${i}`;
        tp.logins += 1;
      }
      return current;
    },
    invalidate() {
      current = undefined;
      tp.invalidations += 1;
    },
  };
  return tp;
}

function make(f: typeof fetch, tp = fakeTokens()) {
  return createEshopClient({ baseUrl: BASE, tokenProvider: tp, fetchImpl: f, log: silent });
}

const list = (orders: unknown[] = [sampleOrder()], total = orders.length) =>
  json(200, { success: true, orders, pagination: { page: 1, limit: 20, total, pages: 1 } });

describe('eshop client: URL building', () => {
  it('normalises order ids', () => {
    expect(normaliseOrderId('20261029-ABCDEF12')).toBe('#20261029-ABCDEF12');
    expect(normaliseOrderId('  #D20261029-abcdef12 ')).toBe('#D20261029-abcdef12');
  });

  it('clamps limit to 1–100 and drops undefined', () => {
    expect(clampLimit(undefined)).toBeUndefined();
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(20.7)).toBe(20);
  });

  it('buildPath drops undefined and encodes values', () => {
    expect(buildPath('/orders', { page: 1, q: undefined, status: 'paid' })).toBe(
      '/orders?page=1&status=paid',
    );
    expect(buildPath('/orders', { q: '#2026 王' })).toBe('/orders?q=%232026+%E7%8E%8B');
    expect(buildPath('/orders')).toBe('/orders');
  });

  it('getOrder encodes # as %23 and sends the bearer token', async () => {
    const { impl, calls } = recordingFetch(() =>
      json(200, { success: true, order: sampleOrder() }),
    );
    const c = make(impl);
    const o = await c.getOrder('20261029-ABCDEF12');
    expect(o?.orderId).toBe('#20261029-ABCDEF12');
    expect(calls[0].url).toBe(`${BASE}/orders/%2320261029-ABCDEF12`);
    expect(calls[0].init?.method).toBe('GET');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer t1');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('listOrders builds the query with clamped limit and ISO dates', async () => {
    const { impl, calls } = recordingFetch(() => list());
    await make(impl).listOrders({
      limit: 999,
      paymentStatus: 'pending',
      dateFrom: '2026-10-30T00:00:00+08:00',
      q: undefined,
    });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/v1/orders');
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.get('paymentStatus')).toBe('pending');
    expect(u.searchParams.get('dateFrom')).toBe('2026-10-30T00:00:00+08:00');
    expect(u.searchParams.has('q')).toBe(false);
    expect(u.searchParams.has('page')).toBe(false);
  });

  it('other endpoints hit the whitelisted paths', async () => {
    const { impl, calls } = recordingFetch((url) => {
      if (url.endsWith('/admin/products'))
        return json(200, { success: true, products: [{ productId: 1, name: 'A' }] });
      if (url.endsWith('/admin/stock/low'))
        return json(200, {
          success: true,
          products: [],
          addons: [{ name: 'x', stock: 1 }],
          total: 1,
        });
      return json(200, { success: true, stats: { today: { orders: 3, revenue: 999 } } });
    });
    const c = make(impl);
    expect((await c.listProducts())[0].name).toBe('A');
    expect((await c.lowStock()).addons).toHaveLength(1);
    expect((await c.stats()).today?.orders).toBe(3);
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/api/v1/admin/products',
      '/api/v1/admin/stock/low',
      '/api/v1/admin/stats',
    ]);
  });
});

describe('eshop client: responses', () => {
  it('listOrders parses, keeps unknown fields, and labels resolve', async () => {
    const { impl } = recordingFetch(() => list([sampleOrder(), sampleOrder({ status: 'weird' })]));
    const r = await make(impl).listOrders();
    expect(r.pagination.total).toBe(2);
    expect(r.orders[0].customer?.phone).toBe('0912345678');
    expect((r.orders[0] as Record<string, unknown>).extraField).toBe('kept');
    expect(statusLabel[r.orders[0].status as 'paid']).toBe('已付款');
    expect(paymentStatusLabel[r.orders[0].payment!.status as 'paid']).toBe('已付款');
    expect(r.orders[1].status).toBe('weird');
  });

  it('getOrder returns null on 404', async () => {
    const { impl } = recordingFetch(() => json(404, { success: false, message: 'not found' }));
    expect(await make(impl).getOrder('#nope')).toBeNull();
  });

  it('401 invalidates the token and retries exactly once', async () => {
    const tp = fakeTokens();
    const { impl, calls } = recordingFetch((_u, init) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === 'Bearer t1' ? json(401, {}) : list();
    });
    const r = await make(impl, tp).listOrders();
    expect(r.orders).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(tp.invalidations).toBe(1);
    expect(tp.logins).toBe(2);
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe('Bearer t2');
  });

  it('a second 401 is surfaced as EshopHttpError (no endless retry)', async () => {
    const tp = fakeTokens();
    const { impl, calls } = recordingFetch(() => json(401, { message: 'nope' }));
    const err = await make(impl, tp)
      .stats()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EshopHttpError);
    expect((err as EshopHttpError).status).toBe(401);
    expect(calls).toHaveLength(2);
  });

  it('429 throws EshopRateLimited with retryAfter', async () => {
    const { impl } = recordingFetch(() => json(429, {}, { 'retry-after': '30' }));
    const err = await make(impl)
      .lowStock()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EshopRateLimited);
    expect((err as EshopRateLimited).retryAfter).toBe(30);
    expect((err as EshopRateLimited).userMessage).toBe('後台目前請求過多，請稍後再試');
  });

  it('5xx throws EshopHttpError with a ≤200 char snippet', async () => {
    const { impl } = recordingFetch(() => new Response('x'.repeat(1000), { status: 502 }));
    const err = await make(impl)
      .stats()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EshopHttpError);
    expect((err as EshopHttpError).status).toBe(502);
    expect((err as EshopHttpError).bodySnippet).toHaveLength(200);
  });

  it('malformed JSON and schema mismatch throw EshopBadResponse', async () => {
    const f1 = recordingFetch(() => new Response('<html>', { status: 200 }));
    await expect(make(f1.impl).listOrders()).rejects.toBeInstanceOf(EshopBadResponse);
    const f2 = recordingFetch(() => json(200, { success: true, orders: 'nope' }));
    await expect(make(f2.impl).listOrders()).rejects.toBeInstanceOf(EshopBadResponse);
  });

  it('exposes exactly the five read-only methods', () => {
    const { impl } = recordingFetch(() => list());
    const c = make(impl);
    expect(Object.keys(c).sort()).toEqual(
      ['getOrder', 'listOrders', 'listProducts', 'lowStock', 'stats'].sort(),
    );
    // @ts-expect-error no generic request / write method exists
    expect(c.request).toBeUndefined();
  });
});
