/**
 * Seeded deterministic randomness.
 *
 * Every stochastic decision in the judging engine — assignment shuffles, pair
 * exploration, which project shows on the left — runs through here, so an
 * organizer can reproduce and explain any outcome from the recorded seed.
 * `Math.random()` is never used.
 */

/** mulberry32: small, fast, well-distributed for our purposes. */
export function makeRng(seed: number | string): Rng {
  let s = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  if (s === 0) s = 0x9e3779b9;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(maxExclusive: number): number {
      if (maxExclusive <= 0) return 0;
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (items.length === 0) return undefined;
      return items[Math.floor(next() * items.length)];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
    gauss(mean = 0, sd = 1): number {
      // Box-Muller. Guard against log(0).
      let u = next();
      if (u < 1e-12) u = 1e-12;
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

export type Rng = {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T | undefined;
  shuffle<T>(items: readonly T[]): T[];
  gauss(mean?: number, sd?: number): number;
};

/** FNV-1a, so a string seed like an event slug is usable directly. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
