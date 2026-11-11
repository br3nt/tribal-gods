/**
 * The rival gods' judgement: casting with intent and restraint, keeping the
 * leader out of pointless danger, and an answer to water (Causeway).
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, WORLD_SIZE } from '../src/config';
import { findCrossing } from '../src/sim/crossing';
import { regionNear } from '../src/sim/regions';
import type { World } from '../src/sim/world-state';
import { flatWorld, HOMES, rulesFor, run } from './helpers';

const N = WORLD_SIZE;

/** Red is an awake AI god with full spell books; the player is inert. */
function duel(spells: string[] = ['blast', 'convert', 'lightning']) {
  const w = flatWorld(
    rulesFor([
      { id: 'player', ai: false },
      { id: 'red', ai: true, loadout: { spells: spells as never, buildings: [] }, personality: { seeksStones: false } },
    ]),
  );
  const red = w.tribes.red!;
  for (const id of red.known) red.spells[id].charges = 4;
  const leader = w.spawn('shaman', 'red', 60, 60);
  return { w, red, leader };
}

const casts = (w: World, type: string) => w.events.filter((e) => e.type === type).length;

describe('AI casting restraint', () => {
  it('does not spend a Blast on one villager', () => {
    const { w } = duel();
    w.spawn('brave', 'player', 66, 60);
    run(w, 20);
    expect(casts(w, 'explosion')).toBe(0);
    expect(w.tribes.red!.spells.blast.charges).toBeGreaterThanOrEqual(4);
  });

  it('blasts a crowd of fighters, but paced by its cast cooldown — not every think', () => {
    const { w } = duel(['blast']);
    for (let i = 0; i < 8; i++) {
      const u = w.spawn('warrior', 'player', 68 + (i % 3) * 0.8, 60 + Math.floor(i / 3) * 0.8);
      u.hp = u.maxHp = 9999; // they survive, so the crowd stays a target
      u.state = 'idle';
    }
    // Keep them standing still (no AI on the player side; they'd fight the leader otherwise).
    for (const u of w.units) if (u.tribe === 'player') u.pacified = 999;
    const seconds = 30;
    run(w, seconds);
    const n = casts(w, 'explosion');
    expect(n).toBeGreaterThanOrEqual(1);
    const gap = DIFFICULTIES.normal.aiCastGap;
    expect(n).toBeLessThanOrEqual(Math.ceil(seconds / gap) + 1);
  });

  it('saves a tier-3 charge: no Volcano on a lone hut, but yes on a village', () => {
    const lone = duel(['volcano']);
    lone.w.spawnBuilding('player', 'hut', 66, 60);
    lone.red.spells.volcano.charges = 1;
    run(lone.w, 12);
    expect(casts(lone.w, 'volcanoStart')).toBe(0);

    const town = duel(['volcano']);
    for (const [dx, dz] of [[0, 0], [5, 0], [0, 5], [5, 5], [-5, 0], [0, -5]]) town.w.spawnBuilding('player', 'hut', 68 + dx, 60 + dz);
    town.red.spells.volcano.charges = 1;
    run(town.w, 12);
    expect(casts(town.w, 'volcanoStart')).toBe(1);
  });

  it('a hurt leader with enemy fighters close falls back toward home', () => {
    const { w, leader } = duel([]);
    leader.hp = leader.maxHp * 0.3;
    for (let i = 0; i < 3; i++) {
      const u = w.spawn('warrior', 'player', 63 + i, 63);
      u.pacified = 999;
    }
    const home = w.tribes.red!.home;
    const d0 = Math.hypot(leader.x - home.x, leader.z - home.z);
    run(w, 8);
    const d1 = Math.hypot(leader.x - home.x, leader.z - home.z);
    expect(d1).toBeLessThan(d0 - 4);
  });
});

/** Two bands of land running round the planet, sea between them both ways. */
function straitWorld(width: number): World {
  const w = flatWorld(
    rulesFor([
      { id: 'player', ai: false },
      {
        id: 'red', ai: true,
        loadout: { spells: ['blast', 'landbridge'], buildings: [], startUnits: { warrior: 6, brave: 0 } },
        personality: { harassAt: 99, assaultAt: 4, seeksStones: false, builds: false, defends: false },
      },
    ]),
  );
  // Player band x 10..40, red band x (40+width)..(40+width+30); sea elsewhere.
  const redLo = 40 + width;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const land = (x >= 10 && x < 40) || (x >= redLo && x < redLo + 30);
      w.map.heights[z * N + x] = land ? 2 : -2.5;
    }
  }
  w.map.version++;
  w.tribes.player!.home = { x: 25, z: 64 };
  w.tribes.red!.home = { x: redLo + 15, z: 64 };
  w.spawn('brave', 'player', 25, 64);
  w.spawnNearWalkable('shaman', 'red', redLo + 15, 64);
  for (let i = 0; i < 6; i++) w.spawnNearWalkable('warrior', 'red', redLo + 15 + (i % 3), 66 + Math.floor(i / 3));
  w.tribes.red!.spells.landbridge.charges = 2;
  return w;
}

describe('AI and water', () => {
  it('findCrossing picks the narrow gap and reports its width', () => {
    const w = straitWorld(10);
    const c = findCrossing(w.map, w.tribes.red!.home, w.tribes.player!.home)!;
    expect(c).toBeTruthy();
    expect(c.kind).toBe('water');
    expect(c.width).toBeGreaterThan(8);
    expect(c.width).toBeLessThan(14);
    // The red side's shore of the 10-wide strait, not the far side round the planet.
    expect(c.from.x).toBeGreaterThanOrEqual(48);
    expect(c.from.x).toBeLessThan(55);
  });

  it('bridges a strait with Causeway and marches the army across', () => {
    const w = straitWorld(10);
    expect(regionNear(w.map, 25, 64)).not.toBe(regionNear(w.map, 65, 64));
    run(w, 90);
    expect(regionNear(w.map, 25, 64)).toBe(regionNear(w.map, 65, 64));
    // Red fighters set foot on the player's land.
    expect(w.units.some((u) => u.tribe === 'red' && u.kind === 'warrior' && u.x < 40)).toBe(true);
  }, 30_000);

  it('a strait wider than one Causeway takes several casts', () => {
    const w = straitWorld(30);
    run(w, 150);
    expect(regionNear(w.map, 25, 64)).toBe(regionNear(w.map, 85, 64));
    expect(w.tribes.red!.spells.landbridge.charges).toBeLessThanOrEqual(1);
  }, 30_000);
});

void HOMES;
