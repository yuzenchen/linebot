import { afterEach, describe, expect, it } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { QUESTION_SEPARATOR } from '../../src/db/tickets.js';
import { resetClock, setClock } from '../../src/db/time.js';
import { memoryDb } from '../db/helpers.js';

const T0 = new Date('2026-10-30T01:00:00.000Z');

function setup() {
  setClock(() => T0);
  return createRepos(memoryDb()).tickets;
}

afterEach(resetClock);

describe('tickets repo', () => {
  it('openOrAppend creates an open ticket with context, order ids and grok task', () => {
    const tickets = setup();
    const { ticket, created } = tickets.openOrAppend({
      userId: 'U1',
      source: 'grok_failed',
      question: '訂單呢',
      context: ['你好', '訂單呢'],
      orderIds: ['#20261029-VXJG7AZY'],
      grokTaskId: 'task-1',
    });
    expect(created).toBe(true);
    expect(ticket).toMatchObject({
      id: 1,
      user_id: 'U1',
      source: 'grok_failed',
      question: '訂單呢',
      context: JSON.stringify(['你好', '訂單呢']),
      order_ids: JSON.stringify(['#20261029-VXJG7AZY']),
      grok_task_id: 'task-1',
      status: 'open',
      answered_by: null,
      answer: null,
      answered_at: null,
      created_at: T0.toISOString(),
      updated_at: T0.toISOString(),
    });
    expect(tickets.get(1)).toEqual(ticket);
    expect(tickets.findOpenByUser('U1')?.id).toBe(1);
    expect(tickets.findOpenByUser('U2')).toBeUndefined();
    expect(tickets.orderIdsOf(ticket)).toEqual(['#20261029-VXJG7AZY']);
  });

  it('openOrAppend on an open ticket appends the question, merges order ids, keeps source / task', () => {
    const tickets = setup();
    tickets.openOrAppend({
      userId: 'U1',
      source: 'grok_timeout',
      question: '第一問',
      context: ['第一問'],
      orderIds: ['#20261029-AAAAAAAA'],
      grokTaskId: 'task-1',
    });
    const T1 = new Date(T0.getTime() + 1000);
    setClock(() => T1);
    const { ticket, created } = tickets.openOrAppend({
      userId: 'U1',
      source: 'handoff',
      question: '第二問',
      context: ['第一問', '第二問'],
      orderIds: ['#20261029-AAAAAAAA', '#20261029-BBBBBBBB'],
      grokTaskId: 'task-2',
    });
    expect(created).toBe(false);
    expect(ticket).toMatchObject({
      id: 1,
      source: 'grok_timeout',
      grok_task_id: 'task-1',
      question: `第一問${QUESTION_SEPARATOR}第二問`,
      context: JSON.stringify(['第一問', '第二問']),
      order_ids: JSON.stringify(['#20261029-AAAAAAAA', '#20261029-BBBBBBBB']),
      created_at: T0.toISOString(),
      updated_at: T1.toISOString(),
    });
    // Append without context / order ids keeps the stored ones.
    const again = tickets.openOrAppend({ userId: 'U1', source: 'handoff', question: '第三問' });
    expect(again.ticket.context).toBe(JSON.stringify(['第一問', '第二問']));
    expect(again.ticket.order_ids).toBe(
      JSON.stringify(['#20261029-AAAAAAAA', '#20261029-BBBBBBBB']),
    );
    expect(tickets.recentByUser('U1', 5)).toHaveLength(1);
  });

  it('answered / closed tickets do not count as open; a new one is created', () => {
    const tickets = setup();
    tickets.openOrAppend({ userId: 'U1', source: 'handoff', question: 'a', context: [] });
    tickets.markAnswered(1, { by: 'Uadmin', answer: '好了' });
    expect(tickets.get(1)).toMatchObject({
      status: 'answered',
      answered_by: 'Uadmin',
      answer: '好了',
      answered_at: T0.toISOString(),
    });
    expect(tickets.findOpenByUser('U1')).toBeUndefined();
    expect(tickets.findActiveByUser('U1')?.id).toBe(1);

    const { created } = tickets.openOrAppend({
      userId: 'U1',
      source: 'grok_failed',
      question: 'b',
      context: [],
    });
    expect(created).toBe(true);
    expect(tickets.findActiveByUser('U1')?.id).toBe(2);
    tickets.close(2);
    expect(tickets.get(2)!.status).toBe('closed');
    expect(tickets.findActiveByUser('U1')?.id).toBe(1);
    expect(tickets.recentByUser('U1', 5).map((t) => t.id)).toEqual([2, 1]);
  });

  it('listOpen returns open tickets oldest-activity first, capped', () => {
    const tickets = setup();
    for (let i = 1; i <= 12; i++) {
      setClock(() => new Date(T0.getTime() + i * 1000));
      tickets.openOrAppend({ userId: `U${i}`, source: 'handoff', question: 'q', context: [] });
    }
    tickets.close(1);
    expect(tickets.listOpen().map((t) => t.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(tickets.listOpen(2).map((t) => t.id)).toEqual([2, 3]);
  });

  it('autoClose closes answered tickets at the boundary and leaves open / newer ones', () => {
    const tickets = setup();
    tickets.openOrAppend({ userId: 'U1', source: 'handoff', question: 'q', context: [] });
    tickets.openOrAppend({ userId: 'U2', source: 'handoff', question: 'q', context: [] });
    tickets.openOrAppend({ userId: 'U3', source: 'handoff', question: 'q', context: [] });
    tickets.markAnswered(1, { by: 'a', answer: 'x' }); // updated_at = T0
    setClock(() => new Date(T0.getTime() + 1));
    tickets.markAnswered(2, { by: 'a', answer: 'x' }); // updated_at = T0 + 1ms

    const DAY = 86_400_000;
    const closedAt = new Date(T0.getTime() + DAY);
    expect(tickets.autoClose(closedAt, DAY)).toBe(1); // exactly `olderThanMs` old → closed
    expect(tickets.get(1)).toMatchObject({ status: 'closed', updated_at: closedAt.toISOString() });
    expect(tickets.get(2)!.status).toBe('answered');
    expect(tickets.get(3)!.status).toBe('open');
    expect(tickets.autoClose(new Date(T0.getTime() + DAY + 1), DAY)).toBe(1);
    expect(tickets.autoClose(new Date(T0.getTime() + 10 * DAY), DAY)).toBe(0);
    expect(tickets.get(3)!.status).toBe('open');
  });
});
