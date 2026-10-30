import { describe, expect, it, vi } from 'vitest';
import type { Classifier } from '../../src/classifier/index.js';
import { createHandoffService, HANDOFF_DURATION_MS } from '../../src/handlers/handoff.js';
import { createTextMessageHandler } from '../../src/handlers/message.js';
import { texts, ticketFollowUpNotice, ticketNotice } from '../../src/texts.js';
import { ticketRows } from '../tickets/helpers.js';
import {
  classification,
  fakeHealth,
  harness,
  healthResult,
  inbound,
  pushReasons,
  silent,
  type Harness,
} from './helpers.js';

const ADMIN = 'Uadmin0000';
const T0 = new Date('2026-10-29T03:00:00.000Z');

function make(
  h: Harness,
  classify: Classifier['classify'],
  opts: { admin?: string | undefined; now?: () => Date } = {},
) {
  const admin = 'admin' in opts ? opts.admin : ADMIN;
  const now = opts.now ?? (() => T0);
  const service = createHandoffService({
    repos: h.repos,
    replier: h.replier,
    config: { ADMIN_LINE_USER_ID: admin },
    now,
    log: silent,
  });
  const handle = createTextMessageHandler({
    repos: h.repos,
    replier: h.replier,
    classifier: { classify },
    health: fakeHealth(healthResult({ status: 'healthy', httpStatus: 200 })),
    jobs: h.jobs,
    config: { REPLY_DEADLINE_MS: 1000, CONTEXT_MESSAGES: 6, ADMIN_LINE_USER_ID: admin },
    handoffService: service,
    log: silent,
  });
  return { service, handle };
}

function replyTexts(h: Harness): string[][] {
  return h.api.replyMessage.mock.calls.map(([req]) => req.messages.map((m) => m.text));
}

function pushesTo(h: Harness, to: string): string[] {
  return h.api.pushMessage.mock.calls
    .filter(([req]) => req.to === to)
    .flatMap(([req]) => req.messages.map((m) => m.text));
}

describe('handoff', () => {
  it('keyword enters handoff without classifying and opens a handoff ticket (T15)', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({}));
    const { handle } = make(h, classify);
    await handle(inbound(h.repos, '請問運費'));
    classify.mockClear();
    h.api.replyMessage.mockClear();

    await handle(inbound(h.repos, '我要找真人', { userId: 'U1' }));

    expect(classify).not.toHaveBeenCalled();
    expect(replyTexts(h)).toEqual([[texts.handoffEntered]]);
    const until = h.repos.users.get('U1')?.handoff_until;
    expect(until).toBe(new Date(T0.getTime() + HANDOFF_DURATION_MS).toISOString());
    expect(pushReasons(h.db)).toEqual(['admin_ticket']);
    expect(pushesTo(h, ADMIN)).toEqual([
      ticketNotice({
        ticketId: 'T001',
        userId: 'U1',
        question: '我要找真人',
        recentMessages: ['請問運費', '我要找真人'],
        orderIds: [],
      }),
    ]);
    expect(ticketRows(h)).toEqual([
      expect.objectContaining({
        user_id: 'U1',
        source: 'handoff',
        status: 'open',
        question: '我要找真人',
        context: JSON.stringify(['請問運費', '我要找真人']),
      }),
    ]);
  });

  it('two low-confidence messages enter handoff; the next message is forwarded', async () => {
    const h = harness();
    const classify = vi.fn(async () =>
      classification({ category: 'service_related', confidence: 0.4 }),
    );
    const { handle } = make(h, classify);

    await handle(inbound(h.repos, '那個東西'));
    expect(replyTexts(h)).toEqual([[texts.serviceForwarded]]);
    expect(h.repos.users.get('U1')?.low_conf_streak).toBe(1);

    await handle(inbound(h.repos, '就是那個'));
    expect(replyTexts(h)[1]).toEqual([texts.serviceForwarded, texts.handoffEntered]);
    expect(h.repos.users.get('U1')?.low_conf_streak).toBe(0);
    expect(h.repos.users.get('U1')?.handoff_until).not.toBeNull();
    expect(pushReasons(h.db)).toEqual(['admin_ticket']);
    expect(ticketRows(h)).toEqual([expect.objectContaining({ source: 'handoff', status: 'open' })]);

    classify.mockClear();
    h.api.replyMessage.mockClear();
    await handle(inbound(h.repos, '還在嗎'));
    expect(classify).not.toHaveBeenCalled();
    expect(h.api.replyMessage).not.toHaveBeenCalled();
    expect(h.api.showLoadingAnimation).toHaveBeenCalledTimes(2);
    expect(pushReasons(h.db)).toEqual(['admin_ticket', 'admin_ticket_followup']);
    expect(pushesTo(h, ADMIN).at(-1)).toBe(
      ticketFollowUpNotice({ ticketId: 'T001', userId: 'U1', text: '還在嗎' }),
    );
    expect(pushesTo(h, 'U1')).toEqual([]);
    expect(ticketRows(h)).toHaveLength(1);
    expect(ticketRows(h)[0].question).toBe('就是那個\n---\n還在嗎');
  });

  it('admin /handoff opens a handoff ticket immediately; later messages become follow-ups', async () => {
    const h = harness();
    const { handle } = make(
      h,
      vi.fn(async () => classification({})),
    );
    h.repos.users.upsert({ userId: 'Uxyz98765432' });
    await handle(inbound(h.repos, '/handoff Uxyz', { userId: ADMIN }));
    expect(ticketRows(h)).toEqual([
      expect.objectContaining({
        user_id: 'Uxyz98765432',
        source: 'handoff',
        question: '管理員手動轉接',
        status: 'open',
      }),
    ]);
    expect(pushReasons(h.db)).toEqual(['admin_ticket', 'handoff_admin']);

    await handle(inbound(h.repos, '在嗎', { userId: 'Uxyz98765432' }));
    expect(ticketRows(h)).toHaveLength(1);
    expect(pushReasons(h.db)).toEqual(['admin_ticket', 'handoff_admin', 'admin_ticket_followup']);
  });

  it('expired handoff is inactive and cleared', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({ answer: '好的' }));
    const { handle, service } = make(h, classify);
    h.repos.users.upsert({ userId: 'U1' });
    h.repos.users.setHandoffUntil('U1', new Date(T0.getTime() - 1000).toISOString());

    expect(service.hook.isActive('U1')).toBe(false);
    expect(h.repos.users.get('U1')?.handoff_until).toBeNull();

    h.repos.users.setHandoffUntil('U1', new Date(T0.getTime() - 1000).toISOString());
    await handle(inbound(h.repos, '你好'));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(replyTexts(h)).toEqual([['好的']]);
  });

  it('admin /status replies with the four counts', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({}));
    const { handle } = make(h, classify, { now: () => new Date() });
    h.repos.users.upsert({ userId: 'Uaaa' });
    h.repos.users.setHandoffUntil('Uaaa', new Date(Date.now() + 60_000).toISOString());
    h.repos.pushLog.insert({ userId: 'Uaaa', reason: 'x' });
    h.repos.jobs.enqueue({ type: 'service_question', payload: {} });

    await handle(inbound(h.repos, '/status', { userId: ADMIN }));

    expect(classify).not.toHaveBeenCalled();
    // One inbound message (the /status itself) today.
    expect(replyTexts(h)).toEqual([
      ['今日訊息 1 則｜本月 push 1 則｜待處理 jobs 1｜人工中 1 人｜Grok 等待中 0'],
    ]);
  });

  it('admin /resume with one match clears handoff and pushes the user', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({}));
    const { handle } = make(h, classify);
    h.repos.users.upsert({ userId: 'Uabc12345678' });
    h.repos.users.setHandoffUntil('Uabc12345678', new Date(T0.getTime() + 60_000).toISOString());

    await handle(inbound(h.repos, '/resume Uabc', { userId: ADMIN }));

    expect(h.repos.users.get('Uabc12345678')?.handoff_until).toBeNull();
    expect(replyTexts(h)).toEqual([['已解除 Uabc1234 的人工轉接']]);
    expect(pushesTo(h, 'Uabc12345678')).toEqual([texts.handoffResumed]);
    expect(pushReasons(h.db)).toEqual(['handoff_resumed']);
  });

  it('admin /resume with an ambiguous prefix asks for a longer one', async () => {
    const h = harness();
    const { handle } = make(
      h,
      vi.fn(async () => classification({})),
    );
    h.repos.users.upsert({ userId: 'Uabc1' });
    h.repos.users.upsert({ userId: 'Uabc2' });

    await handle(inbound(h.repos, '/resume Uabc', { userId: ADMIN }));

    expect(replyTexts(h)[0][0]).toContain('2 位');
    expect(h.api.pushMessage).not.toHaveBeenCalled();
  });

  it('admin /handoff puts the user in handoff and pushes them', async () => {
    const h = harness();
    const { handle } = make(
      h,
      vi.fn(async () => classification({})),
    );
    h.repos.users.upsert({ userId: 'Uxyz98765432' });

    await handle(inbound(h.repos, '/handoff Uxyz', { userId: ADMIN }));

    expect(h.repos.users.get('Uxyz98765432')?.handoff_until).toBe(
      new Date(T0.getTime() + HANDOFF_DURATION_MS).toISOString(),
    );
    expect(pushesTo(h, 'Uxyz98765432')).toEqual([texts.handoffEntered]);
    expect(pushReasons(h.db)).toEqual(['admin_ticket', 'handoff_admin']);
  });

  it('admin unknown command gets help; admin plain text is classified normally', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({ answer: '答案' }));
    const { handle } = make(h, classify);

    await handle(inbound(h.repos, '/what', { userId: ADMIN }));
    await handle(inbound(h.repos, '免運門檻？', { userId: ADMIN }));

    expect(replyTexts(h)).toEqual([[texts.adminHelp], ['答案']]);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('non-admin /status is classified normally', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({ answer: '答案' }));
    const { handle } = make(h, classify);

    await handle(inbound(h.repos, '/status', { userId: 'U1' }));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(replyTexts(h)).toEqual([['答案']]);
  });

  it('admin id unset: /status is classified; keyword handoff works without a push', async () => {
    const h = harness();
    const classify = vi.fn(async () => classification({ answer: '答案' }));
    const { handle, service } = make(h, classify, { admin: undefined });

    expect(service.isAdmin('')).toBe(false);
    await handle(inbound(h.repos, '/status', { userId: ADMIN }));
    expect(classify).toHaveBeenCalledTimes(1);

    await handle(inbound(h.repos, '可以找客服人員嗎', { userId: 'U2' }));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(replyTexts(h)).toEqual([['答案'], [texts.handoffEntered]]);
    expect(h.repos.users.get('U2')?.handoff_until).not.toBeNull();
    expect(h.api.pushMessage).not.toHaveBeenCalled();
  });

  it('admin push failure does not break keyword handoff', async () => {
    const h = harness();
    h.api.pushMessage.mockRejectedValue(new Error('401'));
    const { handle } = make(
      h,
      vi.fn(async () => classification({})),
    );

    await handle(inbound(h.repos, '人工客服'));

    expect(replyTexts(h)).toEqual([[texts.handoffEntered]]);
    expect(h.repos.users.get('U1')?.handoff_until).not.toBeNull();
    expect(ticketRows(h)).toHaveLength(1);
  });

  it('findByPrefix escapes LIKE wildcards', () => {
    const h = harness();
    h.repos.users.upsert({ userId: 'Ua_b' });
    h.repos.users.upsert({ userId: 'Uaxb' });
    expect(h.repos.users.findByPrefix('Ua_').map((u) => u.user_id)).toEqual(['Ua_b']);
    expect(h.repos.users.findByPrefix('%')).toEqual([]);
  });
});
