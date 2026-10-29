import type { Logger } from 'pino';
import { EshopAuthError } from './errors.js';
import { loginResponseSchema } from './types.js';

export interface TokenProvider {
  /** Cached JWT; logs in when missing, invalidated or about to expire. Throws `EshopAuthError`. */
  getToken(): Promise<string>;
  /** Drops the cached token (call on 401 from the API). */
  invalidate(): void;
}

export interface TokenProviderOptions {
  baseUrl: string;
  /** 後端登入欄位叫 identifier（帳號或手機）；bot 用 viewer 帳號，例如 linebot_viewer。 */
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: Logger;
  timeoutMs?: number;
}

/** Re-login when the token expires within this window. */
export const REFRESH_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
/** After this many consecutive login failures, stop trying for `LOCKOUT_MS`. */
export const MAX_CONSECUTIVE_LOGIN_FAILURES = 2;
export const LOCKOUT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Reads the `exp` claim (ms since epoch) from a JWT payload without verifying the signature. */
export function decodeJwtExp(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log;
  const loginUrl = joinUrl(opts.baseUrl, '/auth/login');

  let cached: { token: string; expMs: number | undefined } | undefined;
  let inflight: Promise<string> | undefined;
  let consecutiveFailures = 0;
  let lockedUntil = 0;

  function cachedIsFresh(): boolean {
    if (!cached) return false;
    if (cached.expMs === undefined) return true;
    return cached.expMs - now().getTime() > REFRESH_BEFORE_EXPIRY_MS;
  }

  async function login(): Promise<string> {
    const started = now().getTime();
    let res: Response;
    try {
      res = await fetchImpl(loginUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ identifier: opts.username, password: opts.password }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new EshopAuthError('network_error', detail);
    }
    const ms = now().getTime() - started;
    if (!res.ok) {
      // Body is dropped on purpose: it may echo the username.
      await res.text().catch(() => '');
      log?.warn(
        { method: 'POST', path: '/auth/login', status: res.status, ms },
        'eshop login failed',
      );
      throw new EshopAuthError('login_failed', `HTTP ${res.status}`, res.status);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new EshopAuthError('bad_login_response', 'not JSON', res.status);
    }
    const result = loginResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new EshopAuthError('bad_login_response', 'missing token', res.status);
    }
    log?.info({ method: 'POST', path: '/auth/login', status: res.status, ms }, 'eshop login ok');
    return result.data.token;
  }

  async function loginWithBackoff(): Promise<string> {
    const t = now().getTime();
    if (t < lockedUntil) {
      throw new EshopAuthError('login_locked_out', `until ${new Date(lockedUntil).toISOString()}`);
    }
    try {
      const token = await login();
      consecutiveFailures = 0;
      cached = { token, expMs: decodeJwtExp(token) };
      return token;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_LOGIN_FAILURES) {
        lockedUntil = now().getTime() + LOCKOUT_MS;
        consecutiveFailures = 0;
        log?.warn({ lockoutMs: LOCKOUT_MS }, 'eshop login backoff engaged');
      }
      throw err;
    }
  }

  return {
    getToken(): Promise<string> {
      if (cachedIsFresh()) return Promise.resolve(cached!.token);
      if (inflight) return inflight;
      inflight = loginWithBackoff().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    invalidate(): void {
      cached = undefined;
    },
  };
}
