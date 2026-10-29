import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthChecker } from '../../src/health/check.js';
import { silent } from '../handlers/helpers.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function make(fetchImpl: typeof fetch, extra: { cacheMs?: number; now?: () => Date } = {}) {
  return createHealthChecker({
    url: 'http://example.test/health',
    timeoutMs: 50,
    cacheMs: extra.cacheMs ?? 0,
    fetchImpl,
    now: extra.now,
    log: silent,
  });
}

describe('health checker', () => {
  afterEach(() => vi.useRealTimers());

  it('200 with status ok is healthy', async () => {
    const f = vi.fn(async () => jsonResponse(200, { status: 'ok', uptime: 1 }));
    const r = await make(f as unknown as typeof fetch).check();
    expect(r.status).toBe('healthy');
    expect(r.httpStatus).toBe(200);
    expect(r.body).toEqual({ status: 'ok', uptime: 1 });
    expect(r.error).toBeUndefined();
    expect(typeof r.latencyMs).toBe('number');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('503 is degraded with httpStatus', async () => {
    const f = vi.fn(async () => jsonResponse(503, { status: 'error' }));
    const r = await make(f as unknown as typeof fetch).check();
    expect(r.status).toBe('degraded');
    expect(r.httpStatus).toBe(503);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('200 with a non-ok body or non-JSON body is degraded', async () => {
    const f1 = vi.fn(async () => jsonResponse(200, { status: 'maintenance' }));
    expect((await make(f1 as unknown as typeof fetch).check()).status).toBe('degraded');
    const f2 = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    const r = await make(f2 as unknown as typeof fetch).check();
    expect(r.status).toBe('degraded');
    expect(r.body).toBe('<html>oops</html>');
  });

  it('two network failures mean down after exactly one retry', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const r = await make(f as unknown as typeof fetch).check();
    expect(r.status).toBe('down');
    expect(r.httpStatus).toBeUndefined();
    expect(r.error).toContain('fetch failed');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a failure followed by a success is healthy', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok' }));
    const r = await make(f as unknown as typeof fetch).check();
    expect(r.status).toBe('healthy');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a real timeout counts as a failure', async () => {
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const r = await make(f as unknown as typeof fetch).check();
    expect(r.status).toBe('down');
    expect(r.error).toMatch(/Timeout/i);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('caches the result within cacheMs and refreshes after expiry', async () => {
    let t = 1_000_000;
    const now = () => new Date(t);
    const f = vi.fn(async () => jsonResponse(200, { status: 'ok' }));
    const checker = make(f as unknown as typeof fetch, { cacheMs: 30_000, now });
    expect((await checker.check()).status).toBe('healthy');
    t += 10_000;
    expect((await checker.check()).status).toBe('healthy');
    expect(f).toHaveBeenCalledTimes(1);
    t += 25_000;
    f.mockResolvedValueOnce(jsonResponse(503, {}));
    expect((await checker.check()).status).toBe('degraded');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one in-flight request', async () => {
    const f = vi.fn(async () => jsonResponse(200, { status: 'ok' }));
    const checker = make(f as unknown as typeof fetch, { cacheMs: 1000 });
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    expect(a).toBe(b);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('reset() drops the cache', async () => {
    const f = vi.fn(async () => jsonResponse(200, { status: 'ok' }));
    const checker = make(f as unknown as typeof fetch, { cacheMs: 60_000 });
    await checker.check();
    checker.reset();
    await checker.check();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
