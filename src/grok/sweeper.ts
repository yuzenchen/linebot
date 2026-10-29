import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { GrokTaskRow } from '../db/grokTasks.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { type AdminNotifier, createAdminNotifier } from '../notify/adminNotifier.js';
import { adminServiceQuestionNotice, adminTriageNotice, texts } from '../texts.js';
import type { TicketService } from '../tickets/service.js';

export const DEFAULT_TICKET_AUTO_CLOSE_MS = 86400000;

export interface GrokTaskSweeperDeps {
  /** With `tickets`, each sweep also auto-closes answered tickets (T15). */
  repos: Pick<Repos, 'grokTasks'> & Partial<Pick<Repos, 'tickets'>>;
  replier: Pick<Replier, 'push'>;
  config: Pick<Config, 'ADMIN_LINE_USER_ID'> &
    Partial<Pick<Config, 'ADMIN_NOTIFY_URL' | 'INTERNAL_NOTIFY_TOKEN' | 'TICKET_AUTO_CLOSE_MS'>>;
  /** Defaults to one built from `config` + `replier`. */
  adminNotifier?: AdminNotifier;
  /** T15: when present, an expired service_question opens a ticket instead of a plain notice. */
  tickets?: TicketService;
  /** Default 60000. */
  intervalMs?: number;
  now?: () => Date;
  log?: Logger;
}

type PayloadContext = { role: 'user' | 'assistant'; text: string }[];

function payloadOf(row: GrokTaskRow): { text: string; context: PayloadContext } {
  try {
    const v = JSON.parse(row.payload ?? 'null') as { text?: unknown; context?: unknown } | null;
    return {
      text: typeof v?.text === 'string' ? v.text : '',
      context: Array.isArray(v?.context) ? (v.context as PayloadContext) : [],
    };
  } catch {
    return { text: '', context: [] };
  }
}

/**
 * Marks open grok_tasks whose `expires_at` passed as `expired` and falls back to humans:
 * service_question → user `grokTimeout` + ticket (or admin notice); incident_triage → admin
 * notice; summarize_suggestion → log only. Each pass also auto-closes idle answered tickets.
 */
export function startGrokTaskSweeper(deps: GrokTaskSweeperDeps) {
  const { repos, replier } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const notifier =
    deps.adminNotifier ?? createAdminNotifier({ config: deps.config, replier, log: deps.log });
  const intervalMs = deps.intervalMs ?? 60000;

  async function push(userId: string, text: string, reason: string, meta: object) {
    try {
      await replier.push(userId, [text], reason);
    } catch (err) {
      log.error({ ...meta, reason, err }, 'grok sweeper push failed');
    }
  }

  async function expire(row: GrokTaskRow): Promise<void> {
    const meta = { taskId: row.id, type: row.type, from: row.status, expiresAt: row.expires_at };
    repos.grokTasks.setStatus(row.id, 'expired');
    log.warn(meta, 'grok task expired');
    const { text, context } = payloadOf(row);
    if (row.type === 'service_question' && row.user_id) {
      await push(row.user_id, texts.grokTimeout, 'grok_timeout', meta);
      if (deps.tickets) {
        await deps.tickets.open({
          userId: row.user_id,
          source: 'grok_timeout',
          question: text,
          context,
          grokTaskId: row.id,
        });
        return;
      }
      await notifier.notify({
        kind: 'service_question',
        text: adminServiceQuestionNotice({ userId: row.user_id, text }),
        meta,
      });
    } else if (row.type === 'incident_triage') {
      let incidentId = 0;
      try {
        incidentId = (JSON.parse(row.payload ?? '{}') as { incidentId?: number }).incidentId ?? 0;
      } catch {
        // keep 0
      }
      await notifier.notify({
        kind: 'triage',
        text: adminTriageNotice({ incidentId, text: '專人系統逾時未回覆分析結果。' }),
        meta,
      });
    }
  }

  function autoCloseTickets(): void {
    if (!repos.tickets) return;
    const olderThanMs = deps.config.TICKET_AUTO_CLOSE_MS ?? DEFAULT_TICKET_AUTO_CLOSE_MS;
    const closed = repos.tickets.autoClose(now(), olderThanMs);
    if (closed > 0) log.info({ closed, olderThanMs }, 'answered tickets auto-closed');
  }

  let sweeping = false;
  /** One pass; never throws. Returns the number of tasks expired (tickets closed are logged). */
  async function sweepOnce(): Promise<number> {
    if (sweeping) return 0;
    sweeping = true;
    try {
      const rows = repos.grokTasks.listExpired(now());
      for (const row of rows) await expire(row);
      autoCloseTickets();
      return rows.length;
    } catch (err) {
      log.error({ err }, 'grok sweeper failed');
      return 0;
    } finally {
      sweeping = false;
    }
  }

  const timer = setInterval(() => void sweepOnce(), intervalMs);
  timer.unref();

  return {
    sweepOnce,
    stop(): void {
      clearInterval(timer);
    },
  };
}

export type GrokTaskSweeper = ReturnType<typeof startGrokTaskSweeper>;
