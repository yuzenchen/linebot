/**
 * Asia/Taipei calendar helpers (SPEC-STAFF). Taipei is a fixed UTC+08:00 with no DST, so every
 * conversion is plain offset arithmetic on UTC fields — independent of the host `TZ`.
 */

export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Taipei calendar date `YYYY-MM-DD`. */
export type LocalDate = string;
/** Taipei calendar month `YYYY-MM`. */
export type Month = string;

function shifted(d: Date): Date {
  return new Date(d.getTime() + TAIPEI_OFFSET_MS);
}

/** Taipei calendar date of an instant. */
export function taipeiDate(d: Date): LocalDate {
  return shifted(d).toISOString().slice(0, 10);
}

/** Taipei calendar month of an instant. */
export function taipeiMonth(d: Date): Month {
  return shifted(d).toISOString().slice(0, 7);
}

/** Taipei wall-clock `HH:MM` of an instant. */
export function taipeiTime(d: Date): string {
  return shifted(d).toISOString().slice(11, 16);
}

/** Taipei calendar year of an instant. */
export function taipeiYear(d: Date): number {
  return shifted(d).getUTCFullYear();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `2026, 11, 2` → `2026-11-02`. */
export function formatLocalDate(year: number, month: number, day: number): LocalDate {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** True when year / month / day name a real calendar date. */
export function isValidDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

function parseLocalDate(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

/** The UTC instant of Taipei wall-clock `date hour:minute`. */
export function taipeiInstant(date: LocalDate, hour = 0, minute = 0): Date {
  const [y, m, d] = parseLocalDate(date);
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - TAIPEI_OFFSET_MS);
}

/** Calendar arithmetic on a Taipei date. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parseLocalDate(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (`b - a`). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const [ay, am, ad] = parseLocalDate(a);
  const [by, bm, bd] = parseLocalDate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** Monday of the Mon–Sun week containing `date`. */
export function weekStart(date: LocalDate): LocalDate {
  const [y, m, d] = parseLocalDate(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** True for a well-formed `YYYY-MM` with month 01–12. */
export function isValidMonth(month: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1970;
}

export interface MonthBounds {
  /** First Taipei day of the month. */
  firstDay: LocalDate;
  /** Last Taipei day of the month. */
  lastDay: LocalDate;
  /** Instant of Taipei 00:00 on the first day (inclusive). */
  start: Date;
  /** Instant of Taipei 00:00 on the first day of the next month (exclusive). */
  end: Date;
}

export function monthBounds(month: Month): MonthBounds {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const firstDay = formatLocalDate(y, m, 1);
  const next = m === 12 ? formatLocalDate(y + 1, 1, 1) : formatLocalDate(y, m + 1, 1);
  return {
    firstDay,
    lastDay: addDays(next, -1),
    start: taipeiInstant(firstDay),
    end: taipeiInstant(next),
  };
}

/** `2026-01` → `2025-12`. */
export function previousMonth(month: Month): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

/** Floors a (possibly fractional) minute count into whole hours and minutes for display. */
export function splitMinutes(totalMinutes: number): { hours: number; minutes: number } {
  const whole = Math.floor(totalMinutes + 1e-9);
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}
