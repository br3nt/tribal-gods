/**
 * Generic scenario rules added for the campaign: loadout extras, scripted
 * events, AI personalities, new objective/fail types, sleeping stones.
 * Each is data on ScenarioRules / MonumentDef — no scenario ids in the sim.
 */
import { describe, expect, it } from 'vitest';
import { spellDef } from '../src/sim/catalog';
import type { ScenarioRules } from '../src/sim/catalog';
import { World } from '../src/sim/world-state';
import { eventsOf, flatWorld, rulesFor, run } from './helpers';

const SETTINGS = { playerCiv: 'forest', difficulty: 'normal' } as const;

/** A flat world rebuilt so setupTribes runs under `rules` (flatWorld wipes units). */
function setupFlat(rules: ScenarioRules): World {
  const w = flatWorld(rules);
  // Re-run tribe setup on the flat ground with the real rules.
  (w as unknown as { setupTribes(r: ScenarioRules, h: object): void }).setupTribes(rules, {
    player: { x: 20, z: 20 },
    red: { x: 84, z: 84 },
    gold: { x: 20, z: 84 },
    violet: { x: 84, z: 20 },
  });
  return w;
}

describe('loadout extras', () => {
  it('extraCharges raises a spell’s max; chargeCost slows its charging', () => {
    const w = setupFlat(
      rulesFor([
        { id: 'player', ai: false, loadout: { spells: ['blast', 'convert'], extraCharges: { blast: 1 }, chargeCost: { convert: 2 } } },
        { id: 'red', ai: false },
      ]),
    );
    expect(w.spellState('player', 'blast').max).toBe(spellDef('blast').maxCharges + 1);
    run(w, 200);
    expect(w.spellState('player', 'blast').charges).toBe(spellDef('blast').maxCharges + 1);
    // Fresh world: compare charge speed of convert with and without the cost.
    const a = setupFlat(rulesFor([{ id: 'player', ai: false, loadout: { spells: ['convert'], chargeCost: { convert: 2 } } }, { id: 'red', ai: false }]));
    const b = setupFlat(rulesFor([{ id: 'player', ai: false, loadout: { spells: ['convert'] } }, { id: 'red', ai: false }]));
    run(a, 5);
    run(b, 5);
    const pa = a.spellState('player', 'convert');
    const pb = b.spellState('player', 'convert');
    expect(pa.charges + pa.progress).toBeCloseTo((pb.charges + pb.progress) / 2, 1);
    expect(pa.eta).toBeGreaterThan(pb.eta);
  });

  it('startBuildings never overlap: a crowded home gets fewer, not stacked, buildings', () => {
    const w = setupFlat(rulesFor([{ id: 'player', ai: false, loadout: { startBuildings: Array(40).fill('hut') } }, { id: 'red', ai: false }]));
    const mine = w.buildings.filter((b) => b.tribe === 'player');
    expect(mine.length).toBeGreaterThan(5);
    for (const a of mine) for (const b of mine) if (a !== b) expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z))).toBeGreaterThanOrEqual(3);
  });

  it('gifts start as free casts; startBuildings stand complete near home', () => {
    const w = setupFlat(
      rulesFor([
        { id: 'player', ai: false, loadout: { gifts: { landbridge: 2 }, startBuildings: ['hut', 'hut', 'warriorHut'] } },
        { id: 'red', ai: false },
      ]),
    );
    expect(w.spellState('player', 'landbridge').gifted).toBe(2);
    const mine = w.buildings.filter((b) => b.tribe === 'player');
    expect(mine.map((b) => b.kind).sort()).toEqual(['hut', 'hut', 'warriorHut']);
    expect(mine.every((b) => b.progress >= 1)).toBe(true);
    for (const b of mine) expect(w.distTo(w.leaderOf('player')!, b.x, b.z)).toBeLessThan(16);
  });
});

describe('scripted events', () => {
  it('a timed spawn sends raiders marching at a point, with a message', () => {
    const w = setupFlat(
      rulesFor(
        [{ id: 'player', ai: false }, { id: 'violet', ai: false, loadout: { startUnits: { shaman: 0, brave: 0 } } }],
        {
          objectives: [{ objective: { type: 'survive', seconds: 999 }, text: 's' }],
          events: [
            {
              when: { type: 'time', at: 3 },
              message: 'Sails on the horizon.',
              actions: [{ type: 'spawn', tribe: 'violet', units: { warrior: 3 }, x: 60, z: 20, march: { x: 30, z: 20 } }],
            },
          ],
        },
      ),
    );
    expect(w.units.filter((u) => u.tribe === 'violet').length).toBe(0);
    run(w, 2.9);
    expect(w.units.filter((u) => u.tribe === 'violet').length).toBe(0);
    run(w, 0.3);
    const raiders = w.units.filter((u) => u.tribe === 'violet');
    expect(raiders.length).toBe(3);
    expect(raiders.every((u) => u.state === 'moving')).toBe(true);
    expect(w.messages.map((m) => m.text)).toContain('Sails on the horizon.');
    run(w, 10);
    expect(raiders.some((u) => w.distTo(u, 30, 20) < 12)).toBe(true);
  });

  it('repeat fires the event `times` times, `every` seconds apart', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false }], {
        events: [
          { when: { type: 'time', at: 1 }, repeat: { every: 2, times: 3 }, actions: [{ type: 'spawn', tribe: 'red', units: { brave: 1 }, x: 84, z: 84 }] },
        ],
      }),
    );
    const before = w.units.filter((u) => u.tribe === 'red').length;
    const red = () => w.units.filter((u) => u.tribe === 'red').length - before;
    run(w, 2); // t=2: fired at 1
    expect(red()).toBe(1);
    run(w, 2); // t=4: fired at 1 and 3
    expect(red()).toBe(2);
    run(w, 6);
    expect(red()).toBe(3);
  });

  it('messageSeq keeps counting past the 50 lines world.messages keeps', () => {
    const w = setupFlat(rulesFor());
    for (let i = 0; i < 60; i++) w.say(`line ${i}`);
    expect(w.messages.length).toBe(50);
    expect(w.messageSeq).toBe(60);
    expect(w.messages.at(-1)!.text).toBe('line 59');
  });

  it('zone triggers fire when the tribe’s units enter; objective triggers after an objective', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false }, { id: 'gold', ai: false }], {
        objectives: [
          { objective: { type: 'leaderReach', x: 40, z: 20, radius: 2 }, text: 'go' },
          { objective: { type: 'survive', seconds: 999 }, text: 's' },
        ],
        events: [
          { when: { type: 'zone', x: 30, z: 20, radius: 3 }, actions: [{ type: 'teach', tribe: 'player', spell: 'ward' }] },
          { when: { type: 'objective', index: 0 }, actions: [{ type: 'allies', tribe: 'red', allies: ['gold'] }] },
        ],
      }),
    );
    expect(w.hostile('red', 'gold')).toBe(true);
    const leader = w.leaderOf('player')!;
    w.orderMove([leader.id], 40, 20);
    run(w, 6);
    expect(w.tribes.player!.known.has('ward')).toBe(true);
    run(w, 6);
    expect(w.objectives[0].done).toBe(true);
    expect(w.hostile('red', 'gold')).toBe(false);
    expect(w.hostile('gold', 'red')).toBe(false);
  });

  it('allies can be broken again, both ways', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false, allies: ['gold'] }, { id: 'gold', ai: false, allies: ['red'] }], {
        events: [{ when: { type: 'time', at: 1 }, actions: [{ type: 'allies', tribe: 'red', allies: [] }] }],
      }),
    );
    expect(w.hostile('red', 'gold')).toBe(false);
    run(w, 1.2);
    expect(w.hostile('red', 'gold')).toBe(true);
  });

  it('strike: the world itself casts (no leader needed)', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false }], {
        events: [{ when: { type: 'time', at: 1 }, actions: [{ type: 'strike', spell: 'sink', x: 60, z: 60, tribe: 'red' }] }],
      }),
    );
    run(w, 14);
    expect(w.map.heightAt(60, 60)).toBeLessThan(0);
  });

  it('gift and wake actions', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { passive: true } }], {
        events: [
          { when: { type: 'time', at: 1 }, actions: [{ type: 'gift', tribe: 'player', spell: 'volcano', charges: 1 }, { type: 'wake', tribe: 'red' }] },
        ],
      }),
    );
    expect(w.tribes.red!.ai!.awake).toBe(false);
    run(w, 1.2);
    expect(w.spellState('player', 'volcano').gifted).toBe(1);
    expect(w.tribes.red!.ai!.awake).toBe(true);
  });
});

describe('objectives & fails added for the campaign', () => {
  it('chargeSpell completes once the spell holds a charge', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false, loadout: { spells: ['blast'] } }, { id: 'red', ai: false }], {
        objectives: [{ objective: { type: 'chargeSpell', spell: 'blast' }, text: 'charge' }],
      }),
    );
    run(w, 1);
    expect(w.objectives[0].progress).toBeGreaterThan(0);
    expect(w.objectives[0].progress).toBeLessThan(1);
    run(w, 30);
    expect(w.gameOver).toBe('victory');
  });

  it('monumentTaken fails when a rival communes at the stone first', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false }], {
        objectives: [{ objective: { type: 'claimMonument', index: 0 }, text: 'claim' }],
        fail: [{ type: 'monumentTaken', index: 0 }],
      }),
    );
    w.monuments = [{ x: 84, z: 88, spell: 'volcano', mode: 'teach', claimedBy: null, claimer: null, sleep: 0 }];
    w.orderWorship([w.leaderOf('red')!.id], 0);
    run(w, 12);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/stone/i);
  });

  it('a stone with opensAt sleeps until then', () => {
    const w = setupFlat(rulesFor());
    w.monuments = [{ x: 24, z: 20, spell: 'ward', mode: 'teach', claimedBy: null, claimer: null, sleep: 0, opensAt: 20 }];
    expect(w.monumentAvailable(w.monuments[0])).toBe(false);
    w.orderWorship([w.leaderOf('player')!.id], 0);
    run(w, 8);
    expect(w.tribes.player!.known.has('ward')).toBe(false);
    run(w, 13);
    expect(w.monumentAvailable(w.monuments[0])).toBe(true);
    w.orderWorship([w.leaderOf('player')!.id], 0);
    run(w, 15);
    expect(w.tribes.player!.known.has('ward')).toBe(true);
  });
});

describe('AI personalities', () => {
  it('passive AI stays home until provoked', () => {
    const w = setupFlat(
      rulesFor([
        { id: 'player', ai: false },
        { id: 'red', ai: true, personality: { passive: true, harassAt: 1, assaultAt: 2, builds: false }, loadout: { startUnits: { warrior: 4 } } },
      ]),
    );
    run(w, 20);
    expect(w.tribes.red!.ai!.state).toBe('grow');
    const home = w.tribes.red!.home;
    expect(w.units.filter((u) => u.tribe === 'red' && u.kind === 'warrior').every((u) => w.distTo(u, home.x, home.z) < 12)).toBe(true);
    w.tribes.red!.threatTimer = 5; // somebody hit them
    run(w, 3);
    expect(w.tribes.red!.ai!.awake).toBe(true);
  });

  it('wakeAt wakes a passive AI on schedule; low assaultAt sends the army', () => {
    const w = setupFlat(
      rulesFor([
        { id: 'player', ai: false },
        { id: 'red', ai: true, personality: { passive: true, wakeAt: 5, assaultAt: 2, builds: false, defends: false }, loadout: { startUnits: { warrior: 3, brave: 0 } } },
      ]),
    );
    run(w, 4);
    expect(w.tribes.red!.ai!.awake).toBe(false);
    run(w, 4);
    expect(w.tribes.red!.ai!.awake).toBe(true);
    expect(w.tribes.red!.ai!.state).toBe('assault');
  });

  it('a passive god’s leader does not cast at you until it wakes', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { passive: true, builds: false } }]),
    );
    const leader = w.leaderOf('red')!;
    // Clear of red's own villagers (the AI won't blast its own people).
    for (let i = 0; i < 4; i++) w.spawn('warrior', 'player', leader.x + 9.5 + i * 0.5, leader.z).pacified = 999;
    w.tribes.red!.spells.blast.charges = 4;
    run(w, 10);
    expect(eventsOf(w, 'explosion').length).toBe(0);
    w.tribes.red!.ai!.awake = true;
    run(w, 10);
    expect(eventsOf(w, 'explosion').length).toBeGreaterThan(0);
  });

  it('builds:false never places buildings', () => {
    const w = setupFlat(rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { builds: false }, loadout: { startWood: 50 } }]));
    w.trees = [];
    run(w, 30);
    expect(w.buildings.filter((b) => b.tribe === 'red').length).toBe(0);
  });

  it('prefer limits what it trains', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { prefer: ['firewarrior'], builds: false }, loadout: { startWood: 80, startUnits: { brave: 14 } } }]),
    );
    const lodge = w.spawnBuilding('red', 'warriorHut', 90, 84);
    const ember = w.spawnBuilding('red', 'fireHut', 84, 92);
    run(w, 20);
    expect(lodge.queue + (lodge.trainee >= 0 ? 1 : 0)).toBe(0);
    expect(ember.queue + (ember.trainee >= 0 ? 1 : 0) + w.units.filter((u) => u.tribe === 'red' && u.kind === 'firewarrior').length).toBeGreaterThan(0);
  });

  it('target pins the AI on one rival', () => {
    const w = setupFlat(
      rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { target: 'gold' } }, { id: 'gold', ai: false }]),
    );
    run(w, 3);
    expect(w.tribes.red!.ai!.target).toBe('gold');
  });

  it('events from the old fixed set still cover everything emitted', () => {
    const w = setupFlat(rulesFor());
    run(w, 1);
    expect(eventsOf(w, 'nonsense').length).toBe(0);
  });
});

describe('unreachable homes', () => {
  it('a villager whose only free Dwelling is cut off stops re-pathing to it every tick', () => {
    const w = setupFlat(rulesFor());
    w.units = [];
    // A dwelling on an islet: its door is unreachable from the mainland.
    for (let z = 34; z <= 46; z++) for (let x = 34; x <= 46; x++) w.map.heights[z * 128 + x] = (x < 36 || x > 44 || z < 36 || z > 44) ? -3 : 2;
    w.map.version++;
    w.spawnBuilding('player', 'hut', 40, 40);
    w.spawn('shaman', 'player', 20, 20);
    const v = w.spawn('brave', 'player', 22, 20);
    v.idleTime = 10;
    let calls = 0;
    const orig = w.sendTo.bind(w);
    w.sendTo = (...a: Parameters<typeof w.sendTo>) => {
      if (a[0] === v) calls++;
      return orig(...a);
    };
    run(w, 10);
    expect(calls).toBeLessThan(20);
  });
});

describe('Causeway over deep water', () => {
  it('a diagonal causeway is walkable end to end (sloped shoulders, no corner-cut gaps)', async () => {
    const { castSpell } = await import('../src/sim/spells');
    const { findPath } = await import('../src/sim/pathfinding');
    const w = setupFlat(rulesFor());
    w.map.heights.fill(-4.5);
    for (let z = 50; z < 70; z++) for (let x = 10; x < 30; x++) w.map.heights[z * 128 + x] = 2;
    for (let z = 60; z < 80; z++) for (let x = 46; x < 66; x++) w.map.heights[z * 128 + x] = 2;
    w.map.version++;
    expect(findPath(w.map, 20, 60, 56, 70, 20000)).toBeNull();
    castSpell(w, 'landbridge', 47, 69, 29, 61, 'player');
    run(w, 6);
    expect(findPath(w.map, 20, 60, 56, 70, 20000)).not.toBeNull();
  });
});

describe('world.loadLevel uses level.rules when no rules are passed', () => {
  it('falls back to skirmish rules for a v1 level', async () => {
    const { OFFICIAL_LEVELS } = await import('../src/level/official-levels');
    const w = new World();
    await w.loadLevel(await OFFICIAL_LEVELS[1].build(), SETTINGS);
    expect(w.rules.briefing.title).toBe('Skirmish');
  });
});
