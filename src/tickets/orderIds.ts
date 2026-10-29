const ORDER_ID = /#?\b[DG]?\d{8}-[A-Z0-9]{8}\b/gi;

/**
 * Order ids mentioned in free text, normalised to `#YYYYMMDD-XXXXXXXX` (optional D / G prefix
 * kept, uppercased, deduped, in order of first appearance).
 */
export function extractOrderIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ORDER_ID)) {
    const id = `#${m[0].replace(/^#/, '').toUpperCase()}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
