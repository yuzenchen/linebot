import { afterEach, describe, expect, it } from 'vitest';
import { loadKnowledge, resetKnowledgeCache } from '../../src/classifier/knowledge.js';

describe('loadKnowledge', () => {
  afterEach(() => resetKnowledgeCache());

  it('loads the real knowledge dir sorted, without welcome.md', () => {
    const kb = loadKnowledge();
    expect(kb.files.length).toBeGreaterThan(0);
    expect(kb.files).toEqual([...kb.files].sort());
    expect(kb.files).not.toContain('welcome.md');
    expect(kb.files[0]).toBe('00-about.md');
    expect(kb.text).toContain('## 00-about.md');
    expect(kb.text.indexOf('## 00-about.md')).toBeLessThan(kb.text.indexOf('## 90-tone.md'));
  });

  it('caches after first load', () => {
    expect(loadKnowledge()).toBe(loadKnowledge());
  });

  it('contains no URLs', () => {
    expect(loadKnowledge().text).not.toMatch(/https?:\/\//);
  });
});
