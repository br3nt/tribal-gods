/**
 * core/noise.ts — seamlessly tileable value noise, from scratch.
 *
 * This is how we generate "natural"-looking continents. The technique
 * (value noise + fractal octaves) is the grandparent of every terrain
 * generator since the 80s:
 *
 *   1. Put random values on a coarse grid of lattice points.
 *   2. Between lattice points, interpolate smoothly → soft random hills.
 *   3. Add several layers ("octaves") of this at doubling frequency and
 *      halving strength → big continents + medium hills + small bumps.
 *
 * THE CRUCIAL TWIST for our game: the world wraps at the edges (it's a
 * planet), so the noise must tile seamlessly. We get that for free by
 * wrapping the LATTICE coordinates with a modulo before hashing — the
 * random values themselves repeat with the world, so the east edge
 * interpolates straight into the west edge with no visible seam.
 */

import { lerp } from './util';

/**
 * Hash two integer coordinates + a seed into a pseudo-random float in [0,1).
 *
 * This is a small integer "avalanche" mixer (multiply by odd constants, xor
 * with shifted self). It has no state and no memory: the same (x, z, seed)
 * always gives the same value, which is exactly what we want — terrain that
 * is random-looking but perfectly reproducible from a single seed number.
 */
export function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  // >>> 0 reinterprets as unsigned 32-bit; divide to land in [0, 1).
  return (h >>> 0) / 4294967296;
}

/** Quintic fade curve (Perlin's): smoother than smoothstep at the joins. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * One layer of value noise, tileable with the given `period`.
 *
 * `x`/`z` are in lattice cells (so x=2.5 sits halfway between lattice
 * columns 2 and 3). `period` is how many lattice cells fit across the world
 * — wrapping lattice lookups by it is what makes the noise seamless.
 */
export function valueNoise(x: number, z: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = fade(x - xi);
  const tz = fade(z - zi);

  // Wrap lattice coords onto [0, period) — the seamless-tiling trick.
  const w = (i: number) => ((i % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1);
  const z0 = w(zi), z1 = w(zi + 1);

  // Random values at the four surrounding lattice corners...
  const a = hash2(x0, z0, seed);
  const b = hash2(x1, z0, seed);
  const c = hash2(x0, z1, seed);
  const d = hash2(x1, z1, seed);

  // ...blended bilinearly with the fade curve.
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

/**
 * Fractal Brownian motion: stack octaves of value noise.
 *
 * `x`/`z` are in TILES (0..worldSize). Each octave's lattice cell size must
 * divide worldSize evenly or the tiling breaks — hence worldSize being a
 * power of two in config. Returns roughly [0, 1].
 *
 * Octave intuition: cell 32 = continents, 16 = regions, 8 = hills, 4 = bumps.
 */
export function fbm(x: number, z: number, worldSize: number, seed: number): number {
  const octaves = [
    { cell: 32, amp: 1.0 },
    { cell: 16, amp: 0.5 },
    { cell: 8, amp: 0.25 },
    { cell: 4, amp: 0.12 },
  ];
  let sum = 0;
  let ampSum = 0;
  for (let o = 0; o < octaves.length; o++) {
    const { cell, amp } = octaves[o];
    // A different seed per octave, or every layer would have peaks in the
    // same places and the terrain would look strangely self-similar.
    sum += valueNoise(x / cell, z / cell, worldSize / cell, seed + o * 1013) * amp;
    ampSum += amp;
  }
  return sum / ampSum;
}
