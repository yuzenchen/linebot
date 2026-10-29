import type { Logger } from 'pino';
import { logger } from '../logger.js';

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface HealthResult {
  status: HealthStatus;
  httpStatus?: number;
  body?: unknown;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

export interface HealthChecker {
  /** Cached for `cacheMs`; concurrent callers share one in-flight check. Never throws. */
  check(): Promise<HealthResult>;
  /** Drops the cache (tests). */
  reset(): void;
}

export interface HealthCheckerOptions {
  url: string;
  timeoutMs: number;
  cacheMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: Logger;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Undici wraps the real cause (ECONNREFUSED etc.) in `cause`.
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (${cause.message})` : '';
    return `${err.name}: ${err.message}${causeMsg}`;
  }
  return String(err);
}

/**
 * SPEC 5.4 steps 1–2. GET `url` with a timeout; timeout / network error is retried once and
 * two failures mean `down`. 200 + JSON `{status:'ok'}` → healthy; anything else → degraded.
 */
export function createHealthChecker(opts: HealthCheckerOptions): HealthChecker {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? logger;

  let cached: { result: HealthResult; at: number } | undefined;
  let inflight: Promise<HealthResult> | undefined;

  async function attempt(): Promise<HealthResult> {
    const started = now().getTime();
    const res = await fetchImpl(opts.url, {
      method: 'GET',
      signal: AbortSignal.timeout(opts.timeoutMs),
      headers: { accept: 'application/json' },
    });
    const latencyMs = Math.max(0, now().getTime() - started);
    const checkedAt = now().toISOString();
    let body: unknown;
    let bodyIsJson = false;
    try {
      const raw = await res.text();
      try {
        body = JSON.parse(raw) as unknown;
        bodyIsJson = true;
      } catch {
        body = raw.length > 500 ? raw.slice(0, 500) : raw;
      }
    } catch (err) {
      body = undefined;
      log.debug({ err: errorMessage(err) }, 'health body read failed');
    }
    const ok =
      res.status === 200 &&
      bodyIsJson &&
      typeof body === 'object' &&
      body !== null &&
      (body as { status?: unknown }).status === 'ok';
    return {
      status: ok ? 'healthy' : 'degraded',
      httpStatus: res.status,
      body,
      latencyMs,
      checkedAt,
    };
  }

  async function run(): Promise<HealthResult> {
    const started = now().getTime();
    let lastErr: unknown;
    for (let i = 0; i < 2; i++) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        log.warn({ attempt: i + 1, err: errorMessage(err) }, 'health check request failed');
      }
    }
    return {
      status: 'down',
      latencyMs: Math.max(0, now().getTime() - started),
      checkedAt: now().toISOString(),
      error: errorMessage(lastErr),
    };
  }

  return {
    check(): Promise<HealthResult> {
      const t = now().getTime();
      if (cached && t - cached.at < opts.cacheMs) return Promise.resolve(cached.result);
      if (inflight) return inflight;
      inflight = run()
        .catch((err): HealthResult => ({
          status: 'down',
          latencyMs: 0,
          checkedAt: now().toISOString(),
          error: errorMessage(err),
        }))
        .then((result) => {
          cached = { result, at: now().getTime() };
          inflight = undefined;
          return result;
        });
      return inflight;
    },
    reset(): void {
      cached = undefined;
    },
  };
}
