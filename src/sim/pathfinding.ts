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

import { WORLD_SIZE } from '../config';
import { MinHeap } from '../core/heap';
import { wrapDelta } from '../core/util';
import { Heightmap } from '../world/heightmap';
import { groundWalkable, regionAt, regionLabels } from './regions';

/** Search effort of the last findPath calls (tests and the debug readout read it). */
export const pathStats = { expansions: 0, searches: 0 };

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
  // Steepness = worst height step to the 4 cardinal neighbors (sim/regions.ts).
  return groundWalkable(map, x, z);
}

/**
 * walkable() for the inner loop of a search, by tile index: the cached
 * region labels already hold groundWalkable() for every tile (sim/regions.ts,
 * refreshed whenever map.version moves), so a neighbour test is one array
 * read and one set lookup instead of five wrapped height reads.
 */
function openTest(map: Heightmap): (i: number) => boolean {
  const ground = regionLabels(map);
  const obstacles = obstaclesOf(map);
  return (i) => ground[i] !== 0 && !obstacles.has(i);
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
  accept: (x: number, z: number) => boolean = () => true,
): { x: number; z: number } | null {
  const ok = (tx: number, tz: number) => walkable(map, tx, tz) && accept(map.wrap(tx), map.wrap(tz));
  if (ok(x, z)) return { x: map.wrap(x), z: map.wrap(z) };
  for (let r = 1; r <= maxRadius; r++) {
    // Walk the square ring at radius r, nearest-first along the ring's sides.
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const d = dx * dx + dz * dz;
        if (d < bestD && ok(x + dx, z + dz)) {
          bestD = d;
          best = { x: map.wrap(x + dx), z: map.wrap(z + dz) };
        }
      }
    }
    if (best) return best;
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
  /** How far from an unreachable goal to settle for our own shore (player moves look wider). */
  shoreRadius = 8,
): Array<{ x: number; z: number }> | null {
  sx = map.wrap(Math.round(sx));
  sz = map.wrap(Math.round(sz));

  // Rescue unwalkable endpoints (clicked in the sea; standing in a fresh crater).
  const start = findNearestWalkable(map, sx, sz, 4);
  let goal = findNearestWalkable(map, map.wrap(Math.round(gx)), map.wrap(Math.round(gz)));
  if (!start || !goal) return null;
  pathStats.searches++;

  // Different region (another island, a cliff-ringed ridge-top): no path can
  // exist. Settle for the nearest ground on OUR side within reach of the
  // goal, or refuse at once — never flood-fill the budget to prove it.
  const home = regionAt(map, start.x, start.z);
  if (home && regionAt(map, goal.x, goal.z) !== home) {
    goal = findNearestWalkable(map, map.wrap(Math.round(gx)), map.wrap(Math.round(gz)), shoreRadius, (x, z) => regionAt(map, x, z) === home);
    if (!goal) return null;
  }

  const startIdx = start.z * N + start.x;
  const goalIdx = goal.z * N + goal.x;
  if (startIdx === goalIdx) return [];

  const open = openTest(map);
  const heights = map.heights;
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
    pathStats.expansions++;

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
    const ch = heights[cur];

    for (const { dx, dz, cost } of DIRS) {
      const nx = (cx + dx + N) % N;
      const nz = (cz + dz + N) % N;
      const ni = nz * N + nx;
      if (closedStamp[ni] === stamp || !open(ni)) continue;
      // No corner-cutting: a diagonal step needs both adjacent cardinal
      // tiles passable, or units would squeeze through pinched cliffs.
      if (dx !== 0 && dz !== 0 && (!open(cz * N + nx) || !open(nz * N + cx))) {
        continue;
      }

      // Climbing costs extra — paths prefer contouring around hills to
      // marching straight up them, which both looks and plays right.
      const climb = Math.max(0, heights[ni] - ch);
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

// ---------------------------------------------------------------------------
// Flow fields: one search for a whole army
// ---------------------------------------------------------------------------
//
// Sixty warriors told to march across the map are sixty A* searches toward
// the same place — each one re-exploring nearly the same ground, each with
// its own budget, the stragglers at the back running out of it first. The
// classic RTS answer is to search ONCE, BACKWARDS: run Dijkstra outward
// from the goal until it has reached every soldier's tile. Each tile it
// settles remembers which neighbour it was reached from — the next step
// TOWARD the goal. Any soldier on a settled tile now has a path for free:
// follow the arrows. The search costs about as much as one long A*, and
// is shared by the whole army.
//
// Costs mirror findPath() exactly, just read in reverse: the unit walks
// from a tile `n` INTO the tile `cur` we expanded from, so the climb is
// height(cur) − height(n).

const flowDist = new Float32Array(N * N);
const flowNext = new Int32Array(N * N);
const flowOpen = new Uint32Array(N * N);
const flowClosed = new Uint32Array(N * N);
const flowHeap = new MinHeap();
let flowStamp = 0;

export interface FlowField {
  /** Goal tile the field flows toward. */
  goal: { x: number; z: number };
  /** Path (start excluded, goal included) from tile (x, z), or null if the search never reached it. */
  pathFrom(x: number, z: number): Array<{ x: number; z: number }> | null;
  /** Walking cost from (x, z) to the goal (Infinity if unreached). */
  costFrom(x: number, z: number): number;
}

/**
 * Dijkstra outward from (gx, gz) until every tile in `starts` is settled,
 * the budget runs out, or the reachable ground is exhausted. The returned
 * field is valid until the next flowField() call (the scratch is shared).
 */
export function flowField(
  map: Heightmap,
  gx: number,
  gz: number,
  starts: Array<{ x: number; z: number }>,
  maxExpansions = N * N,
): FlowField | null {
  const goal = findNearestWalkable(map, map.wrap(Math.round(gx)), map.wrap(Math.round(gz)));
  if (!goal) return null;
  const my = ++flowStamp;
  flowHeap.clear();
  const goalIdx = goal.z * N + goal.x;
  flowDist[goalIdx] = 0;
  flowNext[goalIdx] = -1;
  flowOpen[goalIdx] = my;
  flowHeap.push(goalIdx, 0);

  const wanted = new Set<number>();
  const tiles: Array<{ x: number; z: number }> = [];
  for (const s of starts) {
    const r = findNearestWalkable(map, map.wrap(Math.round(s.x)), map.wrap(Math.round(s.z)), 4);
    if (r) {
      wanted.add(r.z * N + r.x);
      tiles.push(r);
    }
  }
  const open = openTest(map);
  const heights = map.heights;

  // A sense of direction. Plain Dijkstra would flood the whole planet in
  // every direction before reaching a group 100 steps away. Instead,
  // aim it like A* at the group: h(n) = octile distance from n to the
  // group's centre, minus the group's radius. That never overestimates the
  // distance to the NEAREST member (triangle inequality), and changes by at
  // most one step's cost per step, so every tile it settles still has its
  // exact cheapest cost — the arrows stay correct.
  let cx0 = 0;
  let cz0 = 0;
  const first = tiles[0];
  if (first) {
    for (const s of tiles) {
      cx0 += wrapDelta(s.x - first.x, N);
      cz0 += wrapDelta(s.z - first.z, N);
    }
    cx0 = first.x + cx0 / tiles.length;
    cz0 = first.z + cz0 / tiles.length;
  }
  let radius = 0;
  for (const s of tiles) radius = Math.max(radius, heuristic(s.x, s.z, cx0, cz0));
  const h = (x: number, z: number) => (first ? Math.max(0, heuristic(x, z, cx0, cz0) - radius - 1) : 0);

  let expansions = 0;
  while (flowHeap.size > 0 && expansions < maxExpansions && wanted.size > 0) {
    const cur = flowHeap.pop();
    if (flowClosed[cur] === my) continue;
    flowClosed[cur] = my;
    expansions++;
    pathStats.expansions++;
    wanted.delete(cur);

    const cx = cur % N;
    const cz = (cur / N) | 0;
    const ch = heights[cur];
    for (const { dx, dz, cost } of DIRS) {
      const nx = (cx + dx + N) % N;
      const nz = (cz + dz + N) % N;
      const ni = nz * N + nx;
      if (flowClosed[ni] === my || !open(ni)) continue;
      if (dx !== 0 && dz !== 0 && (!open(cz * N + nx) || !open(nz * N + cx))) continue;
      const climb = Math.max(0, ch - heights[ni]);
      const tentative = flowDist[cur] + cost * (1 + climb * 0.2);
      if (flowOpen[ni] !== my || tentative < flowDist[ni]) {
        flowDist[ni] = tentative;
        flowNext[ni] = cur;
        flowOpen[ni] = my;
        flowHeap.push(ni, tentative + h(nx, nz));
      }
    }
  }
  pathStats.searches++;

  const settled = (i: number) => flowClosed[i] === my && flowStamp === my;
  const rescue = (x: number, z: number) => findNearestWalkable(map, map.wrap(Math.round(x)), map.wrap(Math.round(z)), 4);
  return {
    goal,
    costFrom(x, z) {
      const s = rescue(x, z);
      if (!s) return Infinity;
      const i = s.z * N + s.x;
      return settled(i) ? flowDist[i] : Infinity;
    },
    pathFrom(x, z) {
      const s = rescue(x, z);
      if (!s) return null;
      let i = s.z * N + s.x;
      if (!settled(i)) return null;
      const path: Array<{ x: number; z: number }> = [];
      // A unit standing off its rescued tile (in a fresh crater) steps onto it first.
      if (s.x !== map.wrap(Math.round(x)) || s.z !== map.wrap(Math.round(z))) path.push({ x: s.x, z: s.z });
      for (i = flowNext[i]; i !== -1; i = flowNext[i]) path.push({ x: i % N, z: (i / N) | 0 });
      return path;
    },
  };
}
