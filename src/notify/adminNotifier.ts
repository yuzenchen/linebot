import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';

export type AdminNoticeKind =
  'incident' | 'handoff' | 'forward' | 'service_question' | 'triage' | 'grok_timeout' | 'other';

export interface AdminNotice {
  kind: AdminNoticeKind;
  text: string;
  meta?: Record<string, unknown>;
}

export type AdminNotifyResult = 'relayed' | 'pushed' | 'logged';

export interface AdminNotifier {
  /** Never rejects. */
  notify(n: AdminNotice): Promise<AdminNotifyResult>;
}

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Fallback `push_log` reasons; kept identical to the pre-T13 direct pushes. */
export function fallbackReason(kind: AdminNoticeKind): string {
  return `admin_${kind}`;
}

export interface AdminNotifierDeps {
  /** Relay fields are optional so handler tests can pass only `ADMIN_LINE_USER_ID`. */
  config: Pick<Config, 'ADMIN_LINE_USER_ID'> &
    Partial<Pick<Config, 'ADMIN_NOTIFY_URL' | 'INTERNAL_NOTIFY_TOKEN'>>;
  replier: Pick<Replier, 'push'>;
  fetchImpl?: typeof fetch;
  /** Default 5000. */
  timeoutMs?: number;
  log?: Logger;
}

/**
 * SPEC-ADMIN §11: prefer POSTing the notice to the admin bot's `/internal/notify`; on any relay
 * failure fall back to a direct push to `ADMIN_LINE_USER_ID`, else only log.
 */
export function createAdminNotifier(deps: AdminNotifierDeps): AdminNotifier {
  const { config, replier } = deps;
  const log = deps.log ?? logger;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5000;

  async function relay(n: AdminNotice, url: string, token: string): Promise<boolean> {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_TOKEN_HEADER]: token },
        body: JSON.stringify({
          kind: n.kind,
          text: n.text,
          meta: n.meta,
          sentAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return true;
      log.warn({ ...n.meta, kind: n.kind, status: res.status }, 'admin notice relay rejected');
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.warn({ ...n.meta, kind: n.kind, error }, 'admin notice relay failed');
    }
    return false;
  }

  return {
    async notify(n) {
      const url = config.ADMIN_NOTIFY_URL;
      const token = config.INTERNAL_NOTIFY_TOKEN;
      if (url && token && (await relay(n, url, token))) {
        log.info({ ...n.meta, kind: n.kind, result: 'relayed' }, 'admin notice relayed');
        return 'relayed';
      }
      const reason = fallbackReason(n.kind);
      const adminId = config.ADMIN_LINE_USER_ID;
      if (adminId) {
        try {
          await replier.push(adminId, [n.text], reason);
          log.info({ ...n.meta, kind: n.kind, result: 'pushed' }, 'admin notice pushed directly');
          return 'pushed';
        } catch (err) {
          log.error({ ...n.meta, kind: n.kind, reason, err }, 'admin push failed');
          return 'logged';
        }
      }
      log.warn(
        { ...n.meta, kind: n.kind, reason, notice: n.text, result: 'logged' },
        'ADMIN_LINE_USER_ID not set; admin notice not sent',
      );
      return 'logged';
    },
  };
}
