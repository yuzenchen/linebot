import type { Database } from 'better-sqlite3';
import { nowIso } from './time.js';

export interface UserRow {
  user_id: string;
  display_name: string | null;
  followed: number;
  handoff_until: string | null;
  low_conf_streak: number;
  created_at: string;
  updated_at: string;
}

export type UserListRow = UserRow & { last_message_at: string | null };

export function createUsersRepo(db: Database) {
  const upsert = db.prepare(`
    INSERT INTO users (user_id, display_name, followed, low_conf_streak, created_at, updated_at)
    VALUES (@userId, @displayName, 1, 0, @now, @now)
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, users.display_name),
      followed = 1,
      updated_at = excluded.updated_at`);
  const get = db.prepare('SELECT * FROM users WHERE user_id = ?');
  const setFollowed = db.prepare('UPDATE users SET followed = ?, updated_at = ? WHERE user_id = ?');
  const setHandoff = db.prepare(
    'UPDATE users SET handoff_until = ?, updated_at = ? WHERE user_id = ?',
  );
  const incLowConf = db.prepare(
    'UPDATE users SET low_conf_streak = low_conf_streak + 1, updated_at = ? WHERE user_id = ? RETURNING low_conf_streak',
  );
  const resetLowConf = db.prepare(
    'UPDATE users SET low_conf_streak = 0, updated_at = ? WHERE user_id = ?',
  );
  const list = db.prepare(`
    SELECT u.*, (SELECT MAX(created_at) FROM messages m WHERE m.user_id = u.user_id) AS last_message_at
    FROM users u ORDER BY last_message_at DESC`);

  return {
    /** Creates the user or marks an existing one followed again (keeps display_name if omitted). */
    upsert(u: { userId: string; displayName?: string | null }): void {
      upsert.run({ userId: u.userId, displayName: u.displayName ?? null, now: nowIso() });
    },
    get(userId: string): UserRow | undefined {
      return get.get(userId) as UserRow | undefined;
    },
    setFollowed(userId: string, followed: boolean): void {
      setFollowed.run(followed ? 1 : 0, nowIso(), userId);
    },
    setHandoffUntil(userId: string, iso: string | null): void {
      setHandoff.run(iso, nowIso(), userId);
    },
    /** Returns the new streak (0 if the user does not exist). */
    incrementLowConf(userId: string): number {
      const row = incLowConf.get(nowIso(), userId) as { low_conf_streak: number } | undefined;
      return row?.low_conf_streak ?? 0;
    },
    resetLowConf(userId: string): void {
      resetLowConf.run(nowIso(), userId);
    },
    list(): UserListRow[] {
      return list.all() as UserListRow[];
    },
  };
}

export type UsersRepo = ReturnType<typeof createUsersRepo>;
