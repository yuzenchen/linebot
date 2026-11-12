/**
 * §6 correction apply rules as a pure plan over the employee's live shifts. The service applies
 * the plan (or records the failure) inside one transaction.
 *
 * Rules:
 * - `in` at T: pair with the earliest thing after T —
 *   - a `下班` request waiting for a `上班` (pending, or failed for lack of one) within
 *     STAFF_MAX_SHIFT_HOURS → create the completed shift [T, request];
 *   - a completed shift starting later the same Taipei day → move its start back to T;
 *   - otherwise → create an open shift at T.
 * - `out` at X: close the latest open shift starting before X; none → `noOpenShift`; longer than
 *   STAFF_MAX_SHIFT_HOURS → `exceedsMaxHours`.
 * - `shift` from T to E (§15.4): create one completed shift [T, E]; it never pairs with or
 *   changes another shift or request. Longer than the limit → `exceedsMaxHours`.
 * - The changed shift must not overlap any other live shift (`overlap`). For this check an open
 *   shift spans [start, min(start + max hours, now)] (at least one millisecond).
 */
import type { CorrectionKind } from './commands.js';
import { taipeiDate } from './time.js';

export type CorrectionFailureReason = 'noOpenShift' | 'overlap' | 'exceedsMaxHours';

export interface PlanShift {
  id: number;
  startAt: Date;
  endAt: Date | null;
}

export interface PlanOutRequest {
  id: number;
  at: Date;
}

export interface PlanInput {
  kind: CorrectionKind;
  at: Date;
  /** End of a `shift` request (required for `shift`, ignored otherwise). */
  endAt?: Date | null;
  /** Live (not deleted) shifts of the employee. */
  shifts: PlanShift[];
  /** Pairable `下班` requests of the employee (ignored for `out`). */
  outRequests: PlanOutRequest[];
  maxShiftHours: number;
  now: Date;
}

export type CorrectionPlan =
  | { ok: true; op: 'create'; startAt: Date; endAt: Date | null; pairedRequestId: number | null }
  | { ok: true; op: 'close'; shiftId: number; endAt: Date }
  | { ok: true; op: 'extendStart'; shiftId: number; startAt: Date }
  | { ok: false; reason: CorrectionFailureReason; conflictShiftId: number | null };

interface Interval {
  start: number;
  end: number;
}

function openEnd(start: number, maxMs: number, now: number): number {
  return Math.max(start + 1, Math.min(start + maxMs, now));
}

function intervalOf(s: PlanShift, maxMs: number, now: number): Interval {
  const start = s.startAt.getTime();
  return { start, end: s.endAt ? s.endAt.getTime() : openEnd(start, maxMs, now) };
}

function findConflict(
  candidate: Interval,
  shifts: PlanShift[],
  excludeId: number | null,
  maxMs: number,
  now: number,
): number | null {
  for (const s of shifts) {
    if (s.id === excludeId) continue;
    const o = intervalOf(s, maxMs, now);
    if (candidate.start < o.end && o.start < candidate.end) return s.id;
  }
  return null;
}

function fail(reason: CorrectionFailureReason, conflictShiftId: number | null = null) {
  return { ok: false as const, reason, conflictShiftId };
}

/**
 * First live shift (other than `excludeId`) overlapping `candidate`, using the open-shift interval
 * rule above for open shifts on either side; null when none. Used by `修改 S0123` (§15.2).
 */
export function findShiftConflict(
  candidate: Omit<PlanShift, 'id'>,
  shifts: PlanShift[],
  excludeId: number | null,
  maxShiftHours: number,
  now: Date,
): number | null {
  const maxMs = maxShiftHours * 3_600_000;
  const interval = intervalOf({ id: -1, ...candidate }, maxMs, now.getTime());
  return findConflict(interval, shifts, excludeId, maxMs, now.getTime());
}

export function planCorrection(input: PlanInput): CorrectionPlan {
  const maxMs = input.maxShiftHours * 3_600_000;
  const now = input.now.getTime();
  const at = input.at.getTime();

  if (input.kind === 'shift') {
    if (!input.endAt) throw new Error('planCorrection: shift needs endAt');
    const end = input.endAt.getTime();
    if (end - at > maxMs) return fail('exceedsMaxHours');
    const conflict = findConflict({ start: at, end }, input.shifts, null, maxMs, now);
    if (conflict !== null) return fail('overlap', conflict);
    return { ok: true, op: 'create', startAt: input.at, endAt: input.endAt, pairedRequestId: null };
  }

  if (input.kind === 'out') {
    const open = input.shifts
      .filter((s) => s.endAt === null && s.startAt.getTime() < at)
      .sort((a, b) => b.startAt.getTime() - a.startAt.getTime() || b.id - a.id)[0];
    if (!open) return fail('noOpenShift');
    if (at - open.startAt.getTime() > maxMs) return fail('exceedsMaxHours', open.id);
    const conflict = findConflict(
      { start: open.startAt.getTime(), end: at },
      input.shifts,
      open.id,
      maxMs,
      now,
    );
    if (conflict !== null) return fail('overlap', conflict);
    return { ok: true, op: 'close', shiftId: open.id, endAt: input.at };
  }

  // kind === 'in': find the earliest shift start or pairable 下班 request after T.
  const nextShift = input.shifts
    .filter((s) => s.startAt.getTime() > at)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.id - b.id)[0];
  const nextOut = input.outRequests
    .filter((r) => r.at.getTime() > at && r.at.getTime() - at <= maxMs)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id)[0];

  if (nextOut && (!nextShift || nextOut.at.getTime() < nextShift.startAt.getTime())) {
    const candidate = { start: at, end: nextOut.at.getTime() };
    const conflict = findConflict(candidate, input.shifts, null, maxMs, now);
    if (conflict !== null) return fail('overlap', conflict);
    return {
      ok: true,
      op: 'create',
      startAt: input.at,
      endAt: nextOut.at,
      pairedRequestId: nextOut.id,
    };
  }

  if (nextShift?.endAt && taipeiDate(nextShift.startAt) === taipeiDate(input.at)) {
    const end = nextShift.endAt.getTime();
    if (end - at > maxMs) return fail('exceedsMaxHours', nextShift.id);
    const conflict = findConflict({ start: at, end }, input.shifts, nextShift.id, maxMs, now);
    if (conflict !== null) return fail('overlap', conflict);
    return { ok: true, op: 'extendStart', shiftId: nextShift.id, startAt: input.at };
  }

  const conflict = findConflict(
    { start: at, end: openEnd(at, maxMs, now) },
    input.shifts,
    null,
    maxMs,
    now,
  );
  if (conflict !== null) return fail('overlap', conflict);
  return { ok: true, op: 'create', startAt: input.at, endAt: null, pairedRequestId: null };
}
