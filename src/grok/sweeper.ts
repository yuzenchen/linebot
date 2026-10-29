import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { GrokTaskRow } from '../db/grokTasks.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { adminServiceQuestionNotice, adminTriageNotice, texts } from '../texts.js';

export interface GrokTaskSweeperDeps {
  repos: Pick<Repos, 'grokTasks'>;
  replier: Pick<Replier, 'push'>;
  config: Pick<Config, 'ADMIN_LINE_USER_ID'>;
  /** Default 60000. */
  intervalMs?: number;
  now?: () => Date;
  log?: Logger;
}

function payloadText(row: GrokTaskRow): string {
  try {
    const v = JSON.parse(row.payload ?? 'null') as { text?: unknown } | null;
    return typeof v?.text === 'string' ? v.text : '';
  } catch {
    return '';
  }
}

/**
 * Marks open grok_tasks whose `expires_at` passed as `expired` and falls back to humans:
 * service_question → user `grokTimeout` + admin notice; incident_triage → admin notice;
 * summarize_suggestion → log only.
 */
export function startGrokTaskSweeper(deps: GrokTaskSweeperDeps) {
  const { repos, replier } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const admin = deps.config.ADMIN_LINE_USER_ID;
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
    const text = payloadText(row);
    if (row.type === 'service_question' && row.user_id) {
      await push(row.user_id, texts.grokTimeout, 'grok_timeout', meta);
      if (admin) {
        await push(
          admin,
          adminServiceQuestionNotice({ userId: row.user_id, text }),
          'admin_service_question',
          meta,
        );
      }
    } else if (row.type === 'incident_triage' && admin) {
      let incidentId = 0;
      try {
        incidentId = (JSON.parse(row.payload ?? '{}') as { incidentId?: number }).incidentId ?? 0;
      } catch {
        // keep 0
      }
      await push(
        admin,
        adminTriageNotice({ incidentId, text: '專人系統逾時未回覆分析結果。' }),
        'admin_triage',
        meta,
      );
    }
  }

  let sweeping = false;
  /** One pass; never throws. Returns the number of tasks expired. */
  async function sweepOnce(): Promise<number> {
    if (sweeping) return 0;
    sweeping = true;
    try {
      const rows = repos.grokTasks.listExpired(now());
      for (const row of rows) await expire(row);
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
