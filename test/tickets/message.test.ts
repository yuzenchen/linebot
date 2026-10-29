import { describe, expect, it, vi } from 'vitest';
import type { Classifier } from '../../src/classifier/index.js';
import { createHandoffService } from '../../src/handlers/handoff.js';
import { createTextMessageHandler } from '../../src/handlers/message.js';
import { texts, ticketFollowUpNotice } from '../../src/texts.js';
import {
  classification,
  fakeHealth,
  harness,
  healthResult,
  inbound,
  jobRows,
  pushReasons,
  sentTexts,
  silent,
  type Harness,
} from '../handlers/helpers.js';
import { ticketRows, ticketService } from './helpers.js';

const ADMIN = 'Uadmin000000';

function make(h: Harness, classify: Classifier['classify']) {
  return createTextMessageHandler({
    repos: h.repos,
    replier: h.replier,
    classifier: { classify },
    health: fakeHealth(healthResult({ status: 'healthy', httpStatus: 200 })),
    jobs: h.jobs,
    config: { REPLY_DEADLINE_MS: 1000, CONTEXT_MESSAGES: 6, ADMIN_LINE_USER_ID: ADMIN },
    tickets: ticketService(h, ADMIN),
    log: silent,
  });
}

function openTicket(h: Harness, userId = 'U1') {
  return h.repos.tickets.openOrAppend({
    userId,
    source: 'grok_unconfigured',
    question: '我的訂單呢',
    context: ['我的訂單呢'],
  }).ticket;
}

describe('text message handler with an open ticket (SPEC-ADMIN §12.2)', () => {
  it('service_related: replies ticketPending, appends to the ticket, notifies 追問, enqueues nothing', async () => {
    const h = harness();
    const ticket = openTicket(h);
    const classify = vi.fn(async () =>
      classification({ category: 'service_related', confidence: 0.8, answer: null }),
    );
    const handle = make(h, classify);
    await handle(inbound(h.repos, '還沒出貨嗎'));

    expect(classify).toHaveBeenCalledTimes(1);
    expect(sentTexts(h.api)).toEqual([
      { via: 'reply', text: texts.ticketPending },
      {
        via: 'push',
        text: ticketFollowUpNotice({ ticketId: 'T001', userId: 'U1', text: '還沒出貨嗎' }),
      },
    ]);
    expect(pushReasons(h.db)).toEqual(['admin_ticket_followup']);
    expect(jobRows(h.db)).toHaveLength(0);
    expect(ticketRows(h)).toHaveLength(1);
    expect(h.repos.tickets.get(ticket.id)).toMatchObject({
      status: 'open',
      question: '我的訂單呢\n---\n還沒出貨嗎',
    });
  });

  it('a low-confidence service question that also enters handoff is appended once', async () => {
    const h = harness();
    h.repos.users.upsert({ userId: 'U1' });
    h.repos.users.incrementLowConf('U1');
    openTicket(h);
    const handoffService = createHandoffService({
      repos: h.repos,
      replier: h.replier,
      config: { ADMIN_LINE_USER_ID: ADMIN },
      tickets: ticketService(h, ADMIN),
      log: silent,
    });
    const handle = createTextMessageHandler({
      repos: h.repos,
      replier: h.replier,
      classifier: {
        classify: async () =>
          classification({ category: 'service_related', confidence: 0.3, answer: null }),
      },
      health: fakeHealth(healthResult({ status: 'healthy', httpStatus: 200 })),
      jobs: h.jobs,
      config: { REPLY_DEADLINE_MS: 1000, CONTEXT_MESSAGES: 6, ADMIN_LINE_USER_ID: ADMIN },
      handoffService,
      tickets: ticketService(h, ADMIN),
      log: silent,
    });
    await handle(inbound(h.repos, '可以改地址嗎'));
    expect(sentTexts(h.api).map((t) => t.text)).toEqual([
      texts.ticketPending,
      texts.handoffEntered,
      ticketFollowUpNotice({ ticketId: 'T001', userId: 'U1', text: '可以改地址嗎' }),
    ]);
    expect(pushReasons(h.db)).toEqual(['admin_ticket_followup']);
    expect(ticketRows(h)[0]!.question).toBe('我的訂單呢\n---\n可以改地址嗎');
    expect(h.repos.users.get('U1')?.handoff_until).not.toBeNull();
  });

  it('kb_answer with an open ticket is answered normally', async () => {
    const h = harness();
    openTicket(h);
    const handle = make(h, async () => classification({ answer: '滿 500 免運。' }));
    await handle(inbound(h.repos, '免運門檻？'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: '滿 500 免運。' }]);
    expect(h.api.pushMessage).not.toHaveBeenCalled();
    expect(ticketRows(h)[0]!.question).toBe('我的訂單呢');
  });

  it('off_topic and feature_request with an open ticket are unchanged', async () => {
    const h = harness();
    openTicket(h);
    const handle = make(h, async () => classification({ category: 'off_topic' }));
    await handle(inbound(h.repos, '天氣'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.offTopic }]);
    expect(ticketRows(h)[0]!.question).toBe('我的訂單呢');
  });

  it('an answered ticket no longer short-circuits: the question goes to Grok', async () => {
    const h = harness();
    const ticket = openTicket(h);
    h.repos.tickets.markAnswered(ticket.id, { by: 'Uadmin', answer: '已出貨' });
    const handle = make(h, async () =>
      classification({ category: 'service_related', confidence: 0.8, answer: null }),
    );
    await handle(inbound(h.repos, '還沒收到'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.serviceForwarded }]);
    expect(jobRows(h.db).map((j) => j.type)).toEqual(['service_question']);
  });

  it("another user's open ticket does not affect this user", async () => {
    const h = harness();
    openTicket(h, 'Uother');
    const handle = make(h, async () =>
      classification({ category: 'service_related', confidence: 0.8, answer: null }),
    );
    await handle(inbound(h.repos, '訂單呢'));
    expect(sentTexts(h.api)).toEqual([{ via: 'reply', text: texts.serviceForwarded }]);
    expect(jobRows(h.db)).toHaveLength(1);
  });
});
