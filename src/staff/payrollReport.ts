/**
 * §8 payroll delivery: runs `runPayroll` (one new `payroll_runs` row per run), optionally DMs
 * each employee their own line, then sends the summary to the admins. The group never gets
 * pay data.
 */
import type { Logger } from 'pino';
import { staffPayMessage, staffPayrollSummary } from '../texts.js';
import type { StaffMessenger } from './messenger.js';
import type { PayrollEmployeeLine } from './payroll.js';
import type { PayrollRun, StaffService } from './service.js';
import { type Month, taipeiMonth } from './time.js';

export interface PayrollReportOptions {
  /** DM each employee their own pay line. */
  notifyEmployees: boolean;
  /** Admin who asked (`結算 …`): answered via `replyToken`, other admins get a push. */
  requester?: { userId: string; replyToken: string | undefined };
  /**
   * Schedule only: record the run but send nothing when there is no employee and nothing
   * pending (e.g. the very first deployment).
   */
  skipWhenEmpty?: boolean;
}

export interface PayrollReport extends PayrollRun {
  /** Employee ids whose DM could not be delivered (「未加好友，未通知」). */
  notNotified: number[];
  /** Employee ids that were DMed. */
  notified: number[];
  sent: boolean;
}

export interface PayrollReporterDeps {
  service: Pick<StaffService, 'runPayroll'>;
  messenger: StaffMessenger;
  payday: number;
  log: Logger;
}

/** Employees with nothing in the month (no shift at all) get no DM. */
function hasActivity(line: PayrollEmployeeLine): boolean {
  return line.shiftCount > 0 || line.openShifts.length > 0 || line.unpricedShifts.length > 0;
}

export function createPayrollReporter(deps: PayrollReporterDeps) {
  const { service, messenger, payday, log } = deps;

  async function run(
    month: Month,
    triggeredBy: string,
    now: Date,
    opts: PayrollReportOptions,
  ): Promise<PayrollReport> {
    const run = service.runPayroll(month, triggeredBy, now);
    const { result } = run;
    const notified: number[] = [];
    const notNotified: number[] = [];

    if (opts.skipWhenEmpty && result.employees.length === 0 && !result.hasPending) {
      log.info({ month, runId: run.runId }, 'payroll run empty, nothing sent');
      return { ...run, notified, notNotified, sent: false };
    }

    if (opts.notifyEmployees) {
      const current = month === taipeiMonth(now);
      for (const line of result.employees) {
        if (!hasActivity(line)) continue;
        const text = staffPayMessage(line, month, payday, current);
        if (await messenger.dm(line.userId, [text], 'staff_payroll_employee')) {
          notified.push(line.employeeId);
        } else {
          notNotified.push(line.employeeId);
        }
      }
    }

    const lines = staffPayrollSummary(result, payday, new Set(notNotified));
    const requester = opts.requester;
    if (requester) {
      try {
        await messenger.answer(requester.replyToken, requester.userId, lines, 'staff_payroll');
      } catch (err) {
        log.error({ month, err }, 'payroll summary to requester failed');
      }
    }
    await messenger.notifyAdmins(lines, 'staff_payroll', requester?.userId);
    log.info(
      { month, runId: run.runId, triggeredBy: triggeredBy === 'schedule' ? 'schedule' : 'admin' },
      'payroll run sent',
    );
    return { ...run, notified, notNotified, sent: true };
  }

  return { run };
}

export type PayrollReporter = ReturnType<typeof createPayrollReporter>;
