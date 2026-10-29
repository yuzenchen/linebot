import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFeatureHandler, hashUserId } from '../../src/handlers/feature.js';
import { texts } from '../../src/texts.js';
import { harness, inbound, jobRows, silent } from './helpers.js';

describe('feature handler', () => {
  it('stores a hashed suggestion, enqueues summarize_suggestion and never pushes', async () => {
    const h = harness();
    const handle = createFeatureHandler({ repos: h.repos, jobs: h.jobs, log: silent });
    const ctx = inbound(h.repos, '希望可以用信用卡');
    const msgs = await handle(ctx);

    expect(msgs).toEqual([texts.featureThanks]);
    const rows = h.repos.suggestions.list();
    expect(rows).toHaveLength(1);
    const expectedHash = createHash('sha256').update('U1').digest('hex');
    expect(rows[0]).toMatchObject({
      user_hash: expectedHash,
      text: '希望可以用信用卡',
      status: 'new',
    });
    expect(rows[0].user_hash).not.toContain('U1');
    expect(hashUserId('U1')).toBe(expectedHash);

    const jobs = jobRows(h.db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe('summarize_suggestion');
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].payload).toEqual({
      suggestionId: rows[0].id,
      text: '希望可以用信用卡',
      userHash: expectedHash,
    });

    expect(h.api.pushMessage).not.toHaveBeenCalled();
    expect(h.api.replyMessage).not.toHaveBeenCalled();
    expect(h.repos.pushLog.countMonth()).toBe(0);
  });
});
