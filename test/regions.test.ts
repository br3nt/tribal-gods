/**
 * Walkable regions: ground split into islands of tiles a unit can walk
 * between. Units must never be spawned onto a stranded scrap (a flat
 * ridge-top ringed by cliffs) and A* must not burn its budget proving a
 * goal on another island is unreachable.
 */
import { describe, expect, it } from 'vitest';
import { WORLD_SIZE } from '../src/config';
import { findPath, pathStats } from '../src/sim/pathfinding';
import { MAJOR_REGION, regionAt, regionNear, regionSize } from '../src/sim/regions';
import { flatWorld, rulesFor } from './helpers';
import { CAMPAIGN, loadScenario } from './campaign-helpers';

/** A flat-topped mesa: walkable top at 12, cliffs all round, plain at 2. */
function mesaWorld() {
  const w = flatWorld(rulesFor());
  for (let z = 50; z <= 56; z++) for (let x = 50; x <= 56; x++) w.map.heights[z * WORLD_SIZE + x] = 12;
  w.map.version++;
  return w;
}

describe('regions', () => {
  it('labels a cliff-ringed mesa top as its own small region', () => {
    const w = mesaWorld();
    const top = regionAt(w.map, 53, 53);
    const plain = regionAt(w.map, 10, 10);
    expect(top).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
    expect(top).not.toBe(plain);
    expect(regionSize(w.map, top)).toBeLessThan(MAJOR_REGION);
    expect(regionSize(w.map, plain)).toBeGreaterThan(MAJOR_REGION);
  });

  it('follows terrain edits (a ramp joins the mesa to the plain)', () => {
    const w = mesaWorld();
    expect(regionAt(w.map, 53, 53)).not.toBe(regionAt(w.map, 10, 10));
    // Bury the cliffs in a gentle cone of earth.
    for (let z = 36; z <= 70; z++) {
      for (let x = 36; x <= 70; x++) {
        const d = Math.max(0, Math.abs(x - 53) - 3, Math.abs(z - 53) - 3);
        w.map.heights[z * WORLD_SIZE + x] = Math.max(2, 12 - d * 1.5);
      }
    }
    w.map.version++;
    expect(regionAt(w.map, 53, 53)).toBe(regionAt(w.map, 10, 10));
  });

  it('never spawns a unit onto a stranded mesa top', () => {
    const w = mesaWorld();
    for (let i = 0; i < 20; i++) {
      const u = w.spawnNearWalkable('brave', 'player', 53, 53)!;
      expect(u).toBeTruthy();
      const r = regionAt(w.map, Math.round(u.x), Math.round(u.z));
      expect(regionSize(w.map, r)).toBeGreaterThanOrEqual(MAJOR_REGION);
    }
  });

  it('a path onto the mesa ends at its foot, cheaply, instead of searching the planet', () => {
    const w = mesaWorld();
    pathStats.expansions = 0;
    const path = findPath(w.map, 20, 53, 53, 53);
    // Either a short walk to the cliff foot, or a quick refusal — never a full-budget search.
    expect(pathStats.expansions).toBeLessThan(1500);
    if (path && path.length) {
      const end = path[path.length - 1];
      expect(regionAt(w.map, end.x, end.z)).toBe(regionAt(w.map, 20, 53));
    }
  });

  it('a goal across open sea is refused without a full-budget search', () => {
    const w = flatWorld(rulesFor());
    // Two bands of land running all the way round, sea between them both ways.
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) w.map.heights[z * WORLD_SIZE + x] = (x >= 30 && x < 50) || (x >= 90 && x < 110) ? 2 : -3;
    }
    w.map.version++;
    pathStats.expansions = 0;
    expect(findPath(w.map, 40, 40, 100, 40)).toBeNull();
    expect(pathStats.expansions).toBeLessThan(50);
  });

  it('campaign maps: nobody starts stranded, and homes and stones sit on major ground', async () => {
    for (const s of CAMPAIGN) {
      const w = await loadScenario(s.id);
      for (const u of w.units) {
        if (u.hidden || u.joins) continue; // (stranded kin are stranded on purpose: chapter 1's sandbar)
        const r = regionAt(w.map, Math.round(u.x), Math.round(u.z));
        expect(regionSize(w.map, r), `${s.id}: ${u.kind} of ${u.tribe} at ${u.x.toFixed(0)},${u.z.toFixed(0)}`).toBeGreaterThanOrEqual(MAJOR_REGION);
      }
      for (const id of w.activeTribes()) {
        const h = w.tribes[id]!.home;
        expect(regionSize(w.map, regionNear(w.map, h.x, h.z)), `${s.id}: home of ${id}`).toBeGreaterThanOrEqual(MAJOR_REGION);
      }
    }
  });

  it('a move order across the sea walks to the facing shore; a hopeless one says so', () => {
    const w = flatWorld(rulesFor());
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) w.map.heights[z * WORLD_SIZE + x] = (x >= 30 && x < 50) || (x >= 60 && x < 110) ? 2 : -3;
    }
    w.map.version++;
    const u = w.spawn('warrior', 'player', 40, 40);
    w.orderMove([u.id], 65, 40); // 15 tiles past our shore, across a 10-tile strait
    expect(u.state).toBe('moving');
    expect(u.path[u.path.length - 1].x).toBeGreaterThan(44);
    w.events.length = 0;
    w.orderMove([u.id], 100, 40); // far inland on the other side
    expect(w.events.some((e) => e.type === 'denied')).toBe(true);
  });
});
