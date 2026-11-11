import { describe, expect, it } from 'vitest';
import { CHANT, ECONOMY, UNITS } from '../src/sim/catalog';
import { eventsOf, flatWorld, run } from './helpers';

describe('training', () => {
  it('a queue consumes an idle villager and trainWood, takes trainSeconds, walks to the rally', () => {
    const w = flatWorld();
    const lodge = w.spawnBuilding('player', 'warriorHut', 40, 40);
    w.tribes.player!.wood = 10;
    const v = w.spawn('brave', 'player', 40, 44);
    w.spawn('brave', 'player', 70, 70).task = 'build'; // busy: must not be taken
    expect(w.queueTraining(lodge.id, 1)).toBe(1);
    w.setRally(lodge.id, 50, 44);
    run(w, 2 + UNITS.warrior.trainSeconds + 6);
    expect(v.kind).toBe('warrior');
    expect(v.hp).toBe(UNITS.warrior.hp);
    expect(w.tribes.player!.wood).toBe(10 - UNITS.warrior.trainWood);
    expect(eventsOf(w, 'trained').length).toBe(1);
    expect(lodge.queue).toBe(0);
    expect(Math.hypot(v.x - 50, v.z - 44)).toBeLessThan(2.5);
    expect(w.units.filter((u) => u.kind === 'brave').length).toBe(1);
  });

  it('queue length is capped, negative counts cancel', () => {
    const w = flatWorld();
    const lodge = w.spawnBuilding('player', 'warriorHut', 40, 40);
    expect(w.queueTraining(lodge.id, 50)).toBe(ECONOMY.trainQueueMax);
    expect(w.queueTraining(lodge.id, -3)).toBe(ECONOMY.trainQueueMax - 3);
    expect(w.queueTraining(lodge.id, -100)).toBe(0);
  });

  it('waits for wood and idle villagers', () => {
    const w = flatWorld();
    const lodge = w.spawnBuilding('player', 'fireHut', 40, 40);
    w.tribes.player!.wood = 0;
    const v = w.spawn('brave', 'player', 40, 44);
    w.queueTraining(lodge.id, 1);
    run(w, 10);
    expect(v.kind).toBe('brave');
    w.tribes.player!.wood = 3;
    run(w, 15);
    expect(v.kind).toBe('firewarrior');
  });

  it('the human tribe is never drafted automatically', () => {
    const w = flatWorld();
    w.spawnBuilding('player', 'warriorHut', 40, 40);
    w.tribes.player!.wood = 50;
    for (let i = 0; i < 8; i++) w.spawn('brave', 'player', 36 + i, 45);
    run(w, 30);
    expect(w.units.filter((u) => u.kind === 'warrior').length).toBe(0);
  });

  it('every training building trains its catalog unit', () => {
    const w = flatWorld();
    w.tribes.player!.wood = 100;
    const halls = (['wardenHall', 'chantHall'] as const).map((k, i) => w.spawnBuilding('player', k, 40 + i * 12, 40));
    for (const h of halls) {
      w.spawn('brave', 'player', h.x, h.z + 4);
      w.queueTraining(h.id, 1);
    }
    run(w, 20);
    expect(w.units.filter((u) => u.kind === 'warden').length).toBe(1);
    expect(w.units.filter((u) => u.kind === 'chanter').length).toBe(1);
  });
});

describe('warden', () => {
  it('halves spell damage on top of armor', () => {
    const w = flatWorld();
    const d = w.spawn('warden', 'red', 40, 40);
    const r = w.spawn('warrior', 'red', 40, 40);
    w.hurtUnit(d, 20, { spell: true });
    w.hurtUnit(r, 20, { spell: true });
    expect(UNITS.warden.hp - d.hp).toBeCloseTo(20 * 0.5 * (1 - UNITS.warden.armor));
    expect(UNITS.warrior.hp - r.hp).toBeCloseTo(20 * (1 - UNITS.warrior.armor));
  });

  it('wrecks buildings faster than a warrior', () => {
    const w = flatWorld();
    const h1 = w.spawnBuilding('red', 'hut', 40, 40);
    const h2 = w.spawnBuilding('red', 'hut', 70, 40);
    w.spawn('warden', 'player', 40, 43);
    w.spawn('warrior', 'player', 70, 43);
    run(w, 6);
    expect(h1.maxHp - h1.hp).toBeGreaterThan((h2.maxHp - h2.hp) * 1.4);
  });
});

describe('chanter', () => {
  it('pacifies enemies in radius, and after convertSeconds they defect', () => {
    const w = flatWorld();
    const c = w.spawn('chanter', 'player', 40, 40);
    const e = w.spawn('warrior', 'red', 43, 40);
    const leader = w.spawn('shaman', 'red', 40, 43);
    const hp0 = c.hp;
    run(w, 3);
    expect(eventsOf(w, 'chantStart').length).toBeGreaterThan(0);
    expect(e.pacified).toBeGreaterThan(0);
    expect(c.hp).toBe(hp0); // a pacified warrior does not swing
    run(w, CHANT.convertSeconds);
    expect(e.tribe).toBe('player');
    expect(eventsOf(w, 'defect').length).toBe(1);
    expect(leader.tribe).toBe('red'); // leaders are immune
  });

  it('wardens are pacified but never defect', () => {
    const w = flatWorld();
    w.spawn('chanter', 'player', 40, 40);
    const d = w.spawn('warden', 'red', 43, 40);
    run(w, CHANT.convertSeconds + 5);
    expect(d.tribe).toBe('red');
  });

  it('an enemy chanter in range breaks the chant', () => {
    const w = flatWorld();
    w.spawn('chanter', 'player', 40, 40);
    w.spawn('chanter', 'red', 40, 44);
    const e = w.spawn('warrior', 'red', 43, 40);
    run(w, CHANT.convertSeconds + 4);
    expect(e.tribe).toBe('red');
  });
});

describe('burning', () => {
  it('a burning building takes damage until it burns out', () => {
    const w = flatWorld();
    const b = w.spawnBuilding('red', 'hut', 40, 40);
    w.ignite(b);
    expect(eventsOf(w, 'fireStart').length).toBe(1);
    run(w, 3);
    expect(b.hp).toBeLessThan(b.maxHp);
    run(w, 60);
    expect(b.burning).toBe(0);
  });

  it('fire spreads to adjacent trees', () => {
    const w = flatWorld();
    const b = w.spawnBuilding('red', 'hut', 40, 40);
    w.trees = [{ x: 42, z: 42, alive: true, regrow: 0, burning: 0 }];
    w.ignite(b);
    run(w, 25);
    expect(w.trees[0].alive).toBe(false);
  });

  it('emberthrowers set buildings alight', () => {
    const w = flatWorld();
    const b = w.spawnBuilding('red', 'tower', 40, 40);
    w.spawn('firewarrior', 'player', 40, 46);
    run(w, 30);
    expect(eventsOf(w, 'fireStart').length).toBeGreaterThan(0);
    expect(b.hp).toBeLessThan(b.maxHp);
  });
});
