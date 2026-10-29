import { afterEach, describe, expect, it } from 'vitest';
import { startGrokTaskSweeper, type GrokTaskSweeper } from '../../src/grok/sweeper.js';
import { adminServiceQuestionNotice, texts, ticketNotice } from '../../src/texts.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';
import { ticketRows, ticketService } from '../tickets/helpers.js';

const ADMIN = 'Uadmin000000';
const USER = 'Uuser1234567';
const T0 = new Date('2026-10-29T10:00:00.000Z');

let sweeper: GrokTaskSweeper | undefined;
afterEach(() => sweeper?.stop());

function setup(now: () => Date = () => T0, opts: { tickets?: boolean } = {}) {
  const h = harness();
  sweeper = startGrokTaskSweeper({
    repos: h.repos,
    replier: h.replier,
    config: { ADMIN_LINE_USER_ID: ADMIN, TICKET_AUTO_CLOSE_MS: 60_000 },
    tickets: opts.tickets === false ? undefined : ticketService(h, ADMIN),
    now,
    log: silent,
  });
  return { ...h, sweeper };
}

describe('grok task sweeper', () => {
  it('expires an overdue service_question: user timeout text, grok_timeout ticket, status expired', async () => {
    const s = setup();
    s.repos.grokTasks.insert({
      id: 'late',
      jobId: 1,
      type: 'service_question',
      userId: USER,
      payload: { userId: USER, text: '訂單 #20261029-VXJG7AZY 呢', context: [] },
      expiresAt: new Date(T0.getTime() - 1),
    });
    expect(await s.sweeper.sweepOnce()).toBe(1);
    expect(s.repos.grokTasks.get('late')!.status).toBe('expired');
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([USER, ADMIN]);
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokTimeout },
      {
        via: 'push',
        text: ticketNotice({
          ticketId: 'T001',
          userId: USER,
          question: '訂單 #20261029-VXJG7AZY 呢',
          recentMessages: ['訂單 #20261029-VXJG7AZY 呢'],
          orderIds: ['#20261029-VXJG7AZY'],
        }),
      },
    ]);
    expect(pushReasons(s.db)).toEqual(['grok_timeout', 'admin_ticket']);
    expect(ticketRows(s)).toEqual([
      expect.objectContaining({
        source: 'grok_timeout',
        grok_task_id: 'late',
        order_ids: JSON.stringify(['#20261029-VXJG7AZY']),
      }),
    ]);
    // Second pass: nothing left.
    expect(await s.sweeper.sweepOnce()).toBe(0);
    expect(s.api.pushMessage).toHaveBeenCalledTimes(2);
  });

  it('without a ticket service an expired service_question sends the plain admin notice', async () => {
    const s = setup(() => T0, { tickets: false });
    s.repos.grokTasks.insert({
      id: 'late',
      jobId: 1,
      type: 'service_question',
      userId: USER,
      payload: { userId: USER, text: '訂單呢' },
      expiresAt: new Date(T0.getTime() - 1),
    });
    expect(await s.sweeper.sweepOnce()).toBe(1);
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokTimeout },
      { via: 'push', text: adminServiceQuestionNotice({ userId: USER, text: '訂單呢' }) },
    ]);
    expect(pushReasons(s.db)).toEqual(['grok_timeout', 'admin_service_question']);
  });

  it('auto-closes answered tickets idle for TICKET_AUTO_CLOSE_MS on every sweep', async () => {
    let now = T0;
    const s = setup(() => now);
    const { ticket } = s.repos.tickets.openOrAppend({
      userId: USER,
      source: 'handoff',
      question: 'q',
      context: ['q'],
    });
    expect(await s.sweeper.sweepOnce()).toBe(0);
    expect(s.repos.tickets.get(ticket.id)!.status).toBe('open');

    s.repos.tickets.markAnswered(ticket.id, { by: 'Uadmin', answer: 'a' }); // updated_at = real now
    now = new Date(Date.now() + 59_000);
    await s.sweeper.sweepOnce();
    expect(s.repos.tickets.get(ticket.id)!.status).toBe('answered');

    now = new Date(Date.now() + 61_000);
    await s.sweeper.sweepOnce();
    expect(s.repos.tickets.get(ticket.id)!.status).toBe('closed');
  });

  it('leaves non-expired and already closed tasks untouched', async () => {
    const s = setup();
    s.repos.grokTasks.insert({
      id: 'fresh',
      jobId: 1,
      type: 'service_question',
      userId: USER,
      payload: {},
      expiresAt: new Date(T0.getTime() + 60_000),
    });
    s.repos.grokTasks.insert({
      id: 'closed',
      jobId: 2,
      type: 'service_question',
      userId: USER,
      payload: {},
      expiresAt: new Date(T0.getTime() - 60_000),
    });
    s.repos.grokTasks.setStatus('closed', 'done', '答案');
    expect(await s.sweeper.sweepOnce()).toBe(0);
    expect(s.repos.grokTasks.get('fresh')!.status).toBe('sent');
    expect(s.repos.grokTasks.get('closed')!.status).toBe('done');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('expired triage notifies only the admin; expired summarize only logs', async () => {
    const s = setup();
    s.repos.grokTasks.insert({
      id: 'tri',
      jobId: 1,
      type: 'incident_triage',
      userId: USER,
      payload: { incidentId: 9 },
      expiresAt: new Date(T0.getTime() - 1),
    });
    s.repos.grokTasks.insert({
      id: 'sum',
      jobId: 2,
      type: 'summarize_suggestion',
      userId: null,
      payload: { suggestionId: 1 },
      expiresAt: new Date(T0.getTime() - 1),
    });
    expect(await s.sweeper.sweepOnce()).toBe(2);
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([ADMIN]);
    expect(sentTexts(s.api)[0]!.text).toContain('#9');
    expect(s.repos.grokTasks.get('sum')!.status).toBe('expired');
  });
});
