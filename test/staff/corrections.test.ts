import { describe, expect, it } from 'vitest';
import { planCorrection } from '../../src/staff/corrections.js';
import { ADMIN, addShift, hire, setup, tp } from './helpers.js';

const D = '2026-11-12';
const NOW = tp(D, 20);

describe('planCorrection (pure)', () => {
  const base = { outRequests: [], maxShiftHours: 16, now: NOW };

  it('opens a shift for 上班 with nothing after it', () => {
    expect(planCorrection({ ...base, kind: 'in', at: tp(D, 9), shifts: [] })).toEqual({
      ok: true,
      op: 'create',
      startAt: tp(D, 9),
      endAt: null,
      pairedRequestId: null,
    });
  });

  it('pairs 上班 with the earliest waiting 下班 request', () => {
    const plan = planCorrection({
      ...base,
      kind: 'in',
      at: tp(D, 9),
      shifts: [],
      outRequests: [
        { id: 5, at: tp(D, 18) },
        { id: 4, at: tp(D, 12) },
      ],
    });
    expect(plan).toMatchObject({ ok: true, op: 'create', endAt: tp(D, 12), pairedRequestId: 4 });
  });

  it('pairs a cross-midnight 下班 request within the limit', () => {
    const plan = planCorrection({
      ...base,
      now: tp('2026-11-13', 9),
      kind: 'in',
      at: tp(D, 22),
      shifts: [],
      outRequests: [{ id: 1, at: tp('2026-11-13', 2) }],
    });
    expect(plan).toMatchObject({ ok: true, op: 'create', pairedRequestId: 1 });
  });

  it('moves the start of a later completed shift on the same day', () => {
    const plan = planCorrection({
      ...base,
      kind: 'in',
      at: tp(D, 9),
      shifts: [{ id: 3, startAt: tp(D, 10), endAt: tp(D, 18) }],
    });
    expect(plan).toEqual({ ok: true, op: 'extendStart', shiftId: 3, startAt: tp(D, 9) });
  });

  it('fails 上班 inside an existing shift as overlap', () => {
    const plan = planCorrection({
      ...base,
      kind: 'in',
      at: tp(D, 10),
      shifts: [{ id: 3, startAt: tp(D, 9), endAt: tp(D, 18) }],
    });
    expect(plan).toEqual({ ok: false, reason: 'overlap', conflictShiftId: 3 });
  });

  it('fails 上班 before an open shift on the same day as overlap', () => {
    const plan = planCorrection({
      ...base,
      kind: 'in',
      at: tp(D, 9),
      shifts: [{ id: 3, startAt: tp(D, 10), endAt: null }],
    });
    expect(plan).toEqual({ ok: false, reason: 'overlap', conflictShiftId: 3 });
  });

  it('closes the latest open shift before 下班', () => {
    const plan = planCorrection({
      ...base,
      kind: 'out',
      at: tp(D, 18),
      shifts: [
        { id: 1, startAt: tp('2026-11-10', 9), endAt: tp('2026-11-10', 18) },
        { id: 2, startAt: tp(D, 9), endAt: null },
      ],
    });
    expect(plan).toEqual({ ok: true, op: 'close', shiftId: 2, endAt: tp(D, 18) });
  });

  it('fails 下班 without an open shift, past the limit, or across another shift', () => {
    expect(
      planCorrection({
        ...base,
        kind: 'out',
        at: tp(D, 18),
        shifts: [{ id: 1, startAt: tp(D, 9), endAt: tp(D, 12) }],
      }),
    ).toEqual({ ok: false, reason: 'noOpenShift', conflictShiftId: null });
    expect(
      planCorrection({
        ...base,
        kind: 'out',
        at: tp(D, 18),
        shifts: [{ id: 1, startAt: tp('2026-11-11', 9), endAt: null }],
      }),
    ).toEqual({ ok: false, reason: 'exceedsMaxHours', conflictShiftId: 1 });
    expect(
      planCorrection({
        ...base,
        kind: 'out',
        at: tp(D, 18),
        shifts: [
          { id: 1, startAt: tp(D, 8), endAt: null },
          { id: 2, startAt: tp(D, 9), endAt: tp(D, 12) },
        ],
      }),
    ).toEqual({ ok: false, reason: 'overlap', conflictShiftId: 2 });
  });
});

describe('correction requests (§6)', () => {
  it('validates the window: not future, at most 31 days back', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-10-01', 8));
    const req = (at: Date) => svc.requestCorrection('Ua', { kind: 'in', at }, 'Cg', NOW);
    expect(req(tp(D, 20, 1)).kind).toBe('future');
    expect(req(tp('2026-10-11', 9)).kind).toBe('tooOld'); // 32 days back
    expect(req(tp('2026-10-12', 0, 0)).kind).toBe('requested'); // 31 days back
    expect(svc.requestCorrection('Unobody', { kind: 'in', at: tp(D, 9) }, null, NOW)).toEqual({
      kind: 'notRegistered',
    });
  });

  it('creates R ids, dedupes resends and later duplicates', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const first = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 9) }, 'Cg', NOW);
    expect(first).toMatchObject({
      kind: 'requested',
      resent: false,
      request: { id: 1, employee_id: e.id, kind: 'in', status: 'pending', group_id: 'Cg' },
    });
    const resend = svc.requestCorrection(
      'Ua',
      { kind: 'in', at: tp(D, 9) },
      'Cg',
      tp(D, 20, 0, 30),
    );
    expect(resend).toMatchObject({ kind: 'requested', resent: true, request: { id: 1 } });
    const later = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 9) }, null, tp(D, 21));
    expect(later).toMatchObject({ kind: 'duplicate', request: { id: 1 } });
    expect(svc.repo.corrections.listPending()).toHaveLength(1);
  });

  it('approves 上班 then 下班 into one completed shift', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const rin = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 9) }, 'Cg', NOW);
    const rout = svc.requestCorrection('Ua', { kind: 'out', at: tp(D, 18) }, 'Cg', NOW);
    if (rin.kind !== 'requested' || rout.kind !== 'requested') throw new Error();

    // Approving 上班 pairs the waiting 下班 request automatically.
    const a = svc.approveCorrection(ADMIN, rin.request.id, tp(D, 21));
    expect(a).toMatchObject({
      kind: 'approved',
      shift: {
        start_at: tp(D, 9).toISOString(),
        end_at: tp(D, 18).toISOString(),
        start_source: 'correction',
        end_source: 'correction',
      },
      request: { status: 'approved', decided_by: ADMIN },
      pairedRequest: { id: rout.request.id, status: 'approved' },
    });
    expect(svc.approveCorrection(ADMIN, rout.request.id, tp(D, 21)).kind).toBe('alreadyDecided');
    expect(svc.repo.shifts.listForEmployee(e.id)).toHaveLength(1);
  });

  it('fails 下班 without a matching 上班, then pairs it once 上班 is approved', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const rout = svc.requestCorrection('Ua', { kind: 'out', at: tp(D, 18) }, null, NOW);
    const rin = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 9) }, null, NOW);
    if (rin.kind !== 'requested' || rout.kind !== 'requested') throw new Error();

    const failed = svc.approveCorrection(ADMIN, rout.request.id, tp(D, 21));
    expect(failed).toMatchObject({
      kind: 'failed',
      reason: 'noOpenShift',
      conflictShift: null,
      request: { status: 'failed', reason: 'noOpenShift' },
    });
    expect(svc.repo.shifts.listForEmployee(e.id)).toHaveLength(0);

    const ok = svc.approveCorrection(ADMIN, rin.request.id, tp(D, 21));
    expect(ok).toMatchObject({
      kind: 'approved',
      shift: { end_at: tp(D, 18).toISOString() },
      pairedRequest: { id: rout.request.id, status: 'approved' },
    });
  });

  it('closes an open punched shift with an approved 下班', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    svc.punch('Ua', 'in', tp(D, 9));
    svc.punch('Ua', 'out', tp('2026-11-13', 2)); // 17 h → overdue flag
    const r = svc.requestCorrection(
      'Ua',
      { kind: 'out', at: tp(D, 18) },
      'Cg',
      tp('2026-11-13', 2),
    );
    if (r.kind !== 'requested') throw new Error();
    const a = svc.approveCorrection(ADMIN, r.request.id, tp('2026-11-13', 3));
    expect(a).toMatchObject({
      kind: 'approved',
      shift: { start_source: 'punch', end_source: 'correction', overdue: 0 },
    });
  });

  it('moves a late punched start back to the corrected 上班', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    svc.punch('Ua', 'in', tp(D, 10));
    svc.punch('Ua', 'out', tp(D, 18));
    const r = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 9) }, null, NOW);
    if (r.kind !== 'requested') throw new Error();
    expect(svc.approveCorrection(ADMIN, r.request.id, NOW)).toMatchObject({
      kind: 'approved',
      shift: { start_at: tp(D, 9).toISOString(), start_source: 'correction', end_source: 'punch' },
    });
  });

  it('rejects an overlapping correction without writing', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const existing = addShift(svc, e.id, tp(D, 9), tp(D, 18));
    const r = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 12) }, null, NOW);
    if (r.kind !== 'requested') throw new Error();
    const before = svc.repo.shifts.listForEmployee(e.id);
    const res = svc.approveCorrection(ADMIN, r.request.id, NOW);
    expect(res).toMatchObject({
      kind: 'failed',
      reason: 'overlap',
      conflictShift: { id: existing },
      request: { status: 'failed', reason: 'overlap' },
    });
    expect(svc.repo.shifts.listForEmployee(e.id)).toEqual(before);
    const audit = svc.repo.audit.recent(1)[0]!;
    expect(audit).toMatchObject({ actor: ADMIN, action: 'approve_correction', target: 'R001' });
    expect(JSON.parse(audit.after_json!)).toMatchObject({ status: 'failed', reason: 'overlap' });
  });

  it('rejects a request and refuses to decide it twice', () => {
    const { svc } = setup();
    hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const r = svc.requestCorrection('Ua', { kind: 'in', at: tp(D, 9) }, null, NOW);
    if (r.kind !== 'requested') throw new Error();
    expect(svc.rejectCorrection(ADMIN, r.request.id, NOW)).toMatchObject({
      kind: 'rejected',
      request: { status: 'rejected', decided_by: ADMIN },
      employee: { user_id: 'Ua' },
    });
    expect(svc.rejectCorrection(ADMIN, r.request.id, NOW).kind).toBe('alreadyDecided');
    expect(svc.approveCorrection(ADMIN, r.request.id, NOW).kind).toBe('alreadyDecided');
    expect(svc.approveCorrection(ADMIN, 99, NOW)).toEqual({ kind: 'notFound' });
    expect(svc.repo.shifts.listOpen()).toHaveLength(0);
  });

  it('applies admin 代補 at once with source admin', () => {
    const { svc } = setup();
    const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    svc.punch('Ua', 'in', tp(D, 9));
    const res = svc.adminCorrection(ADMIN, e.id, { kind: 'out', at: tp(D, 18) }, NOW);
    expect(res).toMatchObject({
      kind: 'applied',
      request: { status: 'approved', requested_by: ADMIN, decided_by: ADMIN },
      shift: { end_source: 'admin', end_at: tp(D, 18).toISOString() },
    });
    expect(svc.adminCorrection(ADMIN, e.id, { kind: 'out', at: tp(D, 19) }, NOW)).toMatchObject({
      kind: 'failed',
      reason: 'noOpenShift',
    });
    expect(svc.adminCorrection(ADMIN, e.id, { kind: 'in', at: tp(D, 21) }, NOW).kind).toBe(
      'future',
    );
    expect(svc.adminCorrection(ADMIN, 99, { kind: 'in', at: tp(D, 9) }, NOW).kind).toBe('notFound');
    svc.register('Upend', '新人', 'Cg', NOW);
    const pending = svc.repo.employees.findByUserId('Upend')!;
    expect(svc.adminCorrection(ADMIN, pending.id, { kind: 'in', at: tp(D, 9) }, NOW).kind).toBe(
      'notApproved',
    );
    expect(svc.repo.audit.recent(10).filter((a) => a.action === 'admin_correction')).toHaveLength(
      2,
    );
  });
});
