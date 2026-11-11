/**
 * sim/rng.ts — the sim's only source of chance.
 *
 * Math.random() is banned inside src/sim: a World owns one seeded Rng, so
 * the same seed + the same orders replay the same game (and tests repeat).
 * mulberry32 — tiny, fast, good enough for dice that aren't cryptography.
 */
export class Rng {
  /** Generator state (sim/save.ts reads and restores it). */
  s: number;

  constructor(seed = 1) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  seed(seed: number): void {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
