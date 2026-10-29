import type { Database } from 'better-sqlite3';
import { now, nowIso } from './time.js';

export function createPushLogRepo(db: Database) {
  const insert = db.prepare('INSERT INTO push_log (user_id, reason, created_at) VALUES (?, ?, ?)');
  const countRange = db.prepare(
    'SELECT COUNT(*) AS n FROM push_log WHERE created_at >= ? AND created_at < ?',
  );

  return {
    insert(p: { userId: string; reason: string }): number {
      return Number(insert.run(p.userId, p.reason, nowIso()).lastInsertRowid);
    },
    /** Pushes in the UTC calendar month containing `at`. */
    countMonth(at: Date = now()): number {
      const y = at.getUTCFullYear();
      const m = at.getUTCMonth();
      const start = new Date(Date.UTC(y, m, 1)).toISOString();
      const end = new Date(Date.UTC(y, m + 1, 1)).toISOString();
      return (countRange.get(start, end) as { n: number }).n;
    },
  };
}

export type PushLogRepo = ReturnType<typeof createPushLogRepo>;
