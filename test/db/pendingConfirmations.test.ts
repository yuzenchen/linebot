import { describe, expect, it } from 'vitest';
import { createPendingConfirmationsRepo } from '../../src/db/pendingConfirmations.js';
import { memoryDb } from './helpers.js';

const T0 = new Date('2026-10-30T06:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('pending_confirmations repo', () => {
  it('set / get / clear; a new item replaces the old one', () => {
    const repo = createPendingConfirmationsRepo(memoryDb());
    expect(repo.get('Ua', T0)).toBeNull();
    repo.set({ adminUserId: 'Ua', ticketId: 1, text: '已出貨', now: T0, ttlMs: 600_000 });
    expect(repo.get('Ua', T0)).toMatchObject({
      admin_user_id: 'Ua',
      ticket_id: 1,
      text: '已出貨',
      created_at: '2026-10-30T06:00:00.000Z',
      expires_at: '2026-10-30T06:10:00.000Z',
    });
    repo.set({ adminUserId: 'Ua', ticketId: 2, text: '改', now: later(1000), ttlMs: 600_000 });
    expect(repo.get('Ua', T0)).toMatchObject({ ticket_id: 2, text: '改' });
    repo.clear('Ua');
    expect(repo.get('Ua', T0)).toBeNull();
    repo.clear('Ua'); // no-op
  });

  it('expired items read as null and are deleted; admins are independent', () => {
    const db = memoryDb();
    const repo = createPendingConfirmationsRepo(db);
    repo.set({ adminUserId: 'Ua', ticketId: 1, text: 'a', now: T0, ttlMs: 600_000 });
    repo.set({ adminUserId: 'Ub', ticketId: 2, text: 'b', now: T0, ttlMs: 600_000 });
    expect(repo.get('Ua', later(599_999))).not.toBeNull();
    expect(repo.get('Ua', later(600_000))).toBeNull();
    expect(db.prepare('SELECT admin_user_id FROM pending_confirmations').all()).toEqual([
      { admin_user_id: 'Ub' },
    ]);
    expect(repo.get('Ub', T0)).toMatchObject({ ticket_id: 2 });
  });
});
