import { describe, expect, it, vi } from 'vitest';
import {
  NullGrokGateway,
  type GrokGateway,
  type GrokResult,
  type GrokTask,
} from '../../src/grok/gateway.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { JobQueue } from '../../src/jobs/queue.js';
import { adminServiceQuestionNotice, adminTriageNotice, texts } from '../../src/texts.js';
import { harness, healthResult, pushReasons, sentTexts, silent } from '../handlers/helpers.js';

const ADMIN = 'Uadmin000000';
const USER = 'Uuser1234567';

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
      config: { ADMIN_LINE_USER_ID: admin ?? undefined },
      maxAttempts: 5,
      log: silent,
    }),
  );
  return { ...h, queue };
}

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
  it('service_question pushes the Grok answer to the user', async () => {
    const grok = fakeGrok({ ok: true, text: '已出貨，預計明天到。' });
    const s = setup(grok);
    const id = s.queue.enqueue('service_question', serviceQuestion);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(sentTexts(s.api)).toEqual([{ via: 'push', text: '已出貨，預計明天到。' }]);
    expect(pushReasons(s.db)).toEqual(['grok_answer']);
    expect(grok.run.mock.calls[0]![0]).toEqual({
      id: String(id),
      type: 'service_question',
      userMessage: serviceQuestion.text,
      context: serviceQuestion.context,
    });
  });

  it('transient failure retries silently, then informs the user on the final attempt', async () => {
    const s = setup(fakeGrok({ ok: false, error: 'http_500', transient: true }));
    const id = s.queue.enqueue('service_question', serviceQuestion);

    await s.queue.tick();
    let job = s.repos.jobs.get(id)!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(s.api.pushMessage).not.toHaveBeenCalled();

    for (let i = 2; i <= 4; i++) await s.queue.tick();
    expect(s.repos.jobs.get(id)!.attempts).toBe(4);
    expect(s.api.pushMessage).not.toHaveBeenCalled();

    await s.queue.tick();
    job = s.repos.jobs.get(id)!;
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(5);
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_service_question']);
    expect(sentTexts(s.api)[0]).toEqual({ via: 'push', text: texts.grokUnavailable });
  });

  it('non-transient failure informs user and admin and finishes', async () => {
    const s = setup(fakeGrok({ ok: false, error: 'http_400', transient: false }));
    const id = s.queue.enqueue('service_question', serviceQuestion);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(pushReasons(s.db)).toEqual(['grok_unavailable', 'admin_service_question']);
  });

  it('incident_triage pushes the triage to admin', async () => {
    const grok = fakeGrok({ ok: true, text: '後端 DB 連線逾時' });
    const s = setup(grok);
    const id = s.queue.enqueue('incident_triage', triage);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(s.api.pushMessage.mock.calls[0]![0]).toEqual({
      to: ADMIN,
      messages: [
        { type: 'text', text: adminTriageNotice({ incidentId: 3, text: '後端 DB 連線逾時' }) },
      ],
    });
    expect(pushReasons(s.db)).toEqual(['admin_triage']);
    expect(grok.run.mock.calls[0]![0].health?.status).toBe('down');
  });

  it('incident_triage retries on transient failure', async () => {
    const s = setup(fakeGrok({ ok: false, error: 'async_pending', transient: true }));
    const id = s.queue.enqueue('incident_triage', triage);
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('pending');
    expect(s.api.pushMessage).not.toHaveBeenCalled();
  });

  it('summarize_suggestion stores a valid structured summary', async () => {
    const grok = fakeGrok({
      ok: true,
      structured: {
        title: '信用卡付款',
        summary: '希望支援信用卡',
        category: '付款',
        mergedInto: null,
      },
    });
    const s = setup(grok);
    const suggestionId = s.repos.suggestions.insert({ userHash: 'h', text: '希望可以用信用卡' });
    const id = s.queue.enqueue('summarize_suggestion', {
      suggestionId,
      text: '希望可以用信用卡',
      userHash: 'h',
    });
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    const row = s.repos.suggestions.list()[0]!;
    expect(row).toMatchObject({
      status: 'summarized',
      title: '信用卡付款',
      summary: '希望支援信用卡',
      category: '付款',
      merged_into: null,
    });
    expect(grok.run.mock.calls[0]![0].existingSuggestions).toEqual([]);
  });

  it('summarize_suggestion keeps status new on invalid structured output', async () => {
    const s = setup(fakeGrok({ ok: true, structured: { title: 1 } }));
    const suggestionId = s.repos.suggestions.insert({ userHash: 'h', text: '加深色模式' });
    const id = s.queue.enqueue('summarize_suggestion', { suggestionId, text: '加深色模式' });
    await s.queue.tick();
    expect(s.repos.jobs.get(id)!.status).toBe('done');
    expect(s.repos.suggestions.list()[0]!.status).toBe('new');
  });
});
