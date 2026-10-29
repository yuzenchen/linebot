import { afterEach, describe, expect, it } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { resetClock, setClock } from '../../src/db/time.js';
import { memoryDb } from './helpers.js';

afterEach(() => resetClock());

const T0 = new Date('2026-10-29T10:00:00.000Z');

describe('grokTasks repo', () => {
  it('inserts as sent, reads back, and setStatus counts callbacks', () => {
    setClock(() => T0);
    const { grokTasks } = createRepos(memoryDb());
    grokTasks.insert({
      id: 'a',
      jobId: 5,
      type: 'service_question',
      userId: 'U1',
      payload: { text: 'hi' },
      expiresAt: new Date(T0.getTime() + 1000),
    });
    expect(grokTasks.get('a')).toMatchObject({
      id: 'a',
      job_id: 5,
      type: 'service_question',
      user_id: 'U1',
      payload: '{"text":"hi"}',
      status: 'sent',
      last_text: null,
      callbacks: 0,
      created_at: T0.toISOString(),
      expires_at: new Date(T0.getTime() + 1000).toISOString(),
    });
    expect(grokTasks.get('missing')).toBeUndefined();

    const later = new Date(T0.getTime() + 500);
    setClock(() => later);
    grokTasks.setStatus('a', 'received');
    grokTasks.setStatus('a', 'processing', '查詢中');
    grokTasks.setStatus('a', 'done');
    expect(grokTasks.get('a')).toMatchObject({
      status: 'done',
      last_text: '查詢中',
      callbacks: 3,
      updated_at: later.toISOString(),
    });
  });

  it('listExpired returns only open overdue tasks; countOpen counts open ones', () => {
    const { grokTasks } = createRepos(memoryDb());
    const add = (id: string, offsetMs: number) =>
      grokTasks.insert({
        id,
        jobId: null,
        type: 'incident_triage',
        userId: null,
        payload: null,
        expiresAt: new Date(T0.getTime() + offsetMs),
      });
    add('overdue-sent', -2000);
    add('overdue-processing', -1000);
    add('overdue-done', -3000);
    add('future', 1000);
    grokTasks.setStatus('overdue-processing', 'processing');
    grokTasks.setStatus('overdue-done', 'done');
    expect(grokTasks.countOpen()).toBe(3);
    expect(grokTasks.listExpired(T0).map((r) => r.id)).toEqual([
      'overdue-sent',
      'overdue-processing',
    ]);
    grokTasks.setStatus('overdue-sent', 'expired');
    expect(grokTasks.countOpen()).toBe(2);
  });

  it('rejects an unknown status', () => {
    const { grokTasks } = createRepos(memoryDb());
    grokTasks.insert({
      id: 'x',
      jobId: null,
      type: 'service_question',
      userId: 'U1',
      payload: {},
      expiresAt: T0,
    });
    expect(() => grokTasks.setStatus('x', 'bogus' as 'done')).toThrow(/CHECK/);
  });
});
