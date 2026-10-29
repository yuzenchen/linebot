import { HTTPFetchError } from '@line/bot-sdk';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Classifier, ClassifyResult } from '../../src/classifier/index.js';
import { createTextMessageHandler, type MessageDeps } from '../../src/handlers/message.js';
import { texts } from '../../src/texts.js';
import {
  classification,
  classificationRows,
  fakeHealth,
  harness,
  healthResult,
  inbound,
  incidentRows,
  jobRows,
  pushReasons,
  sentTexts,
  silent,
  type Harness,
} from './helpers.js';

const DEADLINE_MS = 1000;

function make(
  h: Harness,
  classify: Classifier['classify'],
  extra: Partial<Omit<MessageDeps, 'repos' | 'replier' | 'classifier' | 'jobs'>> = {},
) {
  return createTextMessageHandler({
    repos: h.repos,
    replier: h.replier,
    classifier: { classify },
    health: fakeHealth(healthResult({ status: 'healthy', httpStatus: 200 })),
    jobs: h.jobs,
    config: { REPLY_DEADLINE_MS: DEADLINE_MS, CONTEXT_MESSAGES: 6 },
    log: silent,
    ...extra,
  });
}

function httpError(status: number): HTTPFetchError {
  return new HTTPFetchError(`HTTP ${status}`, {
    status,
    statusText: 'x',
    headers: new Headers(),
    body: '{"message":"Invalid reply token"}',
  });
}

describe('text message handler', () => {
  afterEach(() => vi.useRealTimers());

  it('kb_answer within the deadline: one reply with the answer, classification row, no push', async () => {
    const h = harness();
    const classify = vi.fn(async () =>
      classification({ answer: '滿 500 免運。', confidence: 0.95 }),
    );
    const handle = make(h, classify);
    const ctx = inbound(h.repos, '免運門檻？');
    await handle(ctx);

    expect(h.api.showLoadingAnimation).toHaveBeenCalledWith({ chatId: 'U1', loadingSeconds: 60 });
    expect(h.api.replyMessage).toHaveBeenCalledTimes(1);
    expect(h.api.replyMessage).toHaveBeenCalledWith({
      replyToken: ctx.replyToken,
      messages: [{ type: 'text', text: '滿 500 免運。' }],
    });
    expect(h.api.pushMessage).not.toHaveBeenCalled();
    expect(classificationRows(h.db)).toEqual([
      expect.objectContaining({
        message_id: ctx.messageId,
        category: 'kb_answer',
        confidence: 0.95,
        classifier: 'rule',
      }),
    ]);
    expect(h.repos.messages.recent('U1', 10).map((m) => m.direction)).toEqual(['in', 'out']);
    expect(jobRows(h.db)).toHaveLength(0);
    expect(h.repos.users.get('U1')?.low_conf_streak).toBe(0);
  });

  it('passes recent context (without the current message) to the classifier', async () => {
    const h = harness();
    inbound(h.repos, '第一句');
    h.repos.messages.insert({ userId: 'U1', direction: 'out', type: 'text', text: '回覆一' });
    h.repos.messages.insert({ userId: 'U1', direction: 'in', type: 'sticker' });
    const classify = vi.fn(async () => classification({ category: 'off_topic' }));
    const handle = make(h, classify);
    await handle(inbound(h.repos, '現在這句'));
    expect(classify).toHaveBeenCalledWith({
      text: '現在這句',
      context: [
        { role: 'user', text: '第一句' },
        { role: 'assistant', text: '回覆一' },
      ],
    });
  });

  it('deadline exceeded: reply ackPending, then push the answer as late_reply', async () => {
    vi.useFakeTimers();
    const h = harness();
    const classify = vi.fn(
      () =>
        new Promise<ClassifyResult>((resolve) =>
          setTimeout(() => resolve(classification({ answer: '慢答' })), DEADLINE_MS + 500),
        ),
    );
    const handle = make(h, classify);
    const ctx = inbound(h.repos, 'q');
    const done = handle(ctx);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(h.api.replyMessage).toHaveBeenCalledWith({
      replyToken: ctx.replyToken,
      messages: [{ type: 'text', text: texts.ackPending }],
    });
    expect(h.api.pushMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    await done;
    expect(h.api.replyMessage).toHaveBeenCalledTimes(1);
    expect(h.api.pushMessage).toHaveBeenCalledWith({
      to: 'U1',
      messages: [{ type: 'text', text: '慢答' }],
    });
    expect(pushReasons(h.db)).toEqual(['late_reply']);
    expect(classificationRows(h.db)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fast classification leaves no pending deadline timer', async () => {
    vi.useFakeTimers();
    const h = harness();
    const handle = make(h, async () => classification({ answer: 'a' }));
    await handle(inbound(h.repos, 'q'));
    expect(vi.getTimerCount()).toBe(0);
    expect(h.api.replyMessage).toHaveBeenCalledTimes(1);
  });

  it('reply 400: the answer arrives via push with reason reply_fallback', async () => {
    const h = harness();
    h.api.replyMessage.mockRejectedValue(httpError(400));
    const handle = make(h, async () => classification({ answer: 'ans' }));
    await handle(inbound(h.repos, 'q'));
    expect(h.api.replyMessage).toHaveBeenCalledTimes(1);
    expect(h.api.pushMessage).toHaveBeenCalledTimes(1);
    expect(sentTexts(h.api)).toEqual([
      { via: 'reply', text: 'ans' },
      { via: 'push', text: 'ans' },
    ]);
    expect(pushReasons(h.db)).toEqual(['reply_fallback']);
  });

  it('classifier rejects: fallbackError sent once via reply, error logged, handler resolves', async () => {
    const h = harness();
    const error = vi.fn();
    const log = pino({ level: 'silent' });
    log.error = error as unknown as typeof log.error;
    const handle = make(
      h,
      async () => {
        throw new Error('boom');
      },
      { log },
    );
    const ctx = inbound(h.repos, 'q');
    await expect(handle(ctx)).resolves.toBeUndefined();
    expect(h.api.replyMessage).toHaveBeenCalledTimes(1);
    expect(h.api.replyMessage).toHaveBeenCalledWith({
      replyToken: ctx.replyToken,
      messages: [{ type: 'text', text: texts.fallbackError }],
    });
    expect(h.api.pushMessage).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({ userId: 'U1', messageId: ctx.messageId });
    expect((error.mock.calls[0][0].err as Error).message).toBe('boom');
    expect(classificationRows(h.db)).toHaveLength(0);
  });

  it('error after the token was used goes to push, and a failing fallback does not reject', async () => {
    const h = harness();
    const error = vi.fn();
    const log = pino({ level: 'silent' });
    log.error = error as unknown as typeof log.error;
    // Reply succeeds (ack), then the late push blows up with a 500, then the fallback push fails too.
    vi.useFakeTimers();
    h.api.pushMessage.mockRejectedValue(httpError(500));
    const classify = () =>
      new Promise<ClassifyResult>((resolve) =>
        setTimeout(() => resolve(classification({ answer: 'late' })), DEADLINE_MS + 1),
      );
    const handle = make(h, classify, { log });
    const ctx = inbound(h.repos, 'q');
    const done = handle(ctx);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 10);
    await expect(done).resolves.toBeUndefined();
    expect(h.api.replyMessage).toHaveBeenCalledTimes(1);
    // late_reply push + fallback_error push, both attempted via push (token already used).
    expect(h.api.pushMessage).toHaveBeenCalledTimes(2);
    expect(h.api.pushMessage.mock.calls[1][0].messages[0].text).toBe(texts.fallbackError);
    expect(pushReasons(h.db)).toEqual([]);
    expect(error.mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining(['text message handling failed', 'fallback reply failed']),
    );
  });

  it('service_related: enqueues service_question with messageId and replies serviceForwarded', async () => {
    const h = harness();
    const handle = make(h, async () =>
      classification({ category: 'service_related', confidence: 0.5, answer: null }),
    );
    const ctx = inbound(h.repos, '我的訂單到哪了');
    await handle(ctx);
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.serviceForwarded }]);
    const jobs = jobRows(h.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('service_question');
    expect(jobs[0].payload).toEqual({
      userId: 'U1',
      messageId: ctx.messageId,
      text: '我的訂單到哪了',
      context: [],
    });
  });

  it('off_topic: replies offTopic and enqueues nothing', async () => {
    const h = harness();
    const handle = make(h, async () => classification({ category: 'off_topic' }));
    await handle(inbound(h.repos, '今天天氣如何'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.offTopic }]);
    expect(jobRows(h.db)).toHaveLength(0);
    expect(h.api.pushMessage).not.toHaveBeenCalled();
  });

  it('feature_request: suggestion row, summarize job, reply only', async () => {
    const h = harness();
    const handle = make(h, async () => classification({ category: 'feature_request' }));
    await handle(inbound(h.repos, '希望可以用信用卡'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.featureThanks }]);
    expect(h.repos.suggestions.list()).toHaveLength(1);
    expect(jobRows(h.db).map((j) => j.type)).toEqual(['summarize_suggestion']);
    expect(pushReasons(h.db)).toEqual([]);
  });

  it('incident_report: runs the incident handler (healthy follow-up)', async () => {
    const h = harness();
    const handle = make(h, async () => classification({ category: 'incident_report' }));
    await handle(inbound(h.repos, '網站打不開'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.incidentHealthyFollowUp }]);
    expect(incidentRows(h.db)).toHaveLength(1);
    expect(incidentRows(h.db)[0].health_status).toBe('healthy');
  });

  it('incident_report degraded with admin: user reply plus admin push', async () => {
    const h = harness();
    const handle = make(h, async () => classification({ category: 'incident_report' }), {
      health: fakeHealth(healthResult({ status: 'degraded', httpStatus: 503 })),
      config: { REPLY_DEADLINE_MS: DEADLINE_MS, CONTEXT_MESSAGES: 6, ADMIN_LINE_USER_ID: 'Uadmin' },
    });
    await handle(inbound(h.repos, '網站打不開'));
    expect(sentTexts(h.api).map((s) => s.via)).toEqual(['reply', 'push']);
    expect(sentTexts(h.api)[0].text).toBe(texts.incidentConfirmed);
    expect(pushReasons(h.db)).toEqual(['admin_incident']);
  });

  it('low-confidence streak increments and resets', async () => {
    const h = harness();
    let conf = 0.3;
    const handle = make(h, async () =>
      classification({ category: 'service_related', confidence: conf, answer: null }),
    );
    await handle(inbound(h.repos, 'a'));
    expect(h.repos.users.get('U1')?.low_conf_streak).toBe(1);
    await handle(inbound(h.repos, 'b'));
    expect(h.repos.users.get('U1')?.low_conf_streak).toBe(2);
    conf = 0.9;
    await handle(inbound(h.repos, 'c'));
    expect(h.repos.users.get('U1')?.low_conf_streak).toBe(0);
  });

  it('handoff hook: when active, forwards and skips classification', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({}));
    const forward = vi.fn(async () => {});
    const handle = make(h, classify, { handoff: { isActive: () => true, forward } });
    const ctx = inbound(h.repos, 'x');
    await handle(ctx);
    expect(forward).toHaveBeenCalledWith(ctx);
    expect(classify).not.toHaveBeenCalled();
    expect(h.api.replyMessage).not.toHaveBeenCalled();
  });

  it('without a reply token everything goes through push', async () => {
    const h = harness();
    const handle = make(h, async () => classification({ answer: 'a' }));
    await handle(inbound(h.repos, 'q', { replyToken: undefined }));
    expect(h.api.replyMessage).not.toHaveBeenCalled();
    expect(pushReasons(h.db)).toEqual(['late_reply']);
  });
});
