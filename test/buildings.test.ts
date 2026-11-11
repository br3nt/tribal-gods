import { describe, expect, it } from 'vitest';
import { BUILDINGS, DWELLING_TIERS, ECONOMY, UNITS } from '../src/sim/catalog';
import { tileIndex } from '../src/sim/pathfinding';
import { eventsOf, flatWorld, rulesFor, run } from './helpers';

describe('placement', () => {
  it('footprints are size x size tiles', () => {
    const w = flatWorld();
    w.tribes.player!.wood = 100;
    const hut = w.spawnBuilding('player', 'hut', 40, 40);
    const shrine = w.spawnBuilding('player', 'shrine', 60, 60);
    expect(hut.size).toBe(3);
    expect(shrine.size).toBe(5);
    expect(w.obstacles.has(tileIndex(41, 39))).toBe(true);
    expect(w.obstacles.has(tileIndex(42, 40))).toBe(false);
    expect(w.obstacles.has(tileIndex(62, 58))).toBe(true);
    expect(w.obstacles.has(tileIndex(63, 60))).toBe(false);
    // overlapping placement refused
    expect(w.canPlaceBuilding('player', 'hut', 43, 40)).toBe(false);
    expect(w.canPlaceBuilding('player', 'hut', 44, 40)).toBe(true);
  });

  it('prerequisites gate placement and buildState explains why', () => {
    const w = flatWorld();
    w.tribes.player!.wood = 100;
    let s = w.buildState('player', 'fireHut');
    expect(s.unlocked).toBe(false);
    expect(s.reason).toMatch(/War Lodge/);
    expect(w.placeBuilding('player', 'fireHut', 40, 40)).toBe(false);
    const lodge = w.spawnBuilding('player', 'warriorHut', 50, 50, { complete: false });
    expect(w.buildState('player', 'fireHut').unlocked).toBe(false); // must be complete
    lodge.progress = 1;
    s = w.buildState('player', 'fireHut');
    expect(s).toEqual({ allowed: true, unlocked: true, affordable: true, reason: null });
    expect(w.placeBuilding('player', 'fireHut', 40, 40)).toBe(true);
    expect(w.tribes.player!.wood).toBe(100 - BUILDINGS.fireHut.wood);
  });

  it('buildState reports unaffordable and disallowed', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false, loadout: { buildings: ['hut'] } }, { id: 'red', ai: false }]));
    w.tribes.player!.wood = 2;
    expect(w.buildState('player', 'hut')).toMatchObject({ allowed: true, affordable: false });
    expect(w.buildState('player', 'hut').reason).toMatch(/wood/i);
    expect(w.buildState('player', 'tower')).toMatchObject({ allowed: false });
    expect(w.buildState('player', 'tower').reason).toBeTruthy();
  });

  it('building hp comes from the catalog and builders raise it', () => {
    const w = flatWorld();
    w.tribes.player!.wood = 100;
    w.placeBuilding('player', 'hut', 40, 40);
    const b = w.buildings[0];
    expect(b.maxHp).toBe(BUILDINGS.hut.hp);
    for (let i = 0; i < 4; i++) w.spawn('brave', 'player', 38 + i, 44);
    run(w, 30);
    expect(b.progress).toBe(1);
    expect(b.hp).toBe(BUILDINGS.hut.hp);
    expect(eventsOf(w, 'built').length).toBe(1);
  });

  it('demolish refunds half the wood', () => {
    const w = flatWorld();
    w.tribes.player!.wood = 0;
    const b = w.spawnBuilding('player', 'warriorHut', 40, 40);
    w.demolish(b.id);
    expect(w.buildings.length).toBe(0);
    expect(w.tribes.player!.wood).toBe(Math.floor(BUILDINGS.warriorHut.wood / 2));
    expect(w.obstacles.has(tileIndex(40, 39))).toBe(false);
  });
});

describe('dwellings', () => {
  it('a dwelling full for growSeconds grows a tier, paying growWood', () => {
    const w = flatWorld();
    const hut = w.spawnBuilding('player', 'hut', 40, 40);
    w.tribes.player!.wood = 10;
    for (let i = 0; i < 3; i++) {
      const u = w.spawn('brave', 'player', 40, 42);
      w.moveIn(u, hut);
    }
    expect(hut.residents).toBe(3);
    expect(w.dwellingCapacity(hut)).toBe(DWELLING_TIERS[0].capacity);
    run(w, DWELLING_TIERS[1].growSeconds + 1);
    expect(hut.tier).toBe(1);
    expect(w.dwellingCapacity(hut)).toBe(DWELLING_TIERS[1].capacity);
    expect(w.tribes.player!.wood).toBeLessThanOrEqual(10 - DWELLING_TIERS[1].growWood);
    expect(eventsOf(w, 'dwellingGrow').length).toBe(1);
  });

  it('no wood, no growth', () => {
    const w = flatWorld();
    const hut = w.spawnBuilding('player', 'hut', 40, 40);
    w.tribes.player!.wood = 0;
    for (let i = 0; i < 3; i++) w.moveIn(w.spawn('brave', 'player', 40, 42), hut);
    run(w, 50);
    expect(hut.tier).toBe(0);
  });

  it('pop cap comes from dwelling capacity', () => {
    const w = flatWorld();
    expect(w.tribeSummary('player').popCap).toBe(ECONOMY.popBase);
    const a = w.spawnBuilding('player', 'hut', 40, 40);
    w.spawnBuilding('player', 'hut', 50, 40);
    a.tier = 2;
    expect(w.tribeSummary('player').popCap).toBe(
      Math.floor(ECONOMY.popBase + (DWELLING_TIERS[0].capacity + DWELLING_TIERS[2].capacity) * ECONOMY.popPerBed),
    );
  });

  it('occupied dwellings breed villagers', () => {
    const w = flatWorld();
    const hut = w.spawnBuilding('player', 'hut', 40, 40);
    w.moveIn(w.spawn('brave', 'player', 40, 42), hut);
    run(w, DWELLING_TIERS[0].breedSeconds * 2.5);
    expect(w.units.filter((u) => u.tribe === 'player').length).toBeGreaterThan(1);
  });
});

describe('lumberyard', () => {
  it('is a second wood drop-off and speeds up chopping nearby', () => {
    const w = flatWorld();
    w.tribes.player!.home = { x: 10, z: 10 };
    w.spawnBuilding('player', 'lumberyard', 60, 60);
    w.trees = [{ x: 64, z: 64, alive: true, regrow: 0, burning: 0 }];
    const v = w.spawn('brave', 'player', 63, 63);
    w.tribes.player!.wood = 0;
    expect(w.chopSecondsFor(v)).toBeLessThan(w.chopSecondsFor(w.spawn('brave', 'player', 10, 12)) * 0.8);
    run(w, 8);
    // delivered at the yard, not 50 tiles away at home
    expect(w.tribes.player!.wood).toBe(1);
    expect(Math.hypot(v.x - 60, v.z - 60)).toBeLessThan(8);
    // and the yard replants faster than the wild regrows
    expect(w.trees[0].alive).toBe(false);
    expect(w.trees[0].regrow).toBeLessThan(60);
  });
});

describe('garrisons', () => {
  it('towers hold up to two fighters who shoot from the top; eject frees them', () => {
    const w = flatWorld();
    const tower = w.spawnBuilding('player', 'tower', 40, 40);
    const a = w.spawn('warrior', 'player', 40, 43);
    const b = w.spawn('firewarrior', 'player', 41, 43);
    const c = w.spawn('warrior', 'player', 39, 43);
    const v = w.spawn('brave', 'player', 42, 43);
    w.orderGarrison([a.id, b.id, c.id, v.id], tower.id);
    run(w, 5);
    expect(tower.garrison.sort()).toEqual([a.id, b.id].sort());
    expect(a.hidden && b.hidden).toBe(true);
    expect(c.hidden).toBe(false);
    expect(v.hidden).toBe(false);
    const enemy = w.spawn('warrior', 'red', 40, 47);
    enemy.task = 'none';
    const hp0 = enemy.hp;
    run(w, 2);
    expect(enemy.hp).toBeLessThan(hp0);
    w.ejectGarrison(tower.id);
    expect(tower.garrison.length).toBe(0);
    expect(a.hidden).toBe(false);
  });

  it('a full tower refuses out loud: the result says who, they walk to the door, the player hears denied', () => {
    const w = flatWorld();
    const tower = w.spawnBuilding('player', 'tower', 40, 40);
    const a = w.spawn('warrior', 'player', 40, 43);
    const b = w.spawn('warrior', 'player', 41, 43);
    w.orderGarrison([a.id, b.id], tower.id);
    run(w, 5);
    expect(tower.garrison.length).toBe(2);
    const c = w.spawn('warrior', 'player', 40, 52);
    expect(w.canGarrison([c.id], tower.id)).toBe(false);
    w.events = [];
    const r = w.orderGarrison([c.id], tower.id);
    expect(r.accepted).toEqual([]);
    expect(r.refused).toEqual([c.id]);
    expect(eventsOf(w, 'denied')).toHaveLength(1);
    expect(c.state).toBe('moving');
    run(w, 6);
    const door = w.doorOf(tower);
    expect(Math.hypot(c.x - door.x, c.z - door.z)).toBeLessThan(3);
    expect(c.hidden).toBe(false);
  });

  it('canGarrison asks the sim: room, completion and who fits', () => {
    const w = flatWorld();
    const tower = w.spawnBuilding('player', 'tower', 40, 40);
    const site = w.spawnBuilding('player', 'tower', 60, 40, { complete: false });
    const shrine = w.spawnBuilding('player', 'shrine', 40, 60);
    const fighter = w.spawn('warrior', 'player', 40, 44);
    const villager = w.spawn('brave', 'player', 41, 44);
    const foe = w.spawn('warrior', 'red', 42, 44);
    expect(w.canGarrison([fighter.id], tower.id)).toBe(true);
    expect(w.canGarrison([villager.id], tower.id)).toBe(false);
    expect(w.canGarrison([villager.id, fighter.id], tower.id)).toBe(true);
    expect(w.canGarrison([foe.id], tower.id)).toBe(false);
    expect(w.canGarrison([fighter.id], site.id)).toBe(false);
    expect(w.canGarrison([villager.id], shrine.id)).toBe(true);
    expect(w.canGarrison([fighter.id], shrine.id)).toBe(false);
  });

  it('a garrison order whose door cannot be reached is refused, not silently dropped', () => {
    const w = flatWorld();
    const tower = w.spawnBuilding('player', 'tower', 40, 40);
    // The fighter stands on an island ringed by sea.
    for (let z = 60; z <= 76; z++) for (let x = 60; x <= 76; x++) {
      if (x < 63 || x > 73 || z < 63 || z > 73) w.map.heights[z * 128 + x] = -1;
    }
    w.map.version++;
    const f = w.spawn('warrior', 'player', 68, 68);
    w.events = [];
    const r = w.orderGarrison([f.id], tower.id);
    expect(r.accepted).toEqual([]);
    expect(r.refused).toEqual([f.id]);
    expect(eventsOf(w, 'denied')).toHaveLength(1);
  });

  it('a fighter across a narrow channel from the door is refused, never let in from the far shore', () => {
    const w = flatWorld();
    const tower = w.spawnBuilding('player', 'tower', 40, 40);
    const door = w.doorOf(tower);
    // A 3-tile channel just past the door, and a second band of sea further
    // round (the planet wraps), so the fighter's side is cut off entirely.
    for (let x = 0; x < 128; x++) {
      for (let z = door.z + 2; z <= door.z + 4; z++) w.map.heights[z * 128 + x] = -1;
      for (let z = door.z + 30; z <= door.z + 34; z++) w.map.heights[(z % 128) * 128 + x] = -1;
    }
    w.map.version++;
    const f = w.spawn('warrior', 'player', door.x, door.z + 6);
    const r = w.orderGarrison([f.id], tower.id);
    expect(r.refused).toEqual([f.id]);
    run(w, 6);
    expect(tower.garrison).toEqual([]);
    expect(f.hidden).toBe(false);
  });

  it('an empty tower does not shoot', () => {
    const w = flatWorld();
    w.spawnBuilding('player', 'tower', 40, 40);
    const enemy = w.spawn('brave', 'red', 40, 44);
    run(w, 3);
    expect(enemy.hp).toBe(UNITS.brave.hp);
  });

  it('shrines take villagers only, up to the worshipper limit', () => {
    const w = flatWorld();
    const shrine = w.spawnBuilding('player', 'shrine', 40, 40);
    const ids = [];
    for (let i = 0; i < ECONOMY.shrineWorshippers + 2; i++) ids.push(w.spawn('brave', 'player', 36 + i, 45).id);
    const fighter = w.spawn('warrior', 'player', 40, 46);
    w.orderGarrison([...ids, fighter.id], shrine.id);
    run(w, 10);
    expect(shrine.garrison.length).toBe(ECONOMY.shrineWorshippers);
    expect(fighter.hidden).toBe(false);
    expect(w.tribeSummary('player').praying).toBe(ECONOMY.shrineWorshippers);
  });
});
