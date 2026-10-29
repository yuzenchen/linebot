import { afterEach, describe, expect, it } from 'vitest';
import { startGrokTaskSweeper, type GrokTaskSweeper } from '../../src/grok/sweeper.js';
import { adminServiceQuestionNotice, texts } from '../../src/texts.js';
import { harness, pushReasons, sentTexts, silent } from '../handlers/helpers.js';

const ADMIN = 'Uadmin000000';
const USER = 'Uuser1234567';
const T0 = new Date('2026-10-29T10:00:00.000Z');

let sweeper: GrokTaskSweeper | undefined;
afterEach(() => sweeper?.stop());

function setup(now: Date = T0) {
  const h = harness();
  sweeper = startGrokTaskSweeper({
    repos: h.repos,
    replier: h.replier,
    config: { ADMIN_LINE_USER_ID: ADMIN },
    now: () => now,
    log: silent,
  });
  return { ...h, sweeper };
}

describe('grok task sweeper', () => {
  it('expires an overdue service_question: user timeout text, admin notice, status expired', async () => {
    const s = setup();
    s.repos.grokTasks.insert({
      id: 'late',
      jobId: 1,
      type: 'service_question',
      userId: USER,
      payload: { userId: USER, text: '訂單呢' },
      expiresAt: new Date(T0.getTime() - 1),
    });
    expect(await s.sweeper.sweepOnce()).toBe(1);
    expect(s.repos.grokTasks.get('late')!.status).toBe('expired');
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([USER, ADMIN]);
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokTimeout },
      { via: 'push', text: adminServiceQuestionNotice({ userId: USER, text: '訂單呢' }) },
    ]);
    expect(pushReasons(s.db)).toEqual(['grok_timeout', 'admin_service_question']);
    // Second pass: nothing left.
    expect(await s.sweeper.sweepOnce()).toBe(0);
    expect(s.api.pushMessage).toHaveBeenCalledTimes(2);
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
