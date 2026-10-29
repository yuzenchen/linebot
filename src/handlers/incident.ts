import type { Logger } from 'pino';
import type { ContextMessage } from '../classifier/index.js';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { HealthChecker, HealthResult } from '../health/check.js';
import type { JobQueue } from '../jobs/queue.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import { type AdminNotifier, createAdminNotifier } from '../notify/adminNotifier.js';
import { adminIncidentNotice, texts } from '../texts.js';
import type { TextMessageContext } from './dispatcher.js';

/** Repeated reports with the same non-healthy status inside this window do not re-notify admin. */
export const INCIDENT_MERGE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RAW_BODY = 500;

export interface IncidentDeps {
  repos: Pick<Repos, 'incidents'>;
  replier: Pick<Replier, 'push'>;
  health: HealthChecker;
  jobs: Pick<JobQueue, 'enqueue'>;
  config: Pick<Config, 'ADMIN_LINE_USER_ID' | 'GROK_WEBHOOK_URL'> &
    Partial<Pick<Config, 'ADMIN_NOTIFY_URL' | 'INTERNAL_NOTIFY_TOKEN'>>;
  /** Defaults to one built from `config` + `replier`. */
  adminNotifier?: AdminNotifier;
  now?: () => Date;
  log?: Logger;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Compact JSON of a health result for `incidents.health_raw` (body capped at 500 chars). */
export function healthRaw(h: HealthResult): string {
  let body: string | undefined;
  if (h.body !== undefined) {
    try {
      body = truncate(JSON.stringify(h.body), MAX_RAW_BODY);
    } catch {
      body = truncate(String(h.body), MAX_RAW_BODY);
    }
  }
  return JSON.stringify({
    httpStatus: h.httpStatus,
    latencyMs: h.latencyMs,
    checkedAt: h.checkedAt,
    error: h.error,
    body,
  });
}

/** SPEC 5.4 steps 1–5. Returns the messages to send to the user; side effects: incidents row, admin push, triage job. */
export function createIncidentHandler(deps: IncidentDeps) {
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const notifier =
    deps.adminNotifier ??
    createAdminNotifier({ config: deps.config, replier: deps.replier, log: deps.log });

  return async function handleIncident(
    ctx: TextMessageContext,
    context: ContextMessage[] = [],
  ): Promise<string[]> {
    const { userId, text } = ctx;
    const h = await deps.health.check();
    const incidentId = deps.repos.incidents.insert({
      userId,
      text,
      healthStatus: h.status,
      healthRaw: healthRaw(h),
    });
    const triagePayload = {
      userId,
      incidentId,
      messageId: ctx.messageId,
      text,
      health: h,
      context,
    };

    if (h.status === 'healthy') {
      if (deps.config.GROK_WEBHOOK_URL) deps.jobs.enqueue('incident_triage', triagePayload);
      log.info({ userId, incidentId, health: h.status }, 'incident report while healthy');
      return [texts.incidentHealthyFollowUp];
    }

    const recent = deps.repos.incidents.recentByStatus(h.status, INCIDENT_MERGE_WINDOW_MS, now());
    const merged = recent.some((r) => r.id !== incidentId && r.admin_notified === 1);
    const notice = adminIncidentNotice({ userId, text, health: h });
    if (merged) {
      log.info({ userId, incidentId, health: h.status }, 'incident merged; admin not re-notified');
    } else {
      const result = await notifier.notify({
        kind: 'incident',
        text: notice,
        meta: { userId, incidentId, health: h.status },
      });
      if (result !== 'logged') {
        deps.repos.incidents.markAdminNotified(incidentId);
        log.info({ userId, incidentId, health: h.status, result }, 'admin notified of incident');
      }
    }
    deps.jobs.enqueue('incident_triage', triagePayload);
    return [texts.incidentConfirmed];
  };
}

export type IncidentHandler = ReturnType<typeof createIncidentHandler>;
