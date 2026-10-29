import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createJobsRepo } from '../../src/db/jobs.js';
import { resetClock, setClock } from '../../src/db/time.js';
import { JobQueue, SkipJob } from '../../src/jobs/queue.js';
import { memoryDb } from '../db/helpers.js';

const silent = pino({ level: 'silent' });

afterEach(() => resetClock());

/** Shared fake clock: repo timestamps and the queue's `now` both follow `setClock`. */
function setup() {
  const repo = createJobsRepo(memoryDb());
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  setClock(clock.now);
  const queue = new JobQueue(repo, { logger: silent });
  return { repo, queue, clock };
}

describe('JobQueue.tick', () => {
  it('marks a successful job done', async () => {
    const { repo, queue } = setup();
    const seen: unknown[] = [];
    queue.setHandlers({
      echo: async (job) => {
        seen.push(job.payload);
      },
    });
    const id = queue.enqueue('echo', { hello: 'world' });
    expect(await queue.tick()).toBe(true);
    expect(seen).toEqual([{ hello: 'world' }]);
    expect(repo.get(id)?.status).toBe('done');
    expect(await queue.tick()).toBe(false);
  });

  it('retries with exponential backoff and fails after maxAttempts', async () => {
    const { repo, queue, clock } = setup();
    queue.setHandlers({
      bad: async () => {
        throw new Error('nope');
      },
    });
    const id = queue.enqueue('bad', {});
    const expectedDelays = [5000, 10000, 20000, 40000];
    for (const [i, delay] of expectedDelays.entries()) {
      expect(await queue.tick()).toBe(true);
      const job = repo.get(id)!;
      expect(job).toMatchObject({ status: 'pending', attempts: i + 1, lastError: 'nope' });
      expect(job.runAfter).toBe(new Date(clock.now().getTime() + delay).toISOString());
      // not runnable yet
      expect(await queue.tick()).toBe(false);
      clock.advance(delay);
    }
    expect(await queue.tick()).toBe(true);
    expect(repo.get(id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(await queue.tick()).toBe(false);
  });

  it('SkipJob marks skipped with the message; unknown type skipped with no_handler', async () => {
    const { repo, queue } = setup();
    queue.setHandlers({
      skip: async () => {
        throw new SkipJob('grok_not_configured');
      },
    });
    const a = queue.enqueue('skip', {});
    const b = queue.enqueue('mystery', {});
    await queue.tick();
    await queue.tick();
    expect(repo.get(a)).toMatchObject({ status: 'skipped', lastError: 'grok_not_configured' });
    expect(repo.get(b)).toMatchObject({ status: 'skipped', lastError: 'no_handler' });
  });

  it('survives a handler that throws a non-Error value', async () => {
    const { repo, queue } = setup();
    queue.setHandlers({
      weird: async () => {
        throw 'string-error';
      },
    });
    const id = queue.enqueue('weird', {});
    await queue.tick();
    expect(repo.get(id)).toMatchObject({ status: 'pending', lastError: 'string-error' });
  });
});

describe('JobQueue.start/stop', () => {
  it('resets stale running jobs on start and stop waits for the in-flight job', async () => {
    const repo = createJobsRepo(memoryDb());
    const stale = repo.enqueue({ type: 'slow', payload: null });
    repo.claimNext(new Date());
    expect(repo.get(stale)?.status).toBe('running');

    const queue = new JobQueue(repo, { intervalMs: 1, logger: silent });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = false;
    queue.start({
      slow: async () => {
        started = true;
        await gate;
      },
    });
    // the stale job is picked up again by the loop
    while (!started) await new Promise((r) => setTimeout(r, 1));
    expect(repo.get(stale)).toMatchObject({ status: 'running', attempts: 2 });

    const stopped = queue.stop();
    release();
    await stopped;
    expect(repo.get(stale)?.status).toBe('done');
    expect(repo.resetRunning()).toBe(0);
  });

  it('stop resolves promptly when idle', async () => {
    const repo = createJobsRepo(memoryDb());
    const queue = new JobQueue(repo, { intervalMs: 60_000, logger: silent });
    queue.start({});
    const t = Date.now();
    await queue.stop();
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
