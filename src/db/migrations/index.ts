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

const tickets = `
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  source TEXT CHECK (source IN ('grok_failed', 'grok_timeout', 'grok_unconfigured', 'handoff')),
  question TEXT,
  context TEXT,
  order_ids TEXT,
  grok_task_id TEXT,
  status TEXT CHECK (status IN ('open', 'answered', 'closed')) DEFAULT 'open',
  answered_by TEXT,
  answer TEXT,
  answered_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_user_status ON tickets (user_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_status_updated ON tickets (status, updated_at);
`;

const pendingConfirmations = `
CREATE TABLE IF NOT EXISTS pending_confirmations (
  admin_user_id TEXT PRIMARY KEY,
  ticket_id INTEGER,
  text TEXT,
  created_at TEXT,
  expires_at TEXT
);
`;

/** SPEC-ADMIN §13: website bugs reported by tagging the admin bot in a group. */
const bugReports = `
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_user_id TEXT,
  group_id TEXT,
  description TEXT,
  health_raw TEXT,
  grok_task_id TEXT,
  status TEXT CHECK (status IN ('queued', 'sent', 'received', 'processing', 'done', 'failed', 'expired')) DEFAULT 'queued',
  last_text TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bug_reports_reporter_created ON bug_reports (reporter_user_id, created_at);
`;

/**
 * SPEC-ADMIN §14.3 step 4: per-group context for tagged queries (the stripped query in, the bot's
 * answer out). Kept apart from `messages` so DM context, `/bug` commands and acks never mix in.
 */
const groupContext = `
CREATE TABLE IF NOT EXISTS group_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  user_id TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_group_context_group ON group_context (group_id, id);
`;

/**
 * SPEC-STAFF §10: punch clock and payroll. Created in every profile's DB, used only by `staff`.
 * Timestamps are ISO-8601 UTC; `effective_from` is a Taipei calendar date (`YYYY-MM-DD`).
 * Nothing here is physically deleted except rejected registrations (shifts are soft-deleted).
 */
const staff = `
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  group_id TEXT,
  created_at TEXT,
  approved_at TEXT,
  approved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (status);

CREATE TABLE IF NOT EXISTS wage_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  hourly_wage INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wage_rates_employee_from ON wage_rates (employee_id, effective_from);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  start_at TEXT NOT NULL,
  end_at TEXT,
  start_source TEXT NOT NULL CHECK (start_source IN ('punch', 'correction', 'admin')),
  end_source TEXT CHECK (end_source IN ('punch', 'correction', 'admin')),
  overdue INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee_start ON shifts (employee_id, start_at);
CREATE INDEX IF NOT EXISTS idx_shifts_start ON shifts (start_at);

CREATE TABLE IF NOT EXISTS correction_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees (id),
  kind TEXT NOT NULL CHECK (kind IN ('in', 'out')),
  at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'failed')) DEFAULT 'pending',
  reason TEXT,
  requested_by TEXT,
  group_id TEXT,
  shift_id INTEGER,
  created_at TEXT,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_correction_requests_status ON correction_requests (status, id);
CREATE INDEX IF NOT EXISTS idx_correction_requests_employee ON correction_requests (employee_id, status);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  run_at TEXT,
  triggered_by TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_month ON payroll_runs (month, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
`;

/**
 * SPEC-ADMIN §16: images waiting for the sender's next model-bound text (LINE message id only, the
 * image itself is never stored) and per-query usage columns on `admin_queries` (§16.5).
 * `conversation` is `dm` or the groupId / roomId. `content_provider` is LINE's `contentProvider.type`
 * (`external` images cannot be downloaded and count as unreadable).
 */
const pendingImages = `
CREATE TABLE IF NOT EXISTS pending_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conversation TEXT NOT NULL,
  line_message_id TEXT NOT NULL UNIQUE,
  content_provider TEXT NOT NULL DEFAULT 'line',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_images_user_conv ON pending_images (user_id, conversation, id);
CREATE INDEX IF NOT EXISTS idx_pending_images_created ON pending_images (created_at);

ALTER TABLE admin_queries ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_queries ADD COLUMN input_tokens INTEGER;
ALTER TABLE admin_queries ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE admin_queries ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE admin_queries ADD COLUMN output_tokens INTEGER;
ALTER TABLE admin_queries ADD COLUMN model TEXT;
`;

export const migrations: Migration[] = [
  { version: 1, name: '001_init', sql: init },
  { version: 2, name: '002_grok_tasks', sql: grokTasks },
  { version: 3, name: '003_admin_queries', sql: adminQueries },
  { version: 4, name: '004_tickets', sql: tickets },
  { version: 5, name: '005_pending_confirmations', sql: pendingConfirmations },
  { version: 6, name: '006_bug_reports', sql: bugReports },
  { version: 7, name: '007_group_context', sql: groupContext },
  { version: 8, name: '008_staff', sql: staff },
  { version: 9, name: '009_pending_images', sql: pendingImages },
];
