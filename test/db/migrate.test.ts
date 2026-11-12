import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations/index.js';
import { memoryDb } from './helpers.js';

const expectedTables = [
  'events',
  'users',
  'messages',
  'classifications',
  'incidents',
  'suggestions',
  'jobs',
  'push_log',
  'grok_tasks',
  'admin_queries',
  'tickets',
  'pending_confirmations',
  'bug_reports',
  'group_context',
  'employees',
  'wage_rates',
  'shifts',
  'correction_requests',
  'payroll_runs',
  'audit_log',
  'pending_images',
  'staff_reminders',
  'staff_backups',
  'schema_migrations',
];

describe('runMigrations', () => {
  it('creates every table and is idempotent', () => {
    const db = memoryDb(); // openDatabase already ran migrations once
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of expectedTables) expect(names).toContain(t);
    expect(names).not.toContain('correction_requests_new');

    expect(runMigrations(db)).toBe(0);
    const rows = db.prepare('SELECT version, name FROM schema_migrations').all();
    expect(rows).toEqual([
      { version: 1, name: '001_init' },
      { version: 2, name: '002_grok_tasks' },
      { version: 3, name: '003_admin_queries' },
      { version: 4, name: '004_tickets' },
      { version: 5, name: '005_pending_confirmations' },
      { version: 6, name: '006_bug_reports' },
      { version: 7, name: '007_group_context' },
      { version: 8, name: '008_staff' },
      { version: 9, name: '009_pending_images' },
      { version: 10, name: '010_staff_corrections' },
      { version: 11, name: '011_staff_backups' },
    ]);
  });

  it('creates the expected indexes', () => {
    const db = memoryDb();
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_messages_user_created',
        'idx_jobs_status_run_after',
        'idx_push_log_created',
        'idx_incidents_status_created',
        'idx_grok_tasks_status_expires',
        'idx_admin_queries_user_created',
        'idx_tickets_user_status',
        'idx_tickets_status_updated',
        'idx_bug_reports_reporter_created',
        'idx_group_context_group',
        'idx_pending_images_user_conv',
        'idx_employees_status',
        'idx_wage_rates_employee_from',
        'idx_shifts_employee_start',
        'idx_shifts_start',
        'idx_correction_requests_status',
        'idx_correction_requests_employee',
        'idx_payroll_runs_month',
        'idx_audit_log_created',
        'idx_staff_backups_date',
      ]),
    );
  });
});

describe('migration 010 (correction_requests rebuild)', () => {
  /** A database migrated only up to `version`, the way an older deployment left it. */
  function dbAt(version: number) {
    const db = new BetterSqlite3(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)',
    );
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );
    for (const m of migrations.filter((x) => x.version <= version)) {
      db.exec(m.sql);
      record.run(m.version, m.name, '2026-11-01T00:00:00.000Z');
    }
    return db;
  }

  it('keeps every existing row, its id and the AUTOINCREMENT high-water mark', () => {
    const db = dbAt(9);
    db.prepare(
      "INSERT INTO employees (id, user_id, name, status, created_at) VALUES (1, 'Ua', '王小明', 'active', 'c')",
    ).run();
    const insert = db.prepare(
      'INSERT INTO correction_requests (id, employee_id, kind, at, status, reason, requested_by, group_id, shift_id, created_at, decided_by, decided_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(1, 'in', 'a1', 'approved', null, 'Ua', 'Cg', 7, 'c1', 'Uadmin', 'd1');
    insert.run(2, 'out', 'a2', 'failed', 'noOpenShift', 'Ua', null, null, 'c2', 'Uadmin', 'd2');
    insert.run(5, 'out', 'a5', 'pending', null, 'Ua', 'Cg', null, 'c5', null, null);
    // R006 existed once and is gone: its id must not be handed out again.
    insert.run(6, 'in', 'a6', 'pending', null, 'Ua', null, null, 'c6', null, null);
    db.prepare('DELETE FROM correction_requests WHERE id = 6').run();
    const before = db.prepare('SELECT * FROM correction_requests ORDER BY id').all() as Record<
      string,
      unknown
    >[];

    expect(runMigrations(db)).toBe(2); // 010 and 011

    const after = db.prepare('SELECT * FROM correction_requests ORDER BY id').all();
    expect(after).toEqual(before.map((r) => ({ ...r, end_at: null })));
    const next = db
      .prepare(
        "INSERT INTO correction_requests (employee_id, kind, at, end_at, status, created_at) VALUES (1, 'shift', 's', 'e', 'pending', 'c')",
      )
      .run();
    expect(Number(next.lastInsertRowid)).toBe(7);
    db.prepare("UPDATE correction_requests SET status = 'cancelled' WHERE id = 5").run();

    // New CHECK values are accepted above; unknown ones are still rejected.
    expect(() =>
      db
        .prepare(
          "INSERT INTO correction_requests (employee_id, kind, at, status) VALUES (1, 'lunch', 'x', 'pending')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("UPDATE correction_requests SET status = 'gone' WHERE id = 1").run(),
    ).toThrow(/CHECK/);
    // The foreign key to employees survives the rebuild.
    expect(() =>
      db
        .prepare(
          "INSERT INTO correction_requests (employee_id, kind, at, status) VALUES (99, 'in', 'x', 'pending')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);

    const idx = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'correction_requests'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_correction_requests_status',
        'idx_correction_requests_employee',
      ]),
    );
    expect(
      db.prepare("SELECT name FROM sqlite_sequence WHERE name LIKE 'correction%'").all(),
    ).toEqual([{ name: 'correction_requests' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('migrates an empty table and creates staff_reminders keyed by date', () => {
    const db = dbAt(9);
    expect(runMigrations(db)).toBe(2); // 010 and 011
    db.prepare(
      "INSERT INTO employees (id, user_id, name, status) VALUES (1, 'Ua', '王小明', 'active')",
    ).run();
    const first = db
      .prepare(
        "INSERT INTO correction_requests (employee_id, kind, at, status) VALUES (1, 'in', 'x', 'pending')",
      )
      .run();
    expect(Number(first.lastInsertRowid)).toBe(1);
    db.prepare('INSERT INTO staff_reminders (date, sent_at, content_json) VALUES (?, ?, ?)').run(
      '2026-11-12',
      null,
      '{}',
    );
    expect(() =>
      db.prepare("INSERT INTO staff_reminders (date) VALUES ('2026-11-12')").run(),
    ).toThrow(/UNIQUE/);
  });
});

describe('migration 011 (staff_backups)', () => {
  it('adds staff_backups to a database at version 10', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)',
    );
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );
    for (const m of migrations.filter((x) => x.version <= 10)) {
      db.exec(m.sql);
      record.run(m.version, m.name, '2026-11-01T00:00:00.000Z');
    }
    expect(runMigrations(db)).toBe(1);
    const cols = (db.prepare('PRAGMA table_info(staff_backups)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual([
      'id',
      'date',
      'triggered_by',
      'started_at',
      'finished_at',
      'ok',
      'error',
      'counts_json',
    ]);
    const r = db
      .prepare('INSERT INTO staff_backups (date, triggered_by, started_at) VALUES (?, ?, ?)')
      .run(null, 'Uadmin', '2026-12-01T01:00:00.000Z');
    expect(Number(r.lastInsertRowid)).toBe(1);
  });
});
