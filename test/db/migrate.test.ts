import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
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
  'schema_migrations',
];

describe('runMigrations', () => {
  it('creates every table and is idempotent', () => {
    const db = memoryDb(); // openDatabase already ran migrations once
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of expectedTables) expect(names).toContain(t);

    expect(runMigrations(db)).toBe(0);
    const rows = db.prepare('SELECT version, name FROM schema_migrations').all();
    expect(rows).toEqual([
      { version: 1, name: '001_init' },
      { version: 2, name: '002_grok_tasks' },
      { version: 3, name: '003_admin_queries' },
      { version: 4, name: '004_tickets' },
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
      ]),
    );
  });
});
