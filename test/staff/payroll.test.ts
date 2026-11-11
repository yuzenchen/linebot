import { describe, expect, it } from 'vitest';
import { payrollShiftWindow, wageOn } from '../../src/staff/payroll.js';
import type { WageRateRow } from '../../src/staff/repo.js';
import { ADMIN, addShift, hire, setup, tp } from './helpers.js';

const RUN_AT = tp('2026-12-01', 9);

describe('payroll calculation (§7–8)', () => {
  it('assigns cross-midnight shifts to their start day and month', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-10-01', 9));
    addShift(svc, e.id, tp('2026-10-31', 22), tp('2026-11-01', 2)); // October
    addShift(svc, e.id, tp('2026-11-03', 9), tp('2026-11-03', 18)); // 540 min
    addShift(svc, e.id, tp('2026-11-30', 22), tp('2026-12-01', 2)); // November, 240 min

    const nov = svc.computePayroll('2026-11', RUN_AT);
    expect(nov.employees).toHaveLength(1);
    expect(nov.employees[0]).toMatchObject({
      displayId: 'E001',
      name: '王小明',
      shiftCount: 2,
      totalMinutes: 780,
      pay: 2600,
    });
    const oct = svc.computePayroll('2026-10', RUN_AT);
    expect(oct.employees[0]).toMatchObject({ shiftCount: 1, totalMinutes: 240, pay: 800 });
    const dec = svc.computePayroll('2026-12', RUN_AT);
    expect(dec.employees[0]).toMatchObject({ shiftCount: 0, pay: 0 });
  });

  it('uses the wage in force on each shift start date and lists rates separately', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    svc.setWage(ADMIN, e.id, 230, '2026-11-16', tp('2026-11-10', 9));
    addShift(svc, e.id, tp('2026-11-15', 20), tp('2026-11-16', 2)); // starts on the old rate
    addShift(svc, e.id, tp('2026-11-16', 9), tp('2026-11-16', 13));
    addShift(svc, e.id, tp('2026-11-17', 9), tp('2026-11-17', 13));
    const line = svc.computePayroll('2026-11', RUN_AT).employees[0]!;
    expect(line.rates).toEqual([
      { hourlyWage: 200, shiftCount: 1, minutes: 360, amount: 1200 },
      { hourlyWage: 230, shiftCount: 2, minutes: 480, amount: 1840 },
    ]);
    expect(line.pay).toBe(3040);
  });

  it('rounds once on the monthly total, not per shift', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 201, tp('2026-11-01', 8));
    // 10 minutes at 201/h = 33.5 each; per-shift rounding would give 68.
    addShift(svc, e.id, tp('2026-11-02', 9), tp('2026-11-02', 9, 10));
    addShift(svc, e.id, tp('2026-11-03', 9), tp('2026-11-03', 9, 10));
    const line = svc.computePayroll('2026-11', RUN_AT).employees[0]!;
    expect(line.payExact).toBeCloseTo(67, 10);
    expect(line.pay).toBe(67);
    // A single 33.5 rounds half-up to 34.
    const { svc: svc2 } = setup();
    const e2 = hire(svc2, 'Ua', '王小明', 201, tp('2026-11-01', 8));
    addShift(svc2, e2.id, tp('2026-11-02', 9), tp('2026-11-02', 9, 10));
    expect(svc2.computePayroll('2026-11', RUN_AT).employees[0]!.pay).toBe(34);
  });

  it('counts exact seconds without rounding minutes', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    svc.punch('Ua', 'in', tp('2026-11-02', 9, 0, 30));
    svc.punch('Ua', 'out', tp('2026-11-02', 18, 3, 0));
    const line = svc.computePayroll('2026-11', RUN_AT).employees[0]!;
    expect(line.totalMinutes).toBeCloseTo(542.5, 10);
    expect(line.payExact).toBeCloseTo(1808.3333, 3);
    expect(line.pay).toBe(1808);
  });

  it('flags days over 8 h and Mon–Sun weeks over 40 h, including days in the previous month', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-10-01', 8));
    // Week Mon 10/26 – Sun 11/1: 5 × 8 h in October + 1 h on 11/1 → 41 h
    for (const d of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
      addShift(svc, e.id, tp(d, 9), tp(d, 17));
    }
    addShift(svc, e.id, tp('2026-11-01', 9), tp('2026-11-01', 10));
    // 11/4: two shifts totalling 9 h
    addShift(svc, e.id, tp('2026-11-04', 8), tp('2026-11-04', 12));
    addShift(svc, e.id, tp('2026-11-04', 13), tp('2026-11-04', 18));
    // exactly 8 h is not flagged
    addShift(svc, e.id, tp('2026-11-05', 9), tp('2026-11-05', 17));

    const line = svc.computePayroll('2026-11', RUN_AT).employees[0]!;
    expect(line.longDays).toEqual([{ date: '2026-11-04', minutes: 540 }]);
    expect(line.longWeeks).toEqual([
      { weekStart: '2026-10-26', weekEnd: '2026-11-01', minutes: 2460 },
    ]);
    // Flags do not change pay: 1 + 9 + 8 = 18 h × 200
    expect(line.pay).toBe(3600);
    expect(line.shiftCount).toBe(4);
  });

  it('lists open, unpriced and pending items without paying them', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-10', 8));
    const open = addShift(svc, e.id, tp('2026-11-20', 9), null);
    const early = addShift(svc, e.id, tp('2026-11-05', 9), tp('2026-11-05', 12)); // before any wage
    addShift(svc, e.id, tp('2026-11-21', 9), tp('2026-11-21', 12));
    svc.register('Ub', '李小華', 'Cg', tp('2026-11-25', 9));
    svc.requestCorrection(
      'Ua',
      { kind: 'out', at: tp('2026-11-20', 18) },
      null,
      tp('2026-11-25', 9),
    );

    const r = svc.computePayroll('2026-11', tp('2026-11-26', 9));
    const line = r.employees[0]!;
    expect(line.openShifts.map((s) => [s.shiftId, s.displayId, s.date])).toEqual([
      [open, 'S0001', '2026-11-20'],
    ]);
    expect(line.unpricedShifts.map((s) => s.shiftId)).toEqual([early]);
    expect(line).toMatchObject({ shiftCount: 1, totalMinutes: 180, pay: 600 });
    expect(r.pending.registrations).toEqual([{ employeeId: 2, displayId: 'E002', name: '李小華' }]);
    expect(r.pending.corrections).toMatchObject([
      { displayId: 'R001', employeeDisplayId: 'E001', name: '王小明', kind: 'out' },
    ]);
    expect(r.pending.shiftIssues).toBe(2);
    expect(r.hasPending).toBe(true);
    expect(r.employees.map((l) => l.displayId)).toEqual(['E001']); // pending E002 not paid
  });

  it('totals employees, includes disabled ones only with shifts, ignores deleted shifts', () => {
    const { svc } = setup();
    const a = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const b = hire(svc, 'Ub', '李小華', 250, tp('2026-11-01', 8));
    const c = hire(svc, 'Uc', '陳小美', 300, tp('2026-11-01', 8));
    addShift(svc, a.id, tp('2026-11-02', 9), tp('2026-11-02', 17)); // 1600
    const gone = addShift(svc, a.id, tp('2026-11-03', 9), tp('2026-11-03', 17));
    svc.deleteShift(ADMIN, gone, tp('2026-11-04', 9));
    addShift(svc, b.id, tp('2026-11-02', 9), tp('2026-11-02', 13)); // 1000
    svc.setEmployeeStatus(ADMIN, b.id, 'disabled', tp('2026-11-05', 9));
    svc.setEmployeeStatus(ADMIN, c.id, 'disabled', tp('2026-11-05', 9)); // no shifts → omitted

    const r = svc.computePayroll('2026-11', RUN_AT);
    expect(r.employees.map((l) => [l.displayId, l.status, l.pay])).toEqual([
      ['E001', 'active', 1600],
      ['E002', 'disabled', 1000],
    ]);
    expect(r.totals).toEqual({ shiftCount: 2, totalMinutes: 720, pay: 2600 });
    expect(r.hasPending).toBe(false);
  });

  it('stores every run as a new payroll_runs row with a JSON snapshot', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    addShift(svc, e.id, tp('2026-11-02', 9), tp('2026-11-02', 17));
    const first = svc.runPayroll('2026-11', 'schedule', RUN_AT);
    const second = svc.runPayroll('2026-11', ADMIN, tp('2026-12-02', 9));
    expect(second.runId).toBeGreaterThan(first.runId);
    const rows = svc.repo.payrollRuns.listForMonth('2026-11');
    expect(rows.map((r) => r.triggered_by)).toEqual(['schedule', ADMIN]);
    expect(JSON.parse(rows[0]!.result_json)).toEqual(first.result);
    expect(first.result.computedAt).toBe(RUN_AT.toISOString());
    expect(svc.repo.audit.recent(2).map((a) => [a.actor, a.action, a.target])).toEqual([
      [ADMIN, 'payroll_run', '2026-11'],
      ['schedule', 'payroll_run', '2026-11'],
    ]);
  });

  it('returns per-shift details and the monthly summary for records', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    addShift(svc, e.id, tp('2026-11-02', 9), tp('2026-11-02', 17));
    addShift(svc, e.id, tp('2026-10-31', 9), tp('2026-10-31', 17)); // other month
    const rec = svc.shiftRecords(e.id, '2026-11');
    if (rec.kind !== 'ok') throw new Error();
    expect(rec.shifts).toEqual([
      {
        shiftId: 1,
        displayId: 'S0001',
        date: '2026-11-02',
        startAt: tp('2026-11-02', 9).toISOString(),
        endAt: tp('2026-11-02', 17).toISOString(),
        minutes: 480,
        hourlyWage: 200,
        startSource: 'punch',
        endSource: 'punch',
        overdue: false,
      },
    ]);
    expect(rec.summary).toMatchObject({ shiftCount: 1, pay: 1600 });
    expect(svc.shiftRecords(99, '2026-11')).toEqual({ kind: 'notFound' });
  });
});

describe('payroll helpers', () => {
  it('widens the shift window to whole Mon–Sun weeks', () => {
    const w = payrollShiftWindow('2026-11'); // 11/1 is a Sunday, 11/30 a Monday
    expect(w.from.toISOString()).toBe(tp('2026-10-26', 0).toISOString());
    expect(w.to.toISOString()).toBe(tp('2026-12-07', 0).toISOString());
  });

  it('picks the latest effective rate, newest row on ties', () => {
    const rows = [
      { id: 1, effective_from: '2026-11-01', hourly_wage: 200 },
      { id: 3, effective_from: '2026-12-01', hourly_wage: 220 },
      { id: 2, effective_from: '2026-12-01', hourly_wage: 210 },
    ] as WageRateRow[];
    expect(wageOn(rows, '2026-10-31')).toBeUndefined();
    expect(wageOn(rows, '2026-11-30')?.hourly_wage).toBe(200);
    expect(wageOn(rows, '2026-12-01')?.hourly_wage).toBe(220);
  });
});
