import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetClock, setClock } from '../../src/db/time.js';
import { MAX_FOLLOWUP_CALLBACKS } from '../../src/grok/callback.js';
import { createApp } from '../../src/server.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';
import { ticketRows, ticketService } from './helpers.js';

const TOKEN = 'cb-test';
const ADMIN = 'Uadmin000000';
const USER = 'Uuser1234567';
const T0 = new Date('2026-10-30T01:00:00.000Z');
const WINDOW_MS = 7 * 86_400_000;

afterEach(resetClock);

/** `now` drives both the DB clock (task `updated_at`) and the callback route's window check. */
function setup() {
  let now = T0;
  setClock(() => now);
  const h = harness();
  const app = createApp({
    channelSecret: 'line-secret',
    repos: h.repos,
    dispatch: vi.fn(async () => {}),
    grokCallback: {
      token: TOKEN,
      repos: h.repos,
      replier: h.replier,
      config: { ADMIN_LINE_USER_ID: ADMIN, GROK_FOLLOWUP_WINDOW_MS: WINDOW_MS },
      tickets: ticketService(h, ADMIN),
      now: () => now,
      log: silent,
    },
  });
  const post = (body: unknown) =>
    app.request('/grok/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-linebot-token': TOKEN },
      body: JSON.stringify(body),
    });
  /** A service_question task already closed with `status`. */
  const closedTask = (id: string, status: 'done' | 'failed' | 'expired') => {
    h.repos.grokTasks.insert({
      id,
      jobId: 1,
      type: 'service_question',
      userId: USER,
      payload: { userId: USER, text: '訂單呢', context: [] },
      expiresAt: new Date(T0.getTime() + 60_000),
    });
    h.repos.grokTasks.setStatus(id, status, status === 'done' ? '第一次答案' : undefined);
    return id;
  };
  return {
    ...h,
    post,
    closedTask,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('POST /grok/callback: late done on a closed service_question (SPEC-ADMIN §12.4)', () => {
  it('within the window with an open ticket: pushes the text and answers the ticket as grok', async () => {
    const s = setup();
    const id = s.closedTask('t1', 'failed');
    s.repos.tickets.openOrAppend({
      userId: USER,
      source: 'grok_failed',
      question: '訂單呢',
      context: ['訂單呢'],
      grokTaskId: id,
    });
    s.advance(WINDOW_MS - 1);
    const res = await s.post({ taskId: id, status: 'done', text: ' 已出貨，明天到 ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, followup: true });
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: '已出貨，明天到' }]);
    expect(pushReasons(s.db)).toEqual(['grok_followup']);
    expect(ticketRows(s)[0]).toMatchObject({
      status: 'answered',
      answered_by: 'grok',
      answer: '已出貨，明天到',
    });
    const task = s.repos.grokTasks.get(id)!;
    expect(task).toMatchObject({ status: 'failed', last_text: '已出貨，明天到', callbacks: 2 });
    // The task's closure time is untouched so the window does not slide.
    expect(task.updated_at).toBe(T0.toISOString());
  });

  it('answers an already answered ticket again; without any ticket it just pushes', async () => {
    const s = setup();
    const id = s.closedTask('t1', 'expired');
    s.repos.tickets.openOrAppend({
      userId: USER,
      source: 'grok_timeout',
      question: 'q',
      context: [],
    });
    s.repos.tickets.markAnswered(1, { by: 'Uadmin', answer: '人工答案' });
    await s.post({ taskId: id, status: 'done', text: 'Grok 補充' });
    expect(ticketRows(s)[0]).toMatchObject({ answered_by: 'grok', answer: 'Grok 補充' });

    s.repos.tickets.close(1);
    const res = await s.post({ taskId: id, status: 'done', text: '再補充' });
    expect(await res.json()).toEqual({ ok: true, followup: true });
    expect(sentTexts(s.api).map((t) => t.text)).toEqual(['Grok 補充', '再補充']);
    expect(ticketRows(s)[0]!.status).toBe('closed');
    expect(ticketRows(s)).toHaveLength(1);
  });

  it('outside the window, or with failed / processing / empty text, it is ignored', async () => {
    const s = setup();
    const id = s.closedTask('t1', 'done');
    s.advance(WINDOW_MS + 1);
    expect(await (await s.post({ taskId: id, status: 'done', text: '太晚了' })).json()).toEqual({
      ok: true,
      ignored: true,
    });
    const s2 = setup();
    const id2 = s2.closedTask('t2', 'done');
    for (const body of [
      { taskId: id2, status: 'failed', text: 'x' },
      { taskId: id2, status: 'processing', text: 'x' },
      { taskId: id2, status: 'done', text: '   ' },
      { taskId: id2, status: 'done' },
    ]) {
      expect(await (await s2.post(body)).json()).toEqual({ ok: true, ignored: true });
    }
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(s2.api.pushMessage).not.toHaveBeenCalled();
    expect(s2.repos.grokTasks.get(id2)!.callbacks).toBe(1);
  });

  it('stops after the callback cap', async () => {
    const s = setup();
    const id = s.closedTask('t1', 'done'); // callbacks = 1
    let delivered = 0;
    for (let i = 0; i < MAX_FOLLOWUP_CALLBACKS + 2; i++) {
      const body = (await (
        await s.post({ taskId: id, status: 'done', text: `補充 ${i}` })
      ).json()) as {
        followup?: boolean;
      };
      if (body.followup) delivered++;
    }
    expect(delivered).toBe(MAX_FOLLOWUP_CALLBACKS);
    expect(s.repos.grokTasks.get(id)!.callbacks).toBe(MAX_FOLLOWUP_CALLBACKS + 1);
  });

  it('a failed follow-up push leaves the ticket open and reports a warning', async () => {
    const s = setup();
    const id = s.closedTask('t1', 'failed');
    s.repos.tickets.openOrAppend({
      userId: USER,
      source: 'grok_failed',
      question: 'q',
      context: [],
    });
    s.api.pushMessage.mockRejectedValueOnce(Object.assign(new Error('blocked'), { status: 400 }));
    const res = await s.post({ taskId: id, status: 'done', text: '答案' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, followup: true, warning: 'push_failed' });
    expect(ticketRows(s)[0]!.status).toBe('open');
  });
});
