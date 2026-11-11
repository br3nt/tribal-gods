/**
 * sim/crossing.ts — "how would we get over there?"
 *
 * When a rival lives on another region (across a strait, up a cliff), the
 * AI needs the cheapest place to make land: the narrowest gap. This is a
 * 0-1 breadth-first search (level by level) over the whole grid outward from every tile of
 * the TARGET region at once: stepping onto walkable ground (any island on
 * the way) is free, stepping onto sea or cliff costs one. Every tile of our
 * own region then knows how much sea lies between it and the target; of
 * the cheapest of them we take the one nearest home (no marching to the
 * far end of the island for the same crossing). Following the search's
 * breadcrumbs from there gives the route; its FIRST gap — from our shore to
 * the next walkable ground — is what the leader bridges now. Once that
 * lands, our region has grown, and the next search starts from the new
 * causeway end: a wide strait takes several casts, and a chain of islands
 * is hopped one gap at a time, with no special casing.
 */

import { WALK_MIN_HEIGHT, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import type { Heightmap } from '../world/heightmap';
import { groundWalkable, regionAt, regionNear } from './regions';

const N = WORLD_SIZE;

export interface Crossing {
  /** Last tile of our ground before the gap: where the leader stands. */
  from: { x: number; z: number };
  /** First walkable tile beyond the gap. */
  to: { x: number; z: number };
  /** Distance across the gap, in tiles. */
  width: number;
  /** Mostly sea (Causeway) or mostly cliff (Level). */
  kind: 'water' | 'cliff';
  /** Gaps on the whole route (1 = this one is the last). */
  gaps: number;
}

const dist = new Int32Array(N * N);
const next = new Int32Array(N * N);

/** The first gap on the cheapest route from `a`'s region to `b`'s; null if they already connect (or either is not ground). */
export function findCrossing(map: Heightmap, a: { x: number; z: number }, b: { x: number; z: number }): Crossing | null {
  const ra = regionNear(map, a.x, a.z, 3);
  const rb = regionNear(map, b.x, b.z, 3);
  if (!ra || !rb || ra === rb) return null;

  dist.fill(0x3fffffff);
  next.fill(-1);
  // Level by level (Dial's algorithm for 0/1 costs): free steps join the
  // current level, costly ones the next.
  let level: number[] = [];
  for (let i = 0; i < N * N; i++) {
    if (regionAt(map, i % N, (i / N) | 0) === rb) {
      dist[i] = 0;
      level.push(i);
    }
  }
  for (let cost = 0; level.length > 0; cost++) {
    const later: number[] = [];
    for (let q = 0; q < level.length; q++) {
      const cur = level[q];
      if (dist[cur] !== cost) continue; // reached cheaper since
      const cx = cur % N;
      const cz = (cur / N) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = (cx + dx + N) % N;
          const nz = (cz + dz + N) % N;
          const ni = nz * N + nx;
          const w = groundWalkable(map, nx, nz) ? 0 : 1;
          if (cost + w >= dist[ni]) continue;
          dist[ni] = cost + w;
          next[ni] = cur; // one step nearer the target
          (w === 0 ? level : later).push(ni);
        }
      }
    }
    level = later;
  }

  // Our shore: the cheapest tiles of our region, nearest home among them.
  let best = -1;
  let bestCost = Infinity;
  let bestHome = Infinity;
  for (let i = 0; i < N * N; i++) {
    if (dist[i] > bestCost) continue;
    const x = i % N;
    const z = (i / N) | 0;
    if (regionAt(map, x, z) !== ra) continue;
    const h = Math.hypot(wrapDelta(x - a.x, N), wrapDelta(z - a.z, N));
    if (dist[i] < bestCost || h < bestHome) {
      bestCost = dist[i];
      bestHome = h;
      best = i;
    }
  }
  if (best < 0 || bestCost >= 0x3fffffff) return null;

  const walk = (i: number) => groundWalkable(map, i % N, (i / N) | 0);
  const route: number[] = [];
  for (let i = best; i >= 0 && route.length < N * 4; i = next[i]) route.push(i);
  let s = 0;
  while (s + 1 < route.length && walk(route[s + 1])) s++;
  let e = s + 1;
  while (e < route.length && !walk(route[e])) e++;
  if (e >= route.length) return null;
  let water = 0;
  for (let k = s + 1; k < e; k++) if (map.heights[route[k]] < WALK_MIN_HEIGHT) water++;
  let gaps = 0;
  for (let k = 1; k < route.length; k++) if (!walk(route[k]) && walk(route[k - 1])) gaps++;

  // The search counts tiles, so a diagonal crossing costs the same as a
  // straight one. Square it up: the nearest far-shore tile to our shore,
  // then the nearest tile of our shore to that.
  const xy = (i: number) => ({ x: i % N, z: (i / N) | 0 });
  const near = (p: { x: number; z: number }, region: number) => {
    let found = p;
    let foundD = Infinity;
    for (let dz = -40; dz <= 40; dz++) {
      for (let dx = -40; dx <= 40; dx++) {
        const d = dx * dx + dz * dz;
        if (d >= foundD) continue;
        const x = (p.x + dx + N) % N;
        const z = (p.z + dz + N) % N;
        if (regionAt(map, x, z) === region) {
          foundD = d;
          found = { x, z };
        }
      }
    }
    return found;
  };
  const farRegion = regionAt(map, route[e] % N, (route[e] / N) | 0);
  const to = near(xy(route[s]), farRegion);
  const from = near(to, ra);
  const width = Math.hypot(wrapDelta(to.x - from.x, N), wrapDelta(to.z - from.z, N));
  return { from, to, width, kind: water * 2 >= e - s - 1 ? 'water' : 'cliff', gaps: Math.max(1, gaps) };
}
