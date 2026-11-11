/**
 * world/wear.ts — trodden ground: where feet and spades have worn the turf
 * away.
 *
 * A building plot, the yard of a finished building and the inside of a
 * tribe's stone circle aren't meadow: no grass tufts grow there and the
 * terrain paints them as bare, packed earth. Renderers REGISTER patches
 * here (keyed, so re-registering is idempotent and cheap); the terrain
 * rasterises them into a small texture (two texels per tile) that both the
 * terrain splat and the grass carpet sample in WORLD space, so the patch is
 * glued to the ground like everything else.
 *
 * Purely cosmetic: the sim never reads it.
 */

import { WORLD_SIZE } from '../config';

export interface WearPatch {
  /** Centre in fractional tile coordinates. */
  x: number;
  z: number;
  /** Half-extent in tiles (square) or radius in tiles (round). */
  r: number;
  round: boolean;
  /** 0..1: how bare. */
  k: number;
}

/** Texels per tile. */
export const WEAR_RES = 2;
export const WEAR_N = WORLD_SIZE * WEAR_RES;

const patches = new Map<string, WearPatch>();
let version = 0;

/** Add or update a patch. No-op (no version bump) if nothing changed. */
export function setWear(key: string, p: WearPatch): void {
  const old = patches.get(key);
  if (old && old.x === p.x && old.z === p.z && old.r === p.r && old.round === p.round && old.k === p.k) return;
  patches.set(key, { ...p });
  version++;
}

export function clearWear(key: string): void {
  if (patches.delete(key)) version++;
}

/** Drop patches whose key starts with `prefix` and isn't in `keep`. */
export function pruneWear(prefix: string, keep: Set<string>): void {
  for (const k of patches.keys()) {
    if (k.startsWith(prefix) && !keep.has(k)) {
      patches.delete(k);
      version++;
    }
  }
}

export function wearVersion(): number {
  return version;
}

/** Rasterise every patch into `out` (WEAR_N² bytes, 0..255), wrapped. */
export function rasterWear(out: Uint8Array): void {
  out.fill(0);
  const N = WEAR_N;
  for (const p of patches.values()) {
    const cx = p.x * WEAR_RES;
    const cz = p.z * WEAR_RES;
    const r = p.r * WEAR_RES;
    const feather = WEAR_RES * 0.6;
    const R = Math.ceil(r + feather + 1);
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const tx = Math.round(cx) + dx;
        const tz = Math.round(cz) + dz;
        const ox = tx - cx;
        const oz = tz - cz;
        const d = p.round ? Math.hypot(ox, oz) : Math.max(Math.abs(ox), Math.abs(oz));
        const k = p.k * Math.min(1, Math.max(0, (r + feather - d) / (2 * feather)));
        if (k <= 0) continue;
        const i = (((tz % N) + N) % N) * N + (((tx % N) + N) % N);
        out[i] = Math.max(out[i], Math.round(k * 255));
      }
    }
  }
}
