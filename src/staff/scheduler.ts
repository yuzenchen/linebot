/**
 * §8 monthly payroll schedule. Instead of a one-shot cron, a periodic check (on start and every
 * `intervalMs`) runs last month's payroll when
 *   - Taipei now is on/after day 1 of the current month at `STAFF_PAYROLL_CRON_HOUR`, and
 *   - no `payroll_runs` row triggered by the schedule exists for that month yet.
 * That makes it restart-safe (a container down at 09:00 catches up on its next check later in
 * the month) and idempotent (the schedule row is written before anything is sent, so a crash
 * mid-send never double-sends). Manual `結算` runs do not count as the scheduled run.
 *
 * §15.5 daily pending-correction reminder, same pattern: from `STAFF_PAYROLL_CRON_HOUR` each
 * Taipei day, the first check records a `staff_reminders` row for the date (before sending) and
 * DMs every admin one merged message when requests have been pending for more than 3 days, or
 * when tomorrow is payday and the payroll month still has pending requests. Nothing qualifying →
 * the row is still recorded (`sent_at` null) and nothing is sent, so a day is checked once.
 * Earlier days are never caught up; requests never expire.
 */
import type { Logger } from 'pino';
import { now as clockNow } from '../db/time.js';
import { staffCorrectionReminder, type StaffReminderItem } from '../texts.js';
import { displayCorrectionId } from './ids.js';
import type { StaffMessenger } from './messenger.js';
import type { PayrollReport, PayrollReporter } from './payrollReport.js';
import type { CorrectionRow, EmployeeRow } from './repo.js';
import { PAYROLL_SCHEDULE_ACTOR, type StaffService } from './service.js';
import {
  addDays,
  type LocalDate,
  type Month,
  previousMonth,
  taipeiDate,
  taipeiInstant,
  taipeiMonth,
} from './time.js';

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

// ------------------------------------------------------------------ §15.5 reminder

/** Requests pending longer than this many days are listed in the daily reminder. */
export const REMINDER_STALE_DAYS = 3;
const DAY_MS = 86_400_000;

export interface ReminderPlan {
  date: LocalDate;
  /** Pending longer than `REMINDER_STALE_DAYS` (by `created_at`), oldest id first. */
  stale: CorrectionRow[];
  /**
   * Set on the day before payday (tomorrow is day `STAFF_PAYDAY`): the pending requests whose
   * `at` falls in the month paid tomorrow, i.e. the month before tomorrow's.
   */
  payday: { date: LocalDate; month: Month; requests: CorrectionRow[] } | null;
}

/** The Taipei date whose reminder is due at `now`, or null before `hour` that day. */
export function dueReminderDate(now: Date, hour: number): LocalDate | null {
  const today = taipeiDate(now);
  return now.getTime() < taipeiInstant(today, hour).getTime() ? null : today;
}

/** Pure selection for one day's reminder from the pending requests. */
export function planReminder(
  date: LocalDate,
  now: Date,
  payday: number,
  pending: CorrectionRow[],
): ReminderPlan {
  const open = pending.filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id);
  const stale = open.filter(
    (r) => now.getTime() - Date.parse(r.created_at) > REMINDER_STALE_DAYS * DAY_MS,
  );
  const tomorrow = addDays(date, 1);
  if (Number(tomorrow.slice(8, 10)) !== payday) return { date, stale, payday: null };
  const month = previousMonth(tomorrow.slice(0, 7));
  return {
    date,
    stale,
    payday: {
      date: tomorrow,
      month,
      requests: open.filter((r) => taipeiMonth(new Date(r.at)) === month),
    },
  };
}

export interface ReminderSchedulerDeps {
  service: Pick<StaffService, 'repo'>;
  messenger: Pick<StaffMessenger, 'notifyAdmins'>;
  /** STAFF_PAYROLL_CRON_HOUR. */
  hour: number;
  /** STAFF_PAYDAY. */
  payday: number;
  intervalMs?: number;
  now?: () => Date;
  log: Logger;
}

export interface ReminderCheck {
  date: LocalDate;
  /** False when nothing qualified (the day is recorded, nothing sent). */
  sent: boolean;
  lines: string[];
}

export function startReminderScheduler(deps: ReminderSchedulerDeps) {
  const { service, messenger, hour, payday, log } = deps;
  const now = deps.now ?? clockNow;
  const intervalMs = deps.intervalMs ?? PAYROLL_CHECK_INTERVAL_MS;
  let running = false;

  function item(r: CorrectionRow, employees: Map<number, EmployeeRow>): StaffReminderItem {
    return {
      displayId: displayCorrectionId(r.id),
      name: employees.get(r.employee_id)?.name ?? '',
      at: r.at,
      kind: r.kind,
      endAt: r.end_at,
    };
  }

  /** One check; never throws. Returns what was recorded for today, or null when nothing ran. */
  async function checkOnce(): Promise<ReminderCheck | null> {
    if (running) return null;
    running = true;
    try {
      const at = now();
      const date = dueReminderDate(at, hour);
      if (!date) return null;
      const { repo } = service;
      if (repo.reminders.get(date)) return null;
      const plan = planReminder(date, at, payday, repo.corrections.listPending());
      const employees = new Map(repo.employees.listAll().map((e) => [e.id, e]));
      const lines = staffCorrectionReminder({
        staleDays: REMINDER_STALE_DAYS,
        stale: plan.stale.map((r) => item(r, employees)),
        payday: plan.payday && {
          date: plan.payday.date,
          month: plan.payday.month,
          items: plan.payday.requests.map((r) => item(r, employees)),
        },
      });
      const sent = lines.length > 0;
      const content = {
        stale: plan.stale.map((r) => displayCorrectionId(r.id)),
        payday: plan.payday && {
          date: plan.payday.date,
          month: plan.payday.month,
          requests: plan.payday.requests.map((r) => displayCorrectionId(r.id)),
        },
        lines,
      };
      // Recorded before sending: a crash mid-send or a restart never sends the day twice.
      if (!repo.reminders.tryInsert(date, sent ? at : null, content)) return null;
      if (sent) {
        await messenger.notifyAdmins(lines, 'staff_correction_reminder');
        log.info(
          { date, stale: content.stale.length, payday: content.payday?.requests.length ?? 0 },
          'correction reminder sent',
        );
      }
      return { date, sent, lines };
    } catch (err) {
      log.error({ err }, 'correction reminder check failed');
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

export type ReminderScheduler = ReturnType<typeof startReminderScheduler>;
