import { describe, expect, it } from 'vitest';
import { displayBugId } from '../../src/bugs/ids.js';
import { createBugReportsRepo } from '../../src/db/bugReports.js';
import { memoryDb } from './helpers.js';

const T0 = new Date('2026-11-02T08:00:00.000Z');

describe('displayBugId', () => {
  it('pads to three digits', () => {
    expect(displayBugId(1)).toBe('B001');
    expect(displayBugId(42)).toBe('B042');
    expect(displayBugId(1234)).toBe('B1234');
  });
});

describe('bug_reports repo', () => {
  it('inserts, links a grok task, moves status and finds recent duplicates', () => {
    const repo = createBugReportsRepo(memoryDb());
    const id = repo.insert(
      { reporterUserId: 'U1', groupId: 'C1', description: '壞了', health: { status: 'down' } },
      T0,
    );
    expect(repo.get(id)).toMatchObject({
      reporter_user_id: 'U1',
      group_id: 'C1',
      description: '壞了',
      health_raw: JSON.stringify({ status: 'down' }),
      grok_task_id: null,
      status: 'queued',
      created_at: T0.toISOString(),
    });
    repo.setGrokTask(id, 'task-1');
    repo.setStatus(id, 'processing', '查詢中');
    repo.setStatus(id, 'done');
    expect(repo.get(id)).toMatchObject({
      grok_task_id: 'task-1',
      status: 'done',
      last_text: '查詢中',
    });

    const at = (ms: number) => new Date(T0.getTime() + ms);
    expect(repo.findRecentDuplicate('U1', '壞了', 60_000, at(60_000))?.id).toBe(id);
    expect(repo.findRecentDuplicate('U1', '壞了', 60_000, at(60_001))).toBeUndefined();
    expect(repo.findRecentDuplicate('U2', '壞了', 60_000, at(1))).toBeUndefined();
    expect(repo.findRecentDuplicate('U1', '別的', 60_000, at(1))).toBeUndefined();
  });

  it('rejects an unknown status', () => {
    const db = memoryDb();
    const repo = createBugReportsRepo(db);
    const id = repo.insert({ reporterUserId: 'U1', groupId: 'C1', description: 'x' }, T0);
    expect(() => repo.setStatus(id, 'bogus' as never)).toThrow();
  });
});
