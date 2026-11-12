import { describe, expect, it } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { Replier } from '../../src/line/replier.js';
import { createStaffMessenger } from '../../src/staff/messenger.js';
import type { CorrectionRow } from '../../src/staff/repo.js';
import {
  dueReminderDate,
  planReminder,
  startReminderScheduler,
} from '../../src/staff/scheduler.js';
import { staffCorrectionReminder, type StaffReminderItem } from '../../src/texts.js';
import { fakeApi, silent } from '../handlers/helpers.js';
import { hire, setup, tp } from './helpers.js';

function row(id: number, at: Date, createdAt: Date, extra: Partial<CorrectionRow> = {}) {
  return {
    id,
    employee_id: 1,
    kind: 'in',
    at: at.toISOString(),
    end_at: null,
    status: 'pending',
    reason: null,
    requested_by: 'Ua',
    group_id: null,
    shift_id: null,
    created_at: createdAt.toISOString(),
    decided_by: null,
    decided_at: null,
    ...extra,
  } satisfies CorrectionRow;
}

describe('dueReminderDate', () => {
  it('is today (Taipei) from the hour on, null before it', () => {
    expect(dueReminderDate(tp('2026-11-16', 8, 59), 9)).toBeNull();
    expect(dueReminderDate(tp('2026-11-16', 9, 0), 9)).toBe('2026-11-16');
    expect(dueReminderDate(tp('2026-11-16', 23, 59), 9)).toBe('2026-11-16');
    expect(dueReminderDate(tp('2026-11-17', 0, 30), 0)).toBe('2026-11-17');
  });
});

describe('planReminder', () => {
  const NOW = tp('2026-11-16', 9);

  it('lists requests pending more than 3 days, oldest id first', () => {
    const plan = planReminder('2026-11-16', NOW, 15, [
      row(4, tp('2026-11-12', 9), tp('2026-11-13', 8, 59)), // 3 days 1 minute
      row(2, tp('2026-11-10', 9), tp('2026-11-12', 9)),
      row(3, tp('2026-11-12', 9), tp('2026-11-13', 9)), // exactly 3 days: not yet
    ]);
    expect(plan.stale.map((r) => r.id)).toEqual([2, 4]);
    expect(plan.payday).toBeNull();
  });

  it("on the day before payday, lists the payroll month's pending requests of any age", () => {
    const now = tp('2026-12-14', 9);
    const plan = planReminder('2026-12-14', now, 15, [
      row(1, tp('2026-11-30', 22), tp('2026-12-13', 9)), // November, 1 day old
      row(2, tp('2026-12-01', 9), tp('2026-12-13', 9)), // December: not this payday
      row(3, tp('2026-11-03', 9), tp('2026-12-01', 9)), // November and stale
    ]);
    expect(plan.payday).toMatchObject({ date: '2026-12-15', month: '2026-11' });
    expect(plan.payday!.requests.map((r) => r.id)).toEqual([1, 3]);
    expect(plan.stale.map((r) => r.id)).toEqual([3]);
    // Payday on the 1st: the eve is the last day of the previous month.
    expect(planReminder('2026-11-30', tp('2026-11-30', 9), 1, []).payday).toMatchObject({
      date: '2026-12-01',
      month: '2026-11',
    });
    expect(planReminder('2026-12-15', tp('2026-12-15', 9), 15, []).payday).toBeNull();
  });
});

describe('staffCorrectionReminder', () => {
  const item = (n: number, extra: Partial<StaffReminderItem> = {}): StaffReminderItem => ({
    displayId: `R${String(n).padStart(3, '0')}`,
    name: '王小明',
    at: tp('2026-11-12', 9).toISOString(),
    kind: 'in',
    endAt: null,
    ...extra,
  });

  it('merges both parts, shows whole shifts, and lists at most 10 per part', () => {
    expect(
      staffCorrectionReminder({
        staleDays: 3,
        stale: [
          item(1),
          item(3, {
            kind: 'shift',
            at: tp('2026-11-11', 22).toISOString(),
            endAt: tp('2026-11-12', 6).toISOString(),
          }),
        ],
        payday: {
          date: '2026-12-15',
          month: '2026-11',
          items: [item(4, { kind: 'out', at: tp('2026-11-30', 18).toISOString() })],
        },
      }),
    ).toEqual([
      '有 2 筆補卡待處理超過 3 天：R001 王小明 11/12 09:00 上班；R003 王小明 11/11 22:00–11/12 06:00 整班。輸入：待處理',
      '明天 12/15 發薪，2026-11 還有 1 筆補卡待處理：R004 王小明 11/30 18:00 下班。處理後請輸入：結算 2026-11',
    ]);
    const many = Array.from({ length: 12 }, (_, i) => item(i + 1));
    const [line] = staffCorrectionReminder({ staleDays: 3, stale: many, payday: null });
    expect(line).toContain('有 12 筆補卡待處理超過 3 天：R001 ');
    expect(line).toContain('R010 王小明 11/12 09:00 上班；另有 2 筆。輸入：待處理');
    expect(line).not.toContain('R011');
    expect(
      staffCorrectionReminder({
        staleDays: 3,
        stale: [],
        payday: { date: '2026-12-15', month: '2026-11', items: [] },
      }),
    ).toEqual([]);
  });
});

describe('reminder scheduler (§15.5)', () => {
  function build() {
    const { db, svc } = setup();
    const repos = createRepos(db);
    const api = fakeApi();
    const replier = new Replier(api, repos, silent);
    const messenger = createStaffMessenger({
      replier,
      repos,
      adminUserIds: ['Uadmin1', 'Uadmin2'],
      log: silent,
    });
    let clock = tp('2026-11-16', 8, 0);
    const start = () =>
      startReminderScheduler({
        service: svc,
        messenger,
        hour: 9,
        payday: 15,
        intervalMs: 3_600_000,
        now: () => clock,
        log: silent,
      });
    const pushes = () =>
      api.pushMessage.mock.calls.map(([req]) => `${req.to}:${req.messages.map((m) => m.text)}`);
    return {
      db,
      svc,
      api,
      start,
      pushes,
      setClock: (d: Date) => {
        clock = d;
      },
    };
  }

  it('sends one merged DM per admin once a day, after the hour, recorded before sending', async () => {
    const b = build();
    hire(b.svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    b.svc.requestCorrection(
      'Ua',
      { kind: 'in', at: tp('2026-11-12', 9) },
      null,
      tp('2026-11-12', 20),
    );
    b.svc.requestCorrection(
      'Ua',
      { kind: 'in', at: tp('2026-11-14', 9) },
      null,
      tp('2026-11-14', 20),
    );

    const sched = b.start();
    expect(await sched.initial).toBeNull(); // 08:00: not yet
    expect(b.svc.repo.reminders.get('2026-11-16')).toBeUndefined();

    b.setClock(tp('2026-11-16', 9, 0));
    const [first, second] = await Promise.all([sched.checkOnce(), sched.checkOnce()]);
    expect(first).toMatchObject({ date: '2026-11-16', sent: true });
    expect(second).toBeNull();
    const text = '有 1 筆補卡待處理超過 3 天：R001 王小明 11/12 09:00 上班。輸入：待處理';
    expect(b.pushes()).toEqual([`Uadmin1:${text}`, `Uadmin2:${text}`]);
    const stored = b.svc.repo.reminders.get('2026-11-16')!;
    expect(stored.sent_at).toBe(tp('2026-11-16', 9).toISOString());
    expect(JSON.parse(stored.content_json!)).toMatchObject({ stale: ['R001'], payday: null });
    const reasons = (
      b.db.prepare('SELECT user_id, reason FROM push_log ORDER BY id').all() as {
        user_id: string;
        reason: string;
      }[]
    ).map((r) => `${r.user_id}:${r.reason}`);
    expect(reasons).toEqual([
      'Uadmin1:staff_correction_reminder',
      'Uadmin2:staff_correction_reminder',
    ]);

    // Later the same day, and after a restart: nothing more.
    b.setClock(tp('2026-11-16', 18, 0));
    expect(await sched.checkOnce()).toBeNull();
    sched.stop();
    const restarted = b.start();
    expect(await restarted.initial).toBeNull();
    restarted.stop();
    expect(b.api.pushMessage).toHaveBeenCalledTimes(2);

    // Next day, first check in the evening (bot was down at 09:00): R002 is stale by now too.
    b.setClock(tp('2026-11-17', 21, 0));
    const next = b.start();
    expect(await next.initial).toMatchObject({ date: '2026-11-17', sent: true });
    next.stop();
    expect(b.pushes().at(-1)).toBe(
      'Uadmin2:有 2 筆補卡待處理超過 3 天：R001 王小明 11/12 09:00 上班；R002 王小明 11/14 09:00 上班。輸入：待處理',
    );
  });

  it('records a quiet day without sending, and never sends for it later that day', async () => {
    const b = build();
    hire(b.svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    b.svc.requestCorrection(
      'Ua',
      { kind: 'in', at: tp('2026-11-12', 9) },
      null,
      tp('2026-11-13', 10),
    );
    b.setClock(tp('2026-11-16', 9, 30)); // created 2 days 23.5 h ago: not yet stale
    const sched = b.start();
    expect(await sched.initial).toEqual({ date: '2026-11-16', sent: false, lines: [] });
    expect(b.svc.repo.reminders.get('2026-11-16')).toMatchObject({ sent_at: null });
    b.setClock(tp('2026-11-16', 11, 0)); // stale now, but the day was already checked
    expect(await sched.checkOnce()).toBeNull();
    sched.stop();
    expect(b.api.pushMessage).not.toHaveBeenCalled();
  });

  it("does not catch up earlier days, and reminds about last month's requests before payday", async () => {
    const b = build();
    hire(b.svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    b.svc.requestCorrection(
      'Ua',
      { kind: 'out', at: tp('2026-11-30', 18) },
      null,
      tp('2026-12-13', 9),
    );
    b.svc.requestCorrection(
      'Ua',
      { kind: 'shift', at: tp('2026-12-01', 9), endAt: tp('2026-12-01', 18) },
      null,
      tp('2026-12-13', 9),
    );
    b.setClock(tp('2026-12-14', 9, 0));
    const sched = b.start();
    expect(await sched.initial).toMatchObject({ date: '2026-12-14', sent: true });
    sched.stop();
    expect(b.pushes()[0]).toBe(
      'Uadmin1:明天 12/15 發薪，2026-11 還有 1 筆補卡待處理：R001 王小明 11/30 18:00 下班。處理後請輸入：結算 2026-11',
    );
    const days = (
      b.db.prepare('SELECT date FROM staff_reminders ORDER BY date').all() as { date: string }[]
    ).map((r) => r.date);
    expect(days).toEqual(['2026-12-14']);
  });

  it('never throws when the check fails', async () => {
    const b = build();
    b.db.exec('DROP TABLE staff_reminders');
    b.setClock(tp('2026-11-16', 9, 0));
    const sched = b.start();
    await expect(sched.initial).resolves.toBeNull();
    sched.stop();
  });
});
