import type { webhook } from '@line/bot-sdk';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { NullGrokGateway } from '../../src/grok/gateway.js';
import { createDispatcher } from '../../src/handlers/dispatcher.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { MAX_MESSAGES, MAX_TEXT_LENGTH } from '../../src/line/replier.js';
import { createProfile } from '../../src/profiles/index.js';
import { createStaffProfile } from '../../src/profiles/staff.js';
import type { Shared } from '../../src/profiles/types.js';
import { createApp } from '../../src/server.js';
import { createStaffService } from '../../src/staff/service.js';
import { staffTexts } from '../../src/texts.js';
import { fakeHealth, harness, healthResult, silent } from '../handlers/helpers.js';
import { addDays } from '../../src/staff/time.js';
import { addShift, hire, OPTS, tp } from '../staff/helpers.js';

const GROUP = 'Cgroup';
const A1 = 'Uadmin1';
const A2 = 'Uadmin2';

const staffEnv = {
  LINE_CHANNEL_SECRET: 's',
  LINE_CHANNEL_ACCESS_TOKEN: 't',
  BOT_PROFILE: 'staff',
  STAFF_ADMIN_USER_IDS: `${A1}, ${A2}`,
  STAFF_GROUP_IDS: GROUP,
};

interface Sent {
  via: 'reply' | 'push';
  to: string;
  text: string;
}

function setup(start: Date, env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const h = harness();
  const logLines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void logLines.push(s) });
  const config = loadConfig({ ...staffEnv, ...env });
  let clock = start;
  const shared: Shared = {
    config,
    db: h.db,
    repos: h.repos,
    replier: h.replier,
    jobs: new JobQueue(h.repos.jobs, { maxAttempts: 1 }),
    grok: new NullGrokGateway(),
    health: fakeHealth(healthResult({ status: 'healthy' })),
    logger,
  };
  const makeProfile = () => createStaffProfile(shared, { now: () => clock, fetch: fetchImpl });
  const profile = makeProfile();
  const dispatch = createDispatcher({
    repos: h.repos,
    replier: h.replier,
    handleText: profile.handleText,
    handleGroupText: profile.handleGroupText,
    welcomeText: profile.welcomeText,
    log: silent,
  });
  const tokens = new Map<string, string>();
  let n = 0;
  const base = {
    timestamp: 1700000000000,
    mode: 'active' as const,
    deliveryContext: { isRedelivery: false },
  };
  function event(source: webhook.Source, chat: string, text: string): webhook.MessageEvent {
    n += 1;
    const replyToken = `tok-${n}`;
    tokens.set(replyToken, chat);
    return {
      ...base,
      webhookEventId: `e${n}`,
      type: 'message',
      replyToken,
      source,
      message: { type: 'text', id: `m${n}`, text, quoteToken: 'q' },
    };
  }
  let seen = 0;
  /** Messages sent since the previous `take()`, in call order. */
  function take(): Sent[] {
    const calls: { order: number; sent: Sent[] }[] = [];
    h.api.replyMessage.mock.calls.forEach(([req], i) =>
      calls.push({
        order: h.api.replyMessage.mock.invocationCallOrder[i]!,
        sent: req.messages.map((m) => ({
          via: 'reply' as const,
          to: tokens.get(req.replyToken) ?? '?',
          text: m.text,
        })),
      }),
    );
    h.api.pushMessage.mock.calls.forEach(([req], i) =>
      calls.push({
        order: h.api.pushMessage.mock.invocationCallOrder[i]!,
        sent: req.messages.map((m) => ({ via: 'push' as const, to: req.to, text: m.text })),
      }),
    );
    const all = calls.sort((a, b) => a.order - b.order).flatMap((c) => c.sent);
    const fresh = all.slice(seen);
    seen = all.length;
    return fresh;
  }
  return {
    ...h,
    shared,
    profile,
    makeProfile,
    logLines,
    seed: createStaffService(h.db, OPTS),
    setClock: (d: Date) => {
      clock = d;
    },
    group: (userId: string, text: string, groupId = GROUP) =>
      dispatch(event({ type: 'group', groupId, userId }, groupId, text)),
    room: (userId: string, text: string, roomId: string) =>
      dispatch(event({ type: 'room', roomId, userId }, roomId, text)),
    dm: (userId: string, text: string) => dispatch(event({ type: 'user', userId }, userId, text)),
    take,
  };
}

/** Makes pushes to these ids fail like LINE does for users who never added the bot. */
function failPushesTo(s: ReturnType<typeof setup>, ids: string[]) {
  s.api.pushMessage.mockImplementation(async (req) => {
    if (ids.includes(req.to)) {
      throw Object.assign(new Error('Failed to send messages'), { status: 400 });
    }
    return {};
  });
}

const texts = (sent: Sent[]) => sent.map((m) => `${m.via}:${m.to}:${m.text}`);

describe('staff profile: group', () => {
  it('register → admins notified → approve → punch in / out, end to end', async () => {
    const s = setup(tp('2026-11-12', 8, 50));
    await s.group('Uwang', '註冊 王小明');
    expect(texts(s.take())).toEqual([
      `push:${A1}:員工註冊申請 E001 王小明。核准請回：核准 E001 時薪 200`,
      `push:${A2}:員工註冊申請 E001 王小明。核准請回：核准 E001 時薪 200`,
      `reply:${GROUP}:已送出註冊申請（E001 王小明），等待管理員核准`,
    ]);

    await s.group('Uwang', '上班');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:${staffTexts.pendingApproval}`]);

    await s.dm(A1, '核准 E001 時薪 200');
    expect(texts(s.take())).toEqual([
      `push:${GROUP}:王小明 已可打卡`,
      `reply:${A1}:已核准 E001 王小明，時薪 NT$200 自 11/12 起`,
    ]);

    s.setClock(tp('2026-11-12', 9, 2));
    await s.group('Uwang', ' 上班 ');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:王小明 上班 09:02`]);
    // Within 60 s: a resend, same answer.
    await s.group('Uwang', '上班');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:王小明 上班 09:02`]);
    s.setClock(tp('2026-11-12', 9, 10));
    await s.group('Uwang', '上班');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:王小明 已在上班中（09:02 起）`]);

    s.setClock(tp('2026-11-12', 18, 5, 30));
    await s.group('Uwang', '下班');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:王小明 下班 18:05，本次 9 小時 3 分`]);
    await s.group('Uwang', '下班');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:王小明 下班 18:05，本次 9 小時 3 分`]);

    s.setClock(tp('2026-11-12', 19, 0));
    await s.group('Uwang', '下班');
    expect(texts(s.take())).toEqual([
      `reply:${GROUP}:王小明 沒有上班紀錄，請用補卡：補卡 11/12 09:00 上班`,
    ]);

    await s.group('Uwang', '註冊 王小明');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:你已註冊為 王小明`]);
  });

  it('flags a shift past STAFF_MAX_SHIFT_HOURS on 下班', async () => {
    const s = setup(tp('2026-11-12', 9, 0));
    const e = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    addShift(s.seed, e.id, tp('2026-11-11', 8), null);
    await s.group('Uwang', '下班');
    expect(texts(s.take())).toEqual([
      `reply:${GROUP}:王小明 上班紀錄已超過 16 小時，請用補卡補下班時間`,
    ]);
  });

  it('ignores groups not in STAFF_GROUP_IDS but logs their id; rooms follow the same rule', async () => {
    const s = setup(tp('2026-11-12', 9, 0));
    await s.group('Uwang', '註冊 王小明', 'Cother');
    await s.group('Uwang', '上班', 'Cother');
    await s.room('Uwang', '上班', 'Rroom');
    expect(s.take()).toEqual([]);
    const logged = s.logLines.join('');
    expect(logged).toContain('"groupId":"Cother"');
    expect(logged).toContain('"groupId":"Rroom"');
    expect(logged).toContain('"sourceType":"room"');

    const r = setup(tp('2026-11-12', 9, 0), { STAFF_GROUP_IDS: 'Rroom' });
    await r.room('Uwang', '上班', 'Rroom');
    expect(texts(r.take())).toEqual([`reply:Rroom:${staffTexts.notRegistered}`]);
  });

  it('stays silent on chat and DM-only commands; non-registered punches get the register hint', async () => {
    const s = setup(tp('2026-11-12', 9, 0));
    for (const t of [
      '大家早',
      '上班了',
      '說明',
      '我的打卡',
      '員工列表',
      '結算 2026-10',
      '核准 E001',
    ]) {
      await s.group('Ux', t);
    }
    expect(s.take()).toEqual([]);
    await s.group('Ux', '上班');
    await s.group('Ux', '下班');
    expect(texts(s.take())).toEqual([
      `reply:${GROUP}:尚未註冊，請輸入：註冊 你的名字`,
      `reply:${GROUP}:尚未註冊，請輸入：註冊 你的名字`,
    ]);
    await s.group('Ux', '補卡 明天 上班');
    await s.group('Ux', '註冊');
    expect(texts(s.take())).toEqual([
      `reply:${GROUP}:${staffTexts.usage.補卡}`,
      `reply:${GROUP}:${staffTexts.usage.註冊}`,
    ]);
  });

  it('correction: request in the group → admins → approve → DM, falling back to the group', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.group('Uwang', '補卡 11/12 09:00 上班');
    expect(texts(s.take())).toEqual([
      `push:${A1}:補卡申請 R001 王小明 11/12 09:00 上班。核准請回：核准 R001，駁回請回：駁回 R001`,
      `push:${A2}:補卡申請 R001 王小明 11/12 09:00 上班。核准請回：核准 R001，駁回請回：駁回 R001`,
      `reply:${GROUP}:已送出補卡申請 R001（11/12 09:00 上班），等待管理員核准`,
    ]);
    await s.group('Uwang', '補卡 11/12 18:00 下班');
    s.take();

    // The applicant never added the bot: the DM fails and the group gets the notice.
    failPushesTo(s, ['Uwang']);
    await s.dm(A1, '核准 R001');
    expect(texts(s.take())).toEqual([
      'push:Uwang:補卡 R001 已核准',
      `push:${GROUP}:王小明 補卡 R001 已核准`,
      'push:Uwang:補卡 R002 已核准',
      `push:${GROUP}:王小明 補卡 R002 已核准`,
      `reply:${A1}:已核准補卡 R001（王小明 11/12 09:00 上班），同時套用 R002`,
    ]);
    const shifts = s.seed.repo.shifts.listForEmployee(1);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]!.end_at).toBe(tp('2026-11-12', 18).toISOString());

    await s.dm(A2, '核准 R001');
    expect(texts(s.take())).toEqual([`reply:${A2}:R001 已處理過（已核准）`]);
  });

  it('rejection DMs the applicant; a failed 下班 approval tells them it will pair later', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.dm('Uwang', '補卡 11/12 18:00 下班');
    expect(texts(s.take()).at(-1)).toBe(
      'reply:Uwang:已送出補卡申請 R001（11/12 18:00 下班），等待管理員核准',
    );
    await s.dm(A1, '核准 R001');
    expect(texts(s.take())).toEqual([
      'push:Uwang:補卡 R001 無法套用：找不到可配對的上班紀錄，等補上班紀錄後會自動配對',
      `reply:${A1}:補卡 R001 無法套用：找不到可配對的上班紀錄`,
    ]);

    await s.dm('Uwang', '補卡 11/12 09:00 上班');
    s.take();
    await s.dm(A2, '駁回 R002');
    expect(texts(s.take())).toEqual([
      'push:Uwang:補卡 R002 已駁回',
      `reply:${A2}:已駁回補卡 R002（王小明）`,
    ]);
  });

  it('a failed push to one admin does not stop the others', async () => {
    const s = setup(tp('2026-11-12', 9, 0));
    failPushesTo(s, [A1]);
    await s.group('Uwang', '註冊 王小明');
    const sent = texts(s.take());
    expect(sent).toContain(`push:${A2}:員工註冊申請 E001 王小明。核准請回：核准 E001 時薪 200`);
    expect(sent).toContain(`reply:${GROUP}:已送出註冊申請（E001 王小明），等待管理員核准`);
    const reasons = (
      s.db.prepare('SELECT user_id, reason FROM push_log ORDER BY id').all() as {
        user_id: string;
        reason: string;
      }[]
    ).map((r) => `${r.user_id}:${r.reason}`);
    expect(reasons).toEqual([`${A2}:staff_registration_request`]);
  });

  it('answers with the fallback text when the service throws', async () => {
    const s = setup(tp('2026-11-12', 9, 0));
    s.db.exec('DROP TABLE shifts');
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.group('Uwang', '上班');
    expect(texts(s.take())).toEqual([`reply:${GROUP}:${staffTexts.error}`]);
  });
});

describe('staff profile: DM', () => {
  it('employee commands, help scoped to the user, unknown text and admin commands from non-admins', async () => {
    const s = setup(tp('2026-11-20', 12, 0));
    const e = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    addShift(s.seed, e.id, tp('2026-11-03', 9), tp('2026-11-03', 18, 5));
    addShift(s.seed, e.id, tp('2026-11-19', 22), tp('2026-11-20', 2, 30));
    addShift(s.seed, e.id, tp('2026-11-20', 9), null);

    await s.dm('Uwang', '上班');
    await s.dm('Uwang', '你好');
    await s.dm('Uwang', '員工列表');
    await s.dm('Uwang', '核准 E001 時薪 300');
    await s.dm('Uwang', '說明');
    await s.dm('Uwang', '註冊 王小明');
    await s.dm('Uwang', '我的打卡 2026/13');
    expect(texts(s.take())).toEqual([
      `reply:Uwang:${staffTexts.punchInGroup}`,
      `reply:Uwang:${staffTexts.unknownCommand}`,
      `reply:Uwang:${staffTexts.unknownCommand}`,
      `reply:Uwang:${staffTexts.unknownCommand}`,
      `reply:Uwang:${staffTexts.employeeHelp}`,
      `reply:Uwang:${staffTexts.registerInGroup}`,
      `reply:Uwang:${staffTexts.usage.我的打卡}`,
    ]);

    await s.dm('Uwang', '我的打卡');
    expect(texts(s.take())).toEqual([
      [
        'reply:Uwang:2026-11 打卡紀錄（王小明）',
        '11/3 09:00–18:05｜9 小時 5 分',
        '11/19 22:00–02:30（隔日）｜4 小時 30 分',
        '11/20 09:00–未下班',
        '合計 2 班｜13 小時 35 分',
      ].join('\n'),
    ]);
    await s.dm('Uwang', '我的薪資');
    expect(texts(s.take())).toEqual([
      [
        'reply:Uwang:2026-11 目前累計（12/15 發薪）',
        '王小明｜2 班｜13 小時 35 分',
        '應發 NT$2,717',
        '時薪 NT$200：2 班，13 小時 35 分',
        '另有 1 班未下班，未計入，請用補卡補下班時間',
        '明細請輸入：我的打卡 2026-11',
      ].join('\n'),
    ]);

    await s.dm('Ustranger', '我的薪資');
    await s.dm('Ustranger', '說明');
    expect(texts(s.take())).toEqual([
      `reply:Ustranger:${staffTexts.notRegisteredDm}`,
      `reply:Ustranger:${staffTexts.employeeHelp}`,
    ]);
  });

  it('admin help includes the employee part only when the admin is also an employee', async () => {
    const s = setup(tp('2026-11-20', 12, 0));
    hire(s.seed, A2, '老闆', 200, tp('2026-11-01', 8));
    await s.dm(A1, '說明');
    await s.dm(A2, '說明');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:${staffTexts.adminHelp}`,
      `reply:${A2}:${staffTexts.adminHelp}\n\n${staffTexts.employeeHelp}`,
    ]);
  });

  it('admin commands: list, pending, wage, 代補, disable / enable, records, two-step delete', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    const e = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    s.seed.register('Ulee', '李小華', GROUP, tp('2026-11-12', 10));
    addShift(s.seed, e.id, tp('2026-11-12', 9), tp('2026-11-12', 18, 5));
    addShift(s.seed, e.id, tp('2026-11-12', 19), null);

    await s.dm(A1, '員工列表');
    await s.dm(A1, '待處理');
    await s.dm(A1, '時薪 E001 190 自 12/1');
    await s.dm(A1, '時薪 E009 210');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:員工列表\nE001 王小明｜啟用｜NT$200\nE002 李小華｜申請中｜未設定時薪`,
      `reply:${A1}:註冊申請：\nE002 李小華\n未下班：\nE001 王小明 S0002 11/12 19:00 上班（上班中）`,
      `reply:${A1}:已設定 E001 王小明 時薪 NT$190，自 12/1 起（原 NT$200）\n注意：時薪低於基本工資 NT$196`,
      `reply:${A1}:找不到 E009`,
    ]);

    await s.dm(A1, '補卡 E001 11/12 19:30 下班');
    expect(texts(s.take())).toEqual([`reply:${A1}:已代補 E001 王小明 11/12 19:30 下班（R001）`]);

    await s.dm(A1, '打卡紀錄 E001 2026-11');
    expect(texts(s.take())).toEqual([
      [
        `reply:${A1}:E001 王小明 2026-11 打卡紀錄`,
        'S0001 11/12 09:00–18:05｜9 小時 5 分',
        'S0002 11/12 19:00–19:30｜0 小時 30 分',
        '合計 2 班｜9 小時 35 分',
      ].join('\n'),
    ]);

    await s.dm(A1, '刪除打卡 E001 11/12');
    expect(texts(s.take())).toEqual([
      [
        `reply:${A1}:E001 王小明 11/12 的打卡：`,
        'S0001 11/12 09:00–18:05｜9 小時 5 分',
        'S0002 11/12 19:00–19:30｜0 小時 30 分',
        '刪除請回：刪除 S0001',
      ].join('\n'),
    ]);
    await s.dm(A1, '刪除 S0002');
    await s.dm(A1, '刪除 S0002');
    await s.dm(A1, '刪除 S0099');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:已刪除 S0002（王小明 11/12 19:00–19:30）`,
      `reply:${A1}:S0002 已刪除過`,
      `reply:${A1}:找不到 S0099`,
    ]);
    expect(s.seed.repo.shifts.get(2)!.deleted_at).not.toBeNull();

    await s.dm(A1, '停用 E001');
    await s.dm(A1, '停用 E001');
    await s.group('Uwang', '上班');
    await s.dm(A1, '啟用 E001');
    await s.dm(A1, '駁回 E002');
    await s.dm(A1, '核准 E9');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:已停用 E001 王小明`,
      `reply:${A1}:E001 王小明 已是停用狀態`,
      `reply:${GROUP}:王小明 已停用，請聯絡管理員`,
      `reply:${A1}:已啟用 E001 王小明`,
      'push:Ulee:李小華 的註冊申請未通過',
      `reply:${A1}:已駁回 E002 李小華 的註冊申請`,
      `reply:${A1}:${staffTexts.usage.核准}`,
    ]);
    const actions = (
      s.db.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'set_wage',
        'admin_correction',
        'delete_shift',
        'disable_employee',
        'enable_employee',
        'reject_registration',
      ]),
    );
  });
});

/** E001 王小明: two shifts at two rates; E002 李小華: one open shift (pending). */
function seedNovember(s: ReturnType<typeof setup>) {
  const wang = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
  const lee = hire(s.seed, 'Ulee', '李小華', 200, tp('2026-11-01', 8));
  s.seed.setWage(A1, wang.id, 210, '2026-11-16', tp('2026-11-10', 9));
  addShift(s.seed, wang.id, tp('2026-11-03', 9), tp('2026-11-03', 18, 5));
  addShift(s.seed, wang.id, tp('2026-11-20', 9), tp('2026-11-20', 17));
  addShift(s.seed, lee.id, tp('2026-11-28', 10), null);
}

const SUMMARY = [
  '2026-11 薪資結算（12/15 發薪）',
  'E001 王小明｜2 班｜17 小時 5 分｜NT$3,497',
  'E002 李小華｜0 班｜0 小時 0 分｜NT$0',
  '合計｜2 班｜17 小時 5 分｜NT$3,497',
  '工時標註（不另計加班費）：',
  'E001 王小明 11/3 超過 8 小時（9 小時 5 分）',
  '待處理：',
  '未下班 E002 李小華 S0003 11/28 10:00 上班',
  '處理後可輸入：結算 2026-11 重新結算',
];

const WANG_DM = [
  '2026-11 薪資（12/15 發薪）',
  '王小明｜2 班｜17 小時 5 分',
  '應發 NT$3,497',
  '時薪 NT$200：1 班，9 小時 5 分',
  '時薪 NT$210：1 班，8 小時 0 分',
  '明細請輸入：我的打卡 2026-11',
].join('\n');

describe('staff profile: monthly payroll', () => {
  it('runs at day 1 STAFF_PAYROLL_CRON_HOUR, once, and survives restarts', async () => {
    const s = setup(tp('2026-12-01', 8, 59));
    seedNovember(s);
    failPushesTo(s, ['Ulee']);

    await s.profile.start?.();
    expect(s.take()).toEqual([]);
    expect(s.seed.repo.payrollRuns.listForMonth('2026-11')).toHaveLength(0);
    await s.profile.stop?.();

    // Restart at 09:00 → runs; employees first, then the summary to every admin.
    s.setClock(tp('2026-12-01', 9, 0));
    const p2 = s.makeProfile();
    await p2.start?.();
    const sent = s.take();
    const summary = [...SUMMARY];
    summary[2] = `${summary[2]}｜未加好友，未通知`;
    expect(texts(sent)).toEqual([
      `push:Uwang:${WANG_DM}`,
      `push:Ulee:${[
        '2026-11 薪資（12/15 發薪）',
        '李小華｜0 班｜0 小時 0 分',
        '應發 NT$0',
        '另有 1 班未下班，未計入，請用補卡補下班時間',
        '明細請輸入：我的打卡 2026-11',
      ].join('\n')}`,
      `push:${A1}:${summary.join('\n')}`,
      `push:${A2}:${summary.join('\n')}`,
    ]);
    expect(sent.some((m) => m.to === GROUP)).toBe(false);
    const runs = s.seed.repo.payrollRuns.listForMonth('2026-11');
    expect(runs.map((r) => r.triggered_by)).toEqual(['schedule']);
    await p2.stop?.();

    // Later checks / restarts in the same month do nothing.
    s.setClock(tp('2026-12-05', 10, 0));
    const p3 = s.makeProfile();
    await p3.start?.();
    await p3.stop?.();
    expect(s.take()).toEqual([]);
    expect(s.seed.repo.payrollRuns.listForMonth('2026-11')).toHaveLength(1);
  });

  it('catches up later in the month when the bot was down on day 1', async () => {
    const s = setup(tp('2026-12-09', 23, 0));
    seedNovember(s);
    await s.profile.start?.();
    await s.profile.stop?.();
    const sent = s.take();
    expect(sent.filter((m) => m.to === A1).map((m) => m.text)).toEqual([SUMMARY.join('\n')]);
    expect(s.seed.repo.payrollRuns.listForMonth('2026-11')).toHaveLength(1);
  });

  it('records but sends nothing when the month has no employees (first deployment)', async () => {
    const s = setup(tp('2026-12-01', 9, 30));
    await s.profile.start?.();
    await s.profile.stop?.();
    expect(s.take()).toEqual([]);
    expect(s.seed.repo.payrollRuns.listForMonth('2026-11')).toHaveLength(1);
  });

  it('結算 re-sends the summary to admins only; 通知員工 also DMs employees', async () => {
    const s = setup(tp('2026-12-03', 10, 0));
    seedNovember(s);
    await s.dm(A1, '結算 2026-11');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:${SUMMARY.join('\n')}`,
      `push:${A2}:${SUMMARY.join('\n')}`,
    ]);
    await s.dm(A2, '結算 2026-11 重新結算');
    expect(texts(s.take())).toEqual([
      `reply:${A2}:${SUMMARY.join('\n')}`,
      `push:${A1}:${SUMMARY.join('\n')}`,
    ]);

    await s.dm(A1, '結算 2026-11 通知員工');
    const sent = s.take();
    expect(sent.map((m) => `${m.via}:${m.to}`)).toEqual([
      'push:Uwang',
      'push:Ulee',
      `reply:${A1}`,
      `push:${A2}`,
    ]);
    expect(sent[0]!.text).toBe(WANG_DM);
    expect(sent.some((m) => m.to === GROUP)).toBe(false);
    const runs = s.seed.repo.payrollRuns.listForMonth('2026-11');
    expect(runs.map((r) => r.triggered_by)).toEqual([A1, A2, A1]);

    // Non-admins cannot run payroll.
    await s.dm('Uwang', '結算 2026-11');
    expect(texts(s.take())).toEqual([`reply:Uwang:${staffTexts.unknownCommand}`]);
  });

  it('splits a long summary into ≤5000-char messages, ≤5 per call, without dropping lines', async () => {
    const s = setup(tp('2026-12-03', 10, 0));
    const longName = '測'.repeat(20);
    for (let i = 0; i < 300; i += 1) {
      const e = hire(s.seed, `U${i}`, `${longName}${i}`, 200, tp('2026-11-01', 8));
      addShift(s.seed, e.id, tp('2026-11-03', 9), tp('2026-11-03', 17));
    }
    await s.dm(A1, '結算 2026-11');
    const toA1 = s.take().filter((m) => m.to === A1);
    expect(toA1.length).toBeGreaterThan(1);
    for (const m of toA1) expect(m.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    for (const [req] of s.api.pushMessage.mock.calls) {
      expect(req.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    }
    for (const [req] of s.api.replyMessage.mock.calls) {
      expect(req.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    }
    const lines = toA1
      .map((m) => m.text)
      .join('\n')
      .split('\n');
    expect(lines[0]).toBe('2026-11 薪資結算（12/15 發薪）');
    expect(lines).toHaveLength(1 + 300 + 1);
    expect(lines.at(-1)).toBe('合計｜300 班｜2400 小時 0 分｜NT$480,000');
  });
});

describe('staff profile: wiring', () => {
  it('boots from a staff env without eshop / Anthropic / Grok settings and has no /grok/callback', async () => {
    const config = loadConfig({
      LINE_CHANNEL_SECRET: 's',
      LINE_CHANNEL_ACCESS_TOKEN: 't',
      BOT_PROFILE: 'staff',
      STAFF_ADMIN_USER_IDS: A1,
    });
    const h = harness();
    const profile = createProfile('staff', {
      config,
      db: h.db,
      repos: h.repos,
      replier: h.replier,
      jobs: new JobQueue(h.repos.jobs, { maxAttempts: 1 }),
      grok: new NullGrokGateway(),
      health: fakeHealth(healthResult({ status: 'healthy' })),
      logger: silent,
    });
    expect(profile.name).toBe('staff');
    expect(profile.welcomeText()).toBe(staffTexts.welcome);
    expect(profile.extraRoutes).toBeUndefined();
    expect(profile.handleGroupText).toBeTypeOf('function');

    const app = createApp({
      channelSecret: 's',
      repos: h.repos,
      dispatch: async () => {},
      extraRoutes: profile.extraRoutes,
      profile: profile.name,
      grokCallbackFallback: false,
    });
    expect((await app.request('/grok/callback', { method: 'POST' })).status).toBe(404);
    const health = await app.request('/health');
    expect(((await health.json()) as { profile: string }).profile).toBe('staff');
    expect((await app.request('/webhook', { method: 'POST' })).status).toBe(401);

    // Other profiles keep the 503 fallback.
    const other = createApp({ channelSecret: 's', repos: h.repos, dispatch: async () => {} });
    expect((await other.request('/grok/callback', { method: 'POST' })).status).toBe(503);
  });

  it('follow gets the staff welcome text', async () => {
    const s = setup(tp('2026-11-12', 9, 0));
    expect(s.profile.welcomeText()).toBe(staffTexts.welcome);
  });
});

describe('staff profile: correction improvements (§15)', () => {
  const SETTLED = '2026-11 已結算，請輸入：結算 2026-11 重新結算';

  it('whole shift: group request → admins → approve; a failed approval reaches the applicant', async () => {
    const s = setup(tp('2026-11-13', 10, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.group('Uwang', '補卡 11/12 22:00-02:00');
    const notice =
      '補卡申請 R001 王小明 11/12 22:00–11/13 02:00 整班。核准請回：核准 R001，駁回請回：駁回 R001';
    expect(texts(s.take())).toEqual([
      `push:${A1}:${notice}`,
      `push:${A2}:${notice}`,
      `reply:${GROUP}:已送出補卡申請 R001（11/12 22:00–11/13 02:00 整班），等待管理員核准`,
    ]);
    await s.dm(A1, '待處理');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:補卡申請：\nR001 王小明 11/12 22:00–11/13 02:00 整班`,
    ]);
    await s.dm(A1, '核准 R001');
    expect(texts(s.take())).toEqual([
      'push:Uwang:補卡 R001 已核准',
      `reply:${A1}:已核准補卡 R001（王小明 11/12 22:00–11/13 02:00 整班）`,
    ]);
    await s.dm('Uwang', '我的打卡');
    expect(texts(s.take())).toEqual([
      [
        'reply:Uwang:2026-11 打卡紀錄（王小明）',
        '11/12 22:00–02:00（隔日）｜4 小時 0 分',
        '合計 1 班｜4 小時 0 分',
      ].join('\n'),
    ]);

    // Overlapping request: approval fails, nothing written, applicant told (group fallback).
    await s.group('Uwang', '補卡 11/12 09:00~23:00');
    s.take();
    failPushesTo(s, ['Uwang']);
    await s.dm(A2, '核准 R002');
    const reason = '和 S0001（11/12 22:00–11/13 02:00）重疊';
    expect(texts(s.take())).toEqual([
      `push:Uwang:補卡 R002 無法套用：${reason}，請聯絡管理員`,
      `push:${GROUP}:王小明 補卡 R002 無法套用：${reason}，請聯絡管理員`,
      `reply:${A2}:補卡 R002 無法套用：${reason}`,
    ]);
    expect(s.seed.repo.shifts.listForEmployee(1)).toHaveLength(1);

    await s.dm('Uwang', '補卡 11/12 01:00-18:00');
    await s.dm('Uwang', '補卡 11/13 09:00-11:00');
    expect(texts(s.take())).toEqual([
      'reply:Uwang:整班補卡不能超過 16 小時',
      `reply:Uwang:${staffTexts.correctionFuture}`,
    ]);
  });

  it('取消: own pending only, admins are not told, a later 核准 / 駁回 answers 已取消', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    hire(s.seed, 'Ulee', '李小華', 200, tp('2026-11-01', 8));
    await s.group('Uwang', '補卡 11/12 09:00 上班');
    s.take();

    await s.group('Ulee', '取消 R001');
    await s.group('Ux', '取消 R001');
    await s.group('Uwang', '取消 R001');
    expect(texts(s.take())).toEqual([
      `reply:${GROUP}:找不到 R001`,
      `reply:${GROUP}:找不到 R001`,
      `reply:${GROUP}:已取消補卡申請 R001（11/12 09:00 上班）`,
    ]);
    s.setClock(tp('2026-11-12', 20, 5));
    await s.dm('Uwang', '取消 R001');
    await s.dm(A1, '核准 R001');
    await s.dm(A2, '駁回 R001');
    expect(texts(s.take())).toEqual([
      'reply:Uwang:R001 已取消，無法取消',
      `reply:${A1}:R001 已取消`,
      `reply:${A2}:R001 已取消`,
    ]);
    expect(s.seed.repo.shifts.listForEmployee(1)).toHaveLength(0);

    // A malformed 取消 is chat in the group, a usage hint in a DM.
    await s.group('Uwang', '取消 明天的聚餐');
    await s.dm('Uwang', '取消');
    expect(texts(s.take())).toEqual([`reply:Uwang:${staffTexts.usage.取消}`]);

    await s.dm('Uwang', '補卡 11/12 09:00 上班');
    await s.dm(A1, '核准 R002');
    s.take();
    await s.dm('Uwang', '取消 R002');
    expect(texts(s.take())).toEqual(['reply:Uwang:R002 已核准，無法取消']);
    expect(
      (
        s.db.prepare("SELECT actor FROM audit_log WHERE action = 'cancel_correction'").all() as {
          actor: string;
        }[]
      ).map((r) => r.actor),
    ).toEqual(['Uwang']);
  });

  it('修改 / 代補 / 刪除 answer only the admin and add the settled-month hint', async () => {
    const s = setup(tp('2026-11-13', 12, 0));
    const e = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    addShift(s.seed, e.id, tp('2026-11-12', 9), tp('2026-11-12', 18)); // S0001
    addShift(s.seed, e.id, tp('2026-11-12', 22), null); // S0002, open

    await s.dm(A1, '修改 S0001 下班 18:30');
    await s.dm(A1, '修改 S0002 下班 02:00'); // closes the open shift, next day
    await s.dm(A1, '修改 S0001 上班 19:00');
    await s.dm(A1, '修改 S0001 下班 22:30');
    await s.dm(A1, '修改 S0001 下班 11/13 13:00');
    await s.dm(A1, '修改 S0099 上班 09:00');
    await s.dm(A1, '修改 S0001');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:已修改 S0001 王小明 11/12 09:00–18:30（9 小時 30 分）`,
      `reply:${A1}:已修改 S0002 王小明 11/12 22:00–11/13 02:00（4 小時 0 分）`,
      `reply:${A1}:無法修改 S0001：上班時間須早於下班時間`,
      `reply:${A1}:無法修改 S0001：和 S0002（11/12 22:00–11/13 02:00）重疊`,
      `reply:${A1}:無法修改 S0001：該班會超過 16 小時`,
      `reply:${A1}:找不到 S0099`,
      `reply:${A1}:${staffTexts.usage.修改}`,
    ]);

    s.seed.runPayroll('2026-11', A1, tp('2026-11-13', 11));
    await s.dm(A1, '修改 S0001 上班 08:30');
    await s.dm(A1, '補卡 E001 11/11 09:00-18:00');
    await s.dm(A1, '刪除 S0003');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:已修改 S0001 王小明 11/12 08:30–18:30（10 小時 0 分）\n${SETTLED}`,
      `reply:${A1}:已代補 E001 王小明 11/11 09:00–18:00 整班（R001）\n${SETTLED}`,
      `reply:${A1}:已刪除 S0003（王小明 11/11 09:00–18:00）\n${SETTLED}`,
    ]);

    // Employees cannot edit.
    await s.dm('Uwang', '修改 S0001 上班 08:00');
    await s.dm('Uwang', '修改');
    expect(texts(s.take())).toEqual([
      `reply:Uwang:${staffTexts.unknownCommand}`,
      `reply:Uwang:${staffTexts.unknownCommand}`,
    ]);
    const edits = s.db
      .prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'edit_shift'")
      .all() as { before_json: string; after_json: string }[];
    expect(edits).toHaveLength(3);
    expect(JSON.parse(edits[0]!.before_json)).toMatchObject({
      end_at: tp('2026-11-12', 18).toISOString(),
      end_source: 'punch',
    });
    expect(JSON.parse(edits[0]!.after_json)).toMatchObject({
      end_at: tp('2026-11-12', 18, 30).toISOString(),
      end_source: 'admin',
    });
  });

  it('daily reminder: DMs every admin once a day from the payroll hour, not again after a restart', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    s.seed.runPayroll('2026-10', 'schedule', tp('2026-11-01', 9)); // October already settled
    await s.group('Uwang', '補卡 11/12 09:00 上班');
    s.take();

    s.setClock(tp('2026-11-16', 8, 59));
    const early = s.makeProfile();
    await early.start?.();
    await early.stop?.();
    expect(s.take()).toEqual([]);

    s.setClock(tp('2026-11-16', 9, 0));
    const p = s.makeProfile();
    await p.start?.();
    await p.stop?.();
    const text = '有 1 筆補卡待處理超過 3 天：R001 王小明 11/12 09:00 上班。輸入：待處理';
    expect(texts(s.take())).toEqual([`push:${A1}:${text}`, `push:${A2}:${text}`]);

    s.setClock(tp('2026-11-16', 15, 0));
    const again = s.makeProfile();
    await again.start?.();
    await again.stop?.();
    expect(s.take()).toEqual([]);
  });

  it('說明 lists the new commands', () => {
    expect(staffTexts.employeeHelp).toContain('補卡 11/12 09:00-18:00');
    expect(staffTexts.employeeHelp).toContain('取消 R001');
    expect(staffTexts.adminHelp).toContain('補卡 E001 11/12 09:00-18:00');
    expect(staffTexts.adminHelp).toContain('修改 S0123 上班 09:00');
    expect(staffTexts.adminHelp).toContain('修改 S0123 下班 11/13 02:00');
  });
});

describe('staff profile: Google Sheets backup (§16)', () => {
  const BACKUP_ENV = {
    STAFF_BACKUP_SHEET_URL: 'https://script.google.com/macros/s/SECRET-DEPLOYMENT/exec',
    STAFF_BACKUP_TOKEN: 'secret-token',
  };
  const ok = (counts: Record<string, number> = {}) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, counts })));

  it('is off unless both settings are set: 備份 answers 尚未設定備份試算表', async () => {
    for (const env of [
      {},
      { STAFF_BACKUP_SHEET_URL: BACKUP_ENV.STAFF_BACKUP_SHEET_URL },
      { STAFF_BACKUP_TOKEN: BACKUP_ENV.STAFF_BACKUP_TOKEN },
    ]) {
      const f = ok();
      const s = setup(tp('2026-12-01', 9, 30), env, f);
      await s.profile.start?.();
      await s.profile.stop?.();
      s.take();
      await s.dm(A1, '備份');
      expect(texts(s.take())).toEqual([`reply:${A1}:尚未設定備份試算表`]);
      expect(f).not.toHaveBeenCalled();
    }
  });

  it('備份 / 備份 強制 answer the admin with counts or the reason; others cannot use it', async () => {
    const f = ok({ 員工: 1, 時薪: 1, 打卡: 1 });
    const s = setup(tp('2026-11-12', 10), BACKUP_ENV, f);
    const e = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    addShift(s.seed, e.id, tp('2026-11-03', 9), tp('2026-11-03', 18));
    const audits = s.seed.repo.audit.listAll().length;

    await s.dm(A1, '備份');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:備份完成：員工 1、時薪 1、打卡 1、補卡 0、結算 0、操作紀錄 ${audits}`,
    ]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(BACKUP_ENV.STAFF_BACKUP_SHEET_URL);
    expect(JSON.parse(init!.body as string)).toMatchObject({ token: 'secret-token', force: false });

    f.mockImplementation(
      async () => new Response(JSON.stringify({ ok: false, error: 'shrink', table: '打卡' })),
    );
    await s.dm(A1, '備份');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:備份失敗：筆數減少（打卡）。確定要覆寫請輸入：備份 強制`,
    ]);

    f.mockImplementation(async () => new Response('{"ok":true,"counts":{}}'));
    await s.dm(A1, '備份 強制');
    expect(s.take()[0]!.text).toMatch(/^備份完成：員工 1、/);
    expect(JSON.parse(f.mock.calls[2]![1]!.body as string)).toMatchObject({ force: true });

    await s.dm(A1, '備份 現在');
    expect(texts(s.take())).toEqual([`reply:${A1}:格式：備份 或 備份 強制`]);

    await s.dm('Uwang', '備份');
    await s.group('Uwang', '備份');
    expect(texts(s.take())).toEqual([`reply:Uwang:${staffTexts.unknownCommand}`]);
    expect(f).toHaveBeenCalledTimes(3);
    expect(s.seed.repo.backups.listAll().map((r) => [r.date, r.triggered_by, r.ok])).toEqual([
      [null, A1, 1],
      [null, A1, 0],
      [null, A1, 1],
    ]);
    // The URL and token never reach the log.
    const logged = s.logLines.join('');
    expect(logged).not.toContain('SECRET-DEPLOYMENT');
    expect(logged).not.toContain('secret-token');
  });

  it('runs daily from STAFF_BACKUP_HOUR on start, once a day, silently on success', async () => {
    const f = ok();
    const s = setup(tp('2026-11-13', 0, 59), BACKUP_ENV, f);
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.profile.start?.();
    await s.profile.stop?.();
    expect(f).not.toHaveBeenCalled(); // before 01:00

    s.setClock(tp('2026-11-13', 1, 0));
    const p = s.makeProfile();
    await p.start?.();
    await p.stop?.();
    expect(f).toHaveBeenCalledTimes(1);
    expect(s.take().some((m) => m.text.includes('備份'))).toBe(false); // only the October payroll
    const payload = JSON.parse(f.mock.calls[0]![1]!.body as string) as {
      tables: { name: string; rows: unknown[][] }[];
    };
    expect(payload.tables.find((t) => t.name === '員工')!.rows).toHaveLength(1);
    expect(s.seed.repo.backups.listAll().map((r) => [r.date, r.triggered_by, r.ok])).toEqual([
      ['2026-11-13', 'schedule', 1],
    ]);

    s.setClock(tp('2026-11-13', 15, 0));
    const again = s.makeProfile();
    await again.start?.();
    await again.stop?.();
    expect(f).toHaveBeenCalledTimes(1);

    // STAFF_BACKUP_HOUR moves the daily time.
    const g = ok();
    const t = setup(tp('2026-11-13', 2, 0), { ...BACKUP_ENV, STAFF_BACKUP_HOUR: '3' }, g);
    await t.profile.start?.();
    await t.profile.stop?.();
    expect(g).not.toHaveBeenCalled();
    t.setClock(tp('2026-11-13', 3, 0));
    const t2 = t.makeProfile();
    await t2.start?.();
    await t2.stop?.();
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('a scheduled failure DMs every admin once; a manual 備份 that succeeds ends the streak', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const s = setup(tp('2026-11-13', 1, 0), BACKUP_ENV, f);
    await s.profile.start?.();
    await s.profile.stop?.();
    const fail = '11/13 每日備份失敗：網路錯誤。處理後可輸入：備份';
    expect(texts(s.take())).toEqual([`push:${A1}:${fail}`, `push:${A2}:${fail}`]);

    // The manual failure is answered only to the asking admin.
    await s.dm(A1, '備份');
    expect(texts(s.take())).toEqual([`reply:${A1}:備份失敗：網路錯誤`]);

    f.mockImplementation(async () => new Response('{"ok":true,"counts":{}}'));
    s.setClock(tp('2026-11-13', 1, 30));
    await s.dm(A1, '備份');
    expect(texts(s.take())).toEqual([
      `push:${A2}:備份已恢復`,
      `reply:${A1}:備份完成：員工 0、時薪 0、打卡 0、補卡 0、結算 0、操作紀錄 1\n備份已恢復`,
    ]);
    await s.dm(A1, '備份');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:備份完成：員工 0、時薪 0、打卡 0、補卡 0、結算 0、操作紀錄 1`,
    ]);
  });

  it('說明 lists 備份 for admins only', () => {
    expect(staffTexts.adminHelp).toContain('備份、備份 強制');
    expect(staffTexts.employeeHelp).not.toContain('備份');
  });
});

describe('staff profile: batch corrections and approvals (§17)', () => {
  const G2 = 'Cgroup2';

  it('multi-line 補卡 in a group: per-line results, one admin notice, resend and same-message duplicate', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    const message = [
      '補卡 11/10 09:00-18:00',
      '',
      '補卡 11/11 09:00 上班',
      '補卡 9/30 09:00 上班',
      '補卡 11/11 18:00 下班',
      '補卡 11/11 09:00 上班',
      '補卡 11/12 21:00 上班',
    ].join('\n');
    await s.group('Uwang', message);
    const notice = [
      '王小明 補卡申請 3 筆：',
      'R001 11/10 09:00–18:00 整班',
      'R002 11/11 09:00 上班',
      'R003 11/11 18:00 下班',
      '核准請回：核准 R001 R002 R003，或：核准全部',
    ].join('\n');
    const answer = [
      'R001 11/10 09:00–18:00 整班 已送出',
      'R002 11/11 09:00 上班 已送出',
      '9/30 09:00 上班：只能補上個月 1 日以後的打卡',
      'R003 11/11 18:00 下班 已送出',
      '11/11 09:00 上班：R002 已在審核中',
      '11/12 21:00 上班：不能補未來的時間',
      '共送出 3 筆，等待管理員核准',
    ].join('\n');
    expect(texts(s.take())).toEqual([
      `push:${A1}:${notice}`,
      `push:${A2}:${notice}`,
      `reply:${GROUP}:${answer}`,
    ]);
    expect(s.seed.repo.corrections.listPending()).toHaveLength(3);

    // Resent within 60 s: the same answer, admins are not told again.
    s.setClock(tp('2026-11-12', 20, 0, 30));
    await s.group('Uwang', message);
    expect(texts(s.take())).toEqual([`reply:${GROUP}:${answer}`]);
    expect(s.seed.repo.corrections.listPending()).toHaveLength(3);
  });

  it('multi-line 補卡 in a DM with nothing created sends no admin notice', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.dm('Uwang', '補卡 9/1 09:00 上班\n補卡 11/10 01:00-18:00');
    expect(texts(s.take())).toEqual([
      [
        'reply:Uwang:9/1 09:00 上班：只能補上個月 1 日以後的打卡',
        '11/10 01:00–18:00 整班：整班補卡不能超過 16 小時',
        '沒有送出新的補卡申請',
      ].join('\n'),
    ]);
    await s.dm('Ustranger', '補卡 11/10 09:00 上班\n補卡 11/10 18:00 下班');
    expect(texts(s.take())).toEqual([`reply:Ustranger:${staffTexts.notRegisteredDm}`]);
  });

  it('a bad line or more than 12 lines refuses the whole message', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    await s.group('Uwang', '補卡 11/10 09:00 上班\n\n補卡 11/10 18:00');
    await s.dm('Uwang', '補卡 11/10 09:00 上班\n上班');
    const many = Array.from({ length: 13 }, (_, i) => `補卡 11/${i + 1} 09:00 上班`).join('\n');
    await s.group('Uwang', many);
    await s.dm(A1, '補卡 E001 11/10 09:00 上班\n補卡 E001 11/10');
    await s.dm(A1, many.replaceAll('補卡 ', '補卡 E001 '));
    // Ordinary multi-line chat is still ignored in the group.
    await s.group('Uwang', '今天\n補卡 11/10 09:00 上班');
    expect(texts(s.take())).toEqual([
      `reply:${GROUP}:第 3 行格式不對：補卡 11/10 18:00\n${staffTexts.usage.補卡}`,
      `reply:Uwang:第 2 行格式不對：上班\n${staffTexts.usage.補卡}`,
      `reply:${GROUP}:一次最多 12 筆，請分開送`,
      `reply:${A1}:第 2 行格式不對：補卡 E001 11/10\n${staffTexts.usage.補卡}\n${staffTexts.adminCorrectionUsage}`,
      `reply:${A1}:一次最多 12 筆，請分開送`,
    ]);
    expect(s.seed.repo.corrections.listAll()).toEqual([]);
    expect(s.seed.repo.shifts.listForEmployee(1)).toEqual([]);
  });

  it('multi-line 代補 applies in line order, mixes employees, adds the settled hint once', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-10-01', 8));
    hire(s.seed, 'Ulee', '李小華', 200, tp('2026-10-01', 8));
    s.seed.runPayroll('2026-10', A1, tp('2026-11-01', 9));
    await s.dm(
      A1,
      [
        '補卡 E001 11/11 09:00 上班',
        '補卡 E002 11/11 10:00-19:00',
        '補卡 E001 11/11 18:00 下班',
        '補卡 E001 9/1 09:00 上班',
        '補卡 E009 11/11 09:00 上班',
        '補卡 E002 10/20 09:00-18:00',
        '補卡 E002 10/21 09:00-18:00',
      ].join('\n'),
    );
    expect(texts(s.take())).toEqual([
      [
        `reply:${A1}:已代補 E001 王小明 11/11 09:00 上班（R001）`,
        '已代補 E002 李小華 11/11 10:00–19:00 整班（R002）',
        '已代補 E001 王小明 11/11 18:00 下班（R003）',
        'E001 9/1 09:00 上班：只能補上個月 1 日以後的打卡',
        '找不到 E009',
        '已代補 E002 李小華 10/20 09:00–18:00 整班（R004）',
        '已代補 E002 李小華 10/21 09:00–18:00 整班（R005）',
        '2026-10 已結算，請輸入：結算 2026-10 重新結算',
      ].join('\n'),
    ]);
    const wang = s.seed.repo.shifts.listForEmployee(1);
    expect(wang).toHaveLength(1);
    expect(wang[0]!.end_at).toBe(tp('2026-11-11', 18).toISOString());
  });

  it('核准 R… R…: separators, duplicates, time order pairs in / out, one notice per applicant and group', async () => {
    const s = setup(tp('2026-11-12', 20, 0), { STAFF_GROUP_IDS: `${GROUP},${G2}` });
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    hire(s.seed, 'Ulee', '李小華', 200, tp('2026-11-01', 8));
    await s.group('Uwang', '補卡 11/11 09:00 上班\n補卡 11/11 18:00 下班'); // R001 R002
    await s.group('Ulee', '補卡 11/11 10:00 上班'); // R003
    await s.group('Ulee', '補卡 11/10 10:00-12:00', G2); // R004
    s.take();

    failPushesTo(s, ['Ulee']);
    await s.dm(A1, '核准 R002，R001、R003 R003 R099,R004');
    expect(texts(s.take())).toEqual([
      'push:Ulee:補卡 R004 已核准\n補卡 R003 已核准',
      `push:${G2}:李小華 補卡 R004 已核准`,
      `push:${GROUP}:李小華 補卡 R003 已核准`,
      'push:Uwang:補卡 R001 已核准\n補卡 R002 已核准',
      [
        `reply:${A1}:已核准補卡 R004（李小華 11/10 10:00–12:00 整班）`,
        '已核准補卡 R001（王小明 11/11 09:00 上班），同時套用 R002',
        '已核准補卡 R003（李小華 11/11 10:00 上班）',
        '已核准補卡 R002（王小明 11/11 18:00 下班）',
        '找不到 R099',
      ].join('\n'),
    ]);
    const wang = s.seed.repo.shifts.listForEmployee(1);
    expect(wang).toHaveLength(1);
    expect(wang[0]!.end_at).toBe(tp('2026-11-11', 18).toISOString());

    // Already decided ones answer per id, nobody is notified.
    await s.dm(A1, '核准 R001 R002');
    expect(texts(s.take())).toEqual([
      `reply:${A1}:R001 已處理過（已核准）\nR002 已處理過（已核准）`,
    ]);
  });

  it('a failed approval goes into the same merged notice; 駁回 R… R… covers cancelled ones', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    const e = hire(s.seed, 'Uwang', '王小明', 200, tp('2026-11-01', 8));
    addShift(s.seed, e.id, tp('2026-11-10', 9), tp('2026-11-10', 18));
    await s.group('Uwang', '補卡 11/10 08:00-12:00\n補卡 11/9 09:00-18:00'); // R001 R002
    await s.group('Uwang', '補卡 11/8 09:00 上班\n補卡 11/7 09:00 上班'); // R003 R004
    await s.group('Uwang', '取消 R003');
    s.take();

    await s.dm(A1, '核准 R001 R002');
    const reason = '和 S0001（11/10 09:00–18:00）重疊';
    expect(texts(s.take())).toEqual([
      `push:Uwang:補卡 R002 已核准\n補卡 R001 無法套用：${reason}，請聯絡管理員`,
      [
        `reply:${A1}:已核准補卡 R002（王小明 11/9 09:00–18:00 整班）`,
        `補卡 R001 無法套用：${reason}`,
      ].join('\n'),
    ]);

    await s.dm(A1, '駁回 R003 R004');
    expect(texts(s.take())).toEqual([
      'push:Uwang:補卡 R004 已駁回',
      `reply:${A1}:已駁回補卡 R004（王小明）\nR003 已取消`,
    ]);

    const ids = Array.from({ length: 13 }, (_, i) => `R${i + 1}`).join(' ');
    await s.dm(A1, `核准 ${ids}`);
    await s.dm(A1, `駁回 ${ids}`);
    await s.dm('Uwang', '核准 R001 R002');
    await s.group('Uwang', `核准 ${ids}`);
    expect(texts(s.take())).toEqual([
      `reply:${A1}:一次最多 12 筆，請分開送`,
      `reply:${A1}:一次最多 12 筆，請分開送`,
      `reply:Uwang:${staffTexts.unknownCommand}`,
    ]);
  });

  it('核准全部: oldest 12 pending, then the rest, then nothing', async () => {
    const s = setup(tp('2026-11-12', 20, 0));
    hire(s.seed, 'Uwang', '王小明', 200, tp('2026-10-01', 8));
    for (let d = 1; d <= 14; d += 1) {
      const date = addDays('2026-10-19', d);
      const r = s.seed.requestCorrection(
        'Uwang',
        { kind: 'shift', at: tp(date, 9), endAt: tp(date, 10) },
        GROUP,
        tp('2026-11-12', 19, 0),
      );
      expect(r.kind).toBe('requested');
    }

    await s.dm(A1, '核准全部');
    const first = s.take();
    expect(first).toHaveLength(2);
    expect(first[0]!.to).toBe('Uwang');
    expect(first[0]!.text.split('\n')).toHaveLength(12);
    const answer = first[1]!.text.split('\n');
    expect(answer).toHaveLength(13);
    expect(answer[0]).toBe(`已核准補卡 R001（王小明 10/20 09:00–10:00 整班）`);
    expect(answer[12]).toBe('另有 2 筆待審，可再輸入：核准全部');

    await s.dm(A1, '核准全部');
    expect(texts(s.take())).toEqual([
      'push:Uwang:補卡 R013 已核准\n補卡 R014 已核准',
      [
        `reply:${A1}:已核准補卡 R013（王小明 11/1 09:00–10:00 整班）`,
        '已核准補卡 R014（王小明 11/2 09:00–10:00 整班）',
      ].join('\n'),
    ]);
    await s.dm(A1, '核准全部');
    expect(texts(s.take())).toEqual([`reply:${A1}:目前沒有待審的補卡`]);
  });

  it('說明 mentions the batch forms', () => {
    expect(staffTexts.employeeHelp).toContain('最多 12 行');
    expect(staffTexts.adminHelp).toContain('核准全部');
  });
});
