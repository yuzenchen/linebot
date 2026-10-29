import type { Database } from 'better-sqlite3';
import { now, nowIso } from './time.js';

export interface IncidentRow {
  id: number;
  user_id: string;
  text: string | null;
  health_status: string;
  health_raw: string | null;
  admin_notified: number;
  created_at: string;
}

export function createIncidentsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO incidents (user_id, text, health_status, health_raw, admin_notified, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const recentByStatus = db.prepare(
    'SELECT * FROM incidents WHERE health_status = ? AND created_at >= ? ORDER BY created_at DESC, id DESC',
  );
  const markNotified = db.prepare('UPDATE incidents SET admin_notified = 1 WHERE id = ?');

  return {
    insert(i: {
      userId: string;
      text?: string | null;
      healthStatus: string;
      healthRaw?: string | null;
      adminNotified?: boolean;
    }): number {
      const r = insert.run(
        i.userId,
        i.text ?? null,
        i.healthStatus,
        i.healthRaw ?? null,
        i.adminNotified ? 1 : 0,
        nowIso(),
      );
      return Number(r.lastInsertRowid);
    },
    /** Incidents with `status` created within the last `withinMs` before `at`, newest first. */
    recentByStatus(status: string, withinMs: number, at: Date = now()): IncidentRow[] {
      const since = new Date(at.getTime() - withinMs).toISOString();
      return recentByStatus.all(status, since) as IncidentRow[];
    },
    markAdminNotified(id: number): void {
      markNotified.run(id);
    },
  };
}

export type IncidentsRepo = ReturnType<typeof createIncidentsRepo>;
