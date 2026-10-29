import type { SuggestionRow } from '../db/suggestions.js';

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/** Local date as YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function renderSuggestionsMarkdown(rows: SuggestionRow[], date: string): string {
  const lines = [`# 需求建議匯出（${date}）`, '', `共 ${rows.length} 筆`, ''];
  if (rows.length === 0) {
    lines.push('目前沒有需求建議');
    return lines.join('\n') + '\n';
  }
  lines.push('| id | 建立時間 | 狀態 | 標題 | 分類 | 合併至 | 摘要 | 原文 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const sorted = [...rows].sort((a, b) =>
    a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1,
  );
  for (const r of sorted) {
    const cells = [
      r.id,
      r.created_at,
      r.status,
      r.title,
      r.category,
      r.merged_into,
      r.summary,
      r.text,
    ];
    lines.push(`| ${cells.map(cell).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}
