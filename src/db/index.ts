import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { runMigrations } from './migrate.js';

export type { Database };

/** Pass as `dataDir` to get an in-memory database (tests). */
export const MEMORY = ':memory:';

export function openDatabase(dataDir: string = config.DATA_DIR): Database {
  let file: string;
  if (dataDir === MEMORY) {
    file = MEMORY;
  } else {
    mkdirSync(dataDir, { recursive: true });
    file = join(dataDir, 'linebot.db');
  }
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  if (file !== MEMORY) logger.info({ file }, 'database opened');
  return db;
}

let singleton: Database | undefined;

export function getDb(): Database {
  singleton ??= openDatabase();
  return singleton;
}

export function closeDb(): void {
  if (!singleton) return;
  singleton.close();
  singleton = undefined;
}
