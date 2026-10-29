import { afterEach, describe, expect, it } from 'vitest';
import { createAdminQueriesRepo } from '../../src/db/adminQueries.js';
import { resetClock, setClock } from '../../src/db/time.js';
import { memoryDb } from './helpers.js';

afterEach(() => resetClock());

describe('admin_queries repo', () => {
  it('inserts with 0/1 pii flag and ISO created_at; recent() is newest first', () => {
    setClock(() => new Date('2026-10-30T06:05:00.000Z'));
    const repo = createAdminQueriesRepo(memoryDb());
    const a = repo.insert({
      userId: 'Uadmin',
      text: '今天幾筆',
      tools: '[]',
      reply: '今天 3 筆',
      piiRevealed: false,
      latencyMs: 1234.6,
    });
    const b = repo.insert({
      userId: 'Uadmin',
      text: '完整電話',
      tools: '[{"name":"get_order"}]',
      reply: '（placeholder）',
      piiRevealed: true,
      latencyMs: 10,
    });
    expect(b).toBe(a + 1);
    const rows = repo.recent(5);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows[1]).toMatchObject({
      user_id: 'Uadmin',
      text: '今天幾筆',
      tools: '[]',
      reply: '今天 3 筆',
      pii_revealed: 0,
      latency_ms: 1235,
      created_at: '2026-10-30T06:05:00.000Z',
    });
    expect(rows[0].pii_revealed).toBe(1);
    expect(repo.recent(1)).toHaveLength(1);
  });
});
