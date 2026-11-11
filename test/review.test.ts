import { describe, expect, it } from 'vitest';
import { CHANT, DWELLING_TIERS } from '../src/sim/catalog';
import { castSpell } from '../src/sim/spells';
import { World } from '../src/sim/world-state';
import { flatWorld, rulesFor, run } from './helpers';

/** Every counter agrees with the units it counts. */
function expectConsistent(w: World) {
  for (const b of w.buildings) {
    for (const id of b.garrison) expect(w.unitById(id)?.garrison).toBe(b.id);
    const inside = w.units.filter((u) => u.hidden && u.home === b.id && u.garrison < 0).length;
    expect(b.residents).toBe(inside);
  }
  for (const u of w.units) {
    if (u.garrison >= 0) expect(u.hidden).toBe(true);
  }
}

describe('review regressions', () => {
  it('destroying a dwelling leaves its villager in the shrine', () => {
    const w = flatWorld();
    const hut = w.spawnBuilding('player', 'hut', 40, 40);
    const shrine = w.spawnBuilding('player', 'shrine', 60, 40);
    const v = w.spawn('brave', 'player', 60, 44);
    v.home = hut.id;
    w.orderGarrison([v.id], shrine.id);
    run(w, 4);
    expect(shrine.garrison).toEqual([v.id]);
    w.demolish(hut.id);
    expect(v.garrison).toBe(shrine.id);
    expect(v.hidden).toBe(true);
    expect(v.home).toBe(-1);
    expectConsistent(w);
  });

  it('a full dwelling that cannot pay to grow lets its residents out', () => {
    const w = flatWorld();
    const hut = w.spawnBuilding('player', 'hut', 40, 40);
    w.tribes.player!.wood = 0;
    for (let i = 0; i < 3; i++) w.moveIn(w.spawn('brave', 'player', 40, 42), hut);
    run(w, DWELLING_TIERS[1].growSeconds);
    // Someone steps out to fetch wood (they may come back in later: watch, don't snapshot).
    let fewest = hut.residents;
    for (let i = 0; i < 40; i++) {
      run(w, 1);
      fewest = Math.min(fewest, hut.residents);
    }
    expect(fewest).toBeLessThan(3);
    expectConsistent(w);
  });

  it('villagers give up on an unreachable tree and chop reachable ones, cheaply', () => {
    const w = flatWorld();
    // a moated islet with one tree, right next to the villagers
    for (let z = 26; z <= 34; z++) for (let x = 26; x <= 34; x++) if (Math.max(Math.abs(x - 30), Math.abs(z - 30)) >= 3) w.map.heights[z * 128 + x] = -3;
    w.map.version++;
    w.trees = [{ x: 30, z: 30, alive: true, regrow: 0, burning: 0 }];
    for (let i = 0; i < 6; i++) w.trees.push({ x: 50 + i, z: 20, alive: true, regrow: 0, burning: 0 });
    w.tribes.player!.home = { x: 40, z: 20 };
    for (let i = 0; i < 6; i++) w.spawn('brave', 'player', 36 + i, 24);
    w.tribes.player!.wood = 0;
    const t0 = performance.now();
    run(w, 30);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(w.tribes.player!.wood).toBeGreaterThan(0);
  });

  it('Undertow drowns the buildings and trees it sinks', () => {
    const w = flatWorld();
    w.spawn('shaman', 'player', 20, 20);
    const hut = w.spawnBuilding('red', 'hut', 60, 60);
    w.trees = [{ x: 62, z: 58, alive: true, regrow: 0, burning: 0 }];
    castSpell(w, 'sink', 60, 60, 20, 20, 'player');
    run(w, 40);
    expect(w.buildings.includes(hut)).toBe(false);
    expect(w.trees[0].alive).toBe(false);
  });

  it('two rival chanters do not freeze each other forever', () => {
    const w = flatWorld();
    const a = w.spawn('chanter', 'player', 40, 40);
    w.spawn('chanter', 'red', 40, 44);
    run(w, CHANT.convertSeconds);
    expect(a.task).not.toBe('chant');
  });

  it('destroyAll with no rivals is not an instant win', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false, allies: ['red'] }, { id: 'red', ai: false }]));
    w.spawn('brave', 'player', 20, 20);
    run(w, 1);
    expect(w.gameOver).toBeNull();
  });

  it('replaying a seed on the same World gives the same ids', () => {
    const w = new World();
    w.reset(9, { playerCiv: 'forest', difficulty: 'normal' });
    const ids = w.units.map((u) => u.id).join();
    w.reset(9, { playerCiv: 'forest', difficulty: 'normal' });
    expect(w.units.map((u) => u.id).join()).toBe(ids);
  });

  it('counters stay consistent through an AI war', () => {
    const w = new World();
    w.reset(11, { playerCiv: 'forest', difficulty: 'normal' }, rulesFor([{ id: 'red', ai: true }, { id: 'gold', ai: true }]));
    for (let m = 0; m < 16; m++) {
      for (let i = 0; i < 900; i++) w.tick(1 / 15);
      w.events.length = 0;
      expectConsistent(w);
    }
  }, 120_000);
});
