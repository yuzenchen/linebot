/** §5 punch state machine as a pure decision over the employee's latest shifts. */
import type { PunchKind } from './commands.js';
import type { ShiftRow } from './repo.js';

/** §5: the same command again within this window is a resend (first result, no write). */
export const RESEND_WINDOW_MS = 60_000;

export type PunchDecision =
  /** Open a new shift at `now`; `staleShiftId` = an open shift older than the limit to flag. */
  | { action: 'open'; staleShiftId: number | null }
  | { action: 'alreadyIn'; shift: ShiftRow }
  /** 上班 resent within 60 s of the punch that opened `shift`. */
  | { action: 'resentIn'; shift: ShiftRow }
  | { action: 'close'; shift: ShiftRow }
  /** 下班 resent within 60 s of the punch that closed `shift`. */
  | { action: 'resentOut'; shift: ShiftRow }
  | { action: 'noOpenShift' }
  /** 下班 on an open shift older than the limit: flag it, do not close. */
  | { action: 'overdue'; shift: ShiftRow };

export interface PunchState {
  /** Latest live open shift (by start). */
  latestOpen: ShiftRow | undefined;
  /** Latest live closed shift (by end). */
  latestClosed: ShiftRow | undefined;
}

function age(from: string, now: Date): number {
  return now.getTime() - Date.parse(from);
}

export function decidePunch(
  kind: PunchKind,
  { latestOpen, latestClosed }: PunchState,
  now: Date,
  maxShiftHours: number,
): PunchDecision {
  const maxMs = maxShiftHours * 3_600_000;
  if (kind === 'in') {
    if (!latestOpen) return { action: 'open', staleShiftId: null };
    const a = age(latestOpen.start_at, now);
    if (latestOpen.start_source === 'punch' && a >= 0 && a <= RESEND_WINDOW_MS) {
      return { action: 'resentIn', shift: latestOpen };
    }
    // An open shift past the limit cannot be the current one (§5 未下班): flag it, start fresh.
    if (a > maxMs) return { action: 'open', staleShiftId: latestOpen.id };
    return { action: 'alreadyIn', shift: latestOpen };
  }

  if (
    latestClosed?.end_at &&
    latestClosed.end_source === 'punch' &&
    age(latestClosed.end_at, now) >= 0 &&
    age(latestClosed.end_at, now) <= RESEND_WINDOW_MS &&
    (!latestOpen || latestOpen.start_at < latestClosed.start_at)
  ) {
    return { action: 'resentOut', shift: latestClosed };
  }
  if (!latestOpen) return { action: 'noOpenShift' };
  if (age(latestOpen.start_at, now) > maxMs) return { action: 'overdue', shift: latestOpen };
  return { action: 'close', shift: latestOpen };
}
