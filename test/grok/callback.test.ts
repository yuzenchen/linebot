import { describe, expect, it, vi } from 'vitest';
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

function setup(opts: { token?: string | undefined; admin?: string; tickets?: boolean } = {}) {
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
