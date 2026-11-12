import { createStaffHandlers } from '../handlers/staff.js';
import { createStaffBackup, type StaffBackup } from '../staff/backup.js';
import { createStaffMessenger } from '../staff/messenger.js';
import { createPayrollReporter } from '../staff/payrollReport.js';
import {
  type BackupScheduler,
  type PayrollScheduler,
  type ReminderScheduler,
  startBackupScheduler,
  startPayrollScheduler,
  startReminderScheduler,
} from '../staff/scheduler.js';
import { createStaffService } from '../staff/service.js';
import { staffTexts } from '../texts.js';
import type { BotProfile, Shared } from './types.js';

/**
 * Employee punch-clock / payroll bot (SPEC-STAFF). Uses only LINE + SQLite: no eshop, Anthropic,
 * Grok, job handlers or extra routes. `start` begins the monthly payroll check (§8), the daily
 * pending-correction reminder (§15.5) and, when STAFF_BACKUP_SHEET_URL and STAFF_BACKUP_TOKEN are
 * both set, the daily Google Sheets backup at STAFF_BACKUP_HOUR (§16). `opts.fetch` replaces the backup's HTTP client
 * in tests.
 */
export function createStaffProfile(
  shared: Shared,
  opts: { now?: () => Date; fetch?: typeof fetch } = {},
): BotProfile {
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
  const backupUrl = config.STAFF_BACKUP_SHEET_URL;
  const backupToken = config.STAFF_BACKUP_TOKEN;
  const backup: StaffBackup | undefined =
    backupUrl && backupToken
      ? createStaffBackup({
          db,
          repo: service.repo,
          url: backupUrl,
          token: backupToken,
          fetch: opts.fetch,
          now: opts.now,
          log: logger,
        })
      : undefined;
  const { handleText, handleGroupText } = createStaffHandlers({
    service,
    reporter,
    backup,
    replier,
    repos,
    config,
    now: opts.now,
    log: logger,
  });
  let scheduler: PayrollScheduler | undefined;
  let reminders: ReminderScheduler | undefined;
  let backups: BackupScheduler | undefined;

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
      if (backup) {
        backups = startBackupScheduler({
          service,
          backup,
          messenger,
          hour: config.STAFF_BACKUP_HOUR,
          now: opts.now,
          log: logger,
        });
      } else if (backupUrl || backupToken) {
        logger.warn(
          'staff backup is off: STAFF_BACKUP_SHEET_URL and STAFF_BACKUP_TOKEN must both be set',
        );
      }
      logger.info(
        { hour: config.STAFF_PAYROLL_CRON_HOUR, backup: backup !== undefined },
        'staff payroll, reminder and backup schedulers started',
      );
      return Promise.all([scheduler.initial, reminders.initial, backups?.initial]).then(
        () => undefined,
      );
    },
    stop: async () => {
      scheduler?.stop();
      reminders?.stop();
      backups?.stop();
    },
  };
}
