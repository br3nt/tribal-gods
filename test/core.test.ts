import { describe, expect, it } from 'vitest';
import { UNITS } from '../src/sim/catalog';
import { World } from '../src/sim/world-state';
import { flatWorld, rulesFor, run } from './helpers';

describe('determinism', () => {
  it('the same seed produces the same skirmish, tick for tick', () => {
    const snap = (w: World) =>
      w.units.map((u) => `${u.kind}:${u.tribe}:${u.x.toFixed(3)},${u.z.toFixed(3)}`).join('|') +
      `#${w.buildings.length}`;
    const a = new World();
    const b = new World();
    a.reset(42, { playerCiv: 'forest', difficulty: 'normal' });
    b.reset(42, { playerCiv: 'forest', difficulty: 'normal' });
    expect(snap(a)).toBe(snap(b));
    for (let i = 0; i < 600; i++) {
      a.tick(1 / 15);
      b.tick(1 / 15);
    }
    expect(snap(a)).toBe(snap(b));
  });
});

describe('catalog-driven units', () => {
  it('spawned units take hp/maxHp from the catalog', () => {
    const w = flatWorld();
    for (const kind of Object.keys(UNITS) as (keyof typeof UNITS)[]) {
      const u = w.spawn(kind, 'player', 30, 30);
      expect(u.hp).toBe(UNITS[kind].hp);
      expect(u.maxHp).toBe(UNITS[kind].hp);
    }
  });

  it('armor reduces incoming damage', () => {
    const w = flatWorld();
    const v = w.spawn('brave', 'player', 30, 30);
    const d = w.spawn('warden', 'player', 32, 30);
    w.hurtUnit(v, 10);
    w.hurtUnit(d, 10);
    expect(UNITS.brave.hp - v.hp).toBeCloseTo(10);
    expect(UNITS.warden.hp - d.hp).toBeCloseTo(10 * (1 - UNITS.warden.armor));
  });

  it('a warrior kills an enemy villager it is ordered to attack', () => {
    const w = flatWorld();
    // (villagers run home from soldiers — catch this one on its doorstep)
    const v = w.spawn('brave', 'red', 84, 84);
    const a = w.spawn('warrior', 'player', 87, 84);
    w.orderAttack([a.id], v.id);
    run(w, 20);
    expect(w.units.includes(v)).toBe(false);
  });
});

describe('tribes and hostility', () => {
  it('supports up to four tribes, all hostile by default', () => {
    const w = flatWorld(
      rulesFor([
        { id: 'player', ai: false },
        { id: 'red', ai: false },
        { id: 'gold', ai: false },
      ]),
    );
    expect(w.activeTribes()).toEqual(['player', 'red', 'gold']);
    expect(w.hostile('player', 'red')).toBe(true);
    expect(w.hostile('red', 'gold')).toBe(true);
    expect(w.hostile('player', 'player')).toBe(false);
    expect(w.hostile('player', 'wild')).toBe(false);
    expect(w.tribes.violet).toBeUndefined();
  });

  it('allies do not fight; a third tribe still does', () => {
    const w = flatWorld(
      rulesFor([
        { id: 'player', ai: false, allies: ['gold'] },
        { id: 'red', ai: false },
        { id: 'gold', ai: false, allies: ['player'] },
      ]),
    );
    expect(w.hostile('player', 'gold')).toBe(false);
    expect(w.hostile('gold', 'player')).toBe(false);
    expect(w.hostile('gold', 'red')).toBe(true);
    const g = w.spawn('warrior', 'gold', 84, 87);
    const p = w.spawn('brave', 'player', 86, 87);
    const r = w.spawn('brave', 'red', 84, 84);
    run(w, 25);
    expect(w.units.includes(p)).toBe(true);
    expect(w.units.includes(r)).toBe(false);
    expect(w.units.includes(g)).toBe(true);
  });

  it('random skirmish takes an enemy count of 1..3', () => {
    const w = new World();
    w.reset(5, { playerCiv: 'forest', difficulty: 'normal', enemies: 3 });
    expect(w.activeTribes()).toEqual(['player', 'red', 'gold', 'violet']);
    for (const id of ['red', 'gold', 'violet'] as const) {
      expect(w.tribes[id]!.ai).not.toBeNull();
      expect(w.units.some((u) => u.tribe === id && u.kind === 'shaman')).toBe(true);
    }
    expect(w.tribes.player!.ai).toBeNull();
    w.reset(5, { playerCiv: 'forest', difficulty: 'normal', enemies: 1 });
    expect(w.activeTribes()).toEqual(['player', 'red']);
  });
});

describe('loadouts', () => {
  it('apply start units, wood, spells and allowed buildings per tribe', () => {
    const w = new World();
    w.reset(
      3,
      { playerCiv: 'forest', difficulty: 'normal' },
      rulesFor([
        { id: 'player', ai: false, loadout: { spells: ['blast', 'ward'], buildings: ['hut', 'tower'], startUnits: { brave: 3, warrior: 2 }, startWood: 20 } },
        { id: 'red', ai: false },
      ]),
    );
    const p = w.tribes.player!;
    expect(p.wood).toBe(20);
    expect([...p.known].sort()).toEqual(['blast', 'ward']);
    expect(w.units.filter((u) => u.tribe === 'player' && u.kind === 'brave').length).toBe(3);
    expect(w.units.filter((u) => u.tribe === 'player' && u.kind === 'warrior').length).toBe(2);
    expect(w.units.filter((u) => u.tribe === 'player' && u.kind === 'shaman').length).toBe(1);
    expect(w.buildState('player', 'warriorHut').allowed).toBe(false);
    expect(w.buildState('player', 'tower').allowed).toBe(true);
    // red got the defaults: starters only
    expect([...w.tribes.red!.known].sort()).toEqual(['blast', 'convert']);
  });
});
