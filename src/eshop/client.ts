import type { Logger } from 'pino';
import type { ZodType } from 'zod';
import type { TokenProvider } from './auth.js';
import {
  EshopBadResponse,
  EshopHttpError,
  EshopNetworkError,
  EshopRateLimited,
  EshopTimeout,
} from './errors.js';
import {
  lowStockResponseSchema,
  orderResponseSchema,
  ordersListResponseSchema,
  productsResponseSchema,
  statsResponseSchema,
  type ListOrdersParams,
  type LowStockResponse,
  type Order,
  type OrdersListResponse,
  type Product,
  type Stats,
} from './types.js';

/**
 * Read-only client for pet eshop `/api/v1` (SPEC-ADMIN §4–5). Only the five whitelisted GET
 * endpoints exist as methods; there is no generic request method, so a write cannot be issued
 * through this module even by mistake.
 */
export interface EshopClient {
  listOrders(params?: ListOrdersParams): Promise<OrdersListResponse>;
  /** `null` when the backend answers 404. Accepts the id with or without the leading `#`. */
  getOrder(orderId: string): Promise<Order | null>;
  /** All products, including inactive ones. */
  listProducts(): Promise<Product[]>;
  lowStock(): Promise<LowStockResponse>;
  stats(): Promise<Stats>;
}

export interface EshopClientOptions {
  baseUrl: string;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: Logger;
  now?: () => Date;
}

export const ORDERS_LIMIT_MIN = 1;
export const ORDERS_LIMIT_MAX = 100;
const BODY_SNIPPET_MAX = 200;

/** Trim and add the leading `#` the backend requires. The hex part is kept as given. */
export function normaliseOrderId(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

export function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || Number.isNaN(limit)) return undefined;
  return Math.min(ORDERS_LIMIT_MAX, Math.max(ORDERS_LIMIT_MIN, Math.trunc(limit)));
}

type QueryValue = string | number | undefined;

/** Builds `path?query`; undefined values are dropped, everything is URL-encoded (`#` → `%23`). */
export function buildPath(path: string, query: Record<string, QueryValue> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - nowMs) / 1000));
}

export function createEshopClient(opts: EshopClientOptions): EshopClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? (() => new Date());
  const log = opts.log;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function fetchOnce(path: string): Promise<Response> {
    const token = await opts.tokenProvider.getToken();
    try {
      return await fetchImpl(base + path, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new EshopTimeout(path);
      }
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new EshopNetworkError(path, detail);
    }
  }

  /**
   * GET + auth + one retry on 401 + status mapping + zod validation. `allow404` makes a 404
   * resolve to `null` instead of throwing. Private: never exported from the module.
   */
  async function get<T>(path: string, schema: ZodType<T>, allow404 = false): Promise<T | null> {
    const started = now().getTime();
    const logPath = path.split('?')[0];
    let res: Response;
    try {
      res = await fetchOnce(path);
      if (res.status === 401) {
        await res.text().catch(() => '');
        opts.tokenProvider.invalidate();
        res = await fetchOnce(path);
      }
    } catch (err) {
      log?.warn(
        { method: 'GET', path: logPath, ms: now().getTime() - started, err: errName(err) },
        'eshop request failed',
      );
      throw err;
    }
    const ms = now().getTime() - started;
    log?.info({ method: 'GET', path: logPath, status: res.status, ms }, 'eshop request');

    if (res.status === 404 && allow404) {
      await res.text().catch(() => '');
      return null;
    }
    if (res.status === 429) {
      await res.text().catch(() => '');
      throw new EshopRateLimited(parseRetryAfter(res.headers.get('retry-after'), now().getTime()));
    }
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      throw new EshopHttpError(res.status, raw.slice(0, BODY_SNIPPET_MAX));
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new EshopBadResponse(logPath, 'not JSON');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first ? `${first.path.join('.')}: ${first.message}` : 'schema mismatch';
      throw new EshopBadResponse(logPath, where);
    }
    return parsed.data;
  }

  return {
    async listOrders(params = {}) {
      const path = buildPath('/orders', {
        page: params.page,
        limit: clampLimit(params.limit),
        status: params.status,
        orderType: params.orderType,
        paymentStatus: params.paymentStatus,
        paymentMethod: params.paymentMethod,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        q: params.q,
      });
      return (await get(path, ordersListResponseSchema))!;
    },
    async getOrder(orderId) {
      const id = normaliseOrderId(orderId);
      const data = await get(`/orders/${encodeURIComponent(id)}`, orderResponseSchema, true);
      return data ? data.order : null;
    },
    async listProducts() {
      return (await get('/admin/products', productsResponseSchema))!.products;
    },
    async lowStock() {
      return (await get('/admin/stock/low', lowStockResponseSchema))!;
    },
    async stats() {
      return (await get('/admin/stats', statsResponseSchema))!.stats;
    },
  };
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}
