import { pino } from 'pino';

export const silent = pino({ level: 'silent' });

export const BASE = 'https://eshop.test/api/v1';

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Unsigned HS256-shaped JWT whose payload carries `exp` (seconds). */
export function fakeJwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds, ...extra })}.sig`;
}

export type Call = { url: string; init: RequestInit | undefined };

/** Records every fetch call and answers with the given responder. */
export function recordingFetch(
  respond: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init, calls.length);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export function sampleOrder(over: Record<string, unknown> = {}) {
  return {
    orderId: '#20261029-ABCDEF12',
    orderType: 'general',
    createdAt: '2026-10-29T16:05:00Z',
    updatedAt: '2026-10-29T16:05:00Z',
    status: 'paid',
    payment: { method: 'linepay', status: 'paid', paidAt: '2026-10-29T16:06:00Z' },
    subtotal: 1200,
    shipping: 60,
    totalAmount: 1260,
    items: [{ refType: 'product', refId: 1, name: '雞肉條', price: 600, qty: 2 }],
    shippingMethod: 'convenience_store',
    shippingInfo: {
      address: '台北市中正區XX路1號',
      storeName: '全家測試店',
      pickupDate: '2026-11-01',
    },
    customer: {
      name: '王小明',
      phone: '0912345678',
      email: 'ming@example.com',
      instagram: 'ming_ig',
      note: '請小心輕放',
    },
    dealer: { shopName: '好狗店', contact: '李老闆', phone: '0987654321' },
    extraField: 'kept',
    ...over,
  };
}
