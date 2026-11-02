import type { Database } from 'better-sqlite3';
import { now as clockNow, nowIso } from './time.js';

export type BugReportStatus =
  'queued' | 'sent' | 'received' | 'processing' | 'done' | 'failed' | 'expired';

export interface BugReportRow {
  id: number;
  reporter_user_id: string;
  group_id: string;
  description: string;
  /** JSON of the HealthResult taken when the report was accepted, or null. */
  health_raw: string | null;
  grok_task_id: string | null;
  status: BugReportStatus;
  last_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertBugReportInput {
  reporterUserId: string;
  groupId: string;
  description: string;
  health?: unknown;
}

/** SPEC-ADMIN §13: website bugs reported by tagging the admin bot in a group. */
export function createBugReportsRepo(db: Database) {
  const insert = db.prepare(
    "INSERT INTO bug_reports (reporter_user_id, group_id, description, health_raw, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
  );
  const get = db.prepare('SELECT * FROM bug_reports WHERE id = ?');
  const findDuplicate = db.prepare(
    'SELECT * FROM bug_reports WHERE reporter_user_id = ? AND description = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
  );
  const setStatus = db.prepare(
    'UPDATE bug_reports SET status = ?, last_text = COALESCE(?, last_text), updated_at = ? WHERE id = ?',
  );
  const setGrokTask = db.prepare(
    'UPDATE bug_reports SET grok_task_id = ?, updated_at = ? WHERE id = ?',
  );

  return {
    /** Returns the new row id; `created_at` / `updated_at` come from `now` (default: the clock). */
    insert(b: InsertBugReportInput, now: Date = clockNow()): number {
      const at = nowIso(now);
      const r = insert.run(
        b.reporterUserId,
        b.groupId,
        b.description,
        b.health === undefined ? null : JSON.stringify(b.health),
        at,
        at,
      );
      return Number(r.lastInsertRowid);
    },
    get(id: number): BugReportRow | undefined {
      return get.get(id) as BugReportRow | undefined;
    },
    /** Newest report by the same reporter with the same description created within `withinMs` of `now`. */
    findRecentDuplicate(
      reporterUserId: string,
      description: string,
      withinMs: number,
      now: Date = clockNow(),
    ): BugReportRow | undefined {
      const since = new Date(now.getTime() - withinMs).toISOString();
      return findDuplicate.get(reporterUserId, description, since) as BugReportRow | undefined;
    },
    /** Keeps the previous `last_text` when none is given. */
    setStatus(id: number, status: BugReportStatus, lastText?: string): void {
      setStatus.run(status, lastText ?? null, nowIso(), id);
    },
    setGrokTask(id: number, grokTaskId: string): void {
      setGrokTask.run(grokTaskId, nowIso(), id);
    },
  };
}

export type BugReportsRepo = ReturnType<typeof createBugReportsRepo>;
