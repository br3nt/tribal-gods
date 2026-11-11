/**
 * world/grass-placement.ts — where each grass clump grows, decided by the
 * WORLD, never by the camera.
 *
 * The ground cover (ground-cover.ts) is drawn as a grid of instances that
 * slides under the camera. What makes a blade stay put while you pan,
 * rotate or zoom is that everything about a clump — its root position,
 * size, lean, colour variation — is a pure function of the world cell it
 * belongs to:
 *
 *     cell (i, j)   = round(world xz / SPACING)        (unbounded integers)
 *     wrapped cell  = cell mod CELLS_PER_LAP            (one lap = 128 tiles)
 *     r1, r2, r3    = hash(wrapped cell + k)            (stable per cell)
 *     root          = cell·SPACING + (r1, r2 − 0.5)·jitter
 *
 * SPACING divides one lap of the planet (256 world units) exactly, so a
 * cell one lap east IS the same cell: the carpet doesn't reshuffle at the
 * world seam either.
 *
 * The shader in ground-cover.ts does this same arithmetic in GLSL; this file
 * is the CPU mirror so it can be unit-tested (test/grass-placement.test.ts)
 * and so tools can ask "where is the blade in this cell?".
 */

import { TILE, WORLD_SIZE } from '../config';

/** One lap of the planet in world units. */
export const LAP_UNITS = WORLD_SIZE * TILE;
/** Clumps per lap along each axis (an integer — see the header). */
export const GRASS_CELLS_PER_LAP = 400;
/** Grid spacing between clumps (world units) = 0.64. */
export const GRASS_SPACING = LAP_UNITS / GRASS_CELLS_PER_LAP;
/** How far a root may wander from its cell centre, as a fraction of spacing. */
export const GRASS_JITTER = 0.9;

const fract = (x: number) => x - Math.floor(x);
const f32 = Math.fround;

/** The GLSL tgHash (terrain-glsl.ts), in float32 like the GPU. */
export function tgHash(px: number, py: number): number {
  let x = f32(fract(f32(px * 0.1031)));
  let y = f32(fract(f32(py * 0.103)));
  const d = f32(x * f32(y + 33.33) + y * f32(x + 33.33));
  x = f32(x + d);
  y = f32(y + d);
  return fract(f32(f32(x + y) * x));
}

/** Wrap an integer cell index onto [0, GRASS_CELLS_PER_LAP). */
export function wrapCell(i: number): number {
  const n = GRASS_CELLS_PER_LAP;
  return ((i % n) + n) % n;
}

/** The cell containing (or nearest to) world point (x, z). */
export function grassCellAt(x: number, z: number): { i: number; j: number } {
  return { i: Math.floor(x / GRASS_SPACING + 0.5), j: Math.floor(z / GRASS_SPACING + 0.5) };
}

export interface GrassClump {
  /** Root position in world units (unwrapped: the image in cell (i, j)'s lap). */
  x: number;
  z: number;
  /** Per-cell randoms: r1 jitter-x/flower, r2 jitter-z/colour, r3 size/yaw. */
  r1: number;
  r2: number;
  r3: number;
}

/** Everything the shader derives from a cell, before the density mask. */
export function grassClump(i: number, j: number): GrassClump {
  const wi = wrapCell(i);
  const wj = wrapCell(j);
  const r1 = tgHash(wi, wj);
  const r2 = tgHash(wi + 17.3, wj + 17.3);
  const r3 = tgHash(wi + 41.9, wj + 41.9);
  return {
    x: i * GRASS_SPACING + (r1 - 0.5) * GRASS_SPACING * GRASS_JITTER,
    z: j * GRASS_SPACING + (r2 - 0.5) * GRASS_SPACING * GRASS_JITTER,
    r1, r2, r3,
  };
}

/**
 * Which cell an instance of the sliding grid covers this frame: the grid's
 * origin snaps to whole cells under the camera target, and instance (a, b)
 * sits `a, b` cells from it. Mirrors the vertex shader's
 * `floor(cell / spacing + 0.5)` on (snapped origin + instance offset).
 */
export function instanceCell(camX: number, camZ: number, a: number, b: number, n: number): { i: number; j: number } {
  const oi = Math.round(camX / GRASS_SPACING);
  const oj = Math.round(camZ / GRASS_SPACING);
  return { i: oi + a - Math.floor(n / 2), j: oj + b - Math.floor(n / 2) };
}
