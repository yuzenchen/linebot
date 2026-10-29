import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export interface AdminQueryRow {
  id: number;
  user_id: string;
  text: string | null;
  tools: string | null;
  reply: string | null;
  pii_revealed: number;
  latency_ms: number | null;
  created_at: string;
}

/** SPEC-ADMIN §4 step 6: one row per admin query (tool calls as JSON, masked reply, latency). */
export function createAdminQueriesRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO admin_queries (user_id, text, tools, reply, pii_revealed, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const recent = db.prepare('SELECT * FROM admin_queries ORDER BY id DESC LIMIT ?');

  return {
    insert(q: {
      userId: string;
      text: string;
      tools: string;
      reply: string;
      piiRevealed: boolean;
      latencyMs: number;
    }): number {
      const r = insert.run(
        q.userId,
        q.text,
        q.tools,
        q.reply,
        q.piiRevealed ? 1 : 0,
        Math.round(q.latencyMs),
        nowIso(),
      );
      return Number(r.lastInsertRowid);
    },
    /** Newest first (tests / CLI). */
    recent(n: number): AdminQueryRow[] {
      return recent.all(n) as AdminQueryRow[];
    },
  };
}

export type AdminQueriesRepo = ReturnType<typeof createAdminQueriesRepo>;
