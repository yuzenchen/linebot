import { afterEach, describe, expect, it } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { resetClock, setClock } from '../../src/db/time.js';
import { memoryDb } from './helpers.js';

afterEach(() => resetClock());

describe('events.insertIfNew', () => {
  it('returns true for a new id and false for a duplicate', () => {
    const { events } = createRepos(memoryDb());
    const e = { webhookEventId: 'evt-1', type: 'message', userId: 'U1', raw: '{}' };
    expect(events.insertIfNew(e)).toBe(true);
    expect(events.insertIfNew(e)).toBe(false);
  });
});

describe('messages', () => {
  it('recent returns the last n oldest→newest; countToday counts UTC day', () => {
    const { messages } = createRepos(memoryDb());
    let t = Date.UTC(2026, 0, 15, 10, 0, 0);
    setClock(() => new Date(t));
    for (const text of ['a', 'b', 'c', 'd']) {
      messages.insert({ userId: 'U1', direction: 'in', type: 'text', text });
      t += 1000;
    }
    messages.insert({ userId: 'U2', direction: 'in', type: 'text', text: 'other' });
    expect(messages.recent('U1', 3).map((m) => m.text)).toEqual(['b', 'c', 'd']);
    expect(messages.recent('U1', 10)).toHaveLength(4);
    expect(messages.countToday(new Date(t))).toBe(5);
    expect(messages.countToday(new Date(Date.UTC(2026, 0, 16)))).toBe(0);
  });
});

describe('users', () => {
  it('upserts, tracks low_conf_streak and handoff', () => {
    const { users } = createRepos(memoryDb());
    users.upsert({ userId: 'U1', displayName: 'Ann' });
    users.upsert({ userId: 'U1' });
    expect(users.get('U1')?.display_name).toBe('Ann');
    expect(users.incrementLowConf('U1')).toBe(1);
    expect(users.incrementLowConf('U1')).toBe(2);
    users.resetLowConf('U1');
    expect(users.get('U1')?.low_conf_streak).toBe(0);
    users.setHandoffUntil('U1', '2026-01-01T00:00:00.000Z');
    expect(users.get('U1')?.handoff_until).toBe('2026-01-01T00:00:00.000Z');
    users.setFollowed('U1', false);
    expect(users.get('U1')?.followed).toBe(0);
    expect(users.list()).toHaveLength(1);
  });
});

describe('incidents.recentByStatus', () => {
  it('filters by status and window', () => {
    const { incidents } = createRepos(memoryDb());
    const base = Date.UTC(2026, 2, 1, 12, 0, 0);
    setClock(() => new Date(base - 15 * 60_000));
    incidents.insert({ userId: 'U1', healthStatus: 'down', text: 'old' });
    setClock(() => new Date(base - 5 * 60_000));
    const id = incidents.insert({ userId: 'U2', healthStatus: 'down', text: 'recent' });
    incidents.insert({ userId: 'U3', healthStatus: 'healthy', text: 'other status' });
    const rows = incidents.recentByStatus('down', 10 * 60_000, new Date(base));
    expect(rows.map((r) => r.text)).toEqual(['recent']);
    incidents.markAdminNotified(id);
    expect(incidents.recentByStatus('down', 10 * 60_000, new Date(base))[0].admin_notified).toBe(1);
  });
});

describe('suggestions', () => {
  it('inserts, updates summary and lists titles', () => {
    const { suggestions } = createRepos(memoryDb());
    const a = suggestions.insert({ userHash: 'h1', text: 'want dark mode' });
    suggestions.insert({ userHash: 'h2', text: 'untitled' });
    suggestions.updateSummary(a, {
      title: 'Dark mode',
      summary: 'Add a dark theme',
      category: 'ui',
      status: 'summarized',
    });
    expect(suggestions.list()).toHaveLength(2);
    expect(suggestions.listTitles()).toEqual([{ id: a, title: 'Dark mode' }]);
    expect(suggestions.list()[0]).toMatchObject({ status: 'summarized', merged_into: null });
  });
});

describe('pushLog.countMonth', () => {
  it('counts only the calendar month of the given time', () => {
    const { pushLog } = createRepos(memoryDb());
    setClock(() => new Date(Date.UTC(2026, 3, 30, 23, 59, 59)));
    pushLog.insert({ userId: 'U1', reason: 'reply_fallback' });
    setClock(() => new Date(Date.UTC(2026, 4, 1, 0, 0, 0)));
    pushLog.insert({ userId: 'U1', reason: 'admin_notify' });
    pushLog.insert({ userId: 'U2', reason: 'admin_notify' });
    expect(pushLog.countMonth(new Date(Date.UTC(2026, 3, 10)))).toBe(1);
    expect(pushLog.countMonth(new Date(Date.UTC(2026, 4, 20)))).toBe(2);
    expect(pushLog.countMonth(new Date(Date.UTC(2026, 5, 1)))).toBe(0);
  });
});

describe('jobs repo', () => {
  it('claimNext takes the oldest runnable job and skips future run_after', () => {
    const { jobs } = createRepos(memoryDb());
    const t0 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    setClock(() => t0);
    const future = jobs.enqueue({
      type: 'x',
      payload: { n: 1 },
      runAfter: new Date(t0.getTime() + 60_000),
    });
    const first = jobs.enqueue({ type: 'x', payload: { n: 2 } });
    const second = jobs.enqueue({ type: 'y', payload: { n: 3 } });

    const claimed = jobs.claimNext(t0);
    expect(claimed?.id).toBe(first);
    expect(claimed).toMatchObject({ status: 'running', attempts: 1, payload: { n: 2 } });
    expect(jobs.claimNext(t0)?.id).toBe(second);
    expect(jobs.claimNext(t0)).toBeUndefined();
    expect(jobs.claimNext(new Date(t0.getTime() + 60_000))?.id).toBe(future);
    expect(jobs.countPending()).toBe(0);
  });

  it('markFailed with retryAt returns to pending; without becomes failed; resetRunning recovers', () => {
    const { jobs } = createRepos(memoryDb());
    const t0 = new Date(Date.UTC(2026, 0, 1));
    setClock(() => t0);
    const id = jobs.enqueue({ type: 'x', payload: null });
    jobs.claimNext(t0);
    const retryAt = new Date(t0.getTime() + 5000);
    jobs.markFailed(id, 'boom', retryAt);
    expect(jobs.get(id)).toMatchObject({
      status: 'pending',
      lastError: 'boom',
      runAfter: retryAt.toISOString(),
    });
    expect(jobs.claimNext(t0)).toBeUndefined();
    expect(jobs.claimNext(retryAt)?.attempts).toBe(2);
    jobs.markFailed(id, 'boom again', null);
    expect(jobs.get(id)?.status).toBe('failed');

    const other = jobs.enqueue({ type: 'x', payload: 1 });
    jobs.claimNext(retryAt);
    expect(jobs.get(other)?.status).toBe('running');
    expect(jobs.resetRunning()).toBe(1);
    expect(jobs.get(other)?.status).toBe('pending');
    jobs.markSkipped(other, 'no_handler');
    expect(jobs.get(other)).toMatchObject({ status: 'skipped', lastError: 'no_handler' });
  });
});
