/**
 * Group moves: one order for a whole army must move the whole army, and
 * must not stall the frame it is issued in.
 */
import { describe, expect, it } from 'vitest';
import { WORLD_SIZE } from '../src/config';
import { findPath } from '../src/sim/pathfinding';
import { World } from '../src/sim/world-state';
import { flatWorld, run } from './helpers';

/**
 * Sea walls at x = 50 and x = 110 from z = 12 to z = 124 (the planet wraps
 * in x too), so the only way
 * from the west side to the east is round through the gap near z = 0.
 */
function walledWorld(): World {
  const w = flatWorld();
  for (let z = 12; z <= 124; z++) for (const x of [48, 49, 50, 51, 52, 108, 109, 110, 111, 112]) w.map.heights[z * WORLD_SIZE + x] = -1;
  w.map.version++;
  return w;
}

function army(w: World, n: number, cx: number, cz: number) {
  const ids: number[] = [];
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) ids.push(w.spawn('warrior', 'player', cx + (i % side) * 1.2, cz + Math.floor(i / side) * 1.2).id);
  return ids;
}

describe('group move', () => {
  it('60 warriors ordered 88+ steps around a sea wall all arrive', () => {
    const w = walledWorld();
    const ids = army(w, 60, 26, 62);
    const tx = 74;
    const tz = 70;
    const probe = findPath(w.map, 30, 66, tx, tz, 100000)!;
    expect(probe.length).toBeGreaterThanOrEqual(88);

    const t0 = performance.now();
    w.orderMove(ids, tx, tz);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(30); // ~5 ms here; was 119-580 ms as 60 independent A* searches

    const moving = ids.filter((id) => w.unitById(id)!.state === 'moving').length;
    expect(moving).toBe(60);
    expect(w.events.filter((e) => e.type === 'denied')).toHaveLength(0);

    run(w, 110);
    const far = ids.map((id) => w.unitById(id)!).filter((u) => Math.hypot(u.x - tx, u.z - tz) > 9);
    expect(far.map((u) => `${u.id}@${u.x.toFixed(0)},${u.z.toFixed(0)}`)).toEqual([]);
  });

  it('a short group move gathers the group around the mark, not on one tile', () => {
    const w = flatWorld();
    const ids = army(w, 12, 30, 30);
    w.orderMove(ids, 40, 40);
    run(w, 20);
    const units = ids.map((id) => w.unitById(id)!);
    for (const u of units) expect(Math.hypot(u.x - 40, u.z - 40)).toBeLessThan(6);
    const tiles = new Set(units.map((u) => `${Math.round(u.x)},${Math.round(u.z)}`));
    expect(tiles.size).toBeGreaterThan(6);
  });

  it('units on another island walk to the shore facing the mark; nobody is left idle', () => {
    const w = flatWorld();
    // Sea ring around the island x,z in 20..40.
    for (let z = 14; z <= 46; z++) for (let x = 14; x <= 46; x++) {
      const edge = x < 18 || x > 42 || z < 18 || z > 42;
      if (edge) w.map.heights[z * WORLD_SIZE + x] = -1;
    }
    w.map.version++;
    const ids = army(w, 8, 28, 28);
    w.orderMove(ids, 30, 60);
    for (const id of ids) expect(w.unitById(id)!.state).toBe('moving');
    run(w, 30);
    for (const id of ids) expect(w.unitById(id)!.z).toBeGreaterThan(36);
  });
});
