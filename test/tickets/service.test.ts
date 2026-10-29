import { describe, expect, it, vi } from 'vitest';
import type { AdminNotice, AdminNotifier } from '../../src/notify/adminNotifier.js';
import { createTicketService } from '../../src/tickets/service.js';
import { ticketFollowUpNotice, ticketNotice } from '../../src/texts.js';
import { harness, silent } from '../handlers/helpers.js';
import { ticketRows } from './helpers.js';

const USER = 'U6037873abcdef';

function setup() {
  const h = harness();
  const notices: AdminNotice[] = [];
  const adminNotifier: AdminNotifier = {
    notify: vi.fn(async (n: AdminNotice) => {
      notices.push(n);
      return 'relayed' as const;
    }),
  };
  const service = createTicketService({ repos: h.repos, adminNotifier, log: silent });
  return { ...h, notices, service };
}

describe('ticket service', () => {
  it('open() stores the last 3 customer texts, extracts order ids and sends the §12.2 notice', async () => {
    const s = setup();
    const ticket = await s.service.open({
      userId: USER,
      source: 'grok_failed',
      question: '我的訂單什麼時候出貨',
      context: [
        { role: 'user', text: '很久以前的話' },
        { role: 'assistant', text: '你好' },
        { role: 'user', text: '昨天訂的 #20261029-VXJG7AZY' },
      ],
      grokTaskId: 'task-9',
    });
    expect(ticket).toMatchObject({ id: 1, status: 'open', grok_task_id: 'task-9' });
    expect(s.notices).toEqual([
      {
        kind: 'ticket',
        text: [
          '[待回覆 T001] 客戶 U6037873…',
          '問：我的訂單什麼時候出貨',
          '最近對話：',
          '- 很久以前的話',
          '- 昨天訂的 #20261029-VXJG7AZY',
          '- 我的訂單什麼時候出貨',
          '訂單：#20261029-VXJG7AZY',
          '回覆方式：在這裡打「回覆 T001 <內容>」',
        ].join('\n'),
        meta: { ticketId: 1, userId: USER, source: 'grok_failed' },
      },
    ]);
    expect(ticketRows(s)[0]).toMatchObject({
      context: JSON.stringify([
        '很久以前的話',
        '昨天訂的 #20261029-VXJG7AZY',
        '我的訂單什麼時候出貨',
      ]),
      order_ids: JSON.stringify(['#20261029-VXJG7AZY']),
    });
  });

  it('notice omits the order line when no order id is mentioned; short ids are not truncated', async () => {
    const s = setup();
    await s.service.open({ userId: 'U1', source: 'handoff', question: '找真人', context: [] });
    expect(s.notices[0]!.text).toBe(
      ticketNotice({
        ticketId: 'T001',
        userId: 'U1',
        question: '找真人',
        recentMessages: ['找真人'],
        orderIds: [],
      }),
    );
    expect(s.notices[0]!.text).not.toContain('訂單：');
    expect(s.notices[0]!.text).toContain('客戶 U1\n');
  });

  it('open() on an existing open ticket appends and sends a 追問 notice instead', async () => {
    const s = setup();
    await s.service.open({ userId: USER, source: 'grok_timeout', question: '第一問', context: [] });
    const ticket = await s.service.open({
      userId: USER,
      source: 'grok_failed',
      question: '第二問 #20261030-ABCDEFGH',
      context: [{ role: 'user', text: '第一問' }],
    });
    expect(ticket.id).toBe(1);
    expect(ticket.question).toBe('第一問\n---\n第二問 #20261030-ABCDEFGH');
    expect(ticket.source).toBe('grok_timeout');
    expect(s.notices.map((n) => n.kind)).toEqual(['ticket', 'ticket_followup']);
    expect(s.notices[1]).toEqual({
      kind: 'ticket_followup',
      text: ticketFollowUpNotice({
        ticketId: 'T001',
        userId: USER,
        text: '第二問 #20261030-ABCDEFGH',
      }),
      meta: { ticketId: 1, userId: USER },
    });
    expect(s.notices[1]!.text).toBe('[T001 追問] 客戶 U6037873…\n第二問 #20261030-ABCDEFGH');
    expect(ticketRows(s)[0]!.order_ids).toBe(JSON.stringify(['#20261030-ABCDEFGH']));
  });

  it('the same text reaching open() / notifyFollowUp twice is appended and notified once', async () => {
    const s = setup();
    const ticket = await s.service.open({
      userId: USER,
      source: 'handoff',
      question: 'q',
      context: [],
    });
    await s.service.notifyFollowUp(ticket, '改地址');
    await s.service.open({ userId: USER, source: 'handoff', question: '改地址', context: [] });
    await s.service.notifyFollowUp(ticket, '改地址');
    expect(s.repos.tickets.get(1)!.question).toBe('q\n---\n改地址');
    expect(s.notices.map((n) => n.kind)).toEqual(['ticket', 'ticket_followup']);
  });

  it('notifyFollowUp appends the text and notifies', async () => {
    const s = setup();
    const ticket = await s.service.open({
      userId: USER,
      source: 'handoff',
      question: 'q',
      context: [],
    });
    await s.service.notifyFollowUp(ticket, '還在嗎');
    expect(s.repos.tickets.get(1)!.question).toBe('q\n---\n還在嗎');
    expect(s.repos.tickets.get(1)!.context).toBe(JSON.stringify(['q']));
    expect(s.notices.at(-1)).toMatchObject({ kind: 'ticket_followup' });
    expect(s.notices.at(-1)!.text).toContain('還在嗎');
  });
});
