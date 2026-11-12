/**
 * world/surface.ts — the height of the ground AS DRAWN, on the CPU.
 *
 * The terrain shader interpolates the tile heights bicubically (Catmull-Rom,
 * terrain-glsl.ts tgHeightGrad). The sim and the old renderers sample the
 * heightmap bilinearly, which agrees at tile corners but can be tens of
 * centimetres off between them on a slope — enough to bury a doorstep or
 * float a plot's stakes. Anything that has to MEET the visible ground (a
 * building's foundation, a site's dug earth, a stone circle's footings)
 * samples this instead: the exact same filter, so CPU and GPU agree.
 */

import type { Heightmap } from './heightmap';

/** Catmull-Rom weights for fraction t. */
function weights(t: number, out: number[]): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1;
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}

const wx: number[] = [0, 0, 0, 0];
const wz: number[] = [0, 0, 0, 0];

/** Ground height at fractional TILE coordinates (fx, fz), as the terrain shader draws it. */
export function surfaceHeight(map: Pick<Heightmap, 'heightAt'>, fx: number, fz: number): number {
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  weights(fx - ix, wx);
  weights(fz - iz, wz);
  let h = 0;
  for (let j = 0; j < 4; j++) {
    const z = iz + j - 1;
    const row =
      wx[0] * map.heightAt(ix - 1, z) +
      wx[1] * map.heightAt(ix, z) +
      wx[2] * map.heightAt(ix + 1, z) +
      wx[3] * map.heightAt(ix + 2, z);
    h += wz[j] * row;
  }
  return h;
}

/**
 * Lowest and highest drawn ground over a square footprint centred on tile
 * (cx, cz), `half` tiles from the centre to each edge, sampled every
 * `step` tiles (edges included).
 */
export function footprintRange(
  map: Pick<Heightmap, 'heightAt'>, cx: number, cz: number, half: number, step = 0.5,
): { lo: number; hi: number; mean: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  const k = Math.max(1, Math.round((2 * half) / step));
  for (let j = 0; j <= k; j++) {
    for (let i = 0; i <= k; i++) {
      const h = surfaceHeight(map, cx - half + (2 * half * i) / k, cz - half + (2 * half * j) / k);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
      n++;
    }
  }
  return { lo, hi, mean: sum / n };
}
