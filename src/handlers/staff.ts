/**
 * Staff bot conversation (SPEC-STAFF §3–9, §15). Fixed-format commands only (no model):
 *
 * - Group / room (only ids in STAFF_GROUP_IDS; others are logged and ignored): 註冊, 上班, 下班,
 *   補卡, 取消. Any other text is ignored; 註冊 / 補卡 with bad arguments get a usage hint (a
 *   malformed 取消 stays silent: the word is common in chat).
 * - DM: employee commands (我的打卡, 我的薪資, 補卡, 取消, 說明) and, for STAFF_ADMIN_USER_IDS,
 *   the §9 / §15 / §16 admin commands. Admin commands from anyone else are treated as unknown.
 *
 * Notifications (requests → every admin, decisions and failed approvals → applicant with group
 * fallback) go through the messenger, which never throws; every handled message gets a fallback
 * reply on failure.
 */
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import { now as clockNow } from '../db/time.js';
import type { Replier } from '../line/replier.js';
import { logger } from '../logger.js';
import {
  type CommandKeyword,
  type CorrectionTime,
  parseStaffCommand,
  type StaffCommand,
} from '../staff/commands.js';
import { displayCorrectionId, displayEmployeeId, displayShiftId } from '../staff/ids.js';
import { createStaffMessenger } from '../staff/messenger.js';
import type { StaffBackup } from '../staff/backup.js';
import type { PayrollReporter } from '../staff/payrollReport.js';
import { backupFailureOutstanding } from '../staff/scheduler.js';
import type {
  CancelCorrectionOutcome,
  CorrectionInput,
  RequestCorrectionOutcome,
  StaffService,
} from '../staff/service.js';
import { type Month, taipeiDate, taipeiMonth } from '../staff/time.js';
import {
  staffAdminCorrectionApplied,
  staffAdminCorrectionNotice,
  staffAdminRegistrationNotice,
  staffAlreadyIn,
  staffAlreadyRegistered,
  staffApprovedCorrection,
  staffApprovedRegistration,
  staffBackupDone,
  staffBackupFailed,
  staffBelowMinimum,
  staffClockedIn,
  staffClockedOut,
  staffCorrectionAlreadyDecided,
  staffCorrectionApprovedDm,
  staffCorrectionCancelled,
  type StaffConflictView,
  staffCorrectionDecisionGroup,
  staffCorrectionDuplicate,
  staffCorrectionFailed,
  staffCorrectionFailedDm,
  staffCorrectionFailedGroup,
  staffCorrectionNotCancellable,
  staffCorrectionRejectedDm,
  staffCorrectionRequested,
  staffCorrectionTooLong,
  staffDisabled,
  staffEmployeeList,
  staffMyShiftsHeader,
  staffNoOpenShift,
  staffNotApproved,
  staffNotFound,
  staffNotPending,
  staffOverdue,
  staffPayMessage,
  staffPendingList,
  staffRegisterRequested,
  staffRegistrationApprovedGroup,
  staffRegistrationRejectedDm,
  staffRejectedCorrection,
  staffRejectedRegistration,
  staffSettledHint,
  staffShiftAlreadyDeleted,
  staffShiftDeleted,
  staffShiftEditDeleted,
  staffShiftEdited,
  staffShiftEditRefused,
  staffShiftRecords,
  staffShiftRecordsHeader,
  staffShiftsOnDay,
  staffStaleShiftNote,
  staffStatusUnchanged,
  staffStatusUpdated,
  staffTexts,
  staffWageSet,
} from '../texts.js';
import type { GroupTextContext, TextMessageContext } from './dispatcher.js';

/**
 * Keywords whose bad arguments get a usage hint in a group; other keywords there are ordinary
 * chat. 取消 works in a group but a malformed one is ignored (common word in chat).
 */
const GROUP_KEYWORDS = new Set(['註冊', '補卡']);
/** Keywords any DM user may use (malformed → usage); the rest are admin-only. */
const EMPLOYEE_DM_KEYWORDS = new Set(['補卡', '取消', '我的打卡', '我的薪資', '說明', '註冊']);
const EMPLOYEE_DM_TYPES = new Set<StaffCommand['type']>([
  'punch',
  'register',
  'correction',
  'cancelCorrection',
  'myShifts',
  'myPay',
  'help',
]);

function correctionInput(c: CorrectionTime): CorrectionInput {
  return c.kind === 'shift'
    ? { kind: 'shift', at: c.at, endAt: c.endAt }
    : { kind: c.kind, at: c.at };
}

function conflictView(
  s: { id: number; start_at: string; end_at: string | null } | null,
): StaffConflictView | null {
  return s ? { displayId: displayShiftId(s.id), startAt: s.start_at, endAt: s.end_at } : null;
}

/** §15.2 settled-month hint lines. */
function settledLines(months: Month[]): string[] {
  return months.map(staffSettledHint);
}

export interface StaffHandlerDeps {
  service: StaffService;
  reporter: PayrollReporter;
  /** §16 backup; undefined when STAFF_BACKUP_SHEET_URL / STAFF_BACKUP_TOKEN are not both set. */
  backup?: Pick<StaffBackup, 'run'>;
  replier: Pick<Replier, 'reply' | 'push' | 'replyOrPush'>;
  repos: Pick<Repos, 'users'>;
  config: Pick<
    Config,
    | 'STAFF_ADMIN_USER_IDS'
    | 'STAFF_GROUP_IDS'
    | 'STAFF_MAX_SHIFT_HOURS'
    | 'STAFF_MIN_HOURLY_WAGE'
    | 'STAFF_PAYDAY'
  >;
  now?: () => Date;
  log?: Logger;
}

export function createStaffHandlers(deps: StaffHandlerDeps) {
  const { service, reporter, config } = deps;
  const log = deps.log ?? logger;
  const now = deps.now ?? clockNow;
  const admins = new Set(config.STAFF_ADMIN_USER_IDS);
  const groups = new Set(config.STAFF_GROUP_IDS);
  const messenger = createStaffMessenger({
    replier: deps.replier,
    repos: deps.repos,
    adminUserIds: config.STAFF_ADMIN_USER_IDS,
    log,
  });

  // ------------------------------------------------------------------ shared pieces

  /** §6 request (group or DM): returns the requester's answer; notifies admins when new. */
  async function correctionRequest(
    outcome: RequestCorrectionOutcome,
    inGroup: boolean,
  ): Promise<string> {
    switch (outcome.kind) {
      case 'notRegistered':
        return inGroup ? staffTexts.notRegistered : staffTexts.notRegisteredDm;
      case 'pendingApproval':
        return staffTexts.pendingApproval;
      case 'disabled':
        return staffDisabled(outcome.employee.name);
      case 'future':
        return staffTexts.correctionFuture;
      case 'tooOld':
        return staffTexts.correctionTooOld;
      case 'tooLong':
        return staffCorrectionTooLong(config.STAFF_MAX_SHIFT_HOURS);
      case 'duplicate':
        return staffCorrectionDuplicate(
          displayCorrectionId(outcome.request.id),
          outcome.request.at,
          outcome.request.kind,
          outcome.request.end_at,
        );
      case 'requested': {
        const { request } = outcome;
        const id = displayCorrectionId(request.id);
        if (!outcome.resent) {
          await messenger.notifyAdmins(
            [
              staffAdminCorrectionNotice(
                id,
                outcome.employee.name,
                request.at,
                request.kind,
                request.end_at,
              ),
            ],
            'staff_correction_request',
          );
        }
        return staffCorrectionRequested(id, request.at, request.kind, request.end_at);
      }
    }
  }

  /** §15.3 `取消 R001` (group or DM). Admins are not notified. */
  function cancelAnswer(outcome: CancelCorrectionOutcome, requestId: number): string {
    const id = displayCorrectionId(requestId);
    switch (outcome.kind) {
      case 'notFound':
        return staffNotFound(id);
      case 'notPending':
        return staffCorrectionNotCancellable(id, outcome.request.status);
      case 'cancelled':
        return staffCorrectionCancelled(
          id,
          outcome.request.at,
          outcome.request.kind,
          outcome.request.end_at,
        );
    }
  }

  // ------------------------------------------------------------------ group

  async function groupCommand(
    cmd: StaffCommand,
    userId: string,
    groupId: string,
    at: Date,
  ): Promise<string[] | null> {
    switch (cmd.type) {
      case 'register': {
        const r = service.register(userId, cmd.name, groupId, at);
        switch (r.kind) {
          case 'requested': {
            const id = displayEmployeeId(r.employee.id);
            if (!r.resent) {
              await messenger.notifyAdmins(
                [staffAdminRegistrationNotice(id, r.employee.name)],
                'staff_registration_request',
              );
            }
            return [staffRegisterRequested(id, r.employee.name)];
          }
          case 'alreadyPending':
            return [staffTexts.pendingApproval];
          case 'alreadyActive':
            return [staffAlreadyRegistered(r.employee.name)];
          case 'disabled':
            return [staffDisabled(r.employee.name)];
        }
        break;
      }
      case 'punch': {
        const r = service.punch(userId, cmd.kind, at);
        switch (r.kind) {
          case 'notRegistered':
            return [staffTexts.notRegistered];
          case 'pendingApproval':
            return [staffTexts.pendingApproval];
          case 'disabled':
            return [staffDisabled(r.employee.name)];
          case 'clockedIn': {
            const text = staffClockedIn(r.employee.name, r.shift.start_at);
            return [r.staleShift ? `${text}\n${staffStaleShiftNote(r.staleShift.start_at)}` : text];
          }
          case 'alreadyIn':
            return [staffAlreadyIn(r.employee.name, r.shift.start_at)];
          case 'clockedOut':
            return [staffClockedOut(r.employee.name, r.shift.end_at!, r.minutes)];
          case 'noOpenShift':
            return [staffNoOpenShift(r.employee.name, taipeiDate(at))];
          case 'overdue':
            return [staffOverdue(r.employee.name, config.STAFF_MAX_SHIFT_HOURS)];
        }
        break;
      }
      case 'correction': {
        const r = service.requestCorrection(userId, correctionInput(cmd), groupId, at);
        return [await correctionRequest(r, true)];
      }
      case 'cancelCorrection':
        return [cancelAnswer(service.cancelCorrection(userId, cmd.requestId, at), cmd.requestId)];
      case 'malformed':
        return GROUP_KEYWORDS.has(cmd.keyword) ? [staffTexts.usage[cmd.keyword]] : null;
      default:
        return null; // admin / DM-only commands are ordinary chat in the group
    }
    return null;
  }

  async function handleGroupText(ctx: GroupTextContext): Promise<void> {
    if (!groups.has(ctx.groupId)) {
      log.info(
        { groupId: ctx.groupId, sourceType: ctx.sourceType },
        'staff: message from a group not in STAFF_GROUP_IDS (ignored)',
      );
      return;
    }
    if (!ctx.userId) return;
    const at = now();
    const cmd = parseStaffCommand(ctx.text, at);
    if (!cmd) return;
    let answered = false;
    try {
      const lines = await groupCommand(cmd, ctx.userId, ctx.groupId, at);
      if (!lines) return;
      answered = true;
      await messenger.answer(ctx.replyToken, ctx.groupId, lines, 'staff_group');
    } catch (err) {
      log.error({ groupId: ctx.groupId, type: cmd.type, err }, 'staff group command failed');
      await fallback(answered ? undefined : ctx.replyToken, ctx.groupId);
    }
  }

  // ------------------------------------------------------------------ DM

  function helpLines(userId: string): string[] {
    const isAdmin = admins.has(userId);
    if (!isAdmin) return [staffTexts.employeeHelp];
    const e = service.repo.employees.findByUserId(userId);
    const isEmployee = e !== undefined && e.status !== 'pending';
    return isEmployee
      ? [staffTexts.adminHelp, '', staffTexts.employeeHelp]
      : [staffTexts.adminHelp];
  }

  async function employeeDm(cmd: StaffCommand, userId: string, at: Date): Promise<string[]> {
    switch (cmd.type) {
      case 'punch':
        return [staffTexts.punchInGroup];
      case 'register':
        return [staffTexts.registerInGroup];
      case 'help':
        return helpLines(userId);
      case 'correction': {
        const r = service.requestCorrection(userId, correctionInput(cmd), null, at);
        return [await correctionRequest(r, false)];
      }
      case 'cancelCorrection':
        return [cancelAnswer(service.cancelCorrection(userId, cmd.requestId, at), cmd.requestId)];
      case 'myShifts':
      case 'myPay': {
        const r = service.myRecords(userId, cmd.month);
        if (r.kind === 'notRegistered') return [staffTexts.notRegisteredDm];
        if (r.kind === 'pendingApproval') return [staffTexts.pendingApproval];
        if (cmd.type === 'myShifts') {
          return staffShiftRecords(
            staffMyShiftsHeader(cmd.month, r.employee.name),
            r.shifts,
            false,
          );
        }
        const current = cmd.month === taipeiMonth(at);
        return [staffPayMessage(r.summary, cmd.month, config.STAFF_PAYDAY, current)];
      }
      default:
        return [staffTexts.unknownCommand];
    }
  }

  /** Admin commands; `null` = also send nothing more (payroll answers on its own). */
  async function adminDm(
    cmd: StaffCommand,
    userId: string,
    replyToken: string | undefined,
    at: Date,
  ): Promise<string[] | null> {
    const belowMin = (flag: boolean) =>
      flag ? [staffBelowMinimum(config.STAFF_MIN_HOURLY_WAGE)] : [];
    switch (cmd.type) {
      case 'listEmployees':
        return staffEmployeeList(
          service.listEmployees(at).map((i) => ({
            displayId: i.displayId,
            name: i.employee.name,
            status: i.employee.status,
            currentWage: i.currentWage,
          })),
        );
      case 'pending': {
        const p = service.pendingItems(at);
        return staffPendingList({
          registrations: p.registrations.map((e) => ({
            displayId: displayEmployeeId(e.id),
            name: e.name,
          })),
          corrections: p.corrections.map((c) => ({
            displayId: displayCorrectionId(c.request.id),
            name: c.employee.name,
            at: c.request.at,
            kind: c.request.kind,
            endAt: c.request.end_at,
          })),
          openShifts: p.openShifts.map((s) => ({
            shiftDisplayId: displayShiftId(s.shift.id),
            employeeDisplayId: displayEmployeeId(s.employee.id),
            name: s.employee.name,
            startAt: s.shift.start_at,
            overdue: s.overdue,
          })),
        });
      }
      case 'approveRegistration': {
        const id = displayEmployeeId(cmd.employeeId);
        const r = service.approveRegistration(userId, cmd.employeeId, cmd.hourlyWage, at);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'notPending') return [staffNotPending(id, r.employee.name)];
        if (r.employee.group_id) {
          await messenger.tryPush(
            r.employee.group_id,
            [staffRegistrationApprovedGroup(r.employee.name)],
            'staff_registration_approved',
          );
        }
        return [
          staffApprovedRegistration(id, r.employee.name, r.hourlyWage, r.effectiveFrom),
          ...belowMin(r.belowMinimum),
        ];
      }
      case 'rejectRegistration': {
        const id = displayEmployeeId(cmd.employeeId);
        const r = service.rejectRegistration(userId, cmd.employeeId, at);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'notPending') return [staffNotPending(id, r.employee.name)];
        // §4.5: the group is not told; a DM only reaches applicants who added the bot.
        await messenger.dm(
          r.employee.user_id,
          [staffRegistrationRejectedDm(r.employee.name)],
          'staff_registration_rejected',
        );
        return [staffRejectedRegistration(id, r.employee.name)];
      }
      case 'approveCorrection': {
        const id = displayCorrectionId(cmd.requestId);
        const r = service.approveCorrection(userId, cmd.requestId, at);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'alreadyDecided')
          return [staffCorrectionAlreadyDecided(id, r.request.status)];
        if (r.kind === 'failed') {
          // §15.1: the applicant hears about it too, through the same channel as an approval.
          const max = config.STAFF_MAX_SHIFT_HOURS;
          const conflict = conflictView(r.conflictShift);
          await messenger.dmOrGroup(
            r.employee.user_id,
            staffCorrectionFailedDm(id, r.reason, conflict, max),
            r.request.group_id,
            staffCorrectionFailedGroup(r.employee.name, id, r.reason, conflict, max),
            'staff_correction_failed',
          );
          return [failureText(id, r)];
        }
        for (const req of [r.request, r.pairedRequest]) {
          if (!req) continue;
          const reqId = displayCorrectionId(req.id);
          await messenger.dmOrGroup(
            r.employee.user_id,
            staffCorrectionApprovedDm(reqId),
            req.group_id,
            staffCorrectionDecisionGroup(r.employee.name, reqId, true),
            'staff_correction_approved',
          );
        }
        return [
          staffApprovedCorrection(
            id,
            r.employee.name,
            r.request.at,
            r.request.kind,
            r.pairedRequest ? displayCorrectionId(r.pairedRequest.id) : null,
            r.request.end_at,
          ),
        ];
      }
      case 'rejectCorrection': {
        const id = displayCorrectionId(cmd.requestId);
        const r = service.rejectCorrection(userId, cmd.requestId, at);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'alreadyDecided')
          return [staffCorrectionAlreadyDecided(id, r.request.status)];
        await messenger.dmOrGroup(
          r.employee.user_id,
          staffCorrectionRejectedDm(id),
          r.request.group_id,
          staffCorrectionDecisionGroup(r.employee.name, id, false),
          'staff_correction_rejected',
        );
        return [staffRejectedCorrection(id, r.employee.name)];
      }
      case 'adminCorrection': {
        const eid = displayEmployeeId(cmd.employeeId);
        const r = service.adminCorrection(userId, cmd.employeeId, correctionInput(cmd), at);
        switch (r.kind) {
          case 'notFound':
            return [staffNotFound(eid)];
          case 'notApproved':
            return [staffNotApproved(eid, r.employee.name)];
          case 'future':
            return [staffTexts.correctionFuture];
          case 'tooOld':
            return [staffTexts.correctionTooOld];
          case 'tooLong':
            return [staffCorrectionTooLong(config.STAFF_MAX_SHIFT_HOURS)];
          case 'failed':
            return [failureText(displayCorrectionId(r.request.id), r)];
          case 'applied':
            return [
              staffAdminCorrectionApplied(
                eid,
                r.employee.name,
                r.request.at,
                r.request.kind,
                displayCorrectionId(r.request.id),
                r.request.end_at,
              ),
              ...settledLines(r.settledMonths),
            ];
        }
        break;
      }
      case 'editShift': {
        const id = displayShiftId(cmd.shiftId);
        const r = service.editShift(
          userId,
          cmd.shiftId,
          { kind: cmd.kind, date: cmd.date, hour: cmd.hour, minute: cmd.minute },
          at,
        );
        switch (r.kind) {
          case 'notFound':
            return [staffNotFound(id)];
          case 'deleted':
            return [staffShiftEditDeleted(id)];
          case 'refused':
            return [
              staffShiftEditRefused(
                id,
                r.reason,
                conflictView(r.conflictShift),
                config.STAFF_MAX_SHIFT_HOURS,
              ),
            ];
          case 'edited':
            // §15.2: the employee is not notified (they can check with 我的打卡).
            return [
              staffShiftEdited(id, r.employee.name, r.shift.start_at, r.shift.end_at, r.minutes),
              ...settledLines(r.settledMonths),
            ];
        }
        break;
      }
      case 'setWage': {
        const id = displayEmployeeId(cmd.employeeId);
        const r = service.setWage(userId, cmd.employeeId, cmd.hourlyWage, cmd.effectiveFrom, at);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'notApproved') return [staffNotApproved(id, r.employee.name)];
        return [
          staffWageSet(id, r.employee.name, r.hourlyWage, r.effectiveFrom, r.previousWage),
          ...belowMin(r.belowMinimum),
        ];
      }
      case 'listShiftsForDelete': {
        const r = service.listShiftsOnDay(cmd.employeeId, cmd.date);
        if (r.kind === 'notFound') return [staffNotFound(displayEmployeeId(cmd.employeeId))];
        return staffShiftsOnDay(
          displayEmployeeId(r.employee.id),
          r.employee.name,
          r.date,
          r.shifts,
        );
      }
      case 'deleteShift': {
        const id = displayShiftId(cmd.shiftId);
        const r = service.deleteShift(userId, cmd.shiftId, at);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'alreadyDeleted') return [staffShiftAlreadyDeleted(id)];
        return [
          staffShiftDeleted(id, r.employee.name, r.shift.start_at, r.shift.end_at),
          ...settledLines(r.settledMonths),
        ];
      }
      case 'disableEmployee':
      case 'enableEmployee': {
        const id = displayEmployeeId(cmd.employeeId);
        const disabled = cmd.type === 'disableEmployee';
        const r = service.setEmployeeStatus(
          userId,
          cmd.employeeId,
          disabled ? 'disabled' : 'active',
          at,
        );
        if (r.kind === 'notFound') return [staffNotFound(id)];
        if (r.kind === 'notApproved') return [staffNotApproved(id, r.employee.name)];
        if (r.kind === 'unchanged') return [staffStatusUnchanged(id, r.employee.name, disabled)];
        return [staffStatusUpdated(id, r.employee.name, disabled)];
      }
      case 'shiftRecords': {
        const id = displayEmployeeId(cmd.employeeId);
        const r = service.shiftRecords(cmd.employeeId, cmd.month);
        if (r.kind === 'notFound') return [staffNotFound(id)];
        return staffShiftRecords(
          staffShiftRecordsHeader(id, r.employee.name, cmd.month),
          r.shifts,
          true,
        );
      }
      case 'backup': {
        if (!deps.backup) return [staffTexts.backupNotConfigured];
        // A failed scheduled streak was announced to every admin: they all hear it ended.
        const outstanding = backupFailureOutstanding(service.repo);
        const r = await deps.backup.run({
          date: null,
          triggeredBy: userId,
          force: cmd.force,
          now: at,
        });
        if (!r.ok) return [staffBackupFailed(r.failure)];
        if (!outstanding) return [staffBackupDone(r.counts)];
        await messenger.notifyAdmins(
          [staffTexts.backupRecovered],
          'staff_backup_recovered',
          userId,
        );
        return [staffBackupDone(r.counts), staffTexts.backupRecovered];
      }
      case 'runPayroll':
        await reporter.run(cmd.month, userId, at, {
          notifyEmployees: cmd.notifyEmployees,
          requester: { userId, replyToken },
        });
        return null;
      case 'malformed': {
        if (cmd.keyword === '補卡') {
          return [staffTexts.usage[cmd.keyword], staffTexts.adminCorrectionUsage];
        }
        return employeeMalformed(cmd.keyword, userId) ?? [staffTexts.usage[cmd.keyword]];
      }
      default:
        return employeeDm(cmd, userId, at);
    }
    return [staffTexts.unknownCommand];
  }

  /** DM special cases for a malformed keyword; null = show the usage hint. */
  function employeeMalformed(keyword: CommandKeyword, userId: string): string[] | null {
    if (keyword === '說明') return helpLines(userId);
    if (keyword === '註冊') return [staffTexts.registerInGroup];
    return null;
  }

  function failureText(
    id: string,
    r: {
      reason: 'noOpenShift' | 'overlap' | 'exceedsMaxHours';
      conflictShift: { id: number; start_at: string; end_at: string | null } | null;
    },
  ): string {
    return staffCorrectionFailed(
      id,
      r.reason,
      conflictView(r.conflictShift),
      config.STAFF_MAX_SHIFT_HOURS,
    );
  }

  async function handleText(ctx: TextMessageContext): Promise<void> {
    const { userId, replyToken } = ctx;
    const at = now();
    let answered = false;
    try {
      const cmd = parseStaffCommand(ctx.text, at);
      let lines: string[] | null;
      if (!cmd) {
        lines = [staffTexts.unknownCommand];
      } else if (admins.has(userId)) {
        lines = await adminDm(cmd, userId, replyToken, at);
        if (lines === null) answered = true;
      } else if (cmd.type === 'malformed') {
        lines = EMPLOYEE_DM_KEYWORDS.has(cmd.keyword)
          ? (employeeMalformed(cmd.keyword, userId) ?? [staffTexts.usage[cmd.keyword]])
          : [staffTexts.unknownCommand];
      } else if (EMPLOYEE_DM_TYPES.has(cmd.type)) {
        lines = await employeeDm(cmd, userId, at);
      } else {
        lines = [staffTexts.unknownCommand]; // admin command from a non-admin
      }
      if (!lines) return;
      answered = true;
      await messenger.answer(replyToken, userId, lines, 'staff_dm');
    } catch (err) {
      log.error({ userId, err }, 'staff DM handling failed');
      await fallback(answered ? undefined : replyToken, userId);
    }
  }

  async function fallback(replyToken: string | undefined, to: string): Promise<void> {
    try {
      await deps.replier.replyOrPush(replyToken, to, [staffTexts.error], 'staff_error');
    } catch (err) {
      log.error({ err }, 'staff fallback reply failed');
    }
  }

  return { handleText, handleGroupText };
}
