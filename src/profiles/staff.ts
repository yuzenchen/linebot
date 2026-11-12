import { createStaffHandlers } from '../handlers/staff.js';
import { createStaffMessenger } from '../staff/messenger.js';
import { createPayrollReporter } from '../staff/payrollReport.js';
import {
  type PayrollScheduler,
  type ReminderScheduler,
  startPayrollScheduler,
  startReminderScheduler,
} from '../staff/scheduler.js';
import { createStaffService } from '../staff/service.js';
import { staffTexts } from '../texts.js';
import type { BotProfile, Shared } from './types.js';

/**
 * Employee punch-clock / payroll bot (SPEC-STAFF). Uses only LINE + SQLite: no eshop, Anthropic,
 * Grok, job handlers or extra routes. `start` begins the monthly payroll check (§8) and the daily
 * pending-correction reminder (§15.5).
 */
export function createStaffProfile(shared: Shared, opts: { now?: () => Date } = {}): BotProfile {
  const { config, db, repos, replier, logger } = shared;
  const service = createStaffService(db, {
    minHourlyWage: config.STAFF_MIN_HOURLY_WAGE,
    maxShiftHours: config.STAFF_MAX_SHIFT_HOURS,
  });
  const messenger = createStaffMessenger({
    replier,
    repos,
    adminUserIds: config.STAFF_ADMIN_USER_IDS,
    log: logger,
  });
  const reporter = createPayrollReporter({
    service,
    messenger,
    payday: config.STAFF_PAYDAY,
    log: logger,
  });
  const { handleText, handleGroupText } = createStaffHandlers({
    service,
    reporter,
    replier,
    repos,
    config,
    now: opts.now,
    log: logger,
  });
  let scheduler: PayrollScheduler | undefined;
  let reminders: ReminderScheduler | undefined;

  return {
    name: 'staff',
    handleText,
    handleGroupText,
    welcomeText: () => staffTexts.welcome,
    start: () => {
      if (config.STAFF_GROUP_IDS.length === 0) {
        logger.warn('STAFF_GROUP_IDS is empty: group punches are off, groupIds are only logged');
      }
      scheduler = startPayrollScheduler({
        service,
        reporter,
        hour: config.STAFF_PAYROLL_CRON_HOUR,
        now: opts.now,
        log: logger,
      });
      reminders = startReminderScheduler({
        service,
        messenger,
        hour: config.STAFF_PAYROLL_CRON_HOUR,
        payday: config.STAFF_PAYDAY,
        now: opts.now,
        log: logger,
      });
      logger.info(
        { hour: config.STAFF_PAYROLL_CRON_HOUR },
        'staff payroll and reminder schedulers started',
      );
      return Promise.all([scheduler.initial, reminders.initial]).then(() => undefined);
    },
    stop: async () => {
      scheduler?.stop();
      reminders?.stop();
    },
  };
}
