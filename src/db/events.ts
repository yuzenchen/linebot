import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export interface NewEvent {
  webhookEventId: string;
  type: string;
  userId?: string | null;
  raw: string;
}

export function createEventsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO events (webhook_event_id, type, user_id, received_at, raw) VALUES (?, ?, ?, ?, ?)',
  );
  return {
    /** Returns true when the event was new (inserted), false when already seen. */
    insertIfNew(e: NewEvent): boolean {
      return insert.run(e.webhookEventId, e.type, e.userId ?? null, nowIso(), e.raw).changes === 1;
    },
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
