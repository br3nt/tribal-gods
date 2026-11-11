/**
 * assets/models/rng.ts — deterministic randomness for models.
 *
 * A crowd must not be clones, but a villager must look the same every
 * time you scroll back to them. So every random choice in a model comes
 * from a tiny seeded generator (mulberry32) keyed by the unit's id or the
 * tile's coordinates — never Math.random().
 */

export type Rng = {
  /** Uniform [0,1). */
  next(): number;
  /** Uniform [a,b). */
  range(a: number, b: number): number;
  /** Integer [0,n). */
  int(n: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
};

export function rng(seed: number): Rng {
  // Scramble the seed first (murmur3 finaliser): neighbouring ids must not
  // produce neighbouring sequences.
  let s = seed | 0;
  s = Math.imul(s ^ (s >>> 16), 0x85ebca6b);
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35);
  s ^= s >>> 16;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next();
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

/** Integer lattice hash → [0,1). */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
