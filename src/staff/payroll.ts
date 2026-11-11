/**
 * §7–8 monthly payroll as a pure calculation. The result is plain JSON (ISO strings, numbers) so
 * it can be stored verbatim in `payroll_runs.result_json`.
 *
 * - A shift belongs to the Taipei date (and month) it started on, even across midnight.
 * - Worked time = end − start, exact (no rounding, no break deduction).
 * - Each shift uses the wage in force on its start date; pay = Σ(ms × wage) / 1 h, rounded
 *   half-up to whole NT$ once per employee per month (never per shift).
 * - Open shifts are not paid; they are listed as pending. Shifts with no wage in force are not
 *   paid either and are listed as `unpricedShifts`.
 * - Flags only (no overtime pay): any day over 8 h, any Mon–Sun week over 40 h. Weekly totals
 *   include days of the week that fall in the neighbouring month.
 */
import { displayCorrectionId, displayEmployeeId, displayShiftId } from './ids.js';
import type {
  CorrectionRow,
  EmployeeRow,
  EmployeeStatus,
  ShiftRow,
  ShiftSource,
  WageRateRow,
} from './repo.js';
import type { PunchKind } from './commands.js';
import {
  addDays,
  type LocalDate,
  type Month,
  monthBounds,
  taipeiDate,
  taipeiInstant,
  taipeiMonth,
  weekStart,
} from './time.js';

export const DAY_FLAG_MINUTES = 8 * 60;
export const WEEK_FLAG_MINUTES = 40 * 60;
const HOUR_MS = 3_600_000;

export interface PayrollShiftRef {
  shiftId: number;
  displayId: string;
  date: LocalDate;
  startAt: string;
}

export interface PayrollRateLine {
  hourlyWage: number;
  shiftCount: number;
  minutes: number;
  /** Unrounded NT$ for this rate; only the employee total is rounded. */
  amount: number;
}

export interface PayrollEmployeeLine {
  employeeId: number;
  displayId: string;
  name: string;
  userId: string;
  status: EmployeeStatus;
  /** Completed, priced shifts. */
  shiftCount: number;
  /** Exact minutes (may be fractional) of those shifts. */
  totalMinutes: number;
  /** Unrounded NT$. */
  payExact: number;
  /** NT$ rounded half-up. */
  pay: number;
  /** One line per wage value, in order of first use. */
  rates: PayrollRateLine[];
  longDays: { date: LocalDate; minutes: number }[];
  longWeeks: { weekStart: LocalDate; weekEnd: LocalDate; minutes: number }[];
  /** No end time yet (未下班): not counted. */
  openShifts: PayrollShiftRef[];
  /** No wage in force on the start date: not counted. */
  unpricedShifts: PayrollShiftRef[];
}

export interface PayrollPendingCorrection {
  requestId: number;
  displayId: string;
  employeeId: number;
  employeeDisplayId: string;
  name: string;
  kind: PunchKind;
  at: string;
}

export interface PayrollResult {
  month: Month;
  computedAt: string;
  employees: PayrollEmployeeLine[];
  totals: { shiftCount: number; totalMinutes: number; pay: number };
  pending: {
    corrections: PayrollPendingCorrection[];
    registrations: { employeeId: number; displayId: string; name: string }[];
    /** Count of open + unpriced shifts across employees. */
    shiftIssues: number;
  };
  /** True when anything above needs an admin before the numbers are final. */
  hasPending: boolean;
}

export interface PayrollInput {
  month: Month;
  now: Date;
  employees: EmployeeRow[];
  wages: WageRateRow[];
  /**
   * Live shifts starting from the Monday of the month's first week up to the Sunday of its last
   * week (wider than the month so weekly flags see whole weeks).
   */
  shifts: ShiftRow[];
  pendingCorrections: CorrectionRow[];
}

/** Start instant (inclusive) / end instant (exclusive) of the shifts `calculatePayroll` needs. */
export function payrollShiftWindow(month: Month): { from: Date; to: Date } {
  const b = monthBounds(month);
  return {
    from: taipeiInstant(weekStart(b.firstDay)),
    to: taipeiInstant(addDays(weekStart(b.lastDay), 7)),
  };
}

/** Wage in force on `date` from rows of one employee (latest `effective_from <= date`, ties → newest). */
export function wageOn(rates: WageRateRow[], date: LocalDate): WageRateRow | undefined {
  let best: WageRateRow | undefined;
  for (const r of rates) {
    if (r.effective_from > date) continue;
    if (
      !best ||
      r.effective_from > best.effective_from ||
      (r.effective_from === best.effective_from && r.id > best.id)
    ) {
      best = r;
    }
  }
  return best;
}

/** Round half-up of `numerator / HOUR_MS` using integer-safe arithmetic. */
function roundHourly(numerator: number): number {
  return Math.floor((2 * numerator + HOUR_MS) / (2 * HOUR_MS));
}

function ref(s: ShiftRow): PayrollShiftRef {
  return {
    shiftId: s.id,
    displayId: displayShiftId(s.id),
    date: taipeiDate(new Date(s.start_at)),
    startAt: s.start_at,
  };
}

function durationMs(s: ShiftRow): number {
  return Date.parse(s.end_at!) - Date.parse(s.start_at);
}

/** Payroll line of one employee; `shifts` = that employee's live shifts in `payrollShiftWindow(month)`. */
export function calculateEmployeeLine(
  e: EmployeeRow,
  month: Month,
  shifts: ShiftRow[],
  rates: WageRateRow[],
): PayrollEmployeeLine {
  const { firstDay, lastDay } = monthBounds(month);
  const inMonth = shifts.filter((s) => taipeiMonth(new Date(s.start_at)) === month);
  const openShifts: PayrollShiftRef[] = [];
  const unpricedShifts: PayrollShiftRef[] = [];
  const rateLines = new Map<number, PayrollRateLine & { weighted: number }>();
  let weightedMs = 0;
  let pricedMs = 0;
  let shiftCount = 0;
  const dayMs = new Map<LocalDate, number>();

  for (const s of inMonth) {
    if (!s.end_at) {
      openShifts.push(ref(s));
      continue;
    }
    const date = taipeiDate(new Date(s.start_at));
    const ms = durationMs(s);
    dayMs.set(date, (dayMs.get(date) ?? 0) + ms);
    const rate = wageOn(rates, date);
    if (!rate) {
      unpricedShifts.push(ref(s));
      continue;
    }
    shiftCount += 1;
    pricedMs += ms;
    weightedMs += ms * rate.hourly_wage;
    const line = rateLines.get(rate.hourly_wage) ?? {
      hourlyWage: rate.hourly_wage,
      shiftCount: 0,
      minutes: 0,
      amount: 0,
      weighted: 0,
    };
    line.shiftCount += 1;
    line.weighted += ms * rate.hourly_wage;
    line.minutes += ms / 60_000;
    rateLines.set(rate.hourly_wage, line);
  }

  const weekMs = new Map<LocalDate, number>();
  for (const s of shifts) {
    if (!s.end_at) continue;
    const w = weekStart(taipeiDate(new Date(s.start_at)));
    weekMs.set(w, (weekMs.get(w) ?? 0) + durationMs(s));
  }

  return {
    employeeId: e.id,
    displayId: displayEmployeeId(e.id),
    name: e.name,
    userId: e.user_id,
    status: e.status,
    shiftCount,
    totalMinutes: pricedMs / 60_000,
    payExact: weightedMs / HOUR_MS,
    pay: roundHourly(weightedMs),
    rates: [...rateLines.values()].map(({ weighted, ...l }) => ({
      ...l,
      amount: weighted / HOUR_MS,
    })),
    longDays: [...dayMs.entries()]
      .filter(([, ms]) => ms > DAY_FLAG_MINUTES * 60_000)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, ms]) => ({ date, minutes: ms / 60_000 })),
    longWeeks: [...weekMs.entries()]
      .filter(
        ([w, ms]) => ms > WEEK_FLAG_MINUTES * 60_000 && w <= lastDay && addDays(w, 6) >= firstDay,
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([w, ms]) => ({ weekStart: w, weekEnd: addDays(w, 6), minutes: ms / 60_000 })),
    openShifts,
    unpricedShifts,
  };
}

export function calculatePayroll(input: PayrollInput): PayrollResult {
  const { month } = input;
  const byEmployee = new Map<number, ShiftRow[]>();
  for (const s of input.shifts) {
    if (s.deleted_at) continue;
    const list = byEmployee.get(s.employee_id) ?? [];
    list.push(s);
    byEmployee.set(s.employee_id, list);
  }
  const ratesByEmployee = new Map<number, WageRateRow[]>();
  for (const r of input.wages) {
    const list = ratesByEmployee.get(r.employee_id) ?? [];
    list.push(r);
    ratesByEmployee.set(r.employee_id, list);
  }
  const employeesById = new Map(input.employees.map((e) => [e.id, e]));

  const lines: PayrollEmployeeLine[] = [];
  for (const e of [...input.employees].sort((a, b) => a.id - b.id)) {
    if (e.status === 'pending') continue;
    const shifts = (byEmployee.get(e.id) ?? []).sort((a, b) =>
      a.start_at === b.start_at ? a.id - b.id : a.start_at.localeCompare(b.start_at),
    );
    const hasMonthShift = shifts.some((s) => taipeiMonth(new Date(s.start_at)) === month);
    if (e.status !== 'active' && !hasMonthShift) continue;
    lines.push(calculateEmployeeLine(e, month, shifts, ratesByEmployee.get(e.id) ?? []));
  }

  const corrections = input.pendingCorrections
    .filter((c) => c.status === 'pending')
    .map((c) => {
      const e = employeesById.get(c.employee_id);
      return {
        requestId: c.id,
        displayId: displayCorrectionId(c.id),
        employeeId: c.employee_id,
        employeeDisplayId: displayEmployeeId(c.employee_id),
        name: e?.name ?? '',
        kind: c.kind,
        at: c.at,
      };
    });
  const registrations = input.employees
    .filter((e) => e.status === 'pending')
    .map((e) => ({ employeeId: e.id, displayId: displayEmployeeId(e.id), name: e.name }));
  const shiftIssues = lines.reduce((n, l) => n + l.openShifts.length + l.unpricedShifts.length, 0);

  return {
    month,
    computedAt: input.now.toISOString(),
    employees: lines,
    totals: {
      shiftCount: lines.reduce((n, l) => n + l.shiftCount, 0),
      totalMinutes: lines.reduce((n, l) => n + l.totalMinutes, 0),
      pay: lines.reduce((n, l) => n + l.pay, 0),
    },
    pending: { corrections, registrations, shiftIssues },
    hasPending: corrections.length > 0 || registrations.length > 0 || shiftIssues > 0,
  };
}

/** One shift as shown in `我的打卡` / `打卡紀錄` / `刪除打卡`. */
export interface ShiftDetail {
  shiftId: number;
  displayId: string;
  /** Taipei date the shift belongs to (its start). */
  date: LocalDate;
  startAt: string;
  endAt: string | null;
  /** Exact minutes, null while open. */
  minutes: number | null;
  /** Wage in force on `date`, or null. */
  hourlyWage: number | null;
  startSource: ShiftSource;
  endSource: ShiftSource | null;
  overdue: boolean;
}

export function shiftDetail(s: ShiftRow, rates: WageRateRow[]): ShiftDetail {
  const date = taipeiDate(new Date(s.start_at));
  return {
    shiftId: s.id,
    displayId: displayShiftId(s.id),
    date,
    startAt: s.start_at,
    endAt: s.end_at,
    minutes: s.end_at ? durationMs(s) / 60_000 : null,
    hourlyWage: wageOn(rates, date)?.hourly_wage ?? null,
    startSource: s.start_source,
    endSource: s.end_source,
    overdue: s.overdue === 1,
  };
}
