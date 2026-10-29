import type { Database } from 'better-sqlite3';
import type { GrokTaskType } from '../grok/gateway.js';
import { nowIso } from './time.js';

export type GrokTaskStatus = 'sent' | 'received' | 'processing' | 'done' | 'failed' | 'expired';

/** Statuses that still wait for a callback (eligible for expiry). */
export const OPEN_GROK_STATUSES: readonly GrokTaskStatus[] = ['sent', 'received', 'processing'];

export interface GrokTaskRow {
  id: string;
  job_id: number | null;
  type: GrokTaskType;
  user_id: string | null;
  /** JSON string of the job payload. */
  payload: string | null;
  status: GrokTaskStatus;
  last_text: string | null;
  callbacks: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** One row per task dispatched to the Cursor Automations webhook; callbacks move its status. */
export function createGrokTasksRepo(db: Database) {
  const insert = db.prepare(
    "INSERT INTO grok_tasks (id, job_id, type, user_id, payload, status, callbacks, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, 'sent', 0, ?, ?, ?)",
  );
  const get = db.prepare('SELECT * FROM grok_tasks WHERE id = ?');
  const setStatus = db.prepare(
    'UPDATE grok_tasks SET status = ?, last_text = COALESCE(?, last_text), callbacks = callbacks + 1, updated_at = ? WHERE id = ?',
  );
  const recordFollowUp = db.prepare(
    'UPDATE grok_tasks SET callbacks = callbacks + 1, last_text = COALESCE(?, last_text) WHERE id = ?',
  );
  const listExpired = db.prepare(
    "SELECT * FROM grok_tasks WHERE status IN ('sent', 'received', 'processing') AND expires_at <= ? ORDER BY expires_at ASC, id ASC",
  );
  const countOpen = db.prepare(
    "SELECT COUNT(*) AS n FROM grok_tasks WHERE status IN ('sent', 'received', 'processing')",
  );

  return {
    insert(t: {
      id: string;
      jobId: number | null;
      type: GrokTaskType;
      userId: string | null;
      payload: unknown;
      expiresAt: Date;
    }): void {
      const now = nowIso();
      insert.run(
        t.id,
        t.jobId,
        t.type,
        t.userId,
        JSON.stringify(t.payload ?? null),
        now,
        now,
        t.expiresAt.toISOString(),
      );
    },
    get(id: string): GrokTaskRow | undefined {
      return get.get(id) as GrokTaskRow | undefined;
    },
    /** Also bumps `callbacks` and `updated_at`; keeps the previous `last_text` when none is given. */
    setStatus(id: string, status: GrokTaskStatus, lastText?: string): void {
      setStatus.run(status, lastText ?? null, nowIso(), id);
    },
    /** Counts a post-closure callback (SPEC-ADMIN §12.4) without touching `updated_at`. */
    recordFollowUp(id: string, lastText?: string): void {
      recordFollowUp.run(lastText ?? null, id);
    },
    /** Open tasks whose `expires_at <= now`. */
    listExpired(now: Date): GrokTaskRow[] {
      return listExpired.all(now.toISOString()) as GrokTaskRow[];
    },
    countOpen(): number {
      return (countOpen.get() as { n: number }).n;
    },
  };
}

export type GrokTasksRepo = ReturnType<typeof createGrokTasksRepo>;
