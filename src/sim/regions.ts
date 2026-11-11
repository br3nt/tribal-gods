/**
 * sim/regions.ts — which bits of ground connect to which.
 *
 * A REGION is a set of walkable tiles a unit can walk between (4-connected,
 * which is exactly what A* allows: it may only cut a corner when both
 * cardinal neighbours are open). Islands are regions; so is a flat ridge-top
 * ringed by cliffs — walkable, but nobody can get up there.
 *
 * Two uses:
 *   - pathfinding refuses (or shortens) a search whose goal sits in another
 *     region at once, instead of flood-filling its whole budget to prove it;
 *   - spawning never puts a person on a stranded scrap: units land on a
 *     MAJOR region (at least MAJOR_REGION tiles).
 *
 * Labels are computed lazily and cached per heightmap, keyed on
 * map.version, so terrain spells and builders' levelling keep it honest.
 * Buildings are ignored on purpose: they come and go, cliffs and sea don't.
 */

import { MAX_WALK_STEP, WALK_MIN_HEIGHT, WORLD_SIZE } from '../config';
import type { Heightmap } from '../world/heightmap';

const N = WORLD_SIZE;

/** Regions smaller than this are scraps: ridge-tops, sea stacks, crater rims. */
export const MAJOR_REGION = 60;

/** Ground a unit could stand on, ignoring buildings: above water and no cliff to any neighbour. */
export function groundWalkable(map: Heightmap, x: number, z: number): boolean {
  const h = map.heightAt(x, z);
  if (h < WALK_MIN_HEIGHT) return false;
  return (
    Math.abs(map.heightAt(x + 1, z) - h) < MAX_WALK_STEP &&
    Math.abs(map.heightAt(x - 1, z) - h) < MAX_WALK_STEP &&
    Math.abs(map.heightAt(x, z + 1) - h) < MAX_WALK_STEP &&
    Math.abs(map.heightAt(x, z - 1) - h) < MAX_WALK_STEP
  );
}

interface Labels {
  version: number;
  label: Int32Array; // 0 = not walkable
  sizes: number[]; // index = label
}

const cache = new WeakMap<Heightmap, Labels>();
const stack = new Int32Array(N * N);

function compute(map: Heightmap): Labels {
  const label = new Int32Array(N * N);
  const open = new Uint8Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) open[z * N + x] = groundWalkable(map, x, z) ? 1 : 0;
  const sizes = [0];
  let next = 1;
  for (let i = 0; i < N * N; i++) {
    if (!open[i] || label[i]) continue;
    const id = next++;
    let size = 0;
    let sp = 0;
    stack[sp++] = i;
    label[i] = id;
    while (sp > 0) {
      const cur = stack[--sp];
      size++;
      const cx = cur % N;
      const cz = (cur / N) | 0;
      const nb = [
        cz * N + ((cx + 1) % N),
        cz * N + ((cx + N - 1) % N),
        ((cz + 1) % N) * N + cx,
        ((cz + N - 1) % N) * N + cx,
      ];
      for (const ni of nb) {
        if (open[ni] && !label[ni]) {
          label[ni] = id;
          stack[sp++] = ni;
        }
      }
    }
    sizes.push(size);
  }
  return { version: map.version, label, sizes };
}

function labels(map: Heightmap): Labels {
  let l = cache.get(map);
  if (!l || l.version !== map.version) {
    l = compute(map);
    cache.set(map, l);
  }
  return l;
}

/**
 * The whole label grid (index z·N + x; 0 = not walkable ground). Search
 * loops read this instead of re-testing five heights per neighbour: it is
 * groundWalkable() for every tile, already computed and cached.
 */
export function regionLabels(map: Heightmap): Int32Array {
  return labels(map).label;
}

/** Region id of a tile (0 = not walkable ground). */
export function regionAt(map: Heightmap, x: number, z: number): number {
  return labels(map).label[map.wrap(Math.round(z)) * N + map.wrap(Math.round(x))];
}

/** Region of the tile, or of the nearest walkable tile within `r` (0 if none). */
export function regionNear(map: Heightmap, x: number, z: number, r = 2): number {
  const l = labels(map);
  const cx = Math.round(x);
  const cz = Math.round(z);
  for (let d = 0; d <= r; d++) {
    for (let dz = -d; dz <= d; dz++) {
      for (let dx = -d; dx <= d; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== d) continue;
        const id = l.label[map.wrap(cz + dz) * N + map.wrap(cx + dx)];
        if (id) return id;
      }
    }
  }
  return 0;
}

/** Tiles in a region (0 for region 0). */
export function regionSize(map: Heightmap, id: number): number {
  return id > 0 ? (labels(map).sizes[id] ?? 0) : 0;
}

/** Is this region big enough to live on? */
export function isMajor(map: Heightmap, id: number): boolean {
  return regionSize(map, id) >= MAJOR_REGION;
}
