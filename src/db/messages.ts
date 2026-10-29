import type { Database } from 'better-sqlite3';
import { now, nowIso } from './time.js';

export type Direction = 'in' | 'out';

export interface MessageRow {
  id: number;
  user_id: string;
  direction: Direction;
  type: string;
  text: string | null;
  reply_token: string | null;
  created_at: string;
}

export function createMessagesRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO messages (user_id, direction, type, text, reply_token, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const recent = db.prepare(
    'SELECT * FROM (SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY created_at ASC, id ASC',
  );
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?');

  return {
    insert(m: {
      userId: string;
      direction: Direction;
      type: string;
      text?: string | null;
      replyToken?: string | null;
    }): number {
      const r = insert.run(
        m.userId,
        m.direction,
        m.type,
        m.text ?? null,
        m.replyToken ?? null,
        nowIso(),
      );
      return Number(r.lastInsertRowid);
    },
    /** Last `n` messages of the user, oldest first. */
    recent(userId: string, n: number): MessageRow[] {
      return recent.all(userId, n) as MessageRow[];
    },
    /** Messages since 00:00 UTC of the day containing `at`. */
    countToday(at: Date = now()): number {
      const start = new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
      ).toISOString();
      return (countSince.get(start) as { n: number }).n;
    },
  };
}

export type MessagesRepo = ReturnType<typeof createMessagesRepo>;
