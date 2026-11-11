/**
 * Fixed-format command parser for the staff bot (SPEC-STAFF §4–6, §9). Pure: the caller decides
 * who may run what (employee vs admin, group vs DM) and maps outcomes to `texts.ts`.
 */
import { parseCorrectionId, parseEmployeeId, parseShiftId } from './ids.js';
import {
  daysBetween,
  formatLocalDate,
  isValidDate,
  type LocalDate,
  type Month,
  taipeiDate,
  taipeiInstant,
  taipeiMonth,
  taipeiYear,
} from './time.js';

export type PunchKind = 'in' | 'out';

/** Longest accepted registration name (characters). */
export const MAX_NAME_LENGTH = 20;

/** A correction time as typed, resolved to a Taipei date and the matching instant. */
export interface CorrectionTime {
  date: LocalDate;
  /** `HH:MM`. */
  time: string;
  at: Date;
  kind: PunchKind;
}

/** First word of every command; `malformed` echoes it so the caller can show usage. */
export type CommandKeyword =
  | '註冊'
  | '補卡'
  | '我的打卡'
  | '我的薪資'
  | '說明'
  | '員工列表'
  | '待處理'
  | '核准'
  | '駁回'
  | '時薪'
  | '刪除打卡'
  | '刪除'
  | '停用'
  | '啟用'
  | '打卡紀錄'
  | '結算';

export type StaffCommand =
  // --- employee ---
  | { type: 'punch'; kind: PunchKind }
  | { type: 'register'; name: string }
  | ({ type: 'correction' } & CorrectionTime)
  | { type: 'myShifts'; month: Month; explicitMonth: boolean }
  | { type: 'myPay'; month: Month; explicitMonth: boolean }
  | { type: 'help' }
  // --- admin ---
  | ({ type: 'adminCorrection'; employeeId: number } & CorrectionTime)
  | { type: 'listEmployees' }
  | { type: 'pending' }
  | { type: 'approveRegistration'; employeeId: number; hourlyWage: number }
  | { type: 'rejectRegistration'; employeeId: number }
  | { type: 'approveCorrection'; requestId: number }
  | { type: 'rejectCorrection'; requestId: number }
  /** `effectiveFrom` null = from today (the caller resolves it with its own `now`). */
  | { type: 'setWage'; employeeId: number; hourlyWage: number; effectiveFrom: LocalDate | null }
  | { type: 'listShiftsForDelete'; employeeId: number; date: LocalDate }
  | { type: 'deleteShift'; shiftId: number }
  | { type: 'disableEmployee'; employeeId: number }
  | { type: 'enableEmployee'; employeeId: number }
  | { type: 'shiftRecords'; employeeId: number; month: Month; explicitMonth: boolean }
  | { type: 'runPayroll'; month: Month; notifyEmployees: boolean }
  /** Known keyword with unusable arguments (bad date, missing wage, …). */
  | { type: 'malformed'; keyword: CommandKeyword };

const KEYWORDS = new Set<string>([
  '註冊',
  '補卡',
  '我的打卡',
  '我的薪資',
  '說明',
  '員工列表',
  '待處理',
  '核准',
  '駁回',
  '時薪',
  '刪除打卡',
  '刪除',
  '停用',
  '啟用',
  '打卡紀錄',
  '結算',
]);

/** Full-width ASCII (`１１／１２`, `０９：００`) → half-width. */
function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * How a year-less `M/D` is resolved:
 * - `past`: the most recent such date that is not after today (补卡, 刪除打卡);
 * - `nearest`: the occurrence closest to today, future allowed (`自 12/1` for wages).
 */
export type YearMode = 'past' | 'nearest';

/** `11/12`, `2026/11/12` or `2026-11-12` → Taipei date; invalid → null. */
export function parseDateToken(token: string, now: Date, mode: YearMode): LocalDate | null {
  const full = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(token);
  if (full) {
    const [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    return isValidDate(y, m, d) ? formatLocalDate(y, m, d) : null;
  }
  const short = /^(\d{1,2})\/(\d{1,2})$/.exec(token);
  if (!short) return null;
  const [m, d] = [Number(short[1]), Number(short[2])];
  if (!isValidDate(2000, m, d)) return null; // 2000 is a leap year: accepts 2/29
  const today = taipeiDate(now);
  const year = taipeiYear(now);
  if (mode === 'past') {
    for (let y = year; y > year - 9; y -= 1) {
      if (!isValidDate(y, m, d)) continue;
      const candidate = formatLocalDate(y, m, d);
      if (candidate <= today) return candidate;
    }
    return null;
  }
  let best: LocalDate | null = null;
  let bestDistance = Infinity;
  for (const y of [year - 1, year, year + 1]) {
    if (!isValidDate(y, m, d)) continue;
    const candidate = formatLocalDate(y, m, d);
    const distance = Math.abs(daysBetween(today, candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** `9:00` / `09:00` → `09:00`; invalid → null. */
export function parseTimeToken(token: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** `2026-11` / `2026/11` / `2026-1` → `2026-11`; invalid → null. */
export function parseMonthToken(token: string): Month | null {
  const m = /^(\d{4})[-/](\d{1,2})$/.exec(token);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12 || Number(m[1]) < 1970) return null;
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

function parseKind(token: string | undefined): PunchKind | null {
  if (token === '上班') return 'in';
  if (token === '下班') return 'out';
  return null;
}

function parseWage(token: string | undefined): number | null {
  if (!token || !/^\d{1,6}$/.test(token)) return null;
  const n = Number(token);
  return n > 0 ? n : null;
}

function parseCorrectionArgs(args: string[], now: Date): CorrectionTime | null {
  if (args.length !== 3) return null;
  const date = parseDateToken(args[0]!, now, 'past');
  const time = parseTimeToken(args[1]!);
  const kind = parseKind(args[2]);
  if (!date || !time || !kind) return null;
  return {
    date,
    time: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
    at: taipeiInstant(date, time.hour, time.minute),
    kind,
  };
}

/** Optional single month argument; missing → the current Taipei month. */
function parseOptionalMonth(
  args: string[],
  now: Date,
): { month: Month; explicitMonth: boolean } | null {
  if (args.length === 0) return { month: taipeiMonth(now), explicitMonth: false };
  if (args.length !== 1) return null;
  const month = parseMonthToken(args[0]!);
  return month ? { month, explicitMonth: true } : null;
}

/**
 * Parses one message. `now` resolves year-less dates and default months (Taipei).
 * Returns null for anything that is not a staff command (ordinary chat).
 */
export function parseStaffCommand(text: string, now: Date): StaffCommand | null {
  const trimmed = text.trim();
  // §5: punches only when the whole message is exactly 上班 / 下班.
  if (trimmed === '上班') return { type: 'punch', kind: 'in' };
  if (trimmed === '下班') return { type: 'punch', kind: 'out' };

  const tokens = toHalfWidth(trimmed).split(/\s+/).filter(Boolean);
  const keyword = tokens[0];
  if (!keyword || !KEYWORDS.has(keyword)) return null;
  const kw = keyword as CommandKeyword;
  const args = tokens.slice(1);
  const malformed: StaffCommand = { type: 'malformed', keyword: kw };

  switch (kw) {
    case '註冊': {
      // The name keeps its original characters (no half-width folding), inner spaces collapsed.
      const name = trimmed.slice('註冊'.length).trim().split(/\s+/).join(' ');
      if (!name || [...name].length > MAX_NAME_LENGTH) return malformed;
      return { type: 'register', name };
    }
    case '補卡': {
      const employeeId = args[0] ? parseEmployeeId(args[0]) : null;
      if (employeeId !== null) {
        const c = parseCorrectionArgs(args.slice(1), now);
        return c ? { type: 'adminCorrection', employeeId, ...c } : malformed;
      }
      const c = parseCorrectionArgs(args, now);
      return c ? { type: 'correction', ...c } : malformed;
    }
    case '我的打卡':
    case '我的薪資': {
      const m = parseOptionalMonth(args, now);
      if (!m) return malformed;
      return { type: kw === '我的打卡' ? 'myShifts' : 'myPay', ...m };
    }
    case '說明':
      return args.length === 0 ? { type: 'help' } : malformed;
    case '員工列表':
      return args.length === 0 ? { type: 'listEmployees' } : malformed;
    case '待處理':
      return args.length === 0 ? { type: 'pending' } : malformed;
    case '核准': {
      const employeeId = args[0] ? parseEmployeeId(args[0]) : null;
      if (employeeId !== null) {
        const wage = args.length === 3 && args[1] === '時薪' ? parseWage(args[2]) : null;
        return wage ? { type: 'approveRegistration', employeeId, hourlyWage: wage } : malformed;
      }
      const requestId = args.length === 1 ? parseCorrectionId(args[0]!) : null;
      return requestId ? { type: 'approveCorrection', requestId } : malformed;
    }
    case '駁回': {
      if (args.length !== 1) return malformed;
      const employeeId = parseEmployeeId(args[0]!);
      if (employeeId) return { type: 'rejectRegistration', employeeId };
      const requestId = parseCorrectionId(args[0]!);
      return requestId ? { type: 'rejectCorrection', requestId } : malformed;
    }
    case '時薪': {
      const employeeId = args[0] ? parseEmployeeId(args[0]) : null;
      const wage = parseWage(args[1]);
      if (!employeeId || !wage) return malformed;
      const rest = args.slice(2);
      if (rest.length === 0) {
        return { type: 'setWage', employeeId, hourlyWage: wage, effectiveFrom: null };
      }
      // `自 12/1` or `自12/1`
      if (!rest[0]!.startsWith('自')) return malformed;
      const dateArgs = [rest[0]!.slice(1), ...rest.slice(1)].filter(Boolean);
      if (dateArgs.length !== 1) return malformed;
      const effectiveFrom = parseDateToken(dateArgs[0]!, now, 'nearest');
      return effectiveFrom
        ? { type: 'setWage', employeeId, hourlyWage: wage, effectiveFrom }
        : malformed;
    }
    case '刪除打卡': {
      if (args.length !== 2) return malformed;
      const employeeId = parseEmployeeId(args[0]!);
      const date = parseDateToken(args[1]!, now, 'past');
      return employeeId && date ? { type: 'listShiftsForDelete', employeeId, date } : malformed;
    }
    case '刪除': {
      const shiftId = args.length === 1 ? parseShiftId(args[0]!) : null;
      return shiftId ? { type: 'deleteShift', shiftId } : malformed;
    }
    case '停用':
    case '啟用': {
      const employeeId = args.length === 1 ? parseEmployeeId(args[0]!) : null;
      if (!employeeId) return malformed;
      return { type: kw === '停用' ? 'disableEmployee' : 'enableEmployee', employeeId };
    }
    case '打卡紀錄': {
      const employeeId = args[0] ? parseEmployeeId(args[0]) : null;
      const m = employeeId ? parseOptionalMonth(args.slice(1), now) : null;
      return employeeId && m ? { type: 'shiftRecords', employeeId, ...m } : malformed;
    }
    case '結算': {
      const month = args[0] ? parseMonthToken(args[0]) : null;
      if (!month) return malformed;
      if (args.length === 1) return { type: 'runPayroll', month, notifyEmployees: false };
      if (args.length === 2 && args[1] === '通知員工') {
        return { type: 'runPayroll', month, notifyEmployees: true };
      }
      return malformed;
    }
  }
}
