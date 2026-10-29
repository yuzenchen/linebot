import { describe, expect, it, vi } from 'vitest';
import {
  NullGrokGateway,
  type GrokGateway,
  type GrokResult,
  type GrokTask,
} from '../../src/grok/gateway.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { adminServiceQuestionNotice, texts } from '../../src/texts.js';
import { harness, healthResult, pushReasons, sentTexts, silent } from '../handlers/helpers.js';

const ADMIN = 'Uadmin000000';
const USER = 'Uuser1234567';
const T0 = new Date('2026-10-29T10:00:00.000Z');
const TIMEOUT_MS = 15 * 60_000;

function fakeGrok(
  results: GrokResult | ((task: GrokTask) => GrokResult),
): GrokGateway & { run: ReturnType<typeof vi.fn<(t: GrokTask) => Promise<GrokResult>>> } {
  return {
    configured: true,
    run: vi.fn(async (t: GrokTask) => (typeof results === 'function' ? results(t) : results)),
  };
}

function setup(grok: GrokGateway, admin: string | null = ADMIN) {
  const h = harness();
  // baseDelayMs 0: a retried job is runnable again on the next tick.
  const queue = new JobQueue(h.repos.jobs, { logger: silent, baseDelayMs: 0, maxAttempts: 5 });
  queue.setHandlers(
    createJobHandlers({
      repos: h.repos,
      replier: h.replier,
      grok,
      config: { ADMIN_LINE_USER_ID: admin ?? undefined, GROK_TASK_TIMEOUT_MS: TIMEOUT_MS },
      maxAttempts: 5,
      now: () => T0,
      log: silent,
    }),
  );
  return { ...h, queue };
}

interface TaskRow {
  id: string;
  job_id: number;
  type: string;
  user_id: string | null;
  payload: string;
  status: string;
  last_text: string | null;
  expires_at: string;
}

const taskRows = (s: ReturnType<typeof setup>) =>
  s.db.prepare('SELECT * FROM grok_tasks ORDER BY rowid').all() as TaskRow[];

const serviceQuestion = {
  userId: USER,
  messageId: 1,
  text: '我的訂單到哪了？',
  context: [{ role: 'user', text: '你好' }],
};
const triage = {
  userId: USER,
  incidentId: 3,
  messageId: 2,
  text: '網站打不開',
  health: healthResult({ status: 'down', error: 'timeout' }),
  context: [],
};

describe('job handlers with NullGrokGateway', () => {
  it('service_question informs user and admin, then skips', async () => {
    const s = setup(new NullGrokGateway());
    const id = s.queue.enqueue('service_question', serviceQuestion);
    await s.queue.tick();
    const job = s.repos.jobs.get(id)!;
    expect(job.status).toBe('skipped');
    expect(job.lastError).toBe('grok_not_configured');
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokUnavailable },
      {
        via: 'push',
        text: adminServiceQuestionNotice({ userId: USER, text: serviceQuestion.text }),
      },
    ]);
    expect(s.api.pushMessage.mock.calls.map(([r]) => r.to)).toEqual([USER, ADMIN]);
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_service_question']);
  });

  it('service_question without admin id only pushes the user', async () => {
    const s = setup(new NullGrokGateway(), null);
    const id = s.queue.enqueue('service_question', serviceQuestion);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('skipped');
    expect(pushReasons(s.db)).toEqual(['grok_unavailable']);
  });

  it('incident_triage skips without pushing', async () => {
    const s = setup(new NullGrokGateway());
    const id = s.queue.enqueue('incident_triage', triage);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('skipped');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('never writes grok_tasks rows', async () => {
    const s = setup(new NullGrokGateway());
    s.queue.enqueue('service_question', serviceQuestion);
    s.queue.enqueue('incident_triage', triage);
    await s.queue.tick();
    await s.queue.tick();
    expect(taskRows(s)).toHaveLength(0);
    expect(s.repos.grokTasks.countOpen()).toBe(0);
  });

  it('summarize_suggestion skips and leaves the suggestion new', async () => {
    const s = setup(new NullGrokGateway());
    const suggestionId = s.repos.suggestions.insert({ userHash: 'h', text: '希望可以用信用卡' });
    const id = s.queue.enqueue('summarize_suggestion', {
      suggestionId,
      text: '希望可以用信用卡',
      userHash: 'h',
    });
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('skipped');
    expect(s.repos.suggestions.list()[0]!.status).toBe('new');
  });

  it('bad payload is skipped as bad_payload', async () => {
    const s = setup(new NullGrokGateway());
    const id = s.queue.enqueue('service_question', { nope: true });
    await s.queue.tick();
    const job = s.repos.jobs.get(id)!;
    expect(job.status).toBe('skipped');
    expect(job.lastError).toBe('bad_payload');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });
});

describe('job handlers with a configured gateway', () => {
  const accepted: GrokResult = { ok: true, accepted: true };

  it('service_question creates a sent grok_task, dispatches it, and finishes without pushing', async () => {
    const grok = fakeGrok(accepted);
    const s = setup(grok);
    const id = s.queue.enqueue('service_question', serviceQuestion);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(s.api.pushMessage).not.toHaveBeenCalled();

    const rows = taskRows(s);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      job_id: id,
      type: 'service_question',
      user_id: USER,
      status: 'sent',
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(row.payload)).toEqual(serviceQuestion);
    expect(row.expires_at).toBe(new Date(T0.getTime() + TIMEOUT_MS).toISOString());

    expect(grok.run.mock.calls[0]![0]).toEqual({
      id: row.id,
      type: 'service_question',
      userMessage: serviceQuestion.text,
      context: serviceQuestion.context,
    });
    expect(s.repos.grokTasks.countOpen()).toBe(1);
  });

  it('401 (non-transient) marks the task failed, informs user and admin, and finishes', async () => {
    const s = setup(fakeGrok({ ok: false, error: 'http_401', transient: false }));
    const id = s.queue.enqueue('service_question', serviceQuestion);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(taskRows(s)[0]).toMatchObject({ status: 'failed', last_text: 'http_401' });
    expect(sentTexts(s.api)).toEqual([
      { via: 'push', text: texts.grokUnavailable },
      {
        via: 'push',
        text: adminServiceQuestionNotice({ userId: USER, text: serviceQuestion.text }),
      },
    ]);
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_service_question']);
  });

  it('500 (transient) marks the task failed, retries silently, then informs on the final attempt', async () => {
    const s = setup(fakeGrok({ ok: false, error: 'http_500', transient: true }));
    const id = s.queue.enqueue('service_question', serviceQuestion);

    await s.queue.tick();
    let job = s.repos.jobs.get(id)!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(taskRows(s).map((r) => r.status)).toEqual(['failed']);
    expect(s.api.pushMessage).not.toHaveBeenCalled();

    for (let i = 2; i <= 4; i++) await s.queue.tick();
    expect(s.repos.jobs.get(id)!.attempts).toBe(4);
    expect(s.api.pushMessage).not.toHaveBeenCalled();

    await s.queue.tick();
    job = s.repos.jobs.get(id)!;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(5);
    // One grok_tasks row per attempt, all failed; none left open.
    expect(taskRows(s).map((r) => r.status)).toEqual(Array<string>(5).fill('failed'));
    expect(s.repos.grokTasks.countOpen()).toBe(0);
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_service_question']);
    expect(sentTexts(s.api)[0]).toEqual({ via: 'push', text: texts.grokUnavailable });
  });

  it('incident_triage dispatches with health and pushes nothing yet', async () => {
    const grok = fakeGrok(accepted);
    const s = setup(grok);
    const id = s.queue.enqueue('incident_triage', triage);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
    expect(taskRows(s)[0]).toMatchObject({
      type: 'incident_triage',
      user_id: USER,
      status: 'sent',
    });
    expect(grok.run.mock.calls[0]![0].health?.status).toBe('down');
  });

  it('incident_triage retries on transient failure and finishes quietly on rejection', async () => {
    const s = setup(fakeGrok({ ok: false, error: 'fetch failed', transient: true }));
    const id = s.queue.enqueue('incident_triage', triage);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('pending');

    const s2 = setup(fakeGrok({ ok: false, error: 'http_403', transient: false }));
    const id2 = s2.queue.enqueue('incident_triage', triage);
    await s2.queue.tick();
    expect(s2.repos.jobs.get(id2)!.status).toBe('done');
    expect(taskRows(s2)[0]!.status).toBe('failed');
    expect(s2.api.pushMessage).not.toHaveBeenCalled();
  });

  it('summarize_suggestion sends existing titles and leaves the suggestion new until the callback', async () => {
    const grok = fakeGrok(accepted);
    const s = setup(grok);
    const other = s.repos.suggestions.insert({ userHash: 'h0', text: '舊建議' });
    s.repos.suggestions.updateSummary(other, {
      title: '深色模式',
      summary: 's',
      category: 'ui',
      status: 'summarized',
    });
    const suggestionId = s.repos.suggestions.insert({ userHash: 'h', text: '希望可以用信用卡' });
    const id = s.queue.enqueue('summarize_suggestion', {
      suggestionId,
      text: '希望可以用信用卡',
      userHash: 'h',
    });
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(s.repos.suggestions.list()[1]!.status).toBe('new');
    expect(taskRows(s)[0]).toMatchObject({ type: 'summarize_suggestion', user_id: null });
    expect(grok.run.mock.calls[0]![0].existingSuggestions).toEqual([
      { id: other, title: '深色模式' },
    ]);
  });
});
