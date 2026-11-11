import { describe, expect, it } from 'vitest';
import { ADMIN, addShift, hire, setup, tp } from './helpers.js';

const D = '2026-11-12';
const NOW = tp(D, 10);

describe('registration (§4)', () => {
  it('requests, resends within 60 s, then reports pending', () => {
    const { svc } = setup();
    const r = svc.register('Ua', '王小明', 'Cg', NOW);
    expect(r).toMatchObject({
      kind: 'requested',
      resent: false,
      employee: { id: 1, user_id: 'Ua', name: '王小明', status: 'pending', group_id: 'Cg' },
    });
    expect(svc.register('Ua', '王小明', 'Cg', tp(D, 10, 0, 59))).toMatchObject({
      kind: 'requested',
      resent: true,
    });
    expect(svc.register('Ua', '王大明', 'Cg', tp(D, 10, 5)).kind).toBe('alreadyPending');
    expect(svc.repo.employees.listAll()).toHaveLength(1);
  });

  it('approves with an hourly wage effective from the approval day', () => {
    const { svc } = setup();
    svc.register('Ua', '王小明', 'Cg', NOW);
    const a = svc.approveRegistration(ADMIN, 1, 200, tp(D, 11));
    expect(a).toMatchObject({
      kind: 'approved',
      employee: { status: 'active', approved_by: ADMIN },
      hourlyWage: 200,
      effectiveFrom: D,
      belowMinimum: false,
    });
    expect(svc.wageOn(1, D)).toBe(200);
    expect(svc.wageOn(1, '2026-11-11')).toBeNull();
    expect(svc.register('Ua', 'x', 'Cg', tp(D, 12)).kind).toBe('alreadyActive');
    expect(svc.approveRegistration(ADMIN, 1, 200, tp(D, 12)).kind).toBe('notPending');
    expect(svc.approveRegistration(ADMIN, 9, 200, tp(D, 12))).toEqual({ kind: 'notFound' });
    const audit = svc.repo.audit.recent(1)[0]!;
    expect(audit).toMatchObject({ actor: ADMIN, action: 'approve_registration', target: 'E001' });
    expect(JSON.parse(audit.before_json!)).toEqual({ status: 'pending' });
  });

  it('flags a wage below the minimum but still approves', () => {
    const { svc } = setup();
    svc.register('Ua', '王小明', 'Cg', NOW);
    expect(svc.approveRegistration(ADMIN, 1, 190, NOW)).toMatchObject({
      kind: 'approved',
      belowMinimum: true,
    });
  });

  it('rejects by deleting the application; a new registration gets a new id', () => {
    const { svc } = setup();
    svc.register('Ua', '王小明', 'Cg', NOW);
    expect(svc.rejectRegistration(ADMIN, 1, NOW)).toMatchObject({
      kind: 'rejected',
      employee: { id: 1, name: '王小明' },
    });
    expect(svc.repo.employees.get(1)).toBeUndefined();
    expect(svc.repo.audit.recent(1)[0]).toMatchObject({
      action: 'reject_registration',
      target: 'E001',
    });
    expect(svc.register('Ua', '王小明', 'Cg', tp(D, 11))).toMatchObject({
      kind: 'requested',
      employee: { id: 2 },
    });
    expect(svc.rejectRegistration(ADMIN, 1, NOW)).toEqual({ kind: 'notFound' });
  });

  it('reports disabled employees who register again', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, NOW);
    svc.setEmployeeStatus(ADMIN, e.id, 'disabled', NOW);
    expect(svc.register('Ua', '王小明', 'Cg', tp(D, 12)).kind).toBe('disabled');
    expect(svc.rejectRegistration(ADMIN, e.id, NOW).kind).toBe('notPending');
  });
});

describe('wages (§7)', () => {
  it('sets a wage from today or from a given date, reporting the previous rate', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 9));
    expect(svc.setWage(ADMIN, e.id, 210, '2026-12-01', NOW)).toMatchObject({
      kind: 'set',
      hourlyWage: 210,
      effectiveFrom: '2026-12-01',
      previousWage: 200,
      belowMinimum: false,
    });
    expect(svc.setWage(ADMIN, e.id, 150, null, NOW)).toMatchObject({
      kind: 'set',
      effectiveFrom: D,
      previousWage: 200,
      belowMinimum: true,
    });
    expect(svc.wageOn(e.id, '2026-11-11')).toBe(200);
    expect(svc.wageOn(e.id, D)).toBe(150);
    expect(svc.wageOn(e.id, '2026-12-01')).toBe(210);
    // Same effective date again: the newest row wins.
    svc.setWage(ADMIN, e.id, 220, '2026-12-01', tp(D, 11));
    expect(svc.wageOn(e.id, '2026-12-31')).toBe(220);
    expect(svc.setWage(ADMIN, 99, 200, null, NOW)).toEqual({ kind: 'notFound' });
    const audit = svc.repo.audit.recent(1)[0]!;
    expect(audit).toMatchObject({ action: 'set_wage', target: 'E001' });
    expect(JSON.parse(audit.before_json!)).toEqual({
      hourlyWage: 210,
      effectiveFrom: '2026-12-01',
    });
    expect(JSON.parse(audit.after_json!)).toEqual({ hourlyWage: 220, effectiveFrom: '2026-12-01' });
  });

  it('refuses wages for pending registrations', () => {
    const { svc } = setup();
    svc.register('Ua', '王小明', 'Cg', NOW);
    expect(svc.setWage(ADMIN, 1, 200, null, NOW).kind).toBe('notApproved');
  });
});

describe('admin operations (§9)', () => {
  it('lists employees with the wage in force today', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 9));
    svc.register('Ub', '李小華', 'Cg', NOW);
    expect(
      svc.listEmployees(NOW).map((i) => [i.displayId, i.employee.status, i.currentWage]),
    ).toEqual([
      ['E001', 'active', 200],
      ['E002', 'pending', null],
    ]);
  });

  it('lists pending registrations, corrections and open shifts', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 9));
    svc.register('Ub', '李小華', 'Cg', NOW);
    svc.requestCorrection('Ua', { kind: 'in', at: tp('2026-11-10', 9) }, null, NOW);
    addShift(svc, e.id, tp('2026-11-10', 13), null);
    const p = svc.pendingItems(NOW);
    expect(p.registrations.map((r) => r.name)).toEqual(['李小華']);
    expect(p.corrections.map((c) => [c.request.id, c.employee.name])).toEqual([[1, '王小明']]);
    expect(p.openShifts.map((o) => o.overdue)).toEqual([true]);
  });

  it('lists a day of shifts and soft-deletes one by S id', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 9));
    const s1 = addShift(svc, e.id, tp('2026-11-11', 9), tp('2026-11-11', 12));
    const s2 = addShift(svc, e.id, tp('2026-11-11', 23), tp(D, 3)); // cross-midnight → 11/11
    addShift(svc, e.id, tp(D, 9), tp(D, 12));
    const day = svc.listShiftsOnDay(e.id, '2026-11-11');
    if (day.kind !== 'ok') throw new Error();
    expect(day.shifts.map((s) => [s.displayId, s.minutes, s.hourlyWage])).toEqual([
      ['S0001', 180, 200],
      ['S0002', 240, 200],
    ]);

    const del = svc.deleteShift(ADMIN, s2, NOW);
    expect(del).toMatchObject({ kind: 'deleted', shift: { id: s2 }, employee: { id: e.id } });
    if (del.kind !== 'deleted') throw new Error();
    expect(del.shift.deleted_at).toBe(NOW.toISOString());
    expect(svc.deleteShift(ADMIN, s2, NOW).kind).toBe('alreadyDeleted');
    expect(svc.deleteShift(ADMIN, 99, NOW)).toEqual({ kind: 'notFound' });
    const after = svc.listShiftsOnDay(e.id, '2026-11-11');
    if (after.kind !== 'ok') throw new Error();
    expect(after.shifts.map((s) => s.shiftId)).toEqual([s1]);
    expect(svc.repo.shifts.get(s2)).toBeDefined(); // still stored
    const audit = svc.repo.audit.recent(1)[0]!;
    expect(audit).toMatchObject({ action: 'delete_shift', target: 'S0002' });
    expect(JSON.parse(audit.before_json!)).toMatchObject({ employee: 'E001', deleted_at: null });
    expect(svc.listShiftsOnDay(99, D)).toEqual({ kind: 'notFound' });
  });

  it('disables and re-enables an employee, keeping records', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 9));
    svc.punch('Ua', 'in', tp(D, 9));
    svc.punch('Ua', 'out', tp(D, 10));
    expect(svc.setEmployeeStatus(ADMIN, e.id, 'disabled', NOW)).toMatchObject({
      kind: 'updated',
      previous: 'active',
      employee: { status: 'disabled' },
    });
    expect(svc.setEmployeeStatus(ADMIN, e.id, 'disabled', NOW).kind).toBe('unchanged');
    expect(svc.punch('Ua', 'in', tp(D, 11)).kind).toBe('disabled');
    const mine = svc.myRecords('Ua', '2026-11');
    expect(mine).toMatchObject({ kind: 'ok', summary: { shiftCount: 1, pay: 200 } });
    expect(svc.setEmployeeStatus(ADMIN, e.id, 'active', NOW).kind).toBe('updated');
    expect(svc.punch('Ua', 'in', tp(D, 11)).kind).toBe('clockedIn');
    expect(svc.repo.audit.recent(10).map((a) => a.action)).toEqual(
      expect.arrayContaining(['disable_employee', 'enable_employee']),
    );
    svc.register('Ub', '李小華', 'Cg', NOW);
    expect(svc.setEmployeeStatus(ADMIN, 2, 'active', NOW).kind).toBe('notApproved');
    expect(svc.setEmployeeStatus(ADMIN, 9, 'active', NOW)).toEqual({ kind: 'notFound' });
  });

  it('answers 我的打卡 only for registered, approved users', () => {
    const { svc } = setup();
    expect(svc.myRecords('Unobody', '2026-11')).toEqual({ kind: 'notRegistered' });
    svc.register('Ub', '李小華', 'Cg', NOW);
    expect(svc.myRecords('Ub', '2026-11').kind).toBe('pendingApproval');
  });
});
