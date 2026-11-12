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

  it('parses a whole-shift 補卡 (§15.4), crossing midnight when the end is not after the start', () => {
    expect(p('補卡 11/12 09:00-18:00')).toEqual({
      type: 'correction',
      date: '2026-11-12',
      time: '09:00',
      endTime: '18:00',
      at: new Date('2026-11-12T01:00:00Z'),
      endAt: new Date('2026-11-12T10:00:00Z'),
      kind: 'shift',
    });
    expect(p('補卡 11/11 22:00~02:00')).toMatchObject({
      kind: 'shift',
      at: new Date('2026-11-11T14:00:00Z'),
      endAt: new Date('2026-11-11T18:00:00Z'), // 11/12 02:00 Taipei
    });
    expect(p('補卡 11/11 9:00 - 9:00')).toMatchObject({
      time: '09:00',
      endAt: new Date('2026-11-12T01:00:00Z'), // same time → next day (24 h, refused later)
    });
    expect(p('補卡 １１/１１ ０９：００～１８：００')).toMatchObject({ kind: 'shift' });
    expect(p('補卡 11/11 09:00〜18:00')).toMatchObject({ kind: 'shift' });
    expect(p('補卡 E002 11/11 09:00-18:00')).toMatchObject({
      type: 'adminCorrection',
      employeeId: 2,
      kind: 'shift',
      endTime: '18:00',
    });
    for (const t of [
      '補卡 11/12 09:00-',
      '補卡 11/12 09:00-24:00',
      '補卡 11/12 09:00-18:00 上班',
      '補卡 11/12 09:00/18:00',
      '補卡 E001 11/12 09:00-1800',
    ]) {
      expect(p(t)).toEqual({ type: 'malformed', keyword: '補卡' });
    }
  });

  it('parses 取消 R001 (§15.3)', () => {
    expect(p('取消 R001')).toEqual({ type: 'cancelCorrection', requestId: 1 });
    expect(p('取消 r12')).toEqual({ type: 'cancelCorrection', requestId: 12 });
    expect(p('取消')).toEqual({ type: 'malformed', keyword: '取消' });
    expect(p('取消 明天的會')).toEqual({ type: 'malformed', keyword: '取消' });
    expect(p('取消了')).toBeNull();
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

  it('parses 修改 S0123 上班|下班 [date] HH:MM (§15.2)', () => {
    expect(p('修改 S0123 上班 09:00')).toEqual({
      type: 'editShift',
      shiftId: 123,
      kind: 'in',
      date: null,
      time: '09:00',
      hour: 9,
      minute: 0,
    });
    expect(p('修改 s5 下班 18:30')).toMatchObject({ shiftId: 5, kind: 'out', date: null });
    expect(p('修改 S0123 下班 11/13 2:00')).toMatchObject({
      kind: 'out',
      date: '2025-11-13', // 11/13 is after today (11/12) → last year, like 補卡
      time: '02:00',
    });
    expect(p('修改 S0123 下班 11/11 02:00')).toMatchObject({ date: '2026-11-11' });
    for (const t of [
      '修改',
      '修改 S0123',
      '修改 S0123 上班',
      '修改 S0123 午休 09:00',
      '修改 E001 上班 09:00',
      '修改 S0123 上班 25:00',
      '修改 S0123 上班 11/31 09:00',
      '修改 S0123 上班 11/12 09:00 多的',
    ]) {
      expect(p(t)).toEqual({ type: 'malformed', keyword: '修改' });
    }
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
    expect(p('結算 2026-11 重新結算')).toEqual({
      type: 'runPayroll',
      month: '2026-11',
      notifyEmployees: false,
    });
    expect(p('結算 2026-11 其他')).toEqual({ type: 'malformed', keyword: '結算' });
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

describe('parseStaffCommand: §17 batches', () => {
  it('parses a multi-line 補卡, skipping blank lines', () => {
    const r = p('補卡 11/10 09:00-18:00\n\n  補卡 11/11 09:00 上班  \r\n補卡 11/11 18:00 下班\n');
    expect(r).toMatchObject({ type: 'correctionBatch' });
    const items = (r as { items: unknown[] }).items;
    expect(items).toEqual([
      {
        date: '2026-11-10',
        time: '09:00',
        endTime: '18:00',
        at: new Date('2026-11-10T01:00:00Z'),
        endAt: new Date('2026-11-10T10:00:00Z'),
        kind: 'shift',
      },
      { date: '2026-11-11', time: '09:00', at: new Date('2026-11-11T01:00:00Z'), kind: 'in' },
      { date: '2026-11-11', time: '18:00', at: new Date('2026-11-11T10:00:00Z'), kind: 'out' },
    ]);
  });

  it('parses a multi-line 代補 with different employees', () => {
    expect(p('補卡 E001 11/11 09:00 上班\n補卡 E002 11/11 10:00-19:00')).toMatchObject({
      type: 'adminCorrectionBatch',
      items: [
        { employeeId: 1, kind: 'in' },
        { employeeId: 2, kind: 'shift' },
      ],
    });
  });

  it('refuses the whole message on the first bad line (numbered as the sender sees it)', () => {
    expect(p('補卡 11/10 09:00 上班\n補卡 11/32 09:00 上班\n補卡 x')).toEqual({
      type: 'batchMalformed',
      line: 2,
      text: '補卡 11/32 09:00 上班',
    });
    expect(p('補卡 11/10 09:00 上班\n\n  謝謝  ')).toEqual({
      type: 'batchMalformed',
      line: 3,
      text: '謝謝',
    });
    // Mixing 代補 and an employee's own 補卡 is not allowed.
    expect(p('補卡 11/10 09:00 上班\n補卡 E001 11/10 18:00 下班')).toMatchObject({
      type: 'batchMalformed',
      line: 2,
    });
    expect(p('補卡 11/10\n補卡 11/10 09:00 上班')).toMatchObject({
      type: 'batchMalformed',
      line: 1,
    });
  });

  it('refuses more than 12 lines', () => {
    const lines = Array.from({ length: 13 }, (_, i) => `補卡 11/${i + 1} 09:00 上班`);
    expect(p(lines.join('\n'))).toEqual({ type: 'batchTooMany', keyword: '補卡' });
    expect(p(lines.slice(0, 12).join('\n\n'))).toMatchObject({ type: 'correctionBatch' });
  });

  it('leaves single-line and non-補卡 multi-line messages as before', () => {
    expect(p('補卡 11/12 09:00 上班\n\n')).toMatchObject({ type: 'correction', kind: 'in' });
    expect(p('大家好\n補卡 11/12 09:00 上班')).toBeNull();
    expect(p('註冊\n王小明')).toEqual({ type: 'register', name: '王小明' });
  });

  it('parses 核准 / 駁回 with several ids', () => {
    expect(p('核准 R004 R005,R006，R007、r8')).toEqual({
      type: 'approveCorrections',
      requestIds: [4, 5, 6, 7, 8],
    });
    expect(p('駁回 R004、R005')).toEqual({ type: 'rejectCorrections', requestIds: [4, 5] });
    expect(p('核准 R004\nR005')).toEqual({ type: 'approveCorrections', requestIds: [4, 5] });
    // Duplicates count once; one id left = the single command.
    expect(p('核准 R004 R004')).toEqual({ type: 'approveCorrection', requestId: 4 });
    expect(p('核准 R4,')).toEqual({ type: 'approveCorrection', requestId: 4 });
    const ids = Array.from({ length: 13 }, (_, i) => `R${i + 1}`);
    expect(p(`核准 ${ids.join(' ')}`)).toEqual({ type: 'batchTooMany', keyword: '核准' });
    expect(p(`駁回 ${ids.join(' ')}`)).toEqual({ type: 'batchTooMany', keyword: '駁回' });
    expect(p(`核准 ${ids.slice(0, 12).join(' ')} R1`)).toMatchObject({
      type: 'approveCorrections',
    });
    expect(p('核准 R004 X1')).toEqual({ type: 'malformed', keyword: '核准' });
    expect(p('核准 R004 E001')).toEqual({ type: 'malformed', keyword: '核准' });
    expect(p('駁回 E001 E002')).toEqual({ type: 'malformed', keyword: '駁回' });
    expect(p('駁回 E001')).toEqual({ type: 'rejectRegistration', employeeId: 1 });
  });

  it('parses 核准全部 (and 核准 全部); 駁回全部 is not a command', () => {
    expect(p('核准全部')).toEqual({ type: 'approveAllCorrections' });
    expect(p(' 核准 全部 ')).toEqual({ type: 'approveAllCorrections' });
    expect(p('駁回 全部')).toEqual({ type: 'malformed', keyword: '駁回' });
    expect(p('駁回全部')).toBeNull();
  });
});
