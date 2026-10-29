/** `42` → `T042` (zero-padded to 3 digits; longer ids keep all digits). */
export function displayId(id: number): string {
  return `T${String(id).padStart(3, '0')}`;
}

/** `T42` / `t042` / `42` → `42`; anything else (including `0`) → null. */
export function parseTicketId(raw: string): number | null {
  const m = /^[Tt]?(\d{1,9})$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}
