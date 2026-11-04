import type { Database } from 'better-sqlite3';
import type { Direction } from './messages.js';
import { nowIso } from './time.js';

export interface GroupContextRow {
  id: number;
  group_id: string;
  /** Sender of an inbound query; null for the bot's answer. */
  user_id: string | null;
  direction: Direction;
  text: string;
  created_at: string;
}

/**
 * SPEC-ADMIN §14.3 step 4: tagged group queries and the bot's answers, per group / room. Separate
 * from `messages` (DM context) by design; `/bug` commands, help texts and acks are never stored.
 */
export function createGroupContextRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO group_context (group_id, user_id, direction, text, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const recent = db.prepare(
    'SELECT * FROM (SELECT * FROM group_context WHERE group_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
  );

  return {
    insert(m: { groupId: string; userId?: string | null; direction: Direction; text: string }) {
      const r = insert.run(m.groupId, m.userId ?? null, m.direction, m.text, nowIso());
      return Number(r.lastInsertRowid);
    },
    /** Last `n` rows of the group, oldest first. */
    recent(groupId: string, n: number): GroupContextRow[] {
      return recent.all(groupId, n) as GroupContextRow[];
    },
  };
}

export type GroupContextRepo = ReturnType<typeof createGroupContextRepo>;
