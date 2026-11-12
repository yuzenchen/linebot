import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { Replier } from '../../src/line/replier.js';
import {
  type BackupPayload,
  buildBackupTables,
  createStaffBackup,
  parseBackupResponse,
  postBackup,
} from '../../src/staff/backup.js';
import { parseStaffCommand } from '../../src/staff/commands.js';
import { createStaffMessenger } from '../../src/staff/messenger.js';
import { backupFailureOutstanding, startBackupScheduler } from '../../src/staff/scheduler.js';
import type { StaffService } from '../../src/staff/service.js';
import { staffBackupFailed, staffBackupScheduledFailed } from '../../src/texts.js';
import { fakeApi, silent } from '../handlers/helpers.js';
import { ADMIN, addShift, hire, setup, tp } from './helpers.js';

const URL_ = 'https://script.google.com/macros/s/SECRET-DEPLOYMENT/exec';
const TOKEN = 'secret-token';

function seed(svc: StaffService) {
  const e = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
  svc.register('Ub', '李小華', 'Cgroup', tp('2026-11-02', 10));
  addShift(svc, e.id, tp('2026-11-03', 9), tp('2026-11-03', 18, 30)); // S0001, 570 min
  const deleted = addShift(svc, e.id, tp('2026-11-04', 9), tp('2026-11-04', 17, 0, 30)); // S0002
  svc.deleteShift(ADMIN, deleted, tp('2026-11-05', 10));
  addShift(svc, e.id, tp('2026-11-06', 9), null); // S0003, open
  svc.requestCorrection(
    'Ua',
    { kind: 'in', at: tp('2026-11-10', 9) },
    'Cgroup',
    tp('2026-11-10', 20),
  );
  svc.runPayroll('2026-11', 'schedule', tp('2026-12-01', 9));
  return e;
}

/** A fetch mock answering with `body` (JSON-encoded unless a string). */
function answering(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function sentPayload(f: ReturnType<typeof answering>, call = 0): BackupPayload {
  const init = f.mock.calls[call]![1]!;
  return JSON.parse(init.body as string) as BackupPayload;
}

describe('buildBackupTables (§16.2)', () => {
  it('builds the seven tabs in Taipei time with display ids, deleted shifts and flattened runs', () => {
    const { db, svc } = setup();
    seed(svc);
    const tables = buildBackupTables(db, svc.repo, {
      now: tp('2026-12-01', 9, 5),
      triggeredBy: 'schedule',
    });
    expect(tables.map((t) => t.name)).toEqual([
      '員工',
      '時薪',
      '打卡',
      '補卡',
      '結算',
      '操作紀錄',
      '備份資訊',
    ]);
    const [employees, wages, shifts, corrections, payroll, audit, info] = tables;

    expect(employees!.header).toEqual([
      '編號',
      '名字',
      '狀態',
      'LINE userId',
      '申請時間',
      '核准時間',
      '核准者',
    ]);
    expect(employees!.rows).toEqual([
      ['E001', '王小明', '啟用', 'Ua', '2026-11-01 07:00', '2026-11-01 08:00', ADMIN],
      ['E002', '李小華', '申請中', 'Ub', '2026-11-02 10:00', '', ''],
    ]);

    expect(wages!.rows).toEqual([['E001', '王小明', 200, '2026-11-01', ADMIN, '2026-11-01 08:00']]);

    expect(shifts!.header).toHaveLength(11);
    expect(shifts!.rows).toEqual([
      [
        'S0001',
        'E001',
        '王小明',
        '2026-11-03 09:00',
        '2026-11-03 18:30',
        570,
        '打卡',
        '打卡',
        '',
        '2026-11-03 09:00',
        '2026-11-03 09:00',
      ],
      [
        'S0002',
        'E001',
        '王小明',
        '2026-11-04 09:00',
        '2026-11-04 17:00',
        480.5,
        '打卡',
        '打卡',
        '2026-11-05 10:00',
        '2026-11-04 09:00',
        '2026-11-05 10:00',
      ],
      [
        'S0003',
        'E001',
        '王小明',
        '2026-11-06 09:00',
        '',
        '',
        '打卡',
        '',
        '',
        '2026-11-06 09:00',
        '2026-11-06 09:00',
      ],
    ]);

    expect(corrections!.header).toHaveLength(14);
    expect(corrections!.rows).toEqual([
      [
        'R001',
        'E001',
        '王小明',
        '上班',
        '2026-11-10 09:00',
        '',
        '待審',
        '',
        'Ua',
        'Cgroup',
        '',
        '2026-11-10 20:00',
        '',
        '',
      ],
    ]);

    expect(payroll!.header).toEqual([
      '結算編號',
      '月份',
      '執行時間',
      '觸發者',
      '員工編號',
      '名字',
      '班數',
      '分鐘',
      '應發金額',
    ]);
    expect(payroll!.rows).toEqual([
      [1, '2026-11', '2026-12-01 09:00', '排程', 'E001', '王小明', 1, 570, 1900],
    ]);

    const auditRows = svc.repo.audit.listAll();
    expect(audit!.rows).toHaveLength(auditRows.length);
    expect(audit!.rows[0]).toEqual([
      auditRows[0]!.id,
      auditRows[0]!.actor,
      auditRows[0]!.action,
      auditRows[0]!.target ?? '',
      auditRows[0]!.before_json ?? '',
      auditRows[0]!.after_json ?? '',
      '2026-11-01 08:00',
    ]);

    expect(info!.header).toEqual([
      '備份時間',
      '觸發者',
      '資料庫版本',
      '員工',
      '時薪',
      '打卡',
      '補卡',
      '結算',
      '操作紀錄',
    ]);
    expect(info!.rows).toEqual([['2026-12-01 09:05', '排程', 11, 2, 1, 3, 1, 1, auditRows.length]]);
    // Every row is as wide as its header.
    for (const t of tables) for (const r of t.rows) expect(r).toHaveLength(t.header.length);
  });

  it('one payroll row per employee per run (manual reruns too); the admin is the trigger', () => {
    const { db, svc } = setup();
    const a = hire(svc, 'Ua', '王小明', 200, tp('2026-11-01', 8));
    const b = hire(svc, 'Ub', '李小華', 210, tp('2026-11-01', 8));
    addShift(svc, a.id, tp('2026-11-03', 9), tp('2026-11-03', 10));
    addShift(svc, b.id, tp('2026-11-03', 9), tp('2026-11-03', 11));
    svc.runPayroll('2026-11', 'schedule', tp('2026-12-01', 9));
    svc.runPayroll('2026-11', ADMIN, tp('2026-12-02', 9));
    const payroll = buildBackupTables(db, svc.repo, {
      now: tp('2026-12-02', 10),
      triggeredBy: ADMIN,
    })[4]!;
    expect(payroll.rows.map((r) => [r[0], r[3], r[4], r[8]])).toEqual([
      [1, '排程', 'E001', 200],
      [1, '排程', 'E002', 420],
      [2, ADMIN, 'E001', 200],
      [2, ADMIN, 'E002', 420],
    ]);
  });
});

describe('parseBackupResponse', () => {
  it('maps the Apps Script answers', () => {
    expect(parseBackupResponse('{"ok":true,"counts":{"員工":3,"x":"no"}}')).toEqual({
      ok: true,
      counts: { 員工: 3 },
    });
    expect(parseBackupResponse('{"ok":false,"error":"unauthorized"}')).toEqual({
      ok: false,
      failure: { code: 'unauthorized' },
    });
    expect(parseBackupResponse('{"ok":false,"error":"shrink","table":"打卡"}')).toEqual({
      ok: false,
      failure: { code: 'shrink', table: '打卡' },
    });
    expect(parseBackupResponse('{"ok":false,"error":"busy"}')).toEqual({
      ok: false,
      failure: { code: 'busy' },
    });
    expect(parseBackupResponse('{"ok":false,"error":"Exception: boom"}')).toEqual({
      ok: false,
      failure: { code: 'script', detail: 'Exception: boom' },
    });
    for (const bad of ['<html>Sign in</html>', '[]', 'null', '{"counts":{}}']) {
      expect(parseBackupResponse(bad)).toEqual({ ok: false, failure: { code: 'badResponse' } });
    }
  });

  it('turns failures into readable reasons', () => {
    expect(staffBackupFailed({ code: 'shrink', table: '打卡' })).toBe(
      '備份失敗：筆數減少（打卡）。確定要覆寫請輸入：備份 強制',
    );
    expect(staffBackupFailed({ code: 'unauthorized' })).toBe('備份失敗：驗證碼不符');
    expect(staffBackupFailed({ code: 'http', status: 404 })).toBe(
      '備份失敗：試算表回應異常（HTTP 404）',
    );
    expect(staffBackupScheduledFailed('2026-11-13', { code: 'network' })).toBe(
      '11/13 每日備份失敗：網路錯誤。處理後可輸入：備份',
    );
  });
});

describe('postBackup', () => {
  const payload: BackupPayload = {
    token: TOKEN,
    force: true,
    generatedAt: '2026-12-01 09:05',
    tables: [{ name: '員工', header: ['編號'], rows: [['E001']] }],
  };

  it('POSTs the JSON payload and follows redirects', async () => {
    const f = answering({ ok: true, counts: { 員工: 1 } });
    expect(await postBackup(URL_, payload, { fetch: f })).toEqual({
      ok: true,
      counts: { 員工: 1 },
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init).toMatchObject({ method: 'POST', redirect: 'follow' });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(sentPayload(f)).toEqual(payload);
  });

  it('reports network errors, timeouts and HTTP errors without throwing', async () => {
    const logs: string[] = [];
    const { pino } = await import('pino');
    const log = pino({ level: 'info' }, { write: (s: string) => void logs.push(s) });
    const down = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new TypeError(`fetch failed ${URL_}`), {
        cause: { code: 'ENOTFOUND' },
      });
    });
    expect(await postBackup(URL_, payload, { fetch: down, log })).toEqual({
      ok: false,
      failure: { code: 'network' },
    });
    expect(logs.join('')).toContain('ENOTFOUND');
    expect(logs.join('')).not.toContain('SECRET-DEPLOYMENT');
    expect(logs.join('')).not.toContain(TOKEN);

    const slow = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        }),
    );
    expect(await postBackup(URL_, payload, { fetch: slow, timeoutMs: 20 })).toEqual({
      ok: false,
      failure: { code: 'timeout' },
    });

    expect(await postBackup(URL_, payload, { fetch: answering('nope', 500) })).toEqual({
      ok: false,
      failure: { code: 'http', status: 500 },
    });
  });

  describe('with a local server that redirects like Apps Script', () => {
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    it('a POST answered with 302 is followed as a GET and yields the JSON body', async () => {
      const seen: string[] = [];
      let received = '';
      const server = createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        if (req.method === 'POST' && req.url === '/exec') {
          let body = '';
          req.on('data', (c: Buffer) => (body += c.toString()));
          req.on('end', () => {
            received = body;
            res.writeHead(302, { location: '/echo?id=1' });
            res.end();
          });
          return;
        }
        if (req.method === 'GET' && req.url === '/echo?id=1') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, counts: { 員工: 1 } }));
          return;
        }
        res.writeHead(405);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      close = () => new Promise((resolve) => server.close(() => resolve()));
      const { port } = server.address() as AddressInfo;

      const r = await postBackup(`http://127.0.0.1:${port}/exec`, payload);
      expect(r).toEqual({ ok: true, counts: { 員工: 1 } });
      expect(seen).toEqual(['POST /exec', 'GET /echo?id=1']);
      expect(JSON.parse(received)).toEqual(payload);
    });
  });
});

describe('createStaffBackup', () => {
  it('records each attempt in staff_backups and returns per-tab counts', async () => {
    const { db, svc } = setup();
    seed(svc);
    const f = answering({ ok: true, counts: { 員工: 2, 時薪: 1, 打卡: 3 } });
    const backup = createStaffBackup({
      db,
      repo: svc.repo,
      url: URL_,
      token: TOKEN,
      fetch: f,
      now: () => tp('2026-12-01', 9, 6),
      log: silent,
    });
    const r = await backup.run({
      date: null,
      triggeredBy: ADMIN,
      force: true,
      now: tp('2026-12-01', 9, 5),
    });
    const auditCount = svc.repo.audit.listAll().length;
    expect(r).toEqual({
      id: 1,
      ok: true,
      counts: [
        { name: '員工', count: 2 },
        { name: '時薪', count: 1 },
        { name: '打卡', count: 3 },
        { name: '補卡', count: 1 },
        { name: '結算', count: 1 },
        { name: '操作紀錄', count: auditCount },
      ],
    });
    const p = sentPayload(f);
    expect(p).toMatchObject({ token: TOKEN, force: true, generatedAt: '2026-12-01 09:05' });
    expect(p.tables).toHaveLength(7);
    expect(p.tables[6]!.rows[0]!.slice(0, 2)).toEqual(['2026-12-01 09:05', ADMIN]);
    expect(svc.repo.backups.get(1)).toMatchObject({
      date: null,
      triggered_by: ADMIN,
      started_at: tp('2026-12-01', 9, 5).toISOString(),
      finished_at: tp('2026-12-01', 9, 6).toISOString(),
      ok: 1,
      error: null,
    });
    expect(JSON.parse(svc.repo.backups.get(1)!.counts_json!)).toMatchObject({ 員工: 2, 補卡: 1 });

    f.mockImplementation(
      async () => new Response(JSON.stringify({ ok: false, error: 'shrink', table: '打卡' })),
    );
    const failed = await backup.run({
      date: '2026-12-01',
      triggeredBy: 'schedule',
      force: false,
      now: tp('2026-12-01', 10),
    });
    expect(failed).toEqual({ id: 2, ok: false, failure: { code: 'shrink', table: '打卡' } });
    expect(svc.repo.backups.get(2)).toMatchObject({
      date: '2026-12-01',
      ok: 0,
      error: '筆數減少（打卡）',
      counts_json: null,
    });
  });

  it('serializes overlapping runs', async () => {
    const { db, svc } = setup();
    let active = 0;
    let maxActive = 0;
    const f = vi.fn<typeof fetch>(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return new Response('{"ok":true,"counts":{}}');
    });
    const backup = createStaffBackup({
      db,
      repo: svc.repo,
      url: URL_,
      token: TOKEN,
      fetch: f,
      log: silent,
    });
    const at = tp('2026-12-01', 9);
    const results = await Promise.all([
      backup.run({ date: null, triggeredBy: ADMIN, force: false, now: at }),
      backup.run({ date: '2026-12-01', triggeredBy: 'schedule', force: false, now: at }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(maxActive).toBe(1);
  });
});

describe('parseStaffCommand: 備份', () => {
  const now = tp('2026-12-01', 10);
  it('parses 備份 and 備份 強制', () => {
    expect(parseStaffCommand('備份', now)).toEqual({ type: 'backup', force: false });
    expect(parseStaffCommand(' 備份  強制 ', now)).toEqual({ type: 'backup', force: true });
    expect(parseStaffCommand('備份 現在', now)).toEqual({ type: 'malformed', keyword: '備份' });
  });
});

describe('backup scheduler (§16.1, §16.5)', () => {
  function build(start: Date) {
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
    let clock = start;
    const f = answering({ ok: true, counts: {} });
    const backup = createStaffBackup({
      db,
      repo: svc.repo,
      url: URL_,
      token: TOKEN,
      fetch: f,
      now: () => clock,
      log: silent,
    });
    const startScheduler = () =>
      startBackupScheduler({
        service: svc,
        backup,
        messenger,
        hour: 1,
        intervalMs: 3_600_000,
        now: () => clock,
        log: silent,
      });
    let seen = 0;
    const pushes = () => {
      const all = api.pushMessage.mock.calls.map(
        ([req]) => `${req.to}:${req.messages.map((m) => m.text).join('|')}`,
      );
      const fresh = all.slice(seen);
      seen = all.length;
      return fresh;
    };
    const fail = () =>
      f.mockImplementation(async () => new Response('{"ok":false,"error":"unauthorized"}'));
    const succeed = () => f.mockImplementation(async () => new Response('{"ok":true,"counts":{}}'));
    return {
      svc,
      f,
      backup,
      startScheduler,
      pushes,
      fail,
      succeed,
      setClock: (d: Date) => {
        clock = d;
      },
    };
  }

  it('runs once a day from STAFF_BACKUP_HOUR, silently, and not again after a restart', async () => {
    const b = build(tp('2026-11-13', 0, 59));
    const s1 = b.startScheduler();
    expect(await s1.initial).toBeNull(); // before 01:00
    b.setClock(tp('2026-11-13', 1, 0));
    const [first, second] = await Promise.all([s1.checkOnce(), s1.checkOnce()]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toBeNull();
    b.setClock(tp('2026-11-13', 23, 0));
    expect(await s1.checkOnce()).toBeNull();
    s1.stop();
    expect(b.pushes()).toEqual([]); // success: log + DB only

    const s2 = b.startScheduler(); // restart the same day
    expect(await s2.initial).toBeNull();
    b.setClock(tp('2026-11-14', 0, 30));
    expect(await s2.checkOnce()).toBeNull();
    b.setClock(tp('2026-11-14', 1, 5));
    expect(await s2.checkOnce()).toMatchObject({ ok: true });
    s2.stop();
    expect(b.f).toHaveBeenCalledTimes(2);
    expect(b.svc.repo.backups.listAll().map((r) => [r.date, r.triggered_by, r.ok])).toEqual([
      ['2026-11-13', 'schedule', 1],
      ['2026-11-14', 'schedule', 1],
    ]);
  });

  it('does not catch up earlier days when the bot was down', async () => {
    const b = build(tp('2026-11-16', 15, 0));
    const s = b.startScheduler();
    expect(await s.initial).toMatchObject({ ok: true });
    s.stop();
    expect(b.svc.repo.backups.listAll().map((r) => r.date)).toEqual(['2026-11-16']);
  });

  it('retries hourly; one DM per failure streak across days; 備份已恢復 when it ends', async () => {
    const b = build(tp('2026-11-13', 1, 0));
    b.fail();
    const s = b.startScheduler();
    expect(await s.initial).toMatchObject({ ok: false, failure: { code: 'unauthorized' } });
    const text = '11/13 每日備份失敗：驗證碼不符。處理後可輸入：備份';
    expect(b.pushes()).toEqual([`Uadmin1:${text}`, `Uadmin2:${text}`]);
    expect(backupFailureOutstanding(b.svc.repo)).toBe(true);

    b.setClock(tp('2026-11-13', 1, 59)); // 59 minutes later: not yet
    expect(await s.checkOnce()).toBeNull();
    b.setClock(tp('2026-11-13', 2, 0));
    expect(await s.checkOnce()).toMatchObject({ ok: false });
    s.stop();

    // A restart keeps the hourly pace; the next day's failures are the same streak.
    b.setClock(tp('2026-11-13', 2, 30));
    const s2 = b.startScheduler();
    expect(await s2.initial).toBeNull();
    b.setClock(tp('2026-11-14', 1, 0));
    expect(await s2.checkOnce()).toMatchObject({ ok: false });
    expect(b.pushes()).toEqual([]);

    b.succeed();
    b.setClock(tp('2026-11-14', 2, 0));
    expect(await s2.checkOnce()).toMatchObject({ ok: true });
    expect(b.pushes()).toEqual(['Uadmin1:備份已恢復', 'Uadmin2:備份已恢復']);
    expect(backupFailureOutstanding(b.svc.repo)).toBe(false);
    b.setClock(tp('2026-11-14', 5, 0));
    expect(await s2.checkOnce()).toBeNull();

    // A new streak notifies again.
    b.fail();
    b.setClock(tp('2026-11-15', 1, 0));
    expect(await s2.checkOnce()).toMatchObject({ ok: false });
    expect(b.pushes()).toEqual([
      'Uadmin1:11/15 每日備份失敗：驗證碼不符。處理後可輸入：備份',
      'Uadmin2:11/15 每日備份失敗：驗證碼不符。處理後可輸入：備份',
    ]);
    s2.stop();
  });

  it('a manual success ends the streak but the day still retries until its scheduled success', async () => {
    const b = build(tp('2026-11-13', 1, 0));
    b.fail();
    const s = b.startScheduler();
    await s.initial;
    b.pushes();
    b.succeed();
    await b.backup.run({
      date: null,
      triggeredBy: ADMIN,
      force: false,
      now: tp('2026-11-13', 1, 30),
    });
    expect(backupFailureOutstanding(b.svc.repo)).toBe(false);
    // A manual failure neither starts a streak nor counts for the day.
    b.fail();
    await b.backup.run({
      date: null,
      triggeredBy: ADMIN,
      force: false,
      now: tp('2026-11-13', 1, 40),
    });
    expect(backupFailureOutstanding(b.svc.repo)).toBe(false);

    b.succeed();
    b.setClock(tp('2026-11-13', 2, 0));
    expect(await s.checkOnce()).toMatchObject({ ok: true });
    expect(b.pushes()).toEqual([]); // the streak already ended: no second 備份已恢復
    s.stop();
  });
});
