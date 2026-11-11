/**
 * Staff bot service layer (SPEC-STAFF §4–8): registration, punches, corrections, wages, admin
 * operations and payroll. Every method takes `now` and returns a typed outcome — no LINE calls
 * and no user-facing text; the profile (T21) maps outcomes to `texts.ts` and notifications.
 *
 * Multi-row changes run in one SQLite transaction. Every admin operation writes `audit_log`
 * (actor, action, target display id, before / after JSON).
 */
import type { Database } from 'better-sqlite3';
import type { PunchKind } from './commands.js';
import { type CorrectionFailureReason, planCorrection } from './corrections.js';
import { displayCorrectionId, displayEmployeeId, displayShiftId } from './ids.js';
import {
  calculateEmployeeLine,
  calculatePayroll,
  type PayrollEmployeeLine,
  type PayrollResult,
  payrollShiftWindow,
  type ShiftDetail,
  shiftDetail,
  wageOn,
} from './payroll.js';
import { decidePunch, RESEND_WINDOW_MS } from './punch.js';
import {
  type CorrectionRow,
  createStaffRepo,
  type EmployeeRow,
  type EmployeeStatus,
  type ShiftRow,
  type ShiftSource,
  type StaffRepo,
} from './repo.js';
import { addDays, type LocalDate, type Month, taipeiDate, taipeiInstant } from './time.js';

/** §6: corrections may go back this many Taipei calendar days (and never into the future). */
export const CORRECTION_WINDOW_DAYS = 31;

export interface StaffServiceOptions {
  /** STAFF_MIN_HOURLY_WAGE: lower wages are allowed but flagged `belowMinimum`. */
  minHourlyWage: number;
  /** STAFF_MAX_SHIFT_HOURS. */
  maxShiftHours: number;
}

/** Why an employee-side command cannot proceed. */
export type NotEmployeeOutcome =
  | { kind: 'notRegistered' }
  | { kind: 'pendingApproval'; employee: EmployeeRow }
  | { kind: 'disabled'; employee: EmployeeRow };

export type RegisterOutcome =
  /** `resent`: the same user registered again within 60 s (treat as the first result). */
  | { kind: 'requested'; employee: EmployeeRow; resent: boolean }
  | { kind: 'alreadyPending'; employee: EmployeeRow }
  | { kind: 'alreadyActive'; employee: EmployeeRow }
  | { kind: 'disabled'; employee: EmployeeRow };

export type ApproveRegistrationOutcome =
  | {
      kind: 'approved';
      employee: EmployeeRow;
      hourlyWage: number;
      effectiveFrom: LocalDate;
      belowMinimum: boolean;
    }
  | { kind: 'notFound' }
  | { kind: 'notPending'; employee: EmployeeRow };

export type RejectRegistrationOutcome =
  | { kind: 'rejected'; employee: EmployeeRow }
  | { kind: 'notFound' }
  | { kind: 'notPending'; employee: EmployeeRow };

export type PunchOutcome =
  | NotEmployeeOutcome
  /** `staleShift`: an open shift past the limit that was flagged 未下班 and left open. */
  | {
      kind: 'clockedIn';
      employee: EmployeeRow;
      shift: ShiftRow;
      resent: boolean;
      staleShift: ShiftRow | null;
    }
  | { kind: 'alreadyIn'; employee: EmployeeRow; shift: ShiftRow }
  | { kind: 'clockedOut'; employee: EmployeeRow; shift: ShiftRow; minutes: number; resent: boolean }
  | { kind: 'noOpenShift'; employee: EmployeeRow }
  | { kind: 'overdue'; employee: EmployeeRow; shift: ShiftRow };

export interface CorrectionInput {
  kind: PunchKind;
  at: Date;
}

/** Validation shared by employee requests and admin 代補. */
export type CorrectionWindowOutcome =
  { kind: 'future'; employee: EmployeeRow } | { kind: 'tooOld'; employee: EmployeeRow };

export type RequestCorrectionOutcome =
  | NotEmployeeOutcome
  | CorrectionWindowOutcome
  /** `resent`: identical pending request created within 60 s. */
  | { kind: 'requested'; employee: EmployeeRow; request: CorrectionRow; resent: boolean }
  /** An identical request is already pending (older than 60 s). */
  | { kind: 'duplicate'; employee: EmployeeRow; request: CorrectionRow };

export interface CorrectionFailure {
  kind: 'failed';
  request: CorrectionRow;
  employee: EmployeeRow;
  reason: CorrectionFailureReason;
  /** The shift that blocked it (overlap / exceedsMaxHours), if any. */
  conflictShift: ShiftRow | null;
}

export interface CorrectionApplied {
  request: CorrectionRow;
  employee: EmployeeRow;
  shift: ShiftRow;
  /** A pending `下班` request approved together with this `上班` (notify its requester too). */
  pairedRequest: CorrectionRow | null;
}

export type ApproveCorrectionOutcome =
  | ({ kind: 'approved' } & CorrectionApplied)
  | CorrectionFailure
  | { kind: 'notFound' }
  | { kind: 'alreadyDecided'; request: CorrectionRow };

export type RejectCorrectionOutcome =
  | { kind: 'rejected'; request: CorrectionRow; employee: EmployeeRow }
  | { kind: 'notFound' }
  | { kind: 'alreadyDecided'; request: CorrectionRow };

export type AdminCorrectionOutcome =
  | ({ kind: 'applied' } & CorrectionApplied)
  | CorrectionFailure
  | CorrectionWindowOutcome
  | { kind: 'notFound' }
  | { kind: 'notApproved'; employee: EmployeeRow };

export type SetWageOutcome =
  | {
      kind: 'set';
      employee: EmployeeRow;
      hourlyWage: number;
      effectiveFrom: LocalDate;
      /** Wage that was in force on `effectiveFrom` before this change. */
      previousWage: number | null;
      belowMinimum: boolean;
    }
  | { kind: 'notFound' }
  | { kind: 'notApproved'; employee: EmployeeRow };

export type DeleteShiftOutcome =
  | { kind: 'deleted'; shift: ShiftRow; employee: EmployeeRow }
  | { kind: 'notFound' }
  | { kind: 'alreadyDeleted'; shift: ShiftRow };

export type SetStatusOutcome =
  | { kind: 'updated'; employee: EmployeeRow; previous: EmployeeStatus }
  | { kind: 'unchanged'; employee: EmployeeRow }
  | { kind: 'notFound' }
  | { kind: 'notApproved'; employee: EmployeeRow };

export interface EmployeeListItem {
  employee: EmployeeRow;
  displayId: string;
  /** Wage in force today, or null (pending / none set). */
  currentWage: number | null;
}

export interface PendingItems {
  registrations: EmployeeRow[];
  corrections: { request: CorrectionRow; employee: EmployeeRow }[];
  /** Every live open shift; `overdue` = flagged or older than STAFF_MAX_SHIFT_HOURS. */
  openShifts: { shift: ShiftRow; employee: EmployeeRow; overdue: boolean }[];
}

export type ShiftsOnDayOutcome =
  | { kind: 'ok'; employee: EmployeeRow; date: LocalDate; shifts: ShiftDetail[] }
  | { kind: 'notFound' };

export interface MonthRecords {
  employee: EmployeeRow;
  month: Month;
  shifts: ShiftDetail[];
  summary: PayrollEmployeeLine;
}

export type ShiftRecordsOutcome = ({ kind: 'ok' } & MonthRecords) | { kind: 'notFound' };

/** `我的打卡` / `我的薪資`: disabled employees may still read their own records (§11). */
export type MyRecordsOutcome =
  | ({ kind: 'ok' } & MonthRecords)
  | { kind: 'notRegistered' }
  | { kind: 'pendingApproval'; employee: EmployeeRow };

export interface PayrollRun {
  runId: number;
  result: PayrollResult;
}

/** `triggered_by` / audit actor for the monthly automatic run. */
export const PAYROLL_SCHEDULE_ACTOR = 'schedule';

function correctionView(r: CorrectionRow) {
  return { id: displayCorrectionId(r.id), kind: r.kind, at: r.at, status: r.status };
}

function shiftView(s: ShiftRow | undefined) {
  if (!s) return null;
  return {
    id: displayShiftId(s.id),
    start_at: s.start_at,
    end_at: s.end_at,
    start_source: s.start_source,
    end_source: s.end_source,
    deleted_at: s.deleted_at,
  };
}

export function createStaffService(db: Database, opts: StaffServiceOptions) {
  const repo: StaffRepo = createStaffRepo(db);
  const maxShiftMs = opts.maxShiftHours * 3_600_000;

  function audit(
    actor: string,
    action: string,
    target: string | null,
    before: unknown,
    after: unknown,
    now: Date,
  ): void {
    repo.audit.insert(actor, action, target, before, after, now);
  }

  /** Active employee for `userId`, or why not. */
  function activeEmployee(userId: string): EmployeeRow | NotEmployeeOutcome {
    const e = repo.employees.findByUserId(userId);
    if (!e) return { kind: 'notRegistered' };
    if (e.status === 'pending') return { kind: 'pendingApproval', employee: e };
    if (e.status === 'disabled') return { kind: 'disabled', employee: e };
    return e;
  }

  function isEmployee(v: EmployeeRow | NotEmployeeOutcome): v is EmployeeRow {
    return 'id' in v;
  }

  function checkWindow(employee: EmployeeRow, at: Date, now: Date): CorrectionWindowOutcome | null {
    if (at.getTime() > now.getTime()) return { kind: 'future', employee };
    if (taipeiDate(at) < addDays(taipeiDate(now), -CORRECTION_WINDOW_DAYS)) {
      return { kind: 'tooOld', employee };
    }
    return null;
  }

  /**
   * Applies a pending request (already validated) inside the caller's transaction and records the
   * decision. Returns the applied result or the failure.
   */
  function applyRequest(
    request: CorrectionRow,
    employee: EmployeeRow,
    actor: string,
    source: ShiftSource,
    now: Date,
  ): CorrectionApplied | CorrectionFailure {
    const at = new Date(request.at);
    const live = repo.shifts.listForEmployee(employee.id);
    const outRequests =
      request.kind === 'in'
        ? repo.corrections
            .listPairableOut(employee.id, at, new Date(at.getTime() + maxShiftMs))
            .filter((r) => r.id !== request.id)
        : [];
    const plan = planCorrection({
      kind: request.kind,
      at,
      shifts: live.map((s) => ({
        id: s.id,
        startAt: new Date(s.start_at),
        endAt: s.end_at ? new Date(s.end_at) : null,
      })),
      outRequests: outRequests.map((r) => ({ id: r.id, at: new Date(r.at) })),
      maxShiftHours: opts.maxShiftHours,
      now,
    });

    if (!plan.ok) {
      repo.corrections.decide(request.id, 'failed', plan.reason, null, actor, now);
      return {
        kind: 'failed',
        request: repo.corrections.get(request.id)!,
        employee,
        reason: plan.reason,
        conflictShift:
          plan.conflictShiftId !== null ? (repo.shifts.get(plan.conflictShiftId) ?? null) : null,
      };
    }

    let shiftId: number;
    let pairedRequest: CorrectionRow | null = null;
    if (plan.op === 'create') {
      shiftId = repo.shifts.insert(
        {
          employeeId: employee.id,
          startAt: plan.startAt,
          endAt: plan.endAt,
          startSource: source,
          endSource: plan.endAt ? source : null,
        },
        now,
      );
      if (plan.pairedRequestId !== null) {
        repo.corrections.decide(plan.pairedRequestId, 'approved', null, shiftId, actor, now);
        pairedRequest = repo.corrections.get(plan.pairedRequestId)!;
      }
    } else if (plan.op === 'close') {
      shiftId = plan.shiftId;
      repo.shifts.close(shiftId, plan.endAt, source, now);
    } else {
      shiftId = plan.shiftId;
      repo.shifts.setStart(shiftId, plan.startAt, source, now);
    }
    repo.corrections.decide(request.id, 'approved', null, shiftId, actor, now);
    return {
      request: repo.corrections.get(request.id)!,
      employee,
      shift: repo.shifts.get(shiftId)!,
      pairedRequest,
    };
  }

  function monthRecords(employee: EmployeeRow, month: Month): MonthRecords {
    const { from, to } = payrollShiftWindow(month);
    const shifts = repo.shifts.listForEmployeeBetween(employee.id, from, to);
    const rates = repo.wages.listForEmployee(employee.id);
    const summary = calculateEmployeeLine(employee, month, shifts, rates);
    return {
      employee,
      month,
      shifts: shifts
        .filter((s) => taipeiDate(new Date(s.start_at)).startsWith(month))
        .map((s) => shiftDetail(s, rates)),
      summary,
    };
  }

  function computePayroll(month: Month, now: Date): PayrollResult {
    const { from, to } = payrollShiftWindow(month);
    return calculatePayroll({
      month,
      now,
      employees: repo.employees.listAll(),
      wages: repo.wages.listAll(),
      shifts: repo.shifts.listBetween(from, to),
      pendingCorrections: repo.corrections.listPending(),
    });
  }

  return {
    repo,

    // ---------------------------------------------------------------- §4 registration

    register(userId: string, name: string, groupId: string | null, now: Date): RegisterOutcome {
      return db.transaction((): RegisterOutcome => {
        const existing = repo.employees.findByUserId(userId);
        if (existing) {
          if (existing.status === 'active') return { kind: 'alreadyActive', employee: existing };
          if (existing.status === 'disabled') return { kind: 'disabled', employee: existing };
          const age = now.getTime() - Date.parse(existing.created_at);
          if (age >= 0 && age <= RESEND_WINDOW_MS) {
            return { kind: 'requested', employee: existing, resent: true };
          }
          return { kind: 'alreadyPending', employee: existing };
        }
        const id = repo.employees.insertPending(userId, name, groupId, now);
        return { kind: 'requested', employee: repo.employees.get(id)!, resent: false };
      })();
    },

    approveRegistration(
      actor: string,
      employeeId: number,
      hourlyWage: number,
      now: Date,
    ): ApproveRegistrationOutcome {
      return db.transaction((): ApproveRegistrationOutcome => {
        const before = repo.employees.get(employeeId);
        if (!before) return { kind: 'notFound' };
        if (before.status !== 'pending') return { kind: 'notPending', employee: before };
        const effectiveFrom = taipeiDate(now);
        repo.employees.activate(employeeId, actor, now);
        repo.wages.insert(employeeId, hourlyWage, effectiveFrom, actor, now);
        const employee = repo.employees.get(employeeId)!;
        audit(
          actor,
          'approve_registration',
          displayEmployeeId(employeeId),
          { status: before.status },
          { status: employee.status, name: employee.name, hourlyWage, effectiveFrom },
          now,
        );
        return {
          kind: 'approved',
          employee,
          hourlyWage,
          effectiveFrom,
          belowMinimum: hourlyWage < opts.minHourlyWage,
        };
      })();
    },

    rejectRegistration(actor: string, employeeId: number, now: Date): RejectRegistrationOutcome {
      return db.transaction((): RejectRegistrationOutcome => {
        const employee = repo.employees.get(employeeId);
        if (!employee) return { kind: 'notFound' };
        if (employee.status !== 'pending') return { kind: 'notPending', employee };
        repo.employees.delete(employeeId);
        audit(
          actor,
          'reject_registration',
          displayEmployeeId(employeeId),
          { userId: employee.user_id, name: employee.name, status: employee.status },
          null,
          now,
        );
        return { kind: 'rejected', employee };
      })();
    },

    // ---------------------------------------------------------------- §5 punches

    punch(userId: string, kind: PunchKind, now: Date): PunchOutcome {
      return db.transaction((): PunchOutcome => {
        const e = activeEmployee(userId);
        if (!isEmployee(e)) return e;
        const decision = decidePunch(
          kind,
          {
            latestOpen: repo.shifts.latestOpen(e.id),
            latestClosed: repo.shifts.latestClosed(e.id),
          },
          now,
          opts.maxShiftHours,
        );
        switch (decision.action) {
          case 'open': {
            let staleShift: ShiftRow | null = null;
            if (decision.staleShiftId !== null) {
              repo.shifts.markOverdue(decision.staleShiftId, now);
              staleShift = repo.shifts.get(decision.staleShiftId)!;
            }
            const id = repo.shifts.insert(
              {
                employeeId: e.id,
                startAt: now,
                endAt: null,
                startSource: 'punch',
                endSource: null,
              },
              now,
            );
            return {
              kind: 'clockedIn',
              employee: e,
              shift: repo.shifts.get(id)!,
              resent: false,
              staleShift,
            };
          }
          case 'resentIn':
            return {
              kind: 'clockedIn',
              employee: e,
              shift: decision.shift,
              resent: true,
              staleShift: null,
            };
          case 'alreadyIn':
            return { kind: 'alreadyIn', employee: e, shift: decision.shift };
          case 'close': {
            repo.shifts.close(decision.shift.id, now, 'punch', now);
            const shift = repo.shifts.get(decision.shift.id)!;
            const minutes = (now.getTime() - Date.parse(shift.start_at)) / 60_000;
            return { kind: 'clockedOut', employee: e, shift, minutes, resent: false };
          }
          case 'resentOut': {
            const s = decision.shift;
            const minutes = (Date.parse(s.end_at!) - Date.parse(s.start_at)) / 60_000;
            return { kind: 'clockedOut', employee: e, shift: s, minutes, resent: true };
          }
          case 'noOpenShift':
            return { kind: 'noOpenShift', employee: e };
          case 'overdue':
            repo.shifts.markOverdue(decision.shift.id, now);
            return { kind: 'overdue', employee: e, shift: repo.shifts.get(decision.shift.id)! };
        }
      })();
    },

    // ---------------------------------------------------------------- §6 corrections

    requestCorrection(
      userId: string,
      c: CorrectionInput,
      groupId: string | null,
      now: Date,
    ): RequestCorrectionOutcome {
      return db.transaction((): RequestCorrectionOutcome => {
        const e = activeEmployee(userId);
        if (!isEmployee(e)) return e;
        const bad = checkWindow(e, c.at, now);
        if (bad) return bad;
        const dup = repo.corrections.findPendingDuplicate(e.id, c.kind, c.at);
        if (dup) {
          const age = now.getTime() - Date.parse(dup.created_at);
          return age >= 0 && age <= RESEND_WINDOW_MS
            ? { kind: 'requested', employee: e, request: dup, resent: true }
            : { kind: 'duplicate', employee: e, request: dup };
        }
        const id = repo.corrections.insert(
          { employeeId: e.id, kind: c.kind, at: c.at, requestedBy: userId, groupId },
          now,
        );
        return {
          kind: 'requested',
          employee: e,
          request: repo.corrections.get(id)!,
          resent: false,
        };
      })();
    },

    approveCorrection(actor: string, requestId: number, now: Date): ApproveCorrectionOutcome {
      return db.transaction((): ApproveCorrectionOutcome => {
        const request = repo.corrections.get(requestId);
        if (!request) return { kind: 'notFound' };
        if (request.status !== 'pending') return { kind: 'alreadyDecided', request };
        const employee = repo.employees.get(request.employee_id)!;
        const before = correctionView(request);
        const result = applyRequest(request, employee, actor, 'correction', now);
        const target = displayCorrectionId(requestId);
        if ('kind' in result) {
          audit(
            actor,
            'approve_correction',
            target,
            before,
            {
              ...correctionView(result.request),
              reason: result.reason,
              conflictShift: result.conflictShift ? displayShiftId(result.conflictShift.id) : null,
            },
            now,
          );
          return result;
        }
        audit(
          actor,
          'approve_correction',
          target,
          before,
          {
            ...correctionView(result.request),
            shift: shiftView(result.shift),
            pairedRequest: result.pairedRequest
              ? displayCorrectionId(result.pairedRequest.id)
              : null,
          },
          now,
        );
        return { kind: 'approved', ...result };
      })();
    },

    rejectCorrection(actor: string, requestId: number, now: Date): RejectCorrectionOutcome {
      return db.transaction((): RejectCorrectionOutcome => {
        const request = repo.corrections.get(requestId);
        if (!request) return { kind: 'notFound' };
        if (request.status !== 'pending') return { kind: 'alreadyDecided', request };
        repo.corrections.decide(requestId, 'rejected', null, null, actor, now);
        const after = repo.corrections.get(requestId)!;
        audit(
          actor,
          'reject_correction',
          displayCorrectionId(requestId),
          correctionView(request),
          correctionView(after),
          now,
        );
        return {
          kind: 'rejected',
          request: after,
          employee: repo.employees.get(request.employee_id)!,
        };
      })();
    },

    /** §6 代補: recorded as a correction request decided by `actor` at once (source `admin`). */
    adminCorrection(
      actor: string,
      employeeId: number,
      c: CorrectionInput,
      now: Date,
    ): AdminCorrectionOutcome {
      return db.transaction((): AdminCorrectionOutcome => {
        const employee = repo.employees.get(employeeId);
        if (!employee) return { kind: 'notFound' };
        if (employee.status === 'pending') return { kind: 'notApproved', employee };
        const bad = checkWindow(employee, c.at, now);
        if (bad) return bad;
        const id = repo.corrections.insert(
          { employeeId, kind: c.kind, at: c.at, requestedBy: actor, groupId: null },
          now,
        );
        const result = applyRequest(repo.corrections.get(id)!, employee, actor, 'admin', now);
        const target = displayCorrectionId(id);
        if ('kind' in result) {
          audit(
            actor,
            'admin_correction',
            target,
            null,
            {
              employee: displayEmployeeId(employeeId),
              ...correctionView(result.request),
              reason: result.reason,
              conflictShift: result.conflictShift ? displayShiftId(result.conflictShift.id) : null,
            },
            now,
          );
          return result;
        }
        audit(
          actor,
          'admin_correction',
          target,
          null,
          {
            employee: displayEmployeeId(employeeId),
            ...correctionView(result.request),
            shift: shiftView(result.shift),
            pairedRequest: result.pairedRequest
              ? displayCorrectionId(result.pairedRequest.id)
              : null,
          },
          now,
        );
        return { kind: 'applied', ...result };
      })();
    },

    // ---------------------------------------------------------------- §7 wages

    /** `effectiveFrom` null = today (Taipei). */
    setWage(
      actor: string,
      employeeId: number,
      hourlyWage: number,
      effectiveFrom: LocalDate | null,
      now: Date,
    ): SetWageOutcome {
      return db.transaction((): SetWageOutcome => {
        const employee = repo.employees.get(employeeId);
        if (!employee) return { kind: 'notFound' };
        if (employee.status === 'pending') return { kind: 'notApproved', employee };
        const from = effectiveFrom ?? taipeiDate(now);
        const previousWage = repo.wages.rateOn(employeeId, from)?.hourly_wage ?? null;
        repo.wages.insert(employeeId, hourlyWage, from, actor, now);
        audit(
          actor,
          'set_wage',
          displayEmployeeId(employeeId),
          { hourlyWage: previousWage, effectiveFrom: from },
          { hourlyWage, effectiveFrom: from },
          now,
        );
        return {
          kind: 'set',
          employee,
          hourlyWage,
          effectiveFrom: from,
          previousWage,
          belowMinimum: hourlyWage < opts.minHourlyWage,
        };
      })();
    },

    /** Wage in force for the employee on a Taipei date, or null. */
    wageOn(employeeId: number, date: LocalDate): number | null {
      return wageOn(repo.wages.listForEmployee(employeeId), date)?.hourly_wage ?? null;
    },

    // ---------------------------------------------------------------- §9 admin reads / ops

    listEmployees(now: Date): EmployeeListItem[] {
      const today = taipeiDate(now);
      return repo.employees.listAll().map((employee) => ({
        employee,
        displayId: displayEmployeeId(employee.id),
        currentWage: repo.wages.rateOn(employee.id, today)?.hourly_wage ?? null,
      }));
    },

    pendingItems(now: Date): PendingItems {
      const byId = new Map(repo.employees.listAll().map((e) => [e.id, e]));
      return {
        registrations: repo.employees.listByStatus('pending'),
        corrections: repo.corrections
          .listPending()
          .map((request) => ({ request, employee: byId.get(request.employee_id)! })),
        openShifts: repo.shifts.listOpen().map((shift) => ({
          shift,
          employee: byId.get(shift.employee_id)!,
          overdue: shift.overdue === 1 || now.getTime() - Date.parse(shift.start_at) > maxShiftMs,
        })),
      };
    },

    /** `刪除打卡 E001 11/12`: live shifts that started on that Taipei day. */
    listShiftsOnDay(employeeId: number, date: LocalDate): ShiftsOnDayOutcome {
      const employee = repo.employees.get(employeeId);
      if (!employee) return { kind: 'notFound' };
      const rates = repo.wages.listForEmployee(employeeId);
      const from = taipeiInstant(date);
      const to = taipeiInstant(addDays(date, 1));
      return {
        kind: 'ok',
        employee,
        date,
        shifts: repo.shifts
          .listForEmployeeBetween(employeeId, from, to)
          .map((s) => shiftDetail(s, rates)),
      };
    },

    /** `刪除 S0123`: soft delete (§10 retention). */
    deleteShift(actor: string, shiftId: number, now: Date): DeleteShiftOutcome {
      return db.transaction((): DeleteShiftOutcome => {
        const shift = repo.shifts.get(shiftId);
        if (!shift) return { kind: 'notFound' };
        if (shift.deleted_at) return { kind: 'alreadyDeleted', shift };
        repo.shifts.softDelete(shiftId, now);
        const after = repo.shifts.get(shiftId)!;
        audit(
          actor,
          'delete_shift',
          displayShiftId(shiftId),
          { employee: displayEmployeeId(shift.employee_id), ...shiftView(shift) },
          { employee: displayEmployeeId(shift.employee_id), ...shiftView(after) },
          now,
        );
        return { kind: 'deleted', shift: after, employee: repo.employees.get(shift.employee_id)! };
      })();
    },

    /** `停用` / `啟用`. Pending registrations must be approved instead. */
    setEmployeeStatus(
      actor: string,
      employeeId: number,
      status: 'active' | 'disabled',
      now: Date,
    ): SetStatusOutcome {
      return db.transaction((): SetStatusOutcome => {
        const employee = repo.employees.get(employeeId);
        if (!employee) return { kind: 'notFound' };
        if (employee.status === 'pending') return { kind: 'notApproved', employee };
        if (employee.status === status) return { kind: 'unchanged', employee };
        repo.employees.setStatus(employeeId, status);
        audit(
          actor,
          status === 'disabled' ? 'disable_employee' : 'enable_employee',
          displayEmployeeId(employeeId),
          { status: employee.status },
          { status },
          now,
        );
        return {
          kind: 'updated',
          employee: repo.employees.get(employeeId)!,
          previous: employee.status,
        };
      })();
    },

    /** `打卡紀錄 E001 2026-11`. */
    shiftRecords(employeeId: number, month: Month): ShiftRecordsOutcome {
      const employee = repo.employees.get(employeeId);
      if (!employee) return { kind: 'notFound' };
      return { kind: 'ok', ...monthRecords(employee, month) };
    },

    /** `我的打卡` / `我的薪資` (both use the same records; `summary` holds the pay). */
    myRecords(userId: string, month: Month): MyRecordsOutcome {
      const employee = repo.employees.findByUserId(userId);
      if (!employee) return { kind: 'notRegistered' };
      if (employee.status === 'pending') return { kind: 'pendingApproval', employee };
      return { kind: 'ok', ...monthRecords(employee, month) };
    },

    // ---------------------------------------------------------------- §8 payroll

    /** Computes without storing (previews). */
    computePayroll,

    /**
     * `結算 2026-11` or the monthly schedule: computes, stores a new `payroll_runs` row (older runs
     * are kept) and audits. `triggeredBy` = admin userId, or `'schedule'`.
     */
    runPayroll(month: Month, triggeredBy: string, now: Date): PayrollRun {
      return db.transaction((): PayrollRun => {
        const result = computePayroll(month, now);
        const runId = repo.payrollRuns.insert(month, triggeredBy, result, now);
        audit(triggeredBy, 'payroll_run', month, null, { runId, totals: result.totals }, now);
        return { runId, result };
      })();
    },
  };
}

export type StaffService = ReturnType<typeof createStaffService>;
