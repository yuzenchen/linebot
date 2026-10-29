import { describe, expect, it } from 'vitest';
import { buildSystemBlocks } from '../../src/classifier/prompt.js';
import { categories } from '../../src/classifier/types.js';

describe('buildSystemBlocks', () => {
  it('block 1 names every category', () => {
    const [rules] = buildSystemBlocks('kb');
    for (const cat of categories) expect(rules.text).toContain(cat);
    expect(rules.cache_control).toBeUndefined();
  });

  it('block 1 is stable across calls; block 2 carries the knowledge with cache_control', () => {
    const a = buildSystemBlocks('A');
    const b = buildSystemBlocks('B');
    expect(a[0].text).toBe(b[0].text);
    expect(a[1].text).toBe('今日知識庫：\nA');
    expect(a[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});
