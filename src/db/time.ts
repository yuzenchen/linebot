/** Injectable clock so tests can freeze time. All timestamps are ISO-8601 UTC strings. */
export type Clock = () => Date;

const realClock: Clock = () => new Date();
let clock: Clock = realClock;

/** Replace the clock used by `now()` / `nowIso()` (tests). */
export function setClock(fn: Clock): void {
  clock = fn;
}

export function resetClock(): void {
  clock = realClock;
}

export function now(): Date {
  return clock();
}

export function nowIso(date: Date = clock()): string {
  return date.toISOString();
}
