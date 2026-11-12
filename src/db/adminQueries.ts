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
  /** SPEC-ADMIN §16.5 (migration 009): images actually given to the model. */
  image_count: number;
  /** Token totals over every round of the query; null when the model was not called. */
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  /** Model that actually answered (differs from config on server-side fallback). */
  model: string | null;
}

/** Summed `usage` of one admin query (SPEC-ADMIN §16.5). */
export interface QueryUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** SPEC-ADMIN §4 step 6: one row per admin query (tool calls as JSON, masked reply, latency). */
export function createAdminQueriesRepo(db: Database) {
  const insert = db.prepare(
    'INSERT INTO admin_queries (user_id, text, tools, reply, pii_revealed, latency_ms, created_at, image_count, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      /** Model queries only (§16.5); intercepted commands leave these out. */
      imageCount?: number;
      usage?: QueryUsage;
      model?: string;
    }): number {
      const r = insert.run(
        q.userId,
        q.text,
        q.tools,
        q.reply,
        q.piiRevealed ? 1 : 0,
        Math.round(q.latencyMs),
        nowIso(),
        q.imageCount ?? 0,
        q.usage?.inputTokens ?? null,
        q.usage?.cacheReadTokens ?? null,
        q.usage?.cacheWriteTokens ?? null,
        q.usage?.outputTokens ?? null,
        q.model ?? null,
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
