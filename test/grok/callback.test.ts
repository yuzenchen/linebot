import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetClock, setClock } from '../../src/db/time.js';
import type { GrokTaskType } from '../../src/grok/gateway.js';
import { createApp } from '../../src/server.js';
import {
  adminServiceQuestionNotice,
  adminTriageNotice,
  texts,
  ticketNotice,
} from '../../src/texts.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';
import { ticketRows, ticketService } from '../tickets/helpers.js';

const TOKEN = 'cb-test';
const ADMIN = 'Uadmin000000';
const USER = 'Uuser1234567';

function setup(
  opts: { token?: string | undefined; admin?: string; tickets?: boolean; now?: () => Date } = {},
) {
  const h = harness();
  const token = 'token' in opts ? opts.token : TOKEN;
  const admin = opts.admin ?? ADMIN;
  const app = createApp({
    channelSecret: 'line-secret',
    repos: h.repos,
    dispatch: vi.fn(async () => {}),
    grokCallback: {
      token,
      repos: h.repos,
      replier: h.replier,
      config: { ADMIN_LINE_USER_ID: admin },
      tickets: opts.tickets === false ? undefined : ticketService(h, admin),
      now: opts.now,
      log: silent,
    },
  });
  const insert = (type: GrokTaskType, payload: unknown, id = `t-${type}`) => {
    h.repos.grokTasks.insert({
      id,
      jobId: 1,
      type,
      userId: type === 'summarize_suggestion' ? null : USER,
      payload,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return id;
  };
  /** `token: null` sends no `x-linebot-token` header. */
  const post = (body: unknown, token: string | null = TOKEN) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers['x-linebot-token'] = token;
    return app.request('/grok/callback', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  };
  return { ...h, app, insert, post };
}

const question = { userId: USER, text: '我的訂單寄出了嗎', context: [] };

describe('POST /grok/callback: auth and validation', () => {
  it('answers 503 without a configured token or without deps', async () => {
    const s = setup({ token: undefined });
    expect((await s.post({ taskId: 'x', status: 'received' })).status).toBe(503);
    const bare = await createApp().request('/grok/callback', { method: 'POST', body: '{}' });
    expect(bare.status).toBe(503);
  });

  it('rejects a wrong or missing token with 401', async () => {
    const s = setup();
    s.insert('service_question', question);
    const body = { taskId: 't-service_question', status: 'received' };
    expect((await s.post(body, 'nope')).status).toBe(401);
    expect((await s.post(body, null)).status).toBe(401);
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('rejects a bad body with 400', async () => {
    const s = setup();
    expect((await s.post('not json')).status).toBe(400);
    const res = await s.post({ taskId: 'x', status: 'weird' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid body' });
  });

  it('answers 404 for an unknown task', async () => {
    const s = setup();
    expect((await s.post({ taskId: 'missing', status: 'received' })).status).toBe(404);
  });
});

describe('POST /grok/callback: service_question', () => {
  it('received pushes the default status text once; a repeated received is silent', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    expect((await s.post({ taskId: id, status: 'received' })).status).toBe(200);
    expect((await s.post({ taskId: id, status: 'received' })).status).toBe(200);
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: texts.grokStatusReceived }]);
    expect(pushReasons(s.db)).toEqual(['grok_status']);
    const task = s.repos.grokTasks.get(id)!;
    expect(task.status).toBe('received');
    expect(task.callbacks).toBe(2);
  });

  it('processing with custom text pushes that text', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    await s.post({ taskId: id, status: 'received' });
    await s.post({ taskId: id, status: 'processing', text: ' 正在查訂單 ' });
    expect(sentTexts(s.api).map((t) => t.text)).toEqual([texts.grokStatusReceived, '正在查訂單']);
    expect(s.repos.grokTasks.get(id)!.last_text).toBe('正在查訂單');
  });

  it('processing without text uses the default processing copy', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    await s.post({ taskId: id, status: 'processing' });
    expect(sentTexts(s.api).map((t) => t.text)).toEqual([texts.grokStatusProcessing]);
  });

  it('done requires text', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    expect((await s.post({ taskId: id, status: 'done' })).status).toBe(400);
    expect((await s.post({ taskId: id, status: 'done', text: '  ' })).status).toBe(400);
    expect(s.repos.grokTasks.get(id)!.status).toBe('sent');
  });

  it('done pushes the answer, closes the task; a later done within the window is a follow-up (T15)', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    const res = await s.post({ taskId: id, status: 'done', text: '已出貨，預計明天到。' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: '已出貨，預計明天到。' }]);
    expect(pushReasons(s.db)).toEqual(['grok_answer']);
    expect(s.repos.grokTasks.get(id)).toMatchObject({
      status: 'done',
      last_text: '已出貨，預計明天到。',
    });

    const again = await s.post({ taskId: id, status: 'done', text: '再一次' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, followup: true });
    expect(pushReasons(s.db)).toEqual(['grok_answer', 'grok_followup']);
    // A later `failed` or `processing` on the closed task is still ignored.
    const failed = await s.post({ taskId: id, status: 'failed', text: 'x' });
    expect(await failed.json()).toEqual({ ok: true, ignored: true });
    expect(s.api.pushMessage).toHaveBeenCalledTimes(2);
  });

  it('failed tells the user and opens a grok_failed ticket (T15)', async () => {
    const s = setup();
    const id = s.insert('service_question', {
      ...question,
      context: [{ role: 'user', text: '嗨' }],
    });
    await s.post({ taskId: id, status: 'failed', text: '找不到訂單系統' });
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([USER, ADMIN]);
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokUnavailable },
      {
        via: 'push',
        text: ticketNotice({
          ticketId: 'T001',
          userId: USER,
          question: question.text,
          recentMessages: ['嗨', question.text],
          orderIds: [],
        }),
      },
    ]);
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_ticket']);
    expect(s.repos.grokTasks.get(id)!.status).toBe('failed');
    expect(ticketRows(s)).toEqual([
      expect.objectContaining({ source: 'grok_failed', grok_task_id: id, status: 'open' }),
    ]);
  });

  it('failed without a ticket service falls back to the plain admin notice', async () => {
    const s = setup({ tickets: false });
    const id = s.insert('service_question', question);
    await s.post({ taskId: id, status: 'failed', text: '找不到訂單系統' });
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokUnavailable },
      {
        via: 'push',
        text: `${adminServiceQuestionNotice({ userId: USER, text: question.text })}\n失敗原因：找不到訂單系統`,
      },
    ]);
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_service_question']);
    expect(ticketRows(s)).toHaveLength(0);
  });

  it('needs_human with text pushes it to the customer, opens a ticket, fails the task', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    const res = await s.post({ taskId: id, status: 'needs_human', text: '這題我請專人幫你確認。' });
    expect(res.status).toBe(200);
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([USER, ADMIN]);
    expect(sentTexts(s.api)[0]).toEqual({ via: 'push', text: '這題我請專人幫你確認。' });
    expect(pushReasons(s.db)).toEqual(['grok_needs_human', 'admin_ticket']);
    expect(s.repos.grokTasks.get(id)).toMatchObject({
      status: 'failed',
      last_text: '這題我請專人幫你確認。',
    });
    expect(ticketRows(s)).toEqual([
      expect.objectContaining({
        source: 'grok_failed',
        grok_task_id: id,
        question: question.text,
        status: 'open',
      }),
    ]);
  });

  it('needs_human without text pushes grokUnavailable and opens a ticket', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    await s.post({ taskId: id, status: 'needs_human' });
    expect(sentTexts(s.api)[0]).toEqual({ via: 'push', text: texts.grokUnavailable });
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_ticket']);
    expect(s.repos.grokTasks.get(id)!.status).toBe('failed');
    expect(ticketRows(s)).toEqual([
      expect.objectContaining({ source: 'grok_failed', grok_task_id: id }),
    ]);
  });

  it('done whose text is a deferral pushes it and also opens a ticket; task stays done', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    const res = await s.post({ taskId: id, status: 'done', text: '已轉給專人查詢，請稍候。' });
    expect(await res.json()).toEqual({ ok: true });
    expect(sentTexts(s.api)[0]).toEqual({ via: 'push', text: '已轉給專人查詢，請稍候。' });
    expect(pushReasons(s.db)).toEqual(['grok_answer', 'admin_ticket']);
    expect(s.repos.grokTasks.get(id)!.status).toBe('done');
    expect(ticketRows(s)).toEqual([
      expect.objectContaining({ source: 'grok_failed', grok_task_id: id, status: 'open' }),
    ]);
  });

  it('done with a normal answer opens no ticket', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    await s.post({ taskId: id, status: 'done', text: '訂單已出貨，預計明天到。' });
    expect(pushReasons(s.db)).toEqual(['grok_answer']);
    expect(ticketRows(s)).toHaveLength(0);
  });

  it('still answers 200 when the LINE push fails', async () => {
    const s = setup();
    const id = s.insert('service_question', question);
    s.api.pushMessage.mockRejectedValueOnce(Object.assign(new Error('line down'), { status: 500 }));
    const res = await s.post({ taskId: id, status: 'done', text: '答案' });
    expect(res.status).toBe(200);
    expect(s.repos.grokTasks.get(id)!.status).toBe('done');
  });
});

describe('POST /grok/callback: incident_triage', () => {
  it('only pushes the admin on done', async () => {
    const s = setup();
    const id = s.insert('incident_triage', { userId: USER, incidentId: 3, text: '網站打不開' });
    await s.post({ taskId: id, status: 'received' });
    await s.post({ taskId: id, status: 'processing', text: '看 log 中' });
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    await s.post({ taskId: id, status: 'done', text: '後端 DB 連線逾時' });
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([ADMIN]);
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: adminTriageNotice({ incidentId: 3, text: '後端 DB 連線逾時' }) },
    ]);
    expect(pushReasons(s.db)).toEqual(['admin_triage']);
  });

  it('failed pushes the reason to the admin', async () => {
    const s = setup();
    const id = s.insert('incident_triage', { userId: USER, incidentId: 3, text: '網站打不開' });
    await s.post({ taskId: id, status: 'failed', text: '無法連線' });
    expect(sentTexts(s.api)[0]!.text).toContain('分析失敗：無法連線');
  });

  it('needs_human behaves like failed', async () => {
    const s = setup();
    const id = s.insert('incident_triage', { userId: USER, incidentId: 3, text: '網站打不開' });
    await s.post({ taskId: id, status: 'needs_human', text: '需要人工看主機' });
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([ADMIN]);
    expect(sentTexts(s.api)[0]!.text).toContain('分析失敗：需要人工看主機');
    expect(s.repos.grokTasks.get(id)!.status).toBe('failed');
    expect(ticketRows(s)).toHaveLength(0);
  });
});

describe('POST /grok/callback: summarize_suggestion', () => {
  it('done with valid structured output summarizes the suggestion', async () => {
    const s = setup();
    const suggestionId = s.repos.suggestions.insert({ userHash: 'h', text: '希望可以用信用卡' });
    const id = s.insert('summarize_suggestion', { suggestionId, text: '希望可以用信用卡' });
    await s.post({ taskId: id, status: 'received' });
    const res = await s.post({
      taskId: id,
      status: 'done',
      structured: {
        title: '信用卡付款',
        summary: '希望支援信用卡',
        category: '付款',
        mergedInto: null,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.repos.suggestions.list()[0]).toMatchObject({
      status: 'summarized',
      title: '信用卡付款',
      summary: '希望支援信用卡',
      category: '付款',
      merged_into: null,
    });
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(s.repos.grokTasks.get(id)!.status).toBe('done');
  });

  it('done with invalid structured output warns and still closes the task', async () => {
    const s = setup();
    const suggestionId = s.repos.suggestions.insert({ userHash: 'h', text: '加深色模式' });
    const id = s.insert('summarize_suggestion', { suggestionId, text: '加深色模式' });
    const res = await s.post({ taskId: id, status: 'done', structured: { title: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, warning: 'bad_structured' });
    expect(s.repos.suggestions.list()[0]!.status).toBe('new');
    expect(s.repos.grokTasks.get(id)!.status).toBe('done');
  });
});

describe('POST /grok/callback: bug_report (SPEC-ADMIN §13.4)', () => {
  const REPORTER = 'Ureporter001';
  const GROUP = 'Cgroup0001';

  function seed(s: ReturnType<typeof setup>) {
    const bugId = s.repos.bugReports.insert({
      reporterUserId: REPORTER,
      groupId: GROUP,
      description: '結帳按鈕沒反應',
    });
    const id = `t-bug-${bugId}`;
    s.repos.grokTasks.insert({
      id,
      jobId: 1,
      type: 'bug_report',
      userId: REPORTER,
      payload: { bugId, reporterUserId: REPORTER, description: '結帳按鈕沒反應', health: {} },
      expiresAt: new Date(Date.now() + 60_000),
    });
    s.repos.bugReports.setGrokTask(bugId, id);
    s.repos.bugReports.setStatus(bugId, 'sent');
    return { bugId, id };
  }

  const notice = (status: 'received' | 'processing' | 'done' | 'failed', text?: string) =>
    texts.bugStatusNotice({ display: 'B001', status, text });

  it('DMs each status to the reporter only, never the group or the admin', async () => {
    const s = setup();
    const { bugId, id } = seed(s);
    await s.post({ taskId: id, status: 'received' });
    expect(s.repos.bugReports.get(bugId)!.status).toBe('received');
    await s.post({ taskId: id, status: 'processing', text: '正在看 log' });
    expect(s.repos.bugReports.get(bugId)).toMatchObject({
      status: 'processing',
      last_text: '正在看 log',
    });
    expect((await s.post({ taskId: id, status: 'done', text: '已修好，部署中' })).status).toBe(200);
    expect(s.repos.bugReports.get(bugId)).toMatchObject({
      status: 'done',
      last_text: '已修好，部署中',
    });
    expect(s.repos.grokTasks.get(id)!.status).toBe('done');

    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: notice('received') },
      { via: 'push', text: notice('processing', '正在看 log') },
      { via: 'push', text: notice('done', '已修好，部署中') },
    ]);
    expect(notice('received')).toBe('[Bug B001] 已收到');
    expect(notice('done', '已修好')).toBe('[Bug B001] 完成：已修好');
    expect(notice('received', '等待確認後交給程式碼 session')).toBe(
      '[Bug B001] 已收到：等待確認後交給程式碼 session',
    );
    expect(notice('done')).toBe('[Bug B001] 完成');
    const targets = s.api.pushMessage.mock.calls.map(([r]) => r.to);
    expect(targets).toEqual([REPORTER, REPORTER, REPORTER]);
    expect(targets).not.toContain(GROUP);
    expect(targets).not.toContain(ADMIN);
    expect(pushReasons(s.db)).toEqual(['bug_status', 'bug_status', 'bug_status']);
    expect(ticketRows(s)).toHaveLength(0);
  });

  it('same status is pushed again only when the text is new', async () => {
    const s = setup();
    const { id } = seed(s);
    await s.post({ taskId: id, status: 'received' });
    await s.post({ taskId: id, status: 'received' });
    await s.post({ taskId: id, status: 'processing', text: '已找到原因' });
    await s.post({ taskId: id, status: 'processing', text: ' 已找到原因 ' });
    await s.post({ taskId: id, status: 'processing', text: '正在修' });
    await s.post({ taskId: id, status: 'processing' });
    expect(sentTexts(s.api).map((t) => t.text)).toEqual([
      notice('received'),
      notice('processing', '已找到原因'),
      notice('processing', '正在修'),
    ]);
  });

  it('needs_human is treated as failed', async () => {
    const s = setup();
    const { bugId, id } = seed(s);
    await s.post({ taskId: id, status: 'needs_human', text: '需要後端權限' });
    expect(s.repos.bugReports.get(bugId)).toMatchObject({
      status: 'failed',
      last_text: '需要後端權限',
    });
    expect(s.repos.grokTasks.get(id)!.status).toBe('failed');
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: notice('failed', '需要後端權限') }]);
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([REPORTER]);
  });

  describe('follow-up after the task closed (30-day window from creation)', () => {
    const T0 = new Date('2026-10-01T00:00:00.000Z');
    const DAY_MS = 86_400_000;
    afterEach(resetClock);

    function closedSetup() {
      setClock(() => T0);
      let current = T0;
      const s = setup({ now: () => current });
      const ids = seed(s);
      const at = (days: number) => {
        const d = new Date(T0.getTime() + days * DAY_MS);
        current = d;
        setClock(() => d);
      };
      return { s, ...ids, at };
    }

    it('a second done with new text is DMed; the task stays done', async () => {
      const { s, id, bugId, at } = closedSetup();
      await s.post({ taskId: id, status: 'done', text: '已找到原因' });
      at(3);
      const res = await s.post({ taskId: id, status: 'done', text: '已部署修正' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, followup: true });
      expect(s.repos.grokTasks.get(id)).toMatchObject({
        status: 'done',
        last_text: '已部署修正',
        callbacks: 2,
      });
      expect(s.repos.bugReports.get(bugId)).toMatchObject({
        status: 'done',
        last_text: '已部署修正',
      });
      expect(sentTexts(s.api).map((t) => t.text)).toEqual([
        notice('done', '已找到原因'),
        notice('done', '已部署修正'),
      ]);
      expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([REPORTER, REPORTER]);
      // Same status and same text again: accepted as a follow-up but not pushed.
      await s.post({ taskId: id, status: 'done', text: '已部署修正' });
      expect(s.api.pushMessage).toHaveBeenCalledTimes(2);
      // done without text on a closed task is still rejected.
      expect((await s.post({ taskId: id, status: 'done' })).status).toBe(400);
    });

    it('a follow-up after the task expired is DMed', async () => {
      const { s, id, bugId, at } = closedSetup();
      s.repos.grokTasks.setStatus(id, 'expired');
      s.repos.bugReports.setStatus(bugId, 'expired');
      at(2);
      const res = await s.post({ taskId: id, status: 'processing', text: '已找到原因' });
      expect(await res.json()).toEqual({ ok: true, followup: true });
      expect(s.repos.grokTasks.get(id)!.status).toBe('expired');
      expect(s.repos.bugReports.get(bugId)!.status).toBe('processing');
      expect(sentTexts(s.api).map((t) => t.text)).toEqual([notice('processing', '已找到原因')]);
    });

    it('is ignored after 31 days, and received on a closed task is ignored', async () => {
      const { s, id, at } = closedSetup();
      await s.post({ taskId: id, status: 'done', text: '好了' });
      at(1);
      const received = await s.post({ taskId: id, status: 'received', text: '再看一次' });
      expect(await received.json()).toEqual({ ok: true, ignored: true });
      at(31);
      const late = await s.post({ taskId: id, status: 'done', text: '補充' });
      expect(await late.json()).toEqual({ ok: true, ignored: true });
      expect(sentTexts(s.api).map((t) => t.text)).toEqual([notice('done', '好了')]);
    });

    it('the 21st callback is ignored', async () => {
      const { s, id } = closedSetup();
      for (let i = 1; i <= 20; i++) {
        const status = i === 20 ? 'done' : 'processing';
        const res = await s.post({ taskId: id, status, text: '進度 ' + i });
        expect(res.status).toBe(200);
      }
      expect(s.repos.grokTasks.get(id)!.callbacks).toBe(20);
      expect(s.api.pushMessage).toHaveBeenCalledTimes(20);
      const res = await s.post({ taskId: id, status: 'done', text: '進度 21' });
      expect(await res.json()).toEqual({ ok: true, ignored: true });
      expect(s.api.pushMessage).toHaveBeenCalledTimes(20);
    });

    it('a closed service_question keeps its own 7-day rule', async () => {
      const { s, at } = closedSetup();
      const id = s.insert('service_question', question);
      await s.post({ taskId: id, status: 'done', text: '已出貨' });
      at(8);
      const late = await s.post({ taskId: id, status: 'done', text: '補充' });
      expect(await late.json()).toEqual({ ok: true, ignored: true });
      const processing = await s.post({ taskId: id, status: 'processing', text: 'x' });
      expect(await processing.json()).toEqual({ ok: true, ignored: true });
      expect(pushReasons(s.db)).toEqual(['grok_answer']);
    });
  });

  it('failed without text says the reason is unknown', async () => {
    const s = setup();
    const { bugId, id } = seed(s);
    await s.post({ taskId: id, status: 'failed' });
    expect(s.repos.bugReports.get(bugId)!.status).toBe('failed');
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: '[Bug B001] 失敗：未說明原因' }]);
  });
});
