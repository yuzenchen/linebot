import { describe, expect, it } from 'vitest';
import { ADMIN, hire, setup, tp } from './helpers.js';

const D = '2026-11-12';

describe('staff punches (§5)', () => {
  it('rejects unknown, pending and disabled users', () => {
    const { svc } = setup();
    expect(svc.punch('Unobody', 'in', tp(D, 9))).toEqual({ kind: 'notRegistered' });
    svc.register('Upend', '待審', 'Cg', tp(D, 8));
    expect(svc.punch('Upend', 'in', tp(D, 9)).kind).toBe('pendingApproval');
    const e = hire(svc, 'Ua', '王小明', 200, tp(D, 8));
    svc.setEmployeeStatus(ADMIN, e.id, 'disabled', tp(D, 8, 30));
    expect(svc.punch('Ua', 'in', tp(D, 9)).kind).toBe('disabled');
    expect(svc.repo.shifts.listForEmployee(e.id)).toHaveLength(0);
  });

  it('opens, refuses a second open, and closes a shift', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp(D, 8));
    const inn = svc.punch('Ua', 'in', tp(D, 9, 2));
    expect(inn).toMatchObject({ kind: 'clockedIn', resent: false, staleShift: null });
    if (inn.kind !== 'clockedIn') throw new Error();
    expect(inn.shift.start_at).toBe(tp(D, 9, 2).toISOString());
    expect(inn.shift.start_source).toBe('punch');

    const again = svc.punch('Ua', 'in', tp(D, 9, 30));
    expect(again).toMatchObject({ kind: 'alreadyIn', shift: { id: inn.shift.id } });

    const out = svc.punch('Ua', 'out', tp(D, 18, 5));
    expect(out).toMatchObject({ kind: 'clockedOut', resent: false, minutes: 543 });
    if (out.kind !== 'clockedOut') throw new Error();
    expect(out.shift.end_at).toBe(tp(D, 18, 5).toISOString());
    expect(out.shift.end_source).toBe('punch');
    expect(svc.repo.shifts.listForEmployee(e.id)).toHaveLength(1);
  });

  it('answers 下班 without an open shift with noOpenShift', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp(D, 8));
    expect(svc.punch('Ua', 'out', tp(D, 18)).kind).toBe('noOpenShift');
  });

  it('treats the same command within 60 s as a resend (first result, no write)', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp(D, 8));
    const first = svc.punch('Ua', 'in', tp(D, 9, 0, 0));
    const resend = svc.punch('Ua', 'in', tp(D, 9, 0, 45));
    expect(resend).toMatchObject({ kind: 'clockedIn', resent: true });
    if (first.kind !== 'clockedIn' || resend.kind !== 'clockedIn') throw new Error();
    expect(resend.shift.id).toBe(first.shift.id);
    expect(svc.punch('Ua', 'in', tp(D, 9, 1, 1)).kind).toBe('alreadyIn');

    const out = svc.punch('Ua', 'out', tp(D, 18, 0, 0));
    const outResend = svc.punch('Ua', 'out', tp(D, 18, 1, 0));
    expect(outResend).toMatchObject({ kind: 'clockedOut', resent: true, minutes: 540 });
    if (out.kind !== 'clockedOut' || outResend.kind !== 'clockedOut') throw new Error();
    expect(outResend.shift).toEqual(out.shift);
    expect(svc.punch('Ua', 'out', tp(D, 18, 1, 1)).kind).toBe('noOpenShift');
    expect(svc.repo.shifts.listForEmployee(e.id)).toHaveLength(1);
  });

  it('closes a shift at exactly the limit but flags one past it (16 h rule)', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp(D, 8));
    svc.punch('Ua', 'in', tp(D, 9));
    expect(svc.punch('Ua', 'out', tp('2026-11-13', 1, 0, 0)).kind).toBe('clockedOut');

    svc.punch('Ua', 'in', tp('2026-11-13', 9));
    const over = svc.punch('Ua', 'out', tp('2026-11-14', 1, 0, 1));
    expect(over.kind).toBe('overdue');
    if (over.kind !== 'overdue') throw new Error();
    expect(over.shift.overdue).toBe(1);
    expect(over.shift.end_at).toBeNull();
    expect(svc.repo.shifts.listForEmployee(e.id)).toHaveLength(2);
  });

  it('starts a new shift when the open one is past the limit, flagging the stale one', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp(D, 8));
    const stale = svc.punch('Ua', 'in', tp(D, 9));
    const next = svc.punch('Ua', 'in', tp('2026-11-13', 9));
    expect(next.kind).toBe('clockedIn');
    if (stale.kind !== 'clockedIn' || next.kind !== 'clockedIn') throw new Error();
    expect(next.staleShift).toMatchObject({ id: stale.shift.id, overdue: 1, end_at: null });
    expect(next.shift.id).not.toBe(stale.shift.id);
    // 下班 closes the new shift, the stale one stays pending
    expect(svc.punch('Ua', 'out', tp('2026-11-13', 18))).toMatchObject({
      kind: 'clockedOut',
      shift: { id: next.shift.id },
    });
    const pending = svc.pendingItems(tp('2026-11-13', 18, 5));
    expect(pending.openShifts.map((o) => [o.shift.id, o.overdue])).toEqual([
      [stale.shift.id, true],
    ]);
  });
});
