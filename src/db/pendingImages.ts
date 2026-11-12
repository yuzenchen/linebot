import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export type ContentProviderType = 'line' | 'external';

export interface PendingImageRow {
  id: number;
  user_id: string;
  /** `dm`, or the groupId / roomId. */
  conversation: string;
  line_message_id: string;
  content_provider: ContentProviderType;
  created_at: string;
}

/**
 * SPEC-ADMIN §16: images an admin sent before asking about them. Only LINE message ids are stored;
 * the image is downloaded when the next model-bound text from the same user in the same
 * conversation consumes them. Expiry and the per-conversation cap are passed in by the caller.
 */
export function createPendingImagesRepo(db: Database) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO pending_images (user_id, conversation, line_message_id, content_provider, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  // Keeps only the newest `keep` rows of one user + conversation.
  const trim = db.prepare(
    'DELETE FROM pending_images WHERE user_id = ? AND conversation = ? AND id NOT IN (SELECT id FROM pending_images WHERE user_id = ? AND conversation = ? ORDER BY id DESC LIMIT ?)',
  );
  const newest = db.prepare(
    'SELECT created_at FROM pending_images WHERE user_id = ? AND conversation = ? ORDER BY id DESC LIMIT 1',
  );
  const select = db.prepare(
    'SELECT * FROM (SELECT * FROM pending_images WHERE user_id = ? AND conversation = ? AND created_at > ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
  );
  const delConv = db.prepare('DELETE FROM pending_images WHERE user_id = ? AND conversation = ?');
  const delExpired = db.prepare('DELETE FROM pending_images WHERE created_at <= ?');

  const cutoff = (now: Date, ttlMs: number) => new Date(now.getTime() - ttlMs).toISOString();

  return {
    /** Records one image and drops this user + conversation's older rows beyond `keep`. */
    add(p: {
      userId: string;
      conversation: string;
      lineMessageId: string;
      contentProvider: ContentProviderType;
      now: Date;
      keep: number;
    }): void {
      db.transaction(() => {
        insert.run(p.userId, p.conversation, p.lineMessageId, p.contentProvider, nowIso(p.now));
        trim.run(p.userId, p.conversation, p.userId, p.conversation, p.keep);
      })();
    },
    /** `created_at` of this user + conversation's newest row (expired or not), or null. */
    newestAt(userId: string, conversation: string): Date | null {
      const row = newest.get(userId, conversation) as { created_at: string } | undefined;
      return row ? new Date(row.created_at) : null;
    },
    /**
     * Removes and returns this user + conversation's images younger than `ttlMs` (at most `limit`,
     * the newest ones, oldest first). Every row of the pair is deleted, expired ones included, and
     * expired rows of everyone else are purged too.
     */
    take(userId: string, conversation: string, now: Date, ttlMs: number, limit: number) {
      return db.transaction(() => {
        const rows = select.all(
          userId,
          conversation,
          cutoff(now, ttlMs),
          limit,
        ) as PendingImageRow[];
        delConv.run(userId, conversation);
        delExpired.run(cutoff(now, ttlMs));
        return rows;
      })();
    },
    /** Deletes rows older than `ttlMs`; returns how many. */
    purgeExpired(now: Date, ttlMs: number): number {
      return delExpired.run(cutoff(now, ttlMs)).changes;
    },
  };
}

export type PendingImagesRepo = ReturnType<typeof createPendingImagesRepo>;
