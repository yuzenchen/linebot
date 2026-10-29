import { afterEach, describe, expect, it } from 'vitest';
import { createRepos } from '../../src/db/repos.js';
import { resetClock, setClock } from '../../src/db/time.js';
import { memoryDb } from './helpers.js';

afterEach(() => resetClock());

describe('messages.statsByUser', () => {
  it('counts per user and returns latest time, newest user first', () => {
    const { messages } = createRepos(memoryDb());
    expect(messages.statsByUser()).toEqual([]);
    const at = (iso: string) => setClock(() => new Date(iso));
    at('2026-01-01T00:00:00.000Z');
    messages.insert({ userId: 'U1', direction: 'in', type: 'text', text: 'a' });
    at('2026-01-02T00:00:00.000Z');
    messages.insert({ userId: 'U2', direction: 'in', type: 'text', text: 'b' });
    at('2026-01-03T00:00:00.000Z');
    messages.insert({ userId: 'U1', direction: 'out', type: 'text', text: 'c' });
    expect(messages.statsByUser()).toEqual([
      { userId: 'U1', count: 2, lastAt: '2026-01-03T00:00:00.000Z' },
      { userId: 'U2', count: 1, lastAt: '2026-01-02T00:00:00.000Z' },
    ]);
  });
});
