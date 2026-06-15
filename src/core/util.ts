/**
 * core/util.ts — tiny math helpers used everywhere.
 *
 * These three functions are the bread and butter of all game feel code:
 * almost every smooth transition in this project is a clamp, a lerp, or a
 * smoothstep wearing a costume.
 */

/** Clamp v into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation: t=0 gives a, t=1 gives b. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * The classic smoothstep: 0 below `edge0`, 1 above `edge1`, an S-curve in
 * between. We use it to blend terrain colors (sand→grass→snow) without
 * hard banding. Note edge0 > edge1 is allowed and simply reverses the ramp —
 * handy for "rockiness increases as the surface normal flattens".
 */
export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp((v - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Shortest SIGNED distance from 0 to `delta` on a ring of circumference
 * `size`. On our wrapping world, "how far east is tile B from tile A?" must
 * consider going the other way round the planet: on a 128-wide ring, tile
 * 126 is not 124 east of tile 2 — it's 4 to the WEST, so this returns -4.
 *
 * Used everywhere two world positions are compared: unit movement,
 * formation offsets, anchoring objects near the camera. Also works for
 * angles (size = 2π), which is how we turn units the short way round.
 */
export function wrapDelta(delta: number, size: number): number {
  let d = delta % size;
  if (d < -size / 2) d += size;
  if (d >= size / 2) d -= size;
  return d;
}
