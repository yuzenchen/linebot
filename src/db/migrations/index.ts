/**
 * Migrations are embedded as strings (not `.sql` files) so `tsc` output and the Docker image
 * need no extra copy step. Append new entries; never edit an applied one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const init = `
CREATE TABLE IF NOT EXISTS events (
  webhook_event_id TEXT PRIMARY KEY,
  type TEXT,
  user_id TEXT,
  received_at TEXT,
  raw TEXT
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  followed INTEGER DEFAULT 1,
  handoff_until TEXT,
  low_conf_streak INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  type TEXT,
  text TEXT,
  reply_token TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages (user_id, created_at);

CREATE TABLE IF NOT EXISTS classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES messages (id),
  category TEXT,
  confidence REAL,
  reason TEXT,
  classifier TEXT,
  latency_ms INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  text TEXT,
  health_status TEXT,
  health_raw TEXT,
  admin_notified INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_status_created ON incidents (health_status, created_at);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_hash TEXT,
  text TEXT,
  title TEXT,
  summary TEXT,
  category TEXT,
  merged_into INTEGER,
  status TEXT DEFAULT 'new',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  payload TEXT,
  status TEXT CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')) DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  run_after TEXT,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_after ON jobs (status, run_after);

CREATE TABLE IF NOT EXISTS push_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  reason TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log (created_at);
`;

const grokTasks = `
CREATE TABLE IF NOT EXISTS grok_tasks (
  id TEXT PRIMARY KEY,
  job_id INTEGER,
  type TEXT,
  user_id TEXT,
  payload TEXT,
  status TEXT CHECK (status IN ('sent', 'received', 'processing', 'done', 'failed', 'expired')) DEFAULT 'sent',
  last_text TEXT,
  callbacks INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_grok_tasks_status_expires ON grok_tasks (status, expires_at);
`;

const adminQueries = `
CREATE TABLE IF NOT EXISTS admin_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  text TEXT,
  tools TEXT,
  reply TEXT,
  pii_revealed INTEGER DEFAULT 0,
  latency_ms INTEGER,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_queries_user_created ON admin_queries (user_id, created_at);
`;

export const migrations: Migration[] = [
  { version: 1, name: '001_init', sql: init },
  { version: 2, name: '002_grok_tasks', sql: grokTasks },
  { version: 3, name: '003_admin_queries', sql: adminQueries },
];
