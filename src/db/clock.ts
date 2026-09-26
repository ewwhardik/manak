/**
 * Time, as this database understands it.
 *
 * Every instant Manak stores is an INTEGER count of milliseconds since the Unix
 * epoch. That choice is made in the schema and this module is the only place that
 * knows it, which matters for two reasons.
 *
 * The first is testability. A deadline is the one piece of arithmetic in this
 * system that decides whether someone's work counts, so no code path is allowed
 * to read the wall clock directly: everything that needs the current time takes a
 * `Clock`. A test can then hold an event open, close it one millisecond later,
 * and assert on both sides of the boundary without sleeping.
 *
 * The second is rendering. An integer is not a time a human wants to read, so the
 * conversion lives here too, next to the reason it is needed.
 */

/** The current instant, in epoch milliseconds. Injected, never read globally. */
export type Clock = { now: () => number };

/** Virtual offset applied to systemClock for demonstrations and walk-throughs. */
let virtualClockOffset = 0;

export function realNow(): number {
  return Date.now();
}

export function getClockOffset(): number {
  return virtualClockOffset;
}

export function setClockOffset(ms: number): void {
  virtualClockOffset = ms;
}

export function resetClockOffset(): void {
  virtualClockOffset = 0;
}

/** The real clock, optionally warped by virtualClockOffset for demos. */
export const systemClock: Clock = { now: () => Date.now() + virtualClockOffset };

/**
 * A clock a test drives by hand.
 *
 * `advance` exists so a test can express "one millisecond after the deadline"
 * without arithmetic on a magic number, which is how off-by-one errors in
 * boundary tests get written in the first place.
 */
export function manualClock(start: number): Clock & {
  advance: (ms: number) => void;
  set: (at: number) => void;
} {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
    set: (next: number) => {
      at = next;
    },
  };
}

/** Epoch milliseconds as an ISO 8601 instant in UTC. The form exports use. */
export function toIso(at: number): string {
  return new Date(at).toISOString();
}

/**
 * An ISO 8601 instant as epoch milliseconds.
 *
 * Throws rather than returning `NaN`. A `NaN` deadline compares false against
 * everything, which would silently accept every late submission — exactly the
 * failure this module exists to prevent.
 */
export function fromIso(text: string): number {
  const at = Date.parse(text);
  if (!Number.isFinite(at)) {
    throw new RangeError(`not an ISO 8601 instant: ${JSON.stringify(text)}`);
  }
  return at;
}

/** Milliseconds, spelled out. Deadlines read better than 86_400_000 does. */
export const MS = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;
