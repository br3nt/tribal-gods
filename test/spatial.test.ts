import { describe, expect, it } from 'vitest';
import { WORLD_SIZE } from '../src/config';
import { wrapDelta } from '../src/core/util';
import { Rng } from '../src/sim/rng';
import { UnitGrid } from '../src/sim/spatial';
import type { Unit } from '../src/sim/world-state';
import { flatWorld } from './helpers';

const fake = (id: number, x: number, z: number, hidden = false) => ({ id, x, z, hidden }) as Unit;
const near = (grid: UnitGrid, x: number, z: number, r: number) => {
  const out: number[] = [];
  grid.forEachNear(x, z, r, (u) => {
    if (Math.hypot(wrapDelta(u.x - x, WORLD_SIZE), wrapDelta(u.z - z, WORLD_SIZE)) <= r) out.push(u.id);
  });
  return out.sort((a, b) => a - b);
};

describe('spatial hash', () => {
  it('finds neighbours across the wrap seam, never twice, and skips the hidden', () => {
    const g = new UnitGrid();
    g.rebuild([fake(1, 127.5, 0.5), fake(2, 0.5, 127.5), fake(3, 64, 64), fake(4, 1, 1, true)]);
    expect(near(g, 0.2, 0.2, 3)).toEqual([1, 2]);
    expect(near(g, 64, 64, 200)).toEqual([1, 2, 3]); // wider than the planet: each once
  });

  it('agrees with a brute-force scan on random crowds', () => {
    const rng = new Rng(9);
    const units = Array.from({ length: 400 }, (_, i) => fake(i, rng.next() * WORLD_SIZE, rng.next() * WORLD_SIZE));
    const g = new UnitGrid();
    g.rebuild(units);
    for (let t = 0; t < 200; t++) {
      const x = rng.next() * WORLD_SIZE;
      const z = rng.next() * WORLD_SIZE;
      const r = 1 + rng.next() * 20;
      const brute = units.filter((u) => Math.hypot(wrapDelta(u.x - x, WORLD_SIZE), wrapDelta(u.z - z, WORLD_SIZE)) <= r).map((u) => u.id);
      expect(near(g, x, z, r)).toEqual(brute.sort((a, b) => a - b));
    }
  });
});

describe('id lookups', () => {
  it('unitById / getBuilding stay right through spawn, death, removal and array replacement', () => {
    const w = flatWorld();
    const a = w.spawn('brave', 'player', 10, 10);
    const b = w.spawn('warrior', 'red', 12, 10);
    const hut = w.spawnBuilding('player', 'hut', 30, 30);
    expect(w.unitById(a.id)).toBe(a);
    expect(w.unitById(b.id)).toBe(b);
    expect(w.getBuilding(hut.id)).toBe(hut);
    b.hp = 0;
    w.tick(1 / 15);
    expect(w.unitById(b.id)).toBeUndefined();
    expect(w.unitById(a.id)).toBe(a);
    w.demolish(hut.id);
    expect(w.getBuilding(hut.id)).toBeUndefined();
    w.units = [];
    expect(w.unitById(a.id)).toBeUndefined();
    const c = w.spawn('brave', 'player', 10, 10);
    expect(w.unitById(c.id)).toBe(c);
  });
});
