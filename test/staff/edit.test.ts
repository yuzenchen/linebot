import { describe, expect, it } from 'vitest';
import type { EditShiftInput } from '../../src/staff/service.js';
import { ADMIN, addShift, hire, setup, tp } from './helpers.js';

const D = '2026-11-12';
const NOW = tp('2026-11-13', 12);

const edit = (
  kind: 'in' | 'out',
  hour: number,
  minute = 0,
  date: string | null = null,
): EditShiftInput => ({ kind, date, hour, minute });

function fixture() {
  const { svc } = setup();
  const e = hire(svc, 'Ua', '王小明', 200, tp('2026-10-01', 8));
  const id = addShift(svc, e.id, tp(D, 9), tp(D, 18));
  return { svc, e, id };
}

describe('修改 S0123 (§15.2)', () => {
  it('moves 上班 on the shift start date; source admin; audit before / after', () => {
    const { svc, e, id } = fixture();
    const r = svc.editShift(ADMIN, id, edit('in', 8, 30), NOW);
    expect(r).toMatchObject({
      kind: 'edited',
      minutes: 570,
      settledMonths: [],
      employee: { id: e.id },
      before: { start_at: tp(D, 9).toISOString(), start_source: 'punch' },
      shift: {
        start_at: tp(D, 8, 30).toISOString(),
        end_at: tp(D, 18).toISOString(),
        start_source: 'admin',
        end_source: 'punch',
      },
    });
    const audit = svc.repo.audit.recent(1)[0]!;
    expect(audit).toMatchObject({ actor: ADMIN, action: 'edit_shift', target: 'S0001' });
    expect(JSON.parse(audit.before_json!)).toMatchObject({
      employee: 'E001',
      id: 'S0001',
      start_at: tp(D, 9).toISOString(),
      start_source: 'punch',
    });
    expect(JSON.parse(audit.after_json!)).toMatchObject({
      start_at: tp(D, 8, 30).toISOString(),
      start_source: 'admin',
      end_source: 'punch',
    });
  });

  it('moves 下班 on the start date, or the next day when not after the start', () => {
    const { svc, id } = fixture();
    expect(svc.editShift(ADMIN, id, edit('out', 18, 30), NOW)).toMatchObject({
      kind: 'edited',
      minutes: 570,
      shift: { end_at: tp(D, 18, 30).toISOString(), end_source: 'admin', start_source: 'punch' },
    });

    const night = addShift(svc, 1, tp(D, 22), tp(D, 23));
    expect(svc.editShift(ADMIN, night, edit('out', 2), NOW)).toMatchObject({
      kind: 'edited',
      minutes: 240,
      shift: { end_at: tp('2026-11-13', 2).toISOString() },
    });
    // A typed date is used as is.
    expect(svc.editShift(ADMIN, night, edit('out', 1, 30, '2026-11-13'), NOW)).toMatchObject({
      kind: 'edited',
      shift: { end_at: tp('2026-11-13', 1, 30).toISOString() },
    });
    expect(svc.editShift(ADMIN, night, edit('out', 23, 30, D), NOW)).toMatchObject({
      kind: 'edited',
      shift: { end_at: tp(D, 23, 30).toISOString() },
    });
  });

  it('closes an open (overdue) shift by editing its 下班; editing 上班 keeps it open', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-10-01', 8));
    svc.punch('Ua', 'in', tp(D, 9));
    svc.punch('Ua', 'out', tp('2026-11-13', 2)); // 17 h → flagged overdue, left open
    const open = svc.repo.shifts.listOpen()[0]!;
    expect(open.overdue).toBe(1);
    expect(svc.editShift(ADMIN, open.id, edit('in', 9, 15), NOW)).toMatchObject({
      kind: 'edited',
      minutes: null,
      shift: { end_at: null, start_source: 'admin', overdue: 0 },
    });
    expect(svc.editShift(ADMIN, open.id, edit('out', 18), NOW)).toMatchObject({
      kind: 'edited',
      minutes: 525,
      shift: {
        end_at: tp(D, 18).toISOString(),
        start_source: 'admin',
        end_source: 'admin',
        overdue: 0,
      },
    });
    expect(svc.repo.shifts.listOpen()).toHaveLength(0);
  });

  it('refuses start not before end, too long, future, before the 1st of last month — writing nothing', () => {
    const { svc, e, id } = fixture();
    const before = svc.repo.shifts.listForEmployee(e.id);
    const auditCount = svc.repo.audit.recent(100).length;
    const refused = (r: ReturnType<typeof svc.editShift>) =>
      r.kind === 'refused' ? r.reason : r.kind;

    expect(refused(svc.editShift(ADMIN, id, edit('in', 18), NOW))).toBe('notAfterStart');
    expect(refused(svc.editShift(ADMIN, id, edit('in', 19, 0, D), NOW))).toBe('notAfterStart');
    expect(refused(svc.editShift(ADMIN, id, edit('out', 8, 0, D), NOW))).toBe('notAfterStart');
    // 下班 02:00 without a date → next day → 17 h.
    expect(refused(svc.editShift(ADMIN, id, edit('out', 2), NOW))).toBe('exceedsMaxHours');
    expect(refused(svc.editShift(ADMIN, id, edit('in', 1, 59), NOW))).toBe('exceedsMaxHours');

    const today = addShift(svc, e.id, tp('2026-11-13', 9), null);
    expect(refused(svc.editShift(ADMIN, today, edit('out', 12, 1), NOW))).toBe('future');
    expect(refused(svc.editShift(ADMIN, today, edit('in', 12, 30), NOW))).toBe('future');

    const old = addShift(svc, e.id, tp('2026-09-30', 9), tp('2026-09-30', 18)); // before 10/1
    expect(refused(svc.editShift(ADMIN, old, edit('out', 17), NOW))).toBe('tooOld');
    const edge = addShift(svc, e.id, tp('2026-10-01', 9), tp('2026-10-01', 18)); // 1st of last month
    expect(svc.editShift(ADMIN, edge, edit('out', 17), NOW).kind).toBe('edited');

    const shiftsNow = svc.repo.shifts.listForEmployee(e.id);
    expect(shiftsNow.find((s) => s.id === id)).toEqual(before.find((s) => s.id === id));
    // Only the one accepted edit was audited.
    expect(svc.repo.audit.recent(100).length).toBe(auditCount + 1);
  });

  it("refuses an overlap with the employee's other shifts, open ones included", () => {
    const { svc, e, id } = fixture();
    const other = hire(svc, 'Ub', '李小華', 200, tp('2026-10-01', 8));
    addShift(svc, other.id, tp(D, 18), tp(D, 22)); // another employee: no conflict
    const evening = addShift(svc, e.id, tp(D, 19), tp(D, 21));
    const r = svc.editShift(ADMIN, id, edit('out', 19, 30), NOW);
    expect(r).toMatchObject({ kind: 'refused', reason: 'overlap', conflictShift: { id: evening } });
    expect(svc.editShift(ADMIN, id, edit('out', 19), NOW).kind).toBe('edited'); // touching is fine

    const open = addShift(svc, e.id, tp('2026-11-13', 8), null);
    const late = addShift(svc, e.id, tp('2026-11-13', 1), tp('2026-11-13', 2));
    expect(svc.editShift(ADMIN, late, edit('out', 9), NOW)).toMatchObject({
      kind: 'refused',
      reason: 'overlap',
      conflictShift: { id: open, end_at: null },
    });
  });

  it('answers notFound / deleted', () => {
    const { svc, id } = fixture();
    expect(svc.editShift(ADMIN, 99, edit('in', 8), NOW)).toEqual({ kind: 'notFound' });
    svc.deleteShift(ADMIN, id, NOW);
    expect(svc.editShift(ADMIN, id, edit('in', 8), NOW)).toMatchObject({
      kind: 'deleted',
      shift: { id },
    });
  });

  it('reports settled months for 修改, 代補 and 刪除 once a payroll run exists', () => {
    const { svc, e, id } = fixture();
    expect(svc.editShift(ADMIN, id, edit('in', 8), NOW)).toMatchObject({ settledMonths: [] });
    svc.runPayroll('2026-11', ADMIN, NOW);
    expect(svc.editShift(ADMIN, id, edit('in', 8, 30), NOW)).toMatchObject({
      settledMonths: ['2026-11'],
    });
    // Moving a start across the month boundary touches both months (before and after).
    const night = addShift(svc, e.id, tp('2026-10-31', 22), tp('2026-11-01', 2));
    expect(svc.editShift(ADMIN, night, edit('in', 0, 30, '2026-11-01'), NOW)).toMatchObject({
      kind: 'edited',
      settledMonths: ['2026-11'],
    });
    svc.runPayroll('2026-10', ADMIN, NOW);
    expect(svc.editShift(ADMIN, night, edit('in', 23, 0, '2026-10-31'), NOW)).toMatchObject({
      kind: 'edited',
      settledMonths: ['2026-11', '2026-10'],
    });
    expect(
      svc.adminCorrection(ADMIN, e.id, { kind: 'in', at: tp('2026-11-10', 9) }, NOW),
    ).toMatchObject({ kind: 'applied', settledMonths: ['2026-11'] });
    const september = addShift(svc, e.id, tp('2026-09-30', 9), tp('2026-09-30', 18));
    expect(svc.deleteShift(ADMIN, september, NOW)).toMatchObject({ settledMonths: [] });
    expect(svc.deleteShift(ADMIN, id, NOW)).toMatchObject({ settledMonths: ['2026-11'] });
  });
});
