import { describe, expect, it } from 'vitest';
import { renderSuggestionsMarkdown } from '../../src/cli/render.js';
import type { SuggestionRow } from '../../src/db/suggestions.js';

const row = (id: number, created_at: string, text: string): SuggestionRow => ({
  id,
  user_hash: 'h',
  text,
  title: null,
  summary: null,
  category: null,
  merged_into: null,
  status: 'new',
  created_at,
  updated_at: created_at,
});

describe('renderSuggestionsMarkdown', () => {
  it('empty → placeholder line', () => {
    const md = renderSuggestionsMarkdown([], '2026-10-29');
    expect(md).toContain('# 需求建議匯出（2026-10-29）');
    expect(md).toContain('目前沒有需求建議');
    expect(md).not.toContain('| id |');
  });

  it('escapes pipes and newlines and sorts newest first', () => {
    const md = renderSuggestionsMarkdown(
      [row(1, '2026-01-01T00:00:00.000Z', 'a|b\nc'), row(2, '2026-02-01T00:00:00.000Z', 'new')],
      '2026-10-29',
    );
    expect(md).toContain('a\\|b<br>c');
    expect(md).toContain('共 2 筆');
    const lines = md.split('\n').filter((l) => /^\| \d/.test(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith('| 2 |')).toBe(true);
    expect(lines[1]?.split(/(?<!\\)\|/)).toHaveLength(10);
  });
});
