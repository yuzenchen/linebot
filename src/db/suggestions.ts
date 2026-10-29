import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export interface SuggestionRow {
  id: number;
  user_hash: string;
  text: string;
  title: string | null;
  summary: string | null;
  category: string | null;
  merged_into: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function createSuggestionsRepo(db: Database) {
  const insert = db.prepare(
    "INSERT INTO suggestions (user_hash, text, status, created_at, updated_at) VALUES (?, ?, 'new', ?, ?)",
  );
  const update = db.prepare(
    'UPDATE suggestions SET title = ?, summary = ?, category = ?, merged_into = ?, status = ?, updated_at = ? WHERE id = ?',
  );
  const list = db.prepare('SELECT * FROM suggestions ORDER BY id ASC');
  const listTitles = db.prepare(
    'SELECT id, title FROM suggestions WHERE title IS NOT NULL ORDER BY id ASC',
  );

  return {
    insert(s: { userHash: string; text: string }): number {
      const t = nowIso();
      return Number(insert.run(s.userHash, s.text, t, t).lastInsertRowid);
    },
    updateSummary(
      id: number,
      s: {
        title: string;
        summary: string;
        category: string;
        mergedInto?: number | null;
        status: string;
      },
    ): void {
      update.run(s.title, s.summary, s.category, s.mergedInto ?? null, s.status, nowIso(), id);
    },
    list(): SuggestionRow[] {
      return list.all() as SuggestionRow[];
    },
    listTitles(): { id: number; title: string }[] {
      return listTitles.all() as { id: number; title: string }[];
    },
  };
}

export type SuggestionsRepo = ReturnType<typeof createSuggestionsRepo>;
