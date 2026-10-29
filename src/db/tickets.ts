import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export type TicketSource = 'grok_failed' | 'grok_timeout' | 'grok_unconfigured' | 'handoff';
export type TicketStatus = 'open' | 'answered' | 'closed';

export interface TicketRow {
  id: number;
  user_id: string;
  source: TicketSource;
  /** Customer text; follow-ups are appended as `\n---\n<text>`. */
  question: string;
  /** JSON array of the customer's recent inbound texts (masked), or null. */
  context: string | null;
  /** JSON array of order ids (`#YYYYMMDD-XXXXXXXX`), or null. */
  order_ids: string | null;
  grok_task_id: string | null;
  status: TicketStatus;
  answered_by: string | null;
  answer: string | null;
  answered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenTicketInput {
  userId: string;
  source: TicketSource;
  question: string;
  /** Stored as JSON; null / undefined keeps the existing context on append. */
  context?: unknown;
  orderIds?: string[];
  grokTaskId?: string;
}

/** Separator between the original question and appended follow-ups. */
export const QUESTION_SEPARATOR = '\n---\n';

/** SPEC-ADMIN §12.2 tickets: one `open` ticket per customer at a time. */
export function createTicketsRepo(db: Database) {
  const insert = db.prepare(
    "INSERT INTO tickets (user_id, source, question, context, order_ids, grok_task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)",
  );
  const get = db.prepare('SELECT * FROM tickets WHERE id = ?');
  const findOpen = db.prepare(
    "SELECT * FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
  );
  const findActive = db.prepare(
    "SELECT * FROM tickets WHERE user_id = ? AND status IN ('open', 'answered') ORDER BY id DESC LIMIT 1",
  );
  const listOpen = db.prepare(
    "SELECT * FROM tickets WHERE status = 'open' ORDER BY updated_at ASC, id ASC LIMIT ?",
  );
  const append = db.prepare(
    'UPDATE tickets SET question = question || ? || ?, context = COALESCE(?, context), order_ids = COALESCE(?, order_ids), updated_at = ? WHERE id = ?',
  );
  const markAnswered = db.prepare(
    "UPDATE tickets SET status = 'answered', answered_by = ?, answer = ?, answered_at = ?, updated_at = ? WHERE id = ?",
  );
  const close = db.prepare("UPDATE tickets SET status = 'closed', updated_at = ? WHERE id = ?");
  const autoClose = db.prepare(
    "UPDATE tickets SET status = 'closed', updated_at = ? WHERE status = 'answered' AND updated_at <= ?",
  );
  const recent = db.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT ?');

  function parseIds(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  return {
    /**
     * Opens a ticket, or appends `question` to the customer's existing `open` ticket (refreshing
     * context, merging order ids and bumping `updated_at`). `grokTaskId` is kept from the original.
     * Appending the text that is already the ticket's last segment (the same message reaching two
     * hook points) changes nothing: `appended: false`.
     */
    openOrAppend(t: OpenTicketInput): { ticket: TicketRow; created: boolean; appended: boolean } {
      const now = nowIso();
      const context =
        t.context === null || t.context === undefined ? null : JSON.stringify(t.context);
      const existing = findOpen.get(t.userId) as TicketRow | undefined;
      if (existing) {
        if (existing.question.split(QUESTION_SEPARATOR).at(-1) === t.question) {
          return { ticket: existing, created: false, appended: false };
        }
        const merged = [...new Set([...parseIds(existing.order_ids), ...(t.orderIds ?? [])])];
        append.run(
          QUESTION_SEPARATOR,
          t.question,
          context,
          merged.length > 0 ? JSON.stringify(merged) : null,
          now,
          existing.id,
        );
        return { ticket: get.get(existing.id) as TicketRow, created: false, appended: true };
      }
      const r = insert.run(
        t.userId,
        t.source,
        t.question,
        context,
        t.orderIds && t.orderIds.length > 0 ? JSON.stringify(t.orderIds) : null,
        t.grokTaskId ?? null,
        now,
        now,
      );
      return {
        ticket: get.get(Number(r.lastInsertRowid)) as TicketRow,
        created: true,
        appended: true,
      };
    },
    get(id: number): TicketRow | undefined {
      return get.get(id) as TicketRow | undefined;
    },
    /** The customer's `open` ticket, if any. */
    findOpenByUser(userId: string): TicketRow | undefined {
      return findOpen.get(userId) as TicketRow | undefined;
    },
    /** The customer's newest `open` or `answered` ticket, if any (§12.4 follow-up target). */
    findActiveByUser(userId: string): TicketRow | undefined {
      return findActive.get(userId) as TicketRow | undefined;
    },
    /** Open tickets, oldest activity first. */
    listOpen(limit = 10): TicketRow[] {
      return listOpen.all(limit) as TicketRow[];
    },
    markAnswered(id: number, a: { by: string; answer: string }): void {
      const now = nowIso();
      markAnswered.run(a.by, a.answer, now, now, id);
    },
    close(id: number): void {
      close.run(nowIso(), id);
    },
    /** Closes `answered` tickets idle for at least `olderThanMs`; returns how many. */
    autoClose(now: Date, olderThanMs: number): number {
      const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
      return Number(autoClose.run(nowIso(now), cutoff).changes);
    },
    /** Newest `n` tickets of the customer, newest first. */
    recentByUser(userId: string, n: number): TicketRow[] {
      return recent.all(userId, n) as TicketRow[];
    },
    /** Parsed `order_ids`. */
    orderIdsOf(t: Pick<TicketRow, 'order_ids'>): string[] {
      return parseIds(t.order_ids);
    },
  };
}

export type TicketsRepo = ReturnType<typeof createTicketsRepo>;
