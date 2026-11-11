import { describe, expect, it, vi } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { Replier } from '../../src/line/replier.js';
import { createStaffMessenger, packLines } from '../../src/staff/messenger.js';
import { createPayrollReporter } from '../../src/staff/payrollReport.js';
import { dueScheduleMonth, startPayrollScheduler } from '../../src/staff/scheduler.js';
import { staffDay, staffDuration, staffMoney, staffPayday, staffTexts } from '../../src/texts.js';
import { fakeApi, silent } from '../handlers/helpers.js';
import { addShift, hire, setup, tp } from './helpers.js';

describe('staff display helpers', () => {
  it('formats money, durations (floored), days and paydays', () => {
    expect(staffMoney(0)).toBe('NT$0');
    expect(staffMoney(999)).toBe('NT$999');
    expect(staffMoney(33667)).toBe('NT$33,667');
    expect(staffMoney(1234567)).toBe('NT$1,234,567');
    expect(staffDuration(0)).toBe('0 小時 0 分');
    expect(staffDuration(10100.99)).toBe('168 小時 20 分');
    expect(staffDuration(59.9999)).toBe('0 小時 59 分');
    expect(staffDay('2026-12-01')).toBe('12/1');
    expect(staffPayday('2026-11', 15)).toBe('12/15');
    expect(staffPayday('2026-12', 5)).toBe('1/5');
  });

  it('keeps copy free of emoji', () => {
    const all = JSON.stringify(staffTexts);
    expect(/\p{Extended_Pictographic}/u.test(all)).toBe(false);
  });
});

describe('packLines', () => {
  it('packs lines up to the limit and hard-splits an overlong line', () => {
    expect(packLines(['a', 'b', 'c'], 3)).toEqual(['a\nb', 'c']);
    expect(packLines(['abcdefg'], 3)).toEqual(['abc', 'def', 'g']);
    expect(packLines([], 3)).toEqual([]);
    expect(packLines(['', 'x'], 5)).toEqual(['\nx']);
  });
});

describe('dueScheduleMonth', () => {
  it('is null before day 1 at the hour (Taipei), then the previous month', () => {
    expect(dueScheduleMonth(tp('2026-12-01', 8, 59), 9)).toBeNull();
    expect(dueScheduleMonth(tp('2026-12-01', 9, 0), 9)).toBe('2026-11');
    expect(dueScheduleMonth(tp('2026-12-31', 23, 59), 9)).toBe('2026-11');
    expect(dueScheduleMonth(tp('2027-01-01', 0, 0), 0)).toBe('2026-12');
    // Uses the Taipei calendar: 2026-12-01 07:00 Taipei is still before the hour.
    expect(dueScheduleMonth(tp('2026-12-01', 7, 0), 9)).toBeNull();
    expect(dueScheduleMonth(tp('2026-11-30', 23, 30), 9)).toBe('2026-10');
  });
});

describe('payroll scheduler', () => {
  function build(now: () => Date) {
    const { db, svc } = setup();
    const repos = createRepos(db);
    const api = fakeApi();
    const replier = new Replier(api, repos, silent);
    const messenger = createStaffMessenger({
      replier,
      repos,
      adminUserIds: ['Uadmin'],
      log: silent,
    });
    const reporter = createPayrollReporter({ service: svc, messenger, payday: 15, log: silent });
    return { db, svc, api, reporter, now };
  }

  it('runs once per month across checks and never in parallel', async () => {
    let clock = tp('2026-12-01', 8, 0);
    const b = build(() => clock);
    const e = hire(b.svc, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    addShift(b.svc, e.id, tp('2026-11-03', 9), tp('2026-11-03', 17));
    const sched = startPayrollScheduler({
      service: b.svc,
      reporter: b.reporter,
      hour: 9,
      intervalMs: 3_600_000,
      now: () => clock,
      log: silent,
    });
    expect(await sched.initial).toBeNull();
    // A manual run before the hour does not count as the scheduled one.
    b.svc.runPayroll('2026-11', 'Uadmin', clock);
    clock = tp('2026-12-01', 9, 1);
    const [first, second] = await Promise.all([sched.checkOnce(), sched.checkOnce()]);
    expect(first?.result.totals.pay).toBe(1600);
    expect(second).toBeNull();
    expect(await sched.checkOnce()).toBeNull();
    expect(b.svc.repo.payrollRuns.listForMonth('2026-11').map((r) => r.triggered_by)).toEqual([
      'Uadmin',
      'schedule',
    ]);
    clock = tp('2027-01-01', 9, 0);
    expect((await sched.checkOnce())?.result.month).toBe('2026-12');
    sched.stop();
  });

  it('never throws when the run fails', async () => {
    const clock = tp('2026-12-01', 10, 0);
    const b = build(() => clock);
    const reporter = { run: vi.fn(async () => Promise.reject(new Error('db gone'))) };
    const sched = startPayrollScheduler({
      service: b.svc,
      reporter,
      hour: 9,
      now: () => clock,
      log: silent,
    });
    await expect(sched.initial).resolves.toBeNull();
    sched.stop();
  });
});
