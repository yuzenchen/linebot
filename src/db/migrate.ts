import type { Database } from 'better-sqlite3';
import { logger } from '../logger.js';
import { migrations } from './migrations/index.js';
import { nowIso } from './time.js';

/** Applies every unapplied migration in version order, each in a transaction. Idempotent. */
export function runMigrations(db: Database): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  let count = 0;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, nowIso());
    })();
    logger.info({ version: m.version, name: m.name }, 'migration applied');
    count += 1;
  }
  return count;
}
