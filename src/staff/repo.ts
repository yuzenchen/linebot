/**
 * SQLite access for the staff tables (migration 008). Every write takes an explicit `now`; the
 * service layer wraps multi-row changes in `db.transaction`.
 */
import type { Database } from 'better-sqlite3';
import type { PunchKind } from './commands.js';
import type { LocalDate, Month } from './time.js';

export type EmployeeStatus = 'pending' | 'active' | 'disabled';
export type ShiftSource = 'punch' | 'correction' | 'admin';
export type CorrectionStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface EmployeeRow {
  id: number;
  user_id: string;
  /** Name typed at registration (not the LINE display name). */
  name: string;
  status: EmployeeStatus;
  /** Group the registration came from (for the "已可打卡" group notice), or null. */
  group_id: string | null;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
}

export interface WageRateRow {
  id: number;
  employee_id: number;
  hourly_wage: number;
  /** Taipei date the rate applies from (inclusive). */
  effective_from: LocalDate;
  created_by: string | null;
  created_at: string;
}

export interface ShiftRow {
  id: number;
  employee_id: number;
  start_at: string;
  /** Null while the shift is open (未下班). */
  end_at: string | null;
  start_source: ShiftSource;
  end_source: ShiftSource | null;
  /** 1 once a `下班` found this open shift older than STAFF_MAX_SHIFT_HOURS (§5 未下班). */
  overdue: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CorrectionRow {
  id: number;
  employee_id: number;
  kind: PunchKind;
  at: string;
  status: CorrectionStatus;
  /** Failure reason code (see `CorrectionFailureReason`), or null. */
  reason: string | null;
  /** userId of whoever asked (the employee, or the admin for 代補). */
  requested_by: string | null;
  /** Group the request came from (null = DM); fallback channel for the decision notice. */
  group_id: string | null;
  /** Shift created / changed when approved. */
  shift_id: number | null;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export interface PayrollRunRow {
  id: number;
  month: Month;
  run_at: string;
  /** `schedule` or the admin userId. */
  triggered_by: string;
  result_json: string;
}

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export interface InsertShiftInput {
  employeeId: number;
  startAt: Date;
  endAt: Date | null;
  startSource: ShiftSource;
  endSource: ShiftSource | null;
}

export interface InsertCorrectionInput {
  employeeId: number;
  kind: PunchKind;
  at: Date;
  requestedBy: string;
  groupId: string | null;
}

const iso = (d: Date) => d.toISOString();
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export function createStaffRepo(db: Database) {
  const emp = {
    insert: db.prepare(
      "INSERT INTO employees (user_id, name, status, group_id, created_at) VALUES (?, ?, 'pending', ?, ?)",
    ),
    get: db.prepare('SELECT * FROM employees WHERE id = ?'),
    byUser: db.prepare('SELECT * FROM employees WHERE user_id = ?'),
    all: db.prepare('SELECT * FROM employees ORDER BY id'),
    byStatus: db.prepare('SELECT * FROM employees WHERE status = ? ORDER BY id'),
    activate: db.prepare(
      "UPDATE employees SET status = 'active', approved_at = ?, approved_by = ? WHERE id = ?",
    ),
    setStatus: db.prepare('UPDATE employees SET status = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM employees WHERE id = ?'),
  };
  const wage = {
    insert: db.prepare(
      'INSERT INTO wage_rates (employee_id, hourly_wage, effective_from, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    forEmployee: db.prepare(
      'SELECT * FROM wage_rates WHERE employee_id = ? ORDER BY effective_from, id',
    ),
    all: db.prepare('SELECT * FROM wage_rates ORDER BY employee_id, effective_from, id'),
    on: db.prepare(
      'SELECT * FROM wage_rates WHERE employee_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1',
    ),
  };
  const live = 'deleted_at IS NULL';
  const shift = {
    insert: db.prepare(
      'INSERT INTO shifts (employee_id, start_at, end_at, start_source, end_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    get: db.prepare('SELECT * FROM shifts WHERE id = ?'),
    latestOpen: db.prepare(
      `SELECT * FROM shifts WHERE employee_id = ? AND end_at IS NULL AND ${live} ORDER BY start_at DESC, id DESC LIMIT 1`,
    ),
    latestClosed: db.prepare(
      `SELECT * FROM shifts WHERE employee_id = ? AND end_at IS NOT NULL AND ${live} ORDER BY end_at DESC, id DESC LIMIT 1`,
    ),
    forEmployee: db.prepare(
      `SELECT * FROM shifts WHERE employee_id = ? AND ${live} ORDER BY start_at, id`,
    ),
    forEmployeeBetween: db.prepare(
      `SELECT * FROM shifts WHERE employee_id = ? AND start_at >= ? AND start_at < ? AND ${live} ORDER BY start_at, id`,
    ),
    between: db.prepare(
      `SELECT * FROM shifts WHERE start_at >= ? AND start_at < ? AND ${live} ORDER BY employee_id, start_at, id`,
    ),
    open: db.prepare(
      `SELECT * FROM shifts WHERE end_at IS NULL AND ${live} ORDER BY employee_id, start_at, id`,
    ),
    close: db.prepare(
      'UPDATE shifts SET end_at = ?, end_source = ?, overdue = 0, updated_at = ? WHERE id = ?',
    ),
    setStart: db.prepare(
      'UPDATE shifts SET start_at = ?, start_source = ?, updated_at = ? WHERE id = ?',
    ),
    markOverdue: db.prepare('UPDATE shifts SET overdue = 1, updated_at = ? WHERE id = ?'),
    softDelete: db.prepare('UPDATE shifts SET deleted_at = ?, updated_at = ? WHERE id = ?'),
  };
  const corr = {
    insert: db.prepare(
      "INSERT INTO correction_requests (employee_id, kind, at, status, requested_by, group_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
    ),
    get: db.prepare('SELECT * FROM correction_requests WHERE id = ?'),
    pending: db.prepare("SELECT * FROM correction_requests WHERE status = 'pending' ORDER BY id"),
    pendingDuplicate: db.prepare(
      "SELECT * FROM correction_requests WHERE employee_id = ? AND kind = ? AND at = ? AND status = 'pending' ORDER BY id LIMIT 1",
    ),
    pairableOut: db.prepare(
      "SELECT * FROM correction_requests WHERE employee_id = ? AND kind = 'out' AND at > ? AND at <= ? AND (status = 'pending' OR (status = 'failed' AND reason = 'noOpenShift')) ORDER BY at, id",
    ),
    decide: db.prepare(
      'UPDATE correction_requests SET status = ?, reason = ?, shift_id = ?, decided_by = ?, decided_at = ? WHERE id = ?',
    ),
  };
  const payroll = {
    insert: db.prepare(
      'INSERT INTO payroll_runs (month, run_at, triggered_by, result_json) VALUES (?, ?, ?, ?)',
    ),
    get: db.prepare('SELECT * FROM payroll_runs WHERE id = ?'),
    forMonth: db.prepare('SELECT * FROM payroll_runs WHERE month = ? ORDER BY id'),
  };
  const audit = {
    insert: db.prepare(
      'INSERT INTO audit_log (actor, action, target, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    recent: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
  };

  return {
    employees: {
      insertPending(userId: string, name: string, groupId: string | null, now: Date): number {
        return Number(emp.insert.run(userId, name, groupId, iso(now)).lastInsertRowid);
      },
      get: (id: number) => emp.get.get(id) as EmployeeRow | undefined,
      findByUserId: (userId: string) => emp.byUser.get(userId) as EmployeeRow | undefined,
      listAll: () => emp.all.all() as EmployeeRow[],
      listByStatus: (status: EmployeeStatus) => emp.byStatus.all(status) as EmployeeRow[],
      activate(id: number, actor: string, now: Date): void {
        emp.activate.run(iso(now), actor, id);
      },
      setStatus(id: number, status: EmployeeStatus): void {
        emp.setStatus.run(status, id);
      },
      /** Only for rejected registrations (§4: 駁回 deletes the application). */
      delete(id: number): void {
        emp.delete.run(id);
      },
    },
    wages: {
      insert(
        employeeId: number,
        hourlyWage: number,
        effectiveFrom: LocalDate,
        createdBy: string,
        now: Date,
      ): number {
        const r = wage.insert.run(employeeId, hourlyWage, effectiveFrom, createdBy, iso(now));
        return Number(r.lastInsertRowid);
      },
      listForEmployee: (employeeId: number) => wage.forEmployee.all(employeeId) as WageRateRow[],
      listAll: () => wage.all.all() as WageRateRow[],
      /** Rate in force on Taipei `date` (latest `effective_from <= date`; ties → newest row). */
      rateOn: (employeeId: number, date: LocalDate) =>
        wage.on.get(employeeId, date) as WageRateRow | undefined,
    },
    shifts: {
      insert(s: InsertShiftInput, now: Date): number {
        const r = shift.insert.run(
          s.employeeId,
          iso(s.startAt),
          s.endAt ? iso(s.endAt) : null,
          s.startSource,
          s.endSource,
          iso(now),
          iso(now),
        );
        return Number(r.lastInsertRowid);
      },
      /** Includes soft-deleted rows. */
      get: (id: number) => shift.get.get(id) as ShiftRow | undefined,
      latestOpen: (employeeId: number) => shift.latestOpen.get(employeeId) as ShiftRow | undefined,
      latestClosed: (employeeId: number) =>
        shift.latestClosed.get(employeeId) as ShiftRow | undefined,
      listForEmployee: (employeeId: number) => shift.forEmployee.all(employeeId) as ShiftRow[],
      /** Live shifts whose start is in `[from, to)`. */
      listForEmployeeBetween: (employeeId: number, from: Date, to: Date) =>
        shift.forEmployeeBetween.all(employeeId, iso(from), iso(to)) as ShiftRow[],
      listBetween: (from: Date, to: Date) => shift.between.all(iso(from), iso(to)) as ShiftRow[],
      listOpen: () => shift.open.all() as ShiftRow[],
      close(id: number, endAt: Date, source: ShiftSource, now: Date): void {
        shift.close.run(iso(endAt), source, iso(now), id);
      },
      setStart(id: number, startAt: Date, source: ShiftSource, now: Date): void {
        shift.setStart.run(iso(startAt), source, iso(now), id);
      },
      markOverdue(id: number, now: Date): void {
        shift.markOverdue.run(iso(now), id);
      },
      softDelete(id: number, now: Date): void {
        shift.softDelete.run(iso(now), iso(now), id);
      },
    },
    corrections: {
      insert(c: InsertCorrectionInput, now: Date): number {
        const r = corr.insert.run(
          c.employeeId,
          c.kind,
          iso(c.at),
          c.requestedBy,
          c.groupId,
          iso(now),
        );
        return Number(r.lastInsertRowid);
      },
      get: (id: number) => corr.get.get(id) as CorrectionRow | undefined,
      listPending: () => corr.pending.all() as CorrectionRow[],
      findPendingDuplicate: (employeeId: number, kind: PunchKind, at: Date) =>
        corr.pendingDuplicate.get(employeeId, kind, iso(at)) as CorrectionRow | undefined,
      /** `下班` requests in `(after, upTo]` still waiting for a `上班` (pending, or failed for lack of one). */
      listPairableOut: (employeeId: number, after: Date, upTo: Date) =>
        corr.pairableOut.all(employeeId, iso(after), iso(upTo)) as CorrectionRow[],
      decide(
        id: number,
        status: Exclude<CorrectionStatus, 'pending'>,
        reason: string | null,
        shiftId: number | null,
        actor: string,
        now: Date,
      ): void {
        corr.decide.run(status, reason, shiftId, actor, iso(now), id);
      },
    },
    payrollRuns: {
      insert(month: Month, triggeredBy: string, result: unknown, now: Date): number {
        const r = payroll.insert.run(month, iso(now), triggeredBy, JSON.stringify(result));
        return Number(r.lastInsertRowid);
      },
      get: (id: number) => payroll.get.get(id) as PayrollRunRow | undefined,
      listForMonth: (month: Month) => payroll.forMonth.all(month) as PayrollRunRow[],
    },
    audit: {
      insert(
        actor: string,
        action: string,
        target: string | null,
        before: unknown,
        after: unknown,
        now: Date,
      ): number {
        const r = audit.insert.run(actor, action, target, json(before), json(after), iso(now));
        return Number(r.lastInsertRowid);
      },
      recent: (limit = 50) => audit.recent.all(limit) as AuditRow[],
    },
  };
}

export type StaffRepo = ReturnType<typeof createStaffRepo>;
