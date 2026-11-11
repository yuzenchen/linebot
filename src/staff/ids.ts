/** Display ids for the staff bot: employees `E001`, correction requests `R001`, shifts `S0001`. */

function display(prefix: string, width: number, id: number): string {
  return `${prefix}${String(id).padStart(width, '0')}`;
}

/** `1` → `E001` (longer ids keep all digits). */
export function displayEmployeeId(id: number): string {
  return display('E', 3, id);
}

/** `1` → `R001`. */
export function displayCorrectionId(id: number): string {
  return display('R', 3, id);
}

/** `1` → `S0001`. */
export function displayShiftId(id: number): string {
  return display('S', 4, id);
}

function parse(prefix: string, raw: string): number | null {
  const m = new RegExp(`^[${prefix}${prefix.toLowerCase()}](\\d{1,9})$`).exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

/** `E001` / `e1` → `1`; anything else (no prefix, `E0`) → null. */
export function parseEmployeeId(raw: string): number | null {
  return parse('E', raw);
}

/** `R001` / `r1` → `1`. */
export function parseCorrectionId(raw: string): number | null {
  return parse('R', raw);
}

/** `S0123` / `s123` → `123`. */
export function parseShiftId(raw: string): number | null {
  return parse('S', raw);
}
