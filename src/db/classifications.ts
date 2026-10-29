import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export interface NewClassification {
  messageId: number;
  category: string;
  confidence: number;
  reason?: string | null;
  /** 'anthropic' | 'rule' */
  classifier: string;
  latencyMs?: number | null;
}

export function createClassificationsRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO classifications (message_id, category, confidence, reason, classifier, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  return {
    insert(c: NewClassification): number {
      const r = insert.run(
        c.messageId,
        c.category,
        c.confidence,
        c.reason ?? null,
        c.classifier,
        c.latencyMs ?? null,
        nowIso(),
      );
      return Number(r.lastInsertRowid);
    },
  };
}

export type ClassificationsRepo = ReturnType<typeof createClassificationsRepo>;
