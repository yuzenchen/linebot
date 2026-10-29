import type { Logger } from 'pino';
import { logger } from '../logger.js';
import { INTERNAL_TOKEN_HEADER } from '../notify/adminNotifier.js';
import type { TicketDetail, TicketSummary } from '../tickets/internalTicketsRoute.js';

/**
 * T16: the admin bot's HTTP client for the enduser bot's `/internal/*` routes. Tickets live in
 * the enduser container's database, so every ticket operation goes through here.
 */

export type { TicketDetail, TicketSummary };

export type EnduserClientErrorKind =
  | 'not_found'
  | 'closed'
  | 'push_failed'
  | 'unauthorized'
  | 'http'
  | 'bad_response'
  | 'timeout'
  | 'network';

export class EnduserClientError extends Error {
  constructor(
    readonly kind: EnduserClientErrorKind,
    readonly userMessage: string,
    readonly status?: number,
    detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'EnduserClientError';
  }
}

export interface ReplyTicketResult {
  ok: true;
  pushed: true;
  ticketId: number;
  /** Shortened customer id (`U6037873…`); the full id never leaves the client. */
  userIdShort: string;
}

export function shortUserId(userId: string): string {
  return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
}

export interface EnduserClient {
  listOpenTickets(limit?: number): Promise<TicketSummary[]>;
  /** Throws `not_found` for an unknown id. */
  getTicket(id: number): Promise<TicketDetail>;
  /** Throws `not_found` / `closed` / `push_failed`. */
  replyTicket(id: number, text: string, by: string): Promise<ReplyTicketResult>;
  closeTicket(id: number): Promise<void>;
}

export interface EnduserClientDeps {
  /** `ENDUSER_INTERNAL_URL` (no trailing slash). */
  baseUrl: string;
  /** `INTERNAL_NOTIFY_TOKEN`; never logged. */
  token: string;
  fetchImpl?: typeof fetch;
  /** Default 8000. */
  timeoutMs?: number;
  log?: Logger;
}

const MSG_UNREACHABLE = '客服端服務無法連線';
const MSG_TIMEOUT = '客服端服務逾時';
const MSG_BAD = '客服端回應格式錯誤';
const MSG_UNAUTHORIZED = '客服端拒絕存取（內部密鑰不一致）';
const MSG_NOT_FOUND = '找不到這張工單';
const MSG_CLOSED = '這張工單已關閉';
const MSG_PUSH_FAILED = '客戶端推播失敗（客戶可能已封鎖）';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function createEnduserClient(deps: EnduserClientDeps): EnduserClient {
  const log = deps.log ?? logger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const baseUrl = deps.baseUrl.replace(/\/+$/, '');

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const url = `${baseUrl}${path}`;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: deps.token,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const message = err instanceof Error ? err.message : String(err);
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      log.warn({ method, path, error: `${name}: ${message}` }, 'enduser client request failed');
      throw timeout
        ? new EnduserClientError('timeout', MSG_TIMEOUT, undefined, message)
        : new EnduserClientError('network', MSG_UNREACHABLE, undefined, message);
    }
    const json: unknown = await res.json().catch(() => null);
    log.debug({ method, path, status: res.status, ms: Date.now() - started }, 'enduser client');
    if (res.status === 401 || res.status === 503) {
      throw new EnduserClientError('unauthorized', MSG_UNAUTHORIZED, res.status);
    }
    return { status: res.status, json };
  }

  function httpError(status: number, json: unknown): EnduserClientError {
    const detail = isRecord(json) && typeof json.error === 'string' ? json.error : undefined;
    return new EnduserClientError('http', `${MSG_UNREACHABLE}（HTTP ${status}）`, status, detail);
  }

  return {
    async listOpenTickets(limit = 10) {
      const { status, json } = await call('GET', `/internal/tickets?status=open&limit=${limit}`);
      if (status !== 200) throw httpError(status, json);
      if (!isRecord(json) || !Array.isArray(json.tickets)) {
        throw new EnduserClientError('bad_response', MSG_BAD, status);
      }
      return json.tickets as TicketSummary[];
    },
    async getTicket(id) {
      const { status, json } = await call('GET', `/internal/tickets/${id}`);
      if (status === 404) throw new EnduserClientError('not_found', MSG_NOT_FOUND, 404);
      if (status !== 200) throw httpError(status, json);
      if (!isRecord(json) || !isRecord(json.ticket)) {
        throw new EnduserClientError('bad_response', MSG_BAD, status);
      }
      return json.ticket as unknown as TicketDetail;
    },
    async replyTicket(id, text, by) {
      const { status, json } = await call('POST', '/internal/reply', { ticketId: id, text, by });
      if (status === 404) throw new EnduserClientError('not_found', MSG_NOT_FOUND, 404);
      if (status === 409) throw new EnduserClientError('closed', MSG_CLOSED, 409);
      if (status === 502) {
        const detail = isRecord(json) && typeof json.error === 'string' ? json.error : undefined;
        throw new EnduserClientError('push_failed', MSG_PUSH_FAILED, 502, detail);
      }
      if (status !== 200) throw httpError(status, json);
      if (!isRecord(json) || json.ok !== true) {
        throw new EnduserClientError('bad_response', MSG_BAD, status);
      }
      const userId = typeof json.userId === 'string' ? json.userId : '';
      return { ok: true, pushed: true, ticketId: id, userIdShort: shortUserId(userId) };
    },
    async closeTicket(id) {
      const { status, json } = await call('POST', `/internal/tickets/${id}/close`);
      if (status === 404) throw new EnduserClientError('not_found', MSG_NOT_FOUND, 404);
      if (status !== 200) throw httpError(status, json);
    },
  };
}

/** The admin-facing reason for any failure. */
export function enduserErrorMessage(err: unknown): string {
  if (err instanceof EnduserClientError) return err.userMessage;
  return MSG_UNREACHABLE;
}
