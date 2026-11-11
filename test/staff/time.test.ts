import { describe, expect, it } from 'vitest';
import {
  displayCorrectionId,
  displayEmployeeId,
  displayShiftId,
  parseCorrectionId,
  parseEmployeeId,
  parseShiftId,
} from '../../src/staff/ids.js';
import {
  addDays,
  daysBetween,
  isValidDate,
  isValidMonth,
  monthBounds,
  previousMonth,
  splitMinutes,
  taipeiDate,
  taipeiInstant,
  taipeiMonth,
  taipeiTime,
  weekStart,
} from '../../src/staff/time.js';

describe('staff time helpers (Asia/Taipei, host-TZ independent)', () => {
  it('maps instants to Taipei date / month / time', () => {
    const lateUtc = new Date('2026-11-30T16:30:00Z'); // 2026-12-01 00:30 Taipei
    expect(taipeiDate(lateUtc)).toBe('2026-12-01');
    expect(taipeiMonth(lateUtc)).toBe('2026-12');
    expect(taipeiTime(lateUtc)).toBe('00:30');
    expect(taipeiDate(new Date('2026-11-30T15:59:59Z'))).toBe('2026-11-30');
  });

  it('builds the UTC instant of a Taipei wall-clock time', () => {
    expect(taipeiInstant('2026-11-12', 9, 0).toISOString()).toBe('2026-11-12T01:00:00.000Z');
    expect(taipeiInstant('2026-01-01').toISOString()).toBe('2025-12-31T16:00:00.000Z');
  });

  it('does calendar arithmetic and weeks start on Monday', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-10-12', '2026-11-12')).toBe(31);
    expect(weekStart('2026-11-12')).toBe('2026-11-09'); // Thursday → Monday
    expect(weekStart('2026-11-15')).toBe('2026-11-09'); // Sunday belongs to the same week
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
  });

  it('validates dates and months', () => {
    expect(isValidDate(2028, 2, 29)).toBe(true);
    expect(isValidDate(2026, 2, 29)).toBe(false);
    expect(isValidDate(2026, 13, 1)).toBe(false);
    expect(isValidMonth('2026-11')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
  });

  it('computes month bounds and previous month', () => {
    const b = monthBounds('2026-12');
    expect(b.firstDay).toBe('2026-12-01');
    expect(b.lastDay).toBe('2026-12-31');
    expect(b.start.toISOString()).toBe('2026-11-30T16:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-12-31T16:00:00.000Z');
    expect(monthBounds('2028-02').lastDay).toBe('2028-02-29');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-11')).toBe('2026-10');
  });

  it('splits minutes for display by flooring', () => {
    expect(splitMinutes(543.9)).toEqual({ hours: 9, minutes: 3 });
    expect(splitMinutes(10100)).toEqual({ hours: 168, minutes: 20 });
  });
});

describe('staff display ids', () => {
  it('formats E / R / S ids', () => {
    expect(displayEmployeeId(1)).toBe('E001');
    expect(displayEmployeeId(1234)).toBe('E1234');
    expect(displayCorrectionId(7)).toBe('R007');
    expect(displayShiftId(123)).toBe('S0123');
  });

  it('parses ids with their own prefix only', () => {
    expect(parseEmployeeId('E001')).toBe(1);
    expect(parseEmployeeId('e12')).toBe(12);
    expect(parseEmployeeId('E0')).toBeNull();
    expect(parseEmployeeId('001')).toBeNull();
    expect(parseEmployeeId('R001')).toBeNull();
    expect(parseCorrectionId('R003')).toBe(3);
    expect(parseShiftId('S0123')).toBe(123);
    expect(parseShiftId('S')).toBeNull();
  });
});
