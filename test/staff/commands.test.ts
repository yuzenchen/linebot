import { describe, expect, it } from 'vitest';
import { parseDateToken, parseStaffCommand } from '../../src/staff/commands.js';

const NOW = new Date('2026-11-12T02:00:00Z'); // 2026-11-12 10:00 Taipei
const JAN = new Date('2027-01-03T02:00:00Z'); // 2027-01-03 10:00 Taipei
const p = (text: string, now = NOW) => parseStaffCommand(text, now);

describe('parseStaffCommand: punches', () => {
  it('accepts exactly 上班 / 下班 after trim', () => {
    expect(p('上班')).toEqual({ type: 'punch', kind: 'in' });
    expect(p('  下班 \n')).toEqual({ type: 'punch', kind: 'out' });
  });

  it('ignores anything else', () => {
    expect(p('我要上班')).toBeNull();
    expect(p('上班了')).toBeNull();
    expect(p('上班 09:00')).toBeNull();
    expect(p('早安')).toBeNull();
    expect(p('')).toBeNull();
  });
});

describe('parseStaffCommand: employee commands', () => {
  it('parses 註冊 with the name as typed', () => {
    expect(p('註冊 王小明')).toEqual({ type: 'register', name: '王小明' });
    expect(p('註冊  Amy   Lin ')).toEqual({ type: 'register', name: 'Amy Lin' });
    expect(p('註冊')).toEqual({ type: 'malformed', keyword: '註冊' });
    expect(p(`註冊 ${'名'.repeat(21)}`)).toEqual({ type: 'malformed', keyword: '註冊' });
    expect(p('註冊王小明')).toBeNull();
  });

  it('parses 補卡 with short and full dates', () => {
    expect(p('補卡 11/12 09:00 上班')).toEqual({
      type: 'correction',
      date: '2026-11-12',
      time: '09:00',
      at: new Date('2026-11-12T01:00:00Z'),
      kind: 'in',
    });
    expect(p('補卡 2026/11/11 18:05 下班')).toMatchObject({
      type: 'correction',
      date: '2026-11-11',
      time: '18:05',
      kind: 'out',
    });
    expect(p('補卡 11/12 9:00 上班')).toMatchObject({ time: '09:00' });
    // full-width digits / colon
    expect(p('補卡 １１/１２ ０９：００ 上班')).toMatchObject({
      date: '2026-11-12',
      time: '09:00',
    });
  });

  it('infers the most recent not-future year for 補卡', () => {
    // 11/13 is tomorrow → last year
    expect(p('補卡 11/13 09:00 上班')).toMatchObject({ date: '2025-11-13' });
    // Around January: 12/31 typed on 2027-01-03 is last year's
    expect(p('補卡 12/31 22:00 上班', JAN)).toMatchObject({
      date: '2026-12-31',
      at: new Date('2026-12-31T14:00:00Z'),
    });
    expect(p('補卡 1/3 09:00 上班', JAN)).toMatchObject({ date: '2027-01-03' });
  });

  it('rejects malformed 補卡', () => {
    for (const t of [
      '補卡',
      '補卡 11/12 09:00',
      '補卡 11/31 09:00 上班',
      '補卡 13/1 09:00 上班',
      '補卡 11/12 24:00 上班',
      '補卡 11/12 09:60 上班',
      '補卡 11/12 09:00 午休',
      '補卡 11/12 09:00 上班 多的',
    ]) {
      expect(p(t)).toEqual({ type: 'malformed', keyword: '補卡' });
    }
  });

  it('parses 我的打卡 / 我的薪資 with optional month', () => {
    expect(p('我的打卡')).toEqual({ type: 'myShifts', month: '2026-11', explicitMonth: false });
    expect(p('我的打卡 2026-10')).toEqual({
      type: 'myShifts',
      month: '2026-10',
      explicitMonth: true,
    });
    expect(p('我的薪資 2026/9')).toEqual({ type: 'myPay', month: '2026-09', explicitMonth: true });
    expect(p('我的薪資 2026-13')).toEqual({ type: 'malformed', keyword: '我的薪資' });
    expect(p('說明')).toEqual({ type: 'help' });
  });
});

describe('parseStaffCommand: admin commands', () => {
  it('parses registration and correction decisions', () => {
    expect(p('核准 E001 時薪 200')).toEqual({
      type: 'approveRegistration',
      employeeId: 1,
      hourlyWage: 200,
    });
    expect(p('核准 E001')).toEqual({ type: 'malformed', keyword: '核准' });
    expect(p('核准 E001 時薪 0')).toEqual({ type: 'malformed', keyword: '核准' });
    expect(p('核准 R002')).toEqual({ type: 'approveCorrection', requestId: 2 });
    expect(p('駁回 E003')).toEqual({ type: 'rejectRegistration', employeeId: 3 });
    expect(p('駁回 r4')).toEqual({ type: 'rejectCorrection', requestId: 4 });
    expect(p('駁回 X1')).toEqual({ type: 'malformed', keyword: '駁回' });
  });

  it('parses 時薪 with optional 自 date (future allowed)', () => {
    expect(p('時薪 E001 210')).toEqual({
      type: 'setWage',
      employeeId: 1,
      hourlyWage: 210,
      effectiveFrom: null,
    });
    expect(p('時薪 E001 210 自 12/1')).toMatchObject({ effectiveFrom: '2026-12-01' });
    expect(p('時薪 E001 210 自12/1')).toMatchObject({ effectiveFrom: '2026-12-01' });
    expect(p('時薪 E001 210 自 2027/1/1')).toMatchObject({ effectiveFrom: '2027-01-01' });
    expect(p('時薪 E001 210 自 10/1')).toMatchObject({ effectiveFrom: '2026-10-01' });
    // In late December, 1/1 means next year
    expect(p('時薪 E001 210 自 1/1', new Date('2026-12-20T02:00:00Z'))).toMatchObject({
      effectiveFrom: '2027-01-01',
    });
    expect(p('時薪 E001')).toEqual({ type: 'malformed', keyword: '時薪' });
    expect(p('時薪 E001 210 從 12/1')).toEqual({ type: 'malformed', keyword: '時薪' });
  });

  it('parses 代補 with an employee id', () => {
    expect(p('補卡 E001 11/12 18:00 下班')).toEqual({
      type: 'adminCorrection',
      employeeId: 1,
      date: '2026-11-12',
      time: '18:00',
      at: new Date('2026-11-12T10:00:00Z'),
      kind: 'out',
    });
    expect(p('補卡 E001 11/12 18:00')).toEqual({ type: 'malformed', keyword: '補卡' });
  });

  it('parses list / delete / status / records / payroll commands', () => {
    expect(p('員工列表')).toEqual({ type: 'listEmployees' });
    expect(p('待處理')).toEqual({ type: 'pending' });
    expect(p('刪除打卡 E001 11/12')).toEqual({
      type: 'listShiftsForDelete',
      employeeId: 1,
      date: '2026-11-12',
    });
    expect(p('刪除 S0123')).toEqual({ type: 'deleteShift', shiftId: 123 });
    expect(p('刪除 E001')).toEqual({ type: 'malformed', keyword: '刪除' });
    expect(p('停用 E001')).toEqual({ type: 'disableEmployee', employeeId: 1 });
    expect(p('啟用 E001')).toEqual({ type: 'enableEmployee', employeeId: 1 });
    expect(p('打卡紀錄 E001 2026-11')).toEqual({
      type: 'shiftRecords',
      employeeId: 1,
      month: '2026-11',
      explicitMonth: true,
    });
    expect(p('打卡紀錄 E001')).toMatchObject({ month: '2026-11', explicitMonth: false });
    expect(p('結算 2026-11')).toEqual({
      type: 'runPayroll',
      month: '2026-11',
      notifyEmployees: false,
    });
    expect(p('結算 2026-11 通知員工')).toEqual({
      type: 'runPayroll',
      month: '2026-11',
      notifyEmployees: true,
    });
    expect(p('結算')).toEqual({ type: 'malformed', keyword: '結算' });
    expect(p('員工列表 全部')).toEqual({ type: 'malformed', keyword: '員工列表' });
  });
});

describe('parseDateToken', () => {
  it('handles 2/29 by walking back to a leap year in past mode', () => {
    expect(parseDateToken('2/29', NOW, 'past')).toBe('2024-02-29');
    // No 2/29 within a year either side of 2026 → unusable
    expect(parseDateToken('2/29', NOW, 'nearest')).toBeNull();
    expect(parseDateToken('2/30', NOW, 'past')).toBeNull();
  });
});
