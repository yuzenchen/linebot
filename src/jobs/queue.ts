import type { Logger } from 'pino';
import type { Job, JobsRepo } from '../db/jobs.js';
import { now as clockNow } from '../db/time.js';
import { logger as defaultLogger } from '../logger.js';

export type { Job };

export type JobHandler = (job: Job) => Promise<void>;

export interface JobHandlers {
  [type: string]: JobHandler;
}

/** Throw from a handler to mark the job `skipped` (with the message as reason) instead of retrying. */
export class SkipJob extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipJob';
  }
}

export interface JobQueueOptions {
  /** Poll interval when no job is runnable (ms). Default 2000. */
  intervalMs?: number;
  /** Attempts before a job becomes terminally `failed`. Default 5. */
  maxAttempts?: number;
  /** Backoff is `baseDelayMs * 2 ** (attempts - 1)`. Default 5000. */
  baseDelayMs?: number;
  /** Defaults to the shared `db/time` clock so `setClock()` moves the queue too. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class JobQueue {
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly now: () => Date;
  private readonly customSleep?: (ms: number) => Promise<void>;
  private readonly log: Logger;

  private handlers: JobHandlers = {};
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly repo: JobsRepo,
    opts: JobQueueOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 2000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 5000;
    this.now = opts.now ?? clockNow;
    this.customSleep = opts.sleep;
    this.log = opts.logger ?? defaultLogger;
  }

  enqueue(type: string, payload: unknown, runAfter?: Date): number {
    return this.repo.enqueue({ type, payload, runAfter });
  }

  /** Registers handlers without starting the loop (use with `tick()`). */
  setHandlers(handlers: JobHandlers): void {
    this.handlers = handlers;
  }

  /** Recovers `running` leftovers, then polls until `stop()`. Idempotent while running. */
  start(handlers: JobHandlers): void {
    if (this.running) return;
    this.setHandlers(handlers);
    this.running = true;
    const reset = this.repo.resetRunning();
    if (reset > 0) this.log.warn({ count: reset }, 'reset running jobs to pending');
    this.loop = this.runLoop();
  }

  /** Stops polling and waits for the in-flight job (if any) to finish. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  /** Processes at most one job. Returns whether a job was claimed. Never throws. */
  async tick(): Promise<boolean> {
    let job: Job | undefined;
    try {
      job = this.repo.claimNext(this.now());
    } catch (err) {
      this.log.error({ err }, 'job claim failed');
      return false;
    }
    if (!job) return false;
    await this.process(job);
    return true;
  }

  private async process(job: Job): Promise<void> {
    const ctx = { jobId: job.id, type: job.type, attempts: job.attempts };
    try {
      const handler = this.handlers[job.type];
      if (!handler) {
        this.repo.markSkipped(job.id, 'no_handler');
        this.log.warn(ctx, 'job skipped: no handler');
        return;
      }
      try {
        await handler(job);
        this.repo.markDone(job.id);
        this.log.info(ctx, 'job done');
      } catch (err) {
        if (err instanceof SkipJob) {
          this.repo.markSkipped(job.id, err.message);
          this.log.info({ ...ctx, reason: err.message }, 'job skipped');
          return;
        }
        const message = errorMessage(err);
        if (job.attempts < this.maxAttempts) {
          const delay = this.baseDelayMs * 2 ** (job.attempts - 1);
          const retryAt = new Date(this.now().getTime() + delay);
          this.repo.markFailed(job.id, message, retryAt);
          this.log.warn({ ...ctx, err, retryAt: retryAt.toISOString() }, 'job failed, will retry');
        } else {
          this.repo.markFailed(job.id, message, null);
          this.log.error({ ...ctx, err }, 'job failed permanently');
        }
      }
    } catch (err) {
      // DB error while recording the outcome; the loop must survive.
      this.log.error({ ...ctx, err }, 'job bookkeeping failed');
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        processed = await this.tick();
      } catch (err) {
        this.log.error({ err }, 'job loop tick failed');
      }
      if (!processed && this.running) await this.sleep(this.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.customSleep) return this.customSleep(ms);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
