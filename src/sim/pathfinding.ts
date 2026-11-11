/**
 * sim/pathfinding.ts — A* over the wrapping world grid.
 *
 * The beautiful economy of this game's design: pathfinding runs on the SAME
 * grid as the terrain. A tile is walkable if it's above the waterline and
 * not too steep — both read straight off the heightmap. So when a god power
 * reshapes the land, the "navigation mesh" updates for free: raise a
 * landbridge and a route exists; blast a crater and it doesn't. There is no
 * separate nav data to keep in sync. That coupling IS the gameplay.
 *
 * A* in one paragraph, for the uninitiated: explore outward from the start,
 * always expanding the tile with the lowest (cost so far + optimistic guess
 * of cost remaining). The guess (the "heuristic") never overestimates, so
 * the first time we reach the goal we've provably found a cheapest path.
 * It's Dijkstra's algorithm wearing a sense of direction.
 *
 * Wrapping changes two things only:
 *   - neighbors wrap around the edges (free — heightAt() wraps), and
 *   - the heuristic must measure distance the short way round the planet
 *     (wrapDelta), or paths near the seam would wander the long way.
 *
 * Performance notes (worth reading — these tricks are everywhere in games):
 *   - Scratch arrays are allocated ONCE at module level and reused by every
 *     search. Zero garbage per path.
 *   - We never clear them between searches. Instead each search bumps a
 *     "stamp" counter; a cell whose stamp isn't current is treated as
 *     untouched. Clearing 16k cells per path would cost more than the path.
 */

import { MAX_WALK_STEP, WALK_MIN_HEIGHT, WORLD_SIZE } from '../config';
import { MinHeap } from '../core/heap';
import { wrapDelta } from '../core/util';
import { Heightmap } from '../world/heightmap';

const N = WORLD_SIZE;
const SQRT2 = Math.SQRT2;

/**
 * Tiles occupied by buildings. The heightmap says "can the GROUND be
 * walked"; this set says "is something standing on it". World-state adds a
 * hut's footprint here when it's placed (leaving the door tile open) and
 * walkable() consults both — so buildings block routes with zero changes to
 * the A* algorithm itself.
 */
const obstacleSets = new WeakMap<Heightmap, Set<number>>();

/** The occupied-tile set for one world (keyed by its heightmap, so two Worlds never share). */
export function obstaclesOf(map: Heightmap): Set<number> {
  let set = obstacleSets.get(map);
  if (!set) {
    set = new Set<number>();
    obstacleSets.set(map, set);
  }
  return set;
}

export const tileIndex = (x: number, z: number): number =>
  (((z % N) + N) % N) * N + (((x % N) + N) % N);

// Reusable per-search scratch state (see header).
const gScore = new Float32Array(N * N);
const cameFrom = new Int32Array(N * N);
const openStamp = new Uint32Array(N * N);
const closedStamp = new Uint32Array(N * N);
const heap = new MinHeap();
let stamp = 0;

// The 8 neighbor directions, with their base step costs.
const DIRS = [
  { dx: 1, dz: 0, cost: 1 }, { dx: -1, dz: 0, cost: 1 },
  { dx: 0, dz: 1, cost: 1 }, { dx: 0, dz: -1, cost: 1 },
  { dx: 1, dz: 1, cost: SQRT2 }, { dx: 1, dz: -1, cost: SQRT2 },
  { dx: -1, dz: 1, cost: SQRT2 }, { dx: -1, dz: -1, cost: SQRT2 },
];

/** Can a unit stand on this tile? Above water, unoccupied, and no cliff-step to any neighbor. */
export function walkable(map: Heightmap, x: number, z: number): boolean {
  if (obstaclesOf(map).has(tileIndex(x, z))) return false;
  const h = map.heightAt(x, z);
  if (h < WALK_MIN_HEIGHT) return false;
  // Steepness = worst height step to the 4 cardinal neighbors.
  return (
    Math.abs(map.heightAt(x + 1, z) - h) < MAX_WALK_STEP &&
    Math.abs(map.heightAt(x - 1, z) - h) < MAX_WALK_STEP &&
    Math.abs(map.heightAt(x, z + 1) - h) < MAX_WALK_STEP &&
    Math.abs(map.heightAt(x, z - 1) - h) < MAX_WALK_STEP
  );
}

/**
 * Octile heuristic with wrapping: the exact cost of the best path on an
 * EMPTY grid with 8-way movement (diagonals shortcut the smaller axis).
 * Never overestimates the real cost, which is what keeps A* correct.
 */
function heuristic(x0: number, z0: number, x1: number, z1: number): number {
  const dx = Math.abs(wrapDelta(x1 - x0, N));
  const dz = Math.abs(wrapDelta(z1 - z0, N));
  return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
}

/**
 * Spiral outward from (x, z) to the nearest walkable tile. Used to rescue
 * a goal that's in the sea, or a unit whose ground was sculpted away.
 */
export function findNearestWalkable(
  map: Heightmap,
  x: number,
  z: number,
  maxRadius = 8,
): { x: number; z: number } | null {
  if (walkable(map, x, z)) return { x: map.wrap(x), z: map.wrap(z) };
  for (let r = 1; r <= maxRadius; r++) {
    // Walk the square ring at radius r.
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        if (walkable(map, x + dx, z + dz)) return { x: map.wrap(x + dx), z: map.wrap(z + dz) };
      }
    }
  }
  return null;
}

/**
 * Find a path from (sx, sz) to (gx, gz), both in whole tiles.
 * Returns the list of tiles to visit (start excluded, goal included) or
 * null if unreachable. `maxExpansions` caps the work: a goal sealed off by
 * ocean would otherwise make us flood-fill the entire planet to prove it.
 */
export function findPath(
  map: Heightmap,
  sx: number,
  sz: number,
  gx: number,
  gz: number,
  maxExpansions = 4000,
): Array<{ x: number; z: number }> | null {
  sx = map.wrap(Math.round(sx));
  sz = map.wrap(Math.round(sz));

  // Rescue unwalkable endpoints (clicked in the sea; standing in a fresh crater).
  const start = findNearestWalkable(map, sx, sz, 4);
  const goal = findNearestWalkable(map, map.wrap(Math.round(gx)), map.wrap(Math.round(gz)));
  if (!start || !goal) return null;

  const startIdx = start.z * N + start.x;
  const goalIdx = goal.z * N + goal.x;
  if (startIdx === goalIdx) return [];

  stamp++; // invalidates all scratch state from previous searches at once
  heap.clear();
  gScore[startIdx] = 0;
  cameFrom[startIdx] = -1;
  openStamp[startIdx] = stamp;
  heap.push(startIdx, heuristic(start.x, start.z, goal.x, goal.z));

  let expansions = 0;
  while (heap.size > 0 && expansions < maxExpansions) {
    const cur = heap.pop();
    if (closedStamp[cur] === stamp) continue; // stale duplicate heap entry — skip
    closedStamp[cur] = stamp;
    expansions++;

    if (cur === goalIdx) {
      // Walk the breadcrumb trail backwards, then flip it.
      const path: Array<{ x: number; z: number }> = [];
      for (let i = cur; i !== startIdx; i = cameFrom[i]) {
        path.push({ x: i % N, z: (i / N) | 0 });
      }
      return path.reverse();
    }

    const cx = cur % N;
    const cz = (cur / N) | 0;
    const ch = map.heightAt(cx, cz);

    for (const { dx, dz, cost } of DIRS) {
      const nx = map.wrap(cx + dx);
      const nz = map.wrap(cz + dz);
      const ni = nz * N + nx;
      if (closedStamp[ni] === stamp || !walkable(map, nx, nz)) continue;
      // No corner-cutting: a diagonal step needs both adjacent cardinal
      // tiles passable, or units would squeeze through pinched cliffs.
      if (dx !== 0 && dz !== 0 && (!walkable(map, cx + dx, cz) || !walkable(map, cx, cz + dz))) {
        continue;
      }

      // Climbing costs extra — paths prefer contouring around hills to
      // marching straight up them, which both looks and plays right.
      const climb = Math.max(0, map.heightAt(nx, nz) - ch);
      const tentative = gScore[cur] + cost * (1 + climb * 0.2);

      if (openStamp[ni] !== stamp || tentative < gScore[ni]) {
        gScore[ni] = tentative;
        cameFrom[ni] = cur;
        openStamp[ni] = stamp;
        // Lazy deletion: just push again with the better score; the stale
        // entry gets skipped via closedStamp when popped later.
        heap.push(ni, tentative + heuristic(nx, nz, goal.x, goal.z));
      }
    }
  }
  return null; // exhausted the budget or the frontier — unreachable
}
