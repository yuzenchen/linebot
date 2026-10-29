import { describe, expect, it } from 'vitest';
import { createTokenProvider, decodeJwtExp, LOCKOUT_MS } from '../../src/eshop/auth.js';
import { EshopAuthError } from '../../src/eshop/errors.js';
import { BASE, fakeJwt, json, recordingFetch, silent } from './helpers.js';

function clock(startMs: number) {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const T0 = Date.parse('2026-10-30T00:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);

function provider(f: typeof fetch, now: () => Date) {
  return createTokenProvider({
    baseUrl: BASE + '/',
    username: 'bot',
    password: 'pw',
    fetchImpl: f,
    now,
    log: silent,
  });
}

describe('token provider', () => {
  it('decodes exp from a JWT without verifying', () => {
    expect(decodeJwtExp(fakeJwt(1700000000))).toBe(1700000000 * 1000);
    expect(decodeJwtExp('not-a-jwt')).toBeUndefined();
    expect(decodeJwtExp('a.!!!.c')).toBeUndefined();
  });

  it('logs in once and reuses the cached token', async () => {
    const c = clock(T0);
    const token = fakeJwt(sec(T0) + 7 * 86400);
    const { impl, calls } = recordingFetch(() => json(200, { token, user: { id: 1 } }));
    const p = provider(impl, c.now);
    expect(await p.getToken()).toBe(token);
    expect(await p.getToken()).toBe(token);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/auth/login`);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ identifier: 'bot', password: 'pw' });
  });

  it('re-logs in when exp is within 1 hour', async () => {
    const c = clock(T0);
    const soon = fakeJwt(sec(T0) + 30 * 60);
    const fresh = fakeJwt(sec(T0) + 7 * 86400);
    const { impl, calls } = recordingFetch((_u, _i, n) =>
      json(200, { token: n === 1 ? soon : fresh }),
    );
    const p = provider(impl, c.now);
    expect(await p.getToken()).toBe(soon);
    expect(await p.getToken()).toBe(fresh);
    expect(await p.getToken()).toBe(fresh);
    expect(calls).toHaveLength(2);
  });

  it('re-logs in after the token ages past exp - 1h (fake time)', async () => {
    const c = clock(T0);
    const { impl, calls } = recordingFetch((_u, _i, n) =>
      json(200, { token: fakeJwt(sec(c.now().getTime()) + 2 * 3600, { n }) }),
    );
    const p = provider(impl, c.now);
    await p.getToken();
    c.advance(30 * 60 * 1000);
    await p.getToken();
    expect(calls).toHaveLength(1);
    c.advance(31 * 60 * 1000); // now 61 min in: 59 min left → refresh
    await p.getToken();
    expect(calls).toHaveLength(2);
  });

  it('invalidate() forces a new login', async () => {
    const c = clock(T0);
    const { impl, calls } = recordingFetch(() => json(200, { token: fakeJwt(sec(T0) + 86400) }));
    const p = provider(impl, c.now);
    await p.getToken();
    p.invalidate();
    await p.getToken();
    expect(calls).toHaveLength(2);
  });

  it('concurrent getToken() shares one login', async () => {
    const c = clock(T0);
    const { impl, calls } = recordingFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return json(200, { token: fakeJwt(sec(T0) + 86400) });
    });
    const p = provider(impl, c.now);
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('two failures lock out without a third login call; lockout expires after 15 min', async () => {
    const c = clock(T0);
    const { impl, calls } = recordingFetch((_u, _i, n) =>
      n <= 2 ? json(401, { error: 'bad' }) : json(200, { token: fakeJwt(sec(T0) + 86400) }),
    );
    const p = provider(impl, c.now);
    await expect(p.getToken()).rejects.toMatchObject({
      name: 'EshopAuthError',
      reason: 'login_failed',
    });
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'login_failed', status: 401 });
    expect(calls).toHaveLength(2);

    const locked = await p.getToken().catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(EshopAuthError);
    expect((locked as EshopAuthError).reason).toBe('login_locked_out');
    expect((locked as EshopAuthError).userMessage).toContain('15 分鐘');
    expect(calls).toHaveLength(2);

    c.advance(LOCKOUT_MS - 1);
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'login_locked_out' });
    expect(calls).toHaveLength(2);

    c.advance(1);
    expect(typeof (await p.getToken())).toBe('string');
    expect(calls).toHaveLength(3);
  });

  it('network error and 5xx are auth errors and count toward the lockout', async () => {
    const c = clock(T0);
    const { impl, calls } = recordingFetch((_u, _i, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return json(503, 'down');
    });
    const p = provider(impl, c.now);
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'network_error' });
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'login_failed', status: 503 });
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'login_locked_out' });
    expect(calls).toHaveLength(2);
  });

  it('a success resets the failure counter', async () => {
    const c = clock(T0);
    const { impl, calls } = recordingFetch((_u, _i, n) =>
      n === 1 || n === 3 ? json(429, {}) : json(200, { token: fakeJwt(sec(T0) + 30) }),
    );
    const p = provider(impl, c.now);
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'login_failed' });
    await p.getToken(); // success (token expires in 30 s, so next call logs in again)
    await expect(p.getToken()).rejects.toMatchObject({ reason: 'login_failed' });
    await p.getToken(); // not locked out: counter was reset
    expect(calls).toHaveLength(4);
  });

  it('login response without a token is bad_login_response', async () => {
    const c = clock(T0);
    const { impl } = recordingFetch(() => json(200, { ok: true }));
    await expect(provider(impl, c.now).getToken()).rejects.toMatchObject({
      reason: 'bad_login_response',
    });
  });
});
