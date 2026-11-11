/**
 * §8 monthly payroll schedule. Instead of a one-shot cron, a periodic check (on start and every
 * `intervalMs`) runs last month's payroll when
 *   - Taipei now is on/after day 1 of the current month at `STAFF_PAYROLL_CRON_HOUR`, and
 *   - no `payroll_runs` row triggered by the schedule exists for that month yet.
 * That makes it restart-safe (a container down at 09:00 catches up on its next check later in
 * the month) and idempotent (the schedule row is written before anything is sent, so a crash
 * mid-send never double-sends). Manual `結算` runs do not count as the scheduled run.
 */
import type { Logger } from 'pino';
import { now as clockNow } from '../db/time.js';
import type { PayrollReport, PayrollReporter } from './payrollReport.js';
import { PAYROLL_SCHEDULE_ACTOR, type StaffService } from './service.js';
import { type Month, previousMonth, taipeiDate, taipeiInstant, taipeiMonth } from './time.js';

export const PAYROLL_CHECK_INTERVAL_MS = 5 * 60_000;

/** The month the schedule should have settled by `now`, or null before day 1 `hour`. */
export function dueScheduleMonth(now: Date, hour: number): Month | null {
  const month = taipeiMonth(now);
  const firstDay = taipeiDate(now).slice(0, 8) + '01';
  if (now.getTime() < taipeiInstant(firstDay, hour).getTime()) return null;
  return previousMonth(month);
}

export interface PayrollSchedulerDeps {
  service: Pick<StaffService, 'repo'>;
  reporter: PayrollReporter;
  /** STAFF_PAYROLL_CRON_HOUR. */
  hour: number;
  intervalMs?: number;
  now?: () => Date;
  log: Logger;
}

export function startPayrollScheduler(deps: PayrollSchedulerDeps) {
  const { service, reporter, hour, log } = deps;
  const now = deps.now ?? clockNow;
  const intervalMs = deps.intervalMs ?? PAYROLL_CHECK_INTERVAL_MS;
  let running = false;

  /** One check; never throws. Returns the report when it ran payroll. */
  async function checkOnce(): Promise<PayrollReport | null> {
    if (running) return null;
    running = true;
    try {
      const at = now();
      const month = dueScheduleMonth(at, hour);
      if (!month) return null;
      const done = service.repo.payrollRuns
        .listForMonth(month)
        .some((r) => r.triggered_by === PAYROLL_SCHEDULE_ACTOR);
      if (done) return null;
      log.info({ month }, 'scheduled payroll run starting');
      return await reporter.run(month, PAYROLL_SCHEDULE_ACTOR, at, {
        notifyEmployees: true,
        skipWhenEmpty: true,
      });
    } catch (err) {
      log.error({ err }, 'scheduled payroll check failed');
      return null;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void checkOnce(), intervalMs);
  timer.unref();
  const initial = checkOnce();

  return {
    checkOnce,
    /** The check started together with the scheduler (tests await it). */
    initial,
    stop(): void {
      clearInterval(timer);
    },
  };
}

export type PayrollScheduler = ReturnType<typeof startPayrollScheduler>;
