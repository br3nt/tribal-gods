/**
 * level/terrain-kit.ts — the chisel the designed levels are carved with.
 *
 * A campaign map is written as a SHAPE: "a ring island 30 tiles out, a
 * lagoon inside, a crown of rock at the centre". The kit turns that into
 * heights in three moves:
 *
 *   1. MASKS — signed-distance helpers (discs, capsules, polylines) on the
 *      wrapping grid, softened and wobbled by seeded noise so coastlines
 *      look like coastlines and not like compass drawings.
 *   2. LAYERS — land = lerp(sea floor, rolling ground, mask); mountains,
 *      cliffs, rivers and pads are added, cut or blended on top.
 *   3. FINISH — a blur or two, then trees scattered by deterministic hash,
 *      thicker where the designer asked for groves.
 *
 * Everything is deterministic (fbm/hash2 from core/noise.ts) — the same
 * recipe makes the same planet on every machine, so a scenario is a shared
 * place, not a dice roll.
 *
 * Heights to know (config.ts): sea level 0; walkable ≥ 0.2 with steps
 * < 3.2 between neighbours; build sites want ≤ 2.4 of relief; −7..18.
 */

import { WORLD_SIZE } from '../config';
import { fbm, hash2 } from '../core/noise';
import { clamp, lerp, smoothstep, wrapDelta } from '../core/util';
import { walkable } from '../sim/pathfinding';
import { Heightmap } from '../world/heightmap';

export const N = WORLD_SIZE;
export type Pt = { x: number; z: number };

export const wrap = (v: number) => ((Math.round(v) % N) + N) % N;

/** Wrapped distance between two tile positions. */
export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(wrapDelta(ax - bx, N), wrapDelta(az - bz, N));
}

/** Wrapped distance from (x, z) to the segment a→b. */
export function segDist(x: number, z: number, a: Pt, b: Pt): number {
  const px = wrapDelta(x - a.x, N);
  const pz = wrapDelta(z - a.z, N);
  const bx = wrapDelta(b.x - a.x, N);
  const bz = wrapDelta(b.z - a.z, N);
  const len2 = bx * bx + bz * bz;
  const t = len2 > 0 ? clamp((px * bx + pz * bz) / len2, 0, 1) : 0;
  return Math.hypot(px - bx * t, pz - bz * t);
}

/** Distance to a polyline. */
export function lineDist(x: number, z: number, pts: Pt[]): number {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(x, z, pts[i], pts[i + 1]));
  return d;
}

/** 1 inside radius r, 0 beyond r + soft, smooth between. */
export function inside(d: number, r: number, soft = 3): number {
  return 1 - smoothstep(r - soft * 0.5, r + soft * 0.5, d);
}

export class Terrain {
  readonly map = new Heightmap();
  readonly h: Float32Array;
  /** Extra tree density per tile (0 = background scatter). */
  private readonly grove = new Float32Array(N * N);

  constructor(readonly seed: number) {
    this.h = this.map.heights;
  }

  /** fbm noise in ~[0,1] at a tile, from this map's seed (+ a layer offset). */
  n(x: number, z: number, layer = 0): number {
    return fbm(x, z, N, this.seed + layer * 7919);
  }

  /** Signed noise in ~[-1,1] — for wobbling distances. */
  wobble(x: number, z: number, layer = 0): number {
    return (this.n(x, z, layer) - 0.5) * 2;
  }

  /** Set every tile from a field function. */
  paint(fn: (x: number, z: number) => number): this {
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) this.h[z * N + x] = fn(x, z);
    return this;
  }

  /** Rewrite every tile from its current height. */
  apply(fn: (x: number, z: number, h: number) => number): this {
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x;
        this.h[i] = fn(x, z, this.h[i]);
      }
    }
    return this;
  }

  /**
   * Standard land from a land mask (0 = sea, 1 = land): sea floor at
   * `sea`, gentle rolling ground of `base` ± `roll` on land.
   */
  landFrom(mask: (x: number, z: number) => number, opts: { sea?: number; base?: number; roll?: number } = {}): this {
    const sea = opts.sea ?? -4.5;
    const base = opts.base ?? 2.2;
    const roll = opts.roll ?? 2.4;
    return this.paint((x, z) => {
      const m = clamp(mask(x, z), 0, 1);
      const ground = base + (this.n(x, z, 3) - 0.5) * 2 * roll;
      return lerp(sea, ground, smoothstep(0.15, 0.85, m));
    });
  }

  /** Blend a circular pad toward height `level` (homes, plazas): flat inside r, eased to r + ease. */
  pad(cx: number, cz: number, r: number, level: number, ease = 4): this {
    return this.around(cx, cz, r + ease, (x, z, h) => lerp(h, level, inside(dist(x, z, cx, cz), r + ease / 2, ease)));
  }

  /** Raise ground inside a disc to at least `level` (a mesa / terrace); `soft` = width of its slope. */
  mesa(cx: number, cz: number, r: number, level: number, soft = 3): this {
    return this.around(cx, cz, r + soft, (x, z, h) => {
      const k = inside(dist(x, z, cx, cz) + this.wobble(x, z, 23) * 1.5, r, soft);
      return h < level ? lerp(h, level, k) : h;
    });
  }

  /** Add a smooth mountain (cosine bump) of `height` and radius r. */
  peak(cx: number, cz: number, r: number, height: number): this {
    return this.around(cx, cz, r, (x, z, h) => {
      const d = dist(x, z, cx, cz);
      return d >= r ? h : h + height * (0.5 + 0.5 * Math.cos((d / r) * Math.PI));
    });
  }

  /**
   * A wall of rock along a polyline: `width` across at the base, rising
   * `height` with steep flanks (steep enough to be unwalkable when tall).
   */
  ridge(pts: Pt[], width: number, height: number, jag = 0.35): this {
    return this.apply((x, z, h) => {
      const d = lineDist(x, z, pts);
      if (d > width) return h;
      const k = 1 - smoothstep(width * 0.35, width, d);
      return Math.max(h, h * (1 - k) + (height * (1 + this.wobble(x, z, 11) * jag)) * k);
    });
  }

  /** Cut a channel (river, strait) along a polyline to `depth`, `width` across. */
  channel(pts: Pt[], width: number, depth = -3.5, soft = 2.5): this {
    return this.apply((x, z, h) => {
      const d = lineDist(x, z, pts) + this.wobble(x, z, 17) * 0.8;
      const k = inside(d, width / 2, soft);
      return k > 0 ? lerp(h, Math.min(h, depth), k) : h;
    });
  }

  /** Lay a walkable road (a ford, a pass floor) at `level` along a polyline. */
  road(pts: Pt[], width: number, level: number): this {
    return this.apply((x, z, h) => {
      const k = inside(lineDist(x, z, pts), width / 2, 2);
      return k > 0 ? lerp(h, level, k) : h;
    });
  }

  /** Mark extra tree density inside a disc (0..1 → up to ~15% of tiles). */
  addGrove(cx: number, cz: number, r: number, density = 0.6): this {
    for (let z = Math.floor(cz - r); z <= cz + r; z++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d = dist(x, z, cx, cz);
        if (d < r) this.grove[wrap(z) * N + wrap(x)] = Math.max(this.grove[wrap(z) * N + wrap(x)], density * (1 - d / r));
      }
    }
    return this;
  }

  /** Box-blur passes (wrapping). */
  smooth(passes = 1): this {
    for (let p = 0; p < passes; p++) {
      const src = this.h.slice();
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          let s = 0;
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) s += src[wrap(z + dz) * N + wrap(x + dx)];
          this.h[z * N + x] = s / 9;
        }
      }
    }
    return this;
  }

  /** Clamp to the engine's height range and bump the version. */
  finish(): Heightmap {
    for (let i = 0; i < this.h.length; i++) this.h[i] = clamp(this.h[i], -7, 18);
    this.map.version++;
    return this.map;
  }

  /** Deterministic trees: a thin background scatter plus the groves. */
  trees(base = 0.02, keepClear: Array<Pt & { r: number }> = []): number[] {
    const out: number[] = [];
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const h = this.map.heightAt(x, z);
        if (h < 1.2 || h > 9 || !walkable(this.map, x, z)) continue;
        if (keepClear.some((c) => dist(x, z, c.x, c.z) < c.r)) continue;
        const p = base + this.grove[z * N + x] * 0.15;
        if (hash2(x, z, this.seed + 555) < p) out.push(x, z);
      }
    }
    return out;
  }

  /** Visit tiles in a square around a point (wrapping), rewriting heights. */
  private around(cx: number, cz: number, r: number, fn: (x: number, z: number, h: number) => number): this {
    for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const i = wrap(z) * N + wrap(x);
        this.h[i] = fn(x, z, this.h[i]);
      }
    }
    return this;
  }
}

/** Points along a circular arc (angles in degrees; 0 = +x, 90 = +z). */
export function arc(cx: number, cz: number, r: number, fromDeg: number, toDeg: number, step = 8): Pt[] {
  const pts: Pt[] = [];
  const n = Math.max(1, Math.ceil(Math.abs(toDeg - fromDeg) / step));
  for (let i = 0; i <= n; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
    pts.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return pts;
}

/** A point at angle `deg` and radius r from a centre (same convention as arc). */
export function polar(cx: number, cz: number, r: number, deg: number): Pt {
  const a = (deg * Math.PI) / 180;
  return { x: Math.round(cx + Math.cos(a) * r), z: Math.round(cz + Math.sin(a) * r) };
}

/** Wanderers scattered deterministically on walkable land within a disc. */
export function wanderers(map: Heightmap, seed: number, cx: number, cz: number, r: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; out.length < count * 2 && i < count * 40; i++) {
    const a = hash2(i, 3, seed) * Math.PI * 2;
    const d = Math.sqrt(hash2(i, 5, seed)) * r;
    const x = wrap(cx + Math.cos(a) * d);
    const z = wrap(cz + Math.sin(a) * d);
    if (walkable(map, x, z)) out.push(x, z);
  }
  return out;
}

/** Tiles reachable on foot from (x, z) — the same rule as A* (8-way, no corner cutting). */
export function reachable(map: Heightmap, sx: number, sz: number): Uint8Array {
  const seen = new Uint8Array(N * N);
  const start = wrap(sz) * N + wrap(sx);
  if (!walkable(map, wrap(sx), wrap(sz))) return seen;
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const cur = queue.pop()!;
    const cx = cur % N;
    const cz = (cur / N) | 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = wrap(cx + dx);
        const nz = wrap(cz + dz);
        const ni = nz * N + nx;
        if (seen[ni] || !walkable(map, nx, nz)) continue;
        if (dx && dz && (!walkable(map, cx + dx, cz) || !walkable(map, cx, cz + dz))) continue;
        seen[ni] = 1;
        queue.push(ni);
      }
    }
  }
  return seen;
}

/** Is (x, z) — or a walkable tile within `slack` of it — in a reachable set? */
export function canReach(set: Uint8Array, x: number, z: number, slack = 2): boolean {
  for (let dz = -slack; dz <= slack; dz++) {
    for (let dx = -slack; dx <= slack; dx++) if (set[wrap(z + dz) * N + wrap(x + dx)]) return true;
  }
  return false;
}
