import { describe, expect, it } from 'vitest';
import { SPELLS, spellDef, SpellId, UNITS } from '../src/sim/catalog';
import { castSpell } from '../src/sim/spells';
import { eventsOf, flatWorld, run } from './helpers';

function world() {
  const w = flatWorld();
  w.spawn('shaman', 'player', 20, 20);
  return w;
}
const cast = (w: ReturnType<typeof world>, id: SpellId, x: number, z: number) =>
  castSpell(w, id, x, z, 20, 20, 'player');

describe('new spells', () => {
  it('ward halves damage to allied units and buildings in radius for its duration', () => {
    const w = world();
    const a = w.spawn('warrior', 'player', 30, 30);
    const far = w.spawn('warrior', 'player', 50, 50);
    const hut = w.spawnBuilding('player', 'hut', 33, 30);
    const foe = w.spawn('warrior', 'red', 31, 31);
    cast(w, 'ward', 30, 30);
    expect(eventsOf(w, 'wardCast').length).toBe(1);
    expect(w.auras.some((x) => x.kind === 'ward')).toBe(true);
    expect(foe.wardTime).toBe(0);
    w.hurtUnit(a, 10);
    w.hurtUnit(far, 10);
    expect(UNITS.warrior.hp - a.hp).toBeCloseTo((UNITS.warrior.hp - far.hp) / 2);
    w.hurtBuilding(hut, 10);
    expect(hut.maxHp - hut.hp).toBeCloseTo(5);
    run(w, spellDef('ward').duration + 1);
    expect(a.wardTime).toBe(0);
    expect(w.auras.some((x) => x.kind === 'ward')).toBe(false);
  });

  it('warsong makes allied fighters faster and quicker to strike', () => {
    const w = world();
    const a = w.spawn('warrior', 'player', 30, 30);
    cast(w, 'warsong', 30, 30);
    expect(eventsOf(w, 'warsongCast').length).toBe(1);
    expect(a.warsongTime).toBeGreaterThan(0);
    expect(w.unitSpeed(a)).toBeCloseTo(UNITS.warrior.speed * 1.33, 1);
    expect(w.unitCooldown(a)).toBeCloseTo(UNITS.warrior.cooldown / 1.33, 1);
  });

  it('bloom regrows felled trees, sprouts new ones, and heals allies', () => {
    const w = world();
    w.trees = [{ x: 31, z: 30, alive: false, regrow: 90, burning: 0 }];
    const a = w.spawn('warrior', 'player', 30, 30);
    a.hp = 5;
    cast(w, 'bloom', 30, 30);
    expect(eventsOf(w, 'bloomCast').length).toBe(1);
    expect(w.trees[0].alive).toBe(true);
    expect(w.trees.length).toBeGreaterThan(1);
    run(w, spellDef('bloom').duration);
    expect(a.hp).toBeGreaterThan(15);
  });

  it('cyclone wanders, flings and hurts units, damages buildings', () => {
    const w = world();
    const victims = [];
    for (let i = 0; i < 6; i++) victims.push(w.spawn('brave', 'red', 40 + (i % 3), 40 + Math.floor(i / 3)));
    const hut = w.spawnBuilding('red', 'hut', 44, 40);
    cast(w, 'cyclone', 41, 40);
    const aura = w.auras.find((a) => a.kind === 'cyclone')!;
    expect(aura).toBeTruthy();
    const x0 = aura.x;
    const z0 = aura.z;
    run(w, 4);
    expect(eventsOf(w, 'cycloneTouch').length).toBeGreaterThan(0);
    expect(Math.hypot(aura.x - x0, aura.z - z0)).toBeGreaterThan(0.5);
    expect(victims.some((v) => v.lifted > 0) || eventsOf(w, 'cycloneTouch').length > 1).toBe(true);
    const hurt = victims.filter((v) => v.hp < UNITS.brave.hp || !w.units.includes(v));
    expect(hurt.length).toBeGreaterThan(0);
    run(w, spellDef('cyclone').duration);
    expect(hut.hp).toBeLessThan(hut.maxHp);
    expect(w.auras.some((a) => a.kind === 'cyclone')).toBe(false);
  });

  it('emberfall rains repeated strikes that ignite trees and buildings', () => {
    const w = world();
    for (let x = 34; x <= 46; x++) for (let z = 34; z <= 46; z += 2) w.trees.push({ x, z, alive: true, regrow: 0, burning: 0 });
    const hut = w.spawnBuilding('red', 'hut', 40, 40);
    cast(w, 'emberfall', 40, 40);
    run(w, spellDef('emberfall').duration);
    expect(eventsOf(w, 'emberStrike').length).toBeGreaterThan(5);
    expect(w.trees.some((t) => t.burning > 0 || !t.alive)).toBe(true);
    expect(hut.hp).toBeLessThan(hut.maxHp);
  });

  it('sink lowers the land in radius below sea level, permanently', () => {
    const w = world();
    cast(w, 'sink', 60, 60);
    run(w, 2);
    expect(eventsOf(w, 'sinkRumble').length).toBeGreaterThan(0);
    expect(w.map.heightAt(60, 60)).toBeLessThan(2);
    expect(w.map.heightAt(60, 60)).toBeGreaterThan(0);
    run(w, spellDef('sink').duration + 30);
    expect(w.map.heightAt(60, 60)).toBeLessThan(0);
    expect(w.map.heightAt(63, 62)).toBeLessThan(0);
    expect(w.map.heightAt(75, 60)).toBe(2);
  });

  it('lightning sets wood alight', () => {
    const w = world();
    const hut = w.spawnBuilding('red', 'hut', 40, 40);
    cast(w, 'lightning', 40, 40);
    expect(hut.burning).toBeGreaterThan(0);
  });

  it('every catalog spell can be cast without throwing and emits something', () => {
    for (const s of SPELLS) {
      const w = world();
      w.spawn('brave', 'red', 30, 30);
      w.spawn('wildman', 'wild', 30, 31);
      cast(w, s.id, 30, 30);
      run(w, s.duration + 1);
      expect(w.events.length).toBeGreaterThan(0);
    }
  });
});

describe('craters', () => {
  it('a Blast on a causeway dents it but leaves it walkable land (a fight on a bridge does not sink it)', async () => {
    const { regionNear } = await import('../src/sim/regions');
    const w = world();
    // Sea everywhere but a 3-wide causeway along z = 40 between two shores.
    for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) w.map.heights[z * 128 + x] = x < 30 || x > 60 ? 2 : Math.abs(z - 40) <= 1 ? 1.8 : -2.5;
    w.map.version++;
    expect(regionNear(w.map, 20, 40)).toBe(regionNear(w.map, 70, 40));
    cast(w, 'blast', 45, 40);
    expect(w.map.heightAt(45, 40)).toBeGreaterThan(0.2);
    expect(w.map.heightAt(45, 40)).toBeLessThan(1.8);
    expect(regionNear(w.map, 20, 40)).toBe(regionNear(w.map, 70, 40));
  });

  it('a Blast still digs a real crater in open ground', () => {
    const w = world();
    const before = w.map.heightAt(80, 80);
    cast(w, 'blast', 80, 80);
    expect(w.map.heightAt(80, 80)).toBeLessThan(before - 1);
  });
});
