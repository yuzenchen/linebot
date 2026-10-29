import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export interface PendingConfirmationRow {
  admin_user_id: string;
  ticket_id: number;
  text: string;
  created_at: string;
  expires_at: string;
}

/**
 * SPEC-ADMIN §12.3 (T16): a staged customer reply waiting for the admin's `Y`. One per admin;
 * `set` replaces any older one.
 */
export function createPendingConfirmationsRepo(db: Database) {
  const upsert = db.prepare(
    'INSERT INTO pending_confirmations (admin_user_id, ticket_id, text, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (admin_user_id) DO UPDATE SET ticket_id = excluded.ticket_id, text = excluded.text, created_at = excluded.created_at, expires_at = excluded.expires_at',
  );
  const select = db.prepare('SELECT * FROM pending_confirmations WHERE admin_user_id = ?');
  const del = db.prepare('DELETE FROM pending_confirmations WHERE admin_user_id = ?');

  return {
    set(p: {
      adminUserId: string;
      ticketId: number;
      text: string;
      now: Date;
      ttlMs: number;
    }): void {
      upsert.run(
        p.adminUserId,
        p.ticketId,
        p.text,
        nowIso(p.now),
        new Date(p.now.getTime() + p.ttlMs).toISOString(),
      );
    },
    /** The admin's pending item, or null; an expired one is deleted and reported as null. */
    get(adminUserId: string, now: Date): PendingConfirmationRow | null {
      const row = select.get(adminUserId) as PendingConfirmationRow | undefined;
      if (!row) return null;
      if (row.expires_at <= now.toISOString()) {
        del.run(adminUserId);
        return null;
      }
      return row;
    },
    clear(adminUserId: string): void {
      del.run(adminUserId);
    },
  };
}

export type PendingConfirmationsRepo = ReturnType<typeof createPendingConfirmationsRepo>;
