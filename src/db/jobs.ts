import type { Database } from 'better-sqlite3';
import { now, nowIso } from './time.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface Job {
  id: number;
  type: string;
  /** Parsed JSON payload (raw string if it was not valid JSON). */
  payload: unknown;
  status: JobStatus;
  attempts: number;
  runAfter: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: number;
  type: string;
  payload: string | null;
  status: JobStatus;
  attempts: number;
  run_after: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function parsePayload(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type,
    payload: parsePayload(r.payload),
    status: r.status,
    attempts: r.attempts,
    runAfter: r.run_after,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createJobsRepo(db: Database) {
  const insert = db.prepare(
    "INSERT INTO jobs (type, payload, status, attempts, run_after, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)",
  );
  const selectNext = db.prepare(
    "SELECT id FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after ASC, id ASC LIMIT 1",
  );
  const claim = db.prepare(
    "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
  );
  const get = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const setStatus = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?');
  const setFailed = db.prepare(
    'UPDATE jobs SET status = ?, last_error = ?, run_after = COALESCE(?, run_after), updated_at = ? WHERE id = ?',
  );
  const resetRunning = db.prepare(
    "UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'",
  );
  const countPending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'");

  // `.immediate` runs BEGIN IMMEDIATE so select + update are one atomic claim.
  const claimTx = db.transaction((at: string): Job | undefined => {
    const row = selectNext.get(at) as { id: number } | undefined;
    if (!row) return undefined;
    claim.run(at, row.id);
    return toJob(get.get(row.id) as JobRow);
  });

  return {
    enqueue(j: { type: string; payload: unknown; runAfter?: Date }): number {
      const t = nowIso();
      const runAfter = j.runAfter ? j.runAfter.toISOString() : t;
      const r = insert.run(j.type, JSON.stringify(j.payload ?? null), runAfter, t, t);
      return Number(r.lastInsertRowid);
    },
    /** Atomically claims the oldest runnable pending job (status→running, attempts+1). */
    claimNext(at: Date = now()): Job | undefined {
      return claimTx.immediate(at.toISOString());
    },
    get(id: number): Job | undefined {
      const row = get.get(id) as JobRow | undefined;
      return row ? toJob(row) : undefined;
    },
    markDone(id: number): void {
      setStatus.run('done', nowIso(), id);
    },
    /** With `retryAt`: back to pending scheduled at `retryAt`; without: terminal failed. */
    markFailed(id: number, error: string, retryAt: Date | null): void {
      setFailed.run(
        retryAt ? 'pending' : 'failed',
        error,
        retryAt ? retryAt.toISOString() : null,
        nowIso(),
        id,
      );
    },
    markSkipped(id: number, reason: string): void {
      setFailed.run('skipped', reason, null, nowIso(), id);
    },
    /** Recovers jobs left `running` by a previous process (call at startup). Returns count. */
    resetRunning(): number {
      return resetRunning.run(nowIso()).changes;
    },
    countPending(): number {
      return (countPending.get() as { n: number }).n;
    },
  };
}

export type JobsRepo = ReturnType<typeof createJobsRepo>;
