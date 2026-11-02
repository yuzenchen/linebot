/** `1` → `B001` (zero-padded to 3 digits; longer ids keep all digits). */
export function displayBugId(id: number): string {
  return `B${String(id).padStart(3, '0')}`;
}
