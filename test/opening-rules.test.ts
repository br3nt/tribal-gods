/**
 * The opening and the ritual (fb-opening): spells start charged, the first
 * minutes pour mana faster, building sites level their own ground,
 * communing is a long, interruptible, contested act, stones can be guarded,
 * stranded kin join when a route reaches them, and the scenario language
 * gained the triggers, actions and objectives the new chapters are told in.
 */
import { describe, expect, it } from 'vitest';
import { communeSecondsFor, spellDef, START_CHARGES } from '../src/sim/catalog';
import { openingBoost } from '../src/sim/spellbook';
import { SITE_LEVEL_SECONDS, World } from '../src/sim/world-state';
import type { Monument } from '../src/sim/world-state';
import { regionNear } from '../src/sim/regions';
import { eventsOf, flatWorld, rulesFor as baseRules, run } from './helpers';
import type { ScenarioRules } from '../src/sim/catalog';

/** Test rules that never end on their own (an empty rival would hand `destroyAll` a win at once). */
const rulesFor = (tribes?: ScenarioRules['tribes'], extra: Partial<ScenarioRules> = {}) =>
  baseRules(tribes, { objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }], ...extra });

const stone = (x: number, z: number, extra: Partial<Monument> = {}): Monument =>
  World.monumentFrom({ x, z, spell: 'lightning', mode: 'teach', ...extra });

function withLeader(rules = rulesFor()) {
  const w = flatWorld(rules);
  const leader = w.spawn('shaman', 'player', 20, 20);
  for (let i = 0; i < 3; i++) w.spawn('brave', 'player', 18 + i, 17);
  return { w, leader };
}

describe('the first seconds are playable', () => {
  it('known spells start charged by tier; a loadout can say otherwise', () => {
    const w = flatWorld(rulesFor([
      { id: 'player', ai: false, loadout: { spells: ['blast', 'lightning', 'volcano', 'convert'], startCharges: { convert: 0 } } },
      { id: 'red', ai: false },
    ]));
    expect(w.spellState('player', 'blast').charges).toBe(START_CHARGES[1]);
    expect(w.spellState('player', 'lightning').charges).toBe(START_CHARGES[2]);
    expect(w.spellState('player', 'volcano').charges).toBe(0);
    expect(w.spellState('player', 'convert').charges).toBe(0);
  });

  it('a default skirmish: every tribe holds a charge of every starter spell at t=0', () => {
    const w = new World();
    w.reset(5, { playerCiv: 'forest', difficulty: 'normal', enemies: 2 });
    for (const id of w.activeTribes()) {
      for (const s of w.tribes[id]!.known) expect(w.spellState(id, s).charges, `${id} ${s}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the opening pours mana faster, and eases back to normal by minute five', () => {
    expect(openingBoost(0)).toBeGreaterThan(1.5);
    expect(openingBoost(200)).toBeLessThan(openingBoost(100));
    expect(openingBoost(300)).toBe(1);
    const { w } = withLeader();
    run(w, 2);
    const early = w.tribes.player!.income;
    w.elapsed = 400;
    run(w, 1);
    expect(early).toBeGreaterThan(w.tribes.player!.income * 1.5);
  });
});

describe('a skirmish gives every leader an errand at the door', () => {
  for (const seed of [3, 11]) {
    it(`seed ${seed}: wanderers and an unguarded stone a short walk from each home; great stones are guarded`, () => {
      const w = new World();
      w.reset(seed, { playerCiv: 'forest', difficulty: 'normal', enemies: 1 });
      for (const id of w.activeTribes()) {
        const home = w.tribes[id]!.home;
        const region = regionNear(w.map, home.x, home.z);
        const wild = w.units.filter((u) => u.kind === 'wildman' && w.distTo(u, home.x, home.z) < 20 && regionNear(w.map, u.x, u.z) === region);
        expect(wild.length, `${id} wanderers near home`).toBeGreaterThanOrEqual(3);
        const own = w.monuments.filter((m) => Math.hypot(m.x - home.x, m.z - home.z) < 17 && !m.guards);
        expect(own.length, `${id} stone near home`).toBeGreaterThanOrEqual(1);
      }
      for (const m of w.monuments) {
        if (spellDef(m.spell).tier === 3) expect(Object.values(m.guards ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
      }
      const guards = w.units.filter((u) => (u.guardOf ?? -1) >= 0);
      expect(guards.length).toBeGreaterThan(0);
      expect(guards.every((u) => u.tribe === 'wild')).toBe(true);
    });
  }
});

describe('building sites level their own ground', () => {
  function bumpy(w: World) {
    for (let z = 30; z < 50; z++) for (let x = 30; x < 50; x++) w.map.heights[z * 128 + x] = 2 + ((x * 7 + z * 13) % 5) * 0.6;
    w.map.version++;
  }

  it('a site on rough ground flattens its footprint over its first seconds, with a blended skirt', () => {
    const w = flatWorld();
    bumpy(w);
    expect(w.siteFree('hut', 40, 40)).toBe(true); // rough, but within the (more forgiving) tolerance
    w.tribes.player!.wood = 50;
    expect(w.placeBuilding('player', 'hut', 40, 40)).toBe(true);
    expect(eventsOf(w, 'siteLevel').length).toBe(1);
    run(w, SITE_LEVEL_SECONDS + 0.2);
    const hs: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) hs.push(w.map.heightAt(40 + dx, 40 + dz));
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(1e-3);
    // The skirt eases toward the ground: one tile out is closer to the pad than the tile beyond.
    const pad = hs[0];
    const rough = (x: number, z: number) => 2 + ((x * 7 + z * 13) % 5) * 0.6;
    expect(Math.abs(w.map.heightAt(42, 40) - pad)).toBeLessThanOrEqual(Math.abs(rough(42, 40) - pad) + 1e-6);
    expect(w.map.heightAt(44, 40)).toBeCloseTo(rough(44, 40), 5);
  });

  it('never flattens into water and leaves a neighbour’s footprint alone', () => {
    const w = flatWorld();
    bumpy(w);
    const old = w.spawnBuilding('player', 'hut', 44, 40);
    const before: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) before.push(w.map.heightAt(44 + dx, 40 + dz));
    for (let z = 36; z <= 44; z++) w.map.heights[z * 128 + 37] = -2; // a creek two tiles west
    w.map.version++;
    w.tribes.player!.wood = 50;
    expect(w.placeBuilding('player', 'hut', 40, 40)).toBe(true);
    run(w, SITE_LEVEL_SECONDS + 0.5);
    const after: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) after.push(w.map.heightAt(44 + dx, 40 + dz));
    expect(after).toEqual(before);
    expect(w.map.heightAt(37, 40)).toBe(-2);
    expect(old.hp).toBeGreaterThan(0);
  });

  it('a building stood up complete is levelled at once', () => {
    const w = flatWorld();
    bumpy(w);
    w.spawnBuilding('player', 'hut', 40, 40);
    const hs: number[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) hs.push(w.map.heightAt(40 + dx, 40 + dz));
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(1e-3);
  });
});

describe('the ritual: communing takes time, and it can be broken', () => {
  it('lasts by tier (gift stones shorter, per-stone override)', () => {
    expect(communeSecondsFor({ spell: 'blast', mode: 'teach' })).toBe(10);
    expect(communeSecondsFor({ spell: 'lightning', mode: 'teach' })).toBe(20);
    expect(communeSecondsFor({ spell: 'volcano', mode: 'teach' })).toBe(35);
    expect(communeSecondsFor({ spell: 'volcano', mode: 'gift' })).toBeLessThan(35);
    expect(communeSecondsFor({ spell: 'volcano', mode: 'gift', communeSeconds: 4 })).toBe(4);
    const { w, leader } = withLeader();
    w.monuments = [stone(20, 22, { spell: 'flatten' })]; // tier 1: 10 s
    w.orderWorship([leader.id], 0);
    run(w, 2);
    expect(w.monuments[0].communing).toBe(true);
    expect(w.monuments[0].communer).toBe('player');
    expect(w.monuments[0].communerId).toBe(leader.id);
    const start = eventsOf(w, 'communeStart');
    expect(start.length).toBe(1);
    expect(start[0].tribe).toBe('player');
    run(w, 6);
    expect(w.monuments[0].communeProgress).toBeGreaterThan(0.6);
    expect(w.tribes.player!.known.has('flatten')).toBe(false);
    run(w, 4);
    expect(w.tribes.player!.known.has('flatten')).toBe(true);
    expect(w.monuments[0].communeProgress).toBe(0);
  });

  it('the kneeling leader cannot cast and takes extra damage', () => {
    const { w, leader } = withLeader();
    w.monuments = [stone(20, 22)];
    w.orderWorship([leader.id], 0);
    run(w, 2);
    expect(w.castCheck('player', 'blast', 24, 24)).toMatch(/communing/);
    const hp = leader.hp;
    w.hurtUnit(leader, 10);
    expect(hp - leader.hp).toBeGreaterThan(10);
  });

  it('a blow interrupts it; progress drains slowly, and a resumed ritual picks up where it was', () => {
    const { w, leader } = withLeader();
    w.monuments = [stone(20, 22)]; // tier 2: 20 s
    w.orderWorship([leader.id], 0);
    run(w, 11);
    const p = w.monuments[0].communeProgress!;
    expect(p).toBeGreaterThan(0.4);
    w.hurtUnit(leader, 1);
    run(w, 0.2);
    expect(leader.task).toBe('none');
    expect(w.monuments[0].communing).toBe(false);
    expect(eventsOf(w, 'communeInterrupted').length).toBe(1);
    run(w, 5);
    const drained = w.monuments[0].communeProgress!;
    expect(drained).toBeLessThan(p);
    expect(drained).toBeGreaterThan(p - 0.2); // not an instant reset
    w.orderWorship([leader.id], 0);
    run(w, 20 * (1 - drained) + 1);
    expect(w.tribes.player!.known.has('lightning')).toBe(true);
  });

  it('being shoved or walking away breaks it too', () => {
    const { w, leader } = withLeader();
    w.monuments = [stone(20, 22)];
    w.orderWorship([leader.id], 0);
    run(w, 3);
    w.orderMove([leader.id], 30, 30);
    run(w, 0.2);
    expect(w.monuments[0].communing).toBe(false);
    w.orderWorship([leader.id], 0);
    run(w, 4);
    expect(w.monuments[0].communing).toBe(true);
    w.displaceUnit(leader, 1, 0);
    run(w, 0.2);
    expect(w.monuments[0].communing).toBe(false);
  });

  it('pauses while hostile fighters stand inside the ring; one tribe at a stone at a time', () => {
    const { w, leader } = withLeader();
    w.monuments = [stone(20, 22)];
    w.orderWorship([leader.id], 0);
    run(w, 3);
    const red = w.spawn('warrior', 'red', 23, 24);
    red.pacified = 999; // stands there without striking (chant-held): only his presence is under test
    run(w, 0.5);
    const p = w.monuments[0].communeProgress!;
    run(w, 4);
    expect(w.monuments[0].contested).toBe(true);
    expect(w.monuments[0].communeProgress).toBeCloseTo(p, 5);
    // A rival leader can't take over a live ritual.
    const redLeader = w.spawn('shaman', 'red', 22, 26);
    w.orderWorship([redLeader.id], 0);
    run(w, 2);
    expect(w.monuments[0].communer).toBe('player');
    expect(redLeader.task).not.toBe('worship');
    w.units = w.units.filter((u) => u !== red);
    run(w, 2);
    expect(w.monuments[0].contested).toBe(false);
    expect(w.monuments[0].communeProgress!).toBeGreaterThan(p);
  });

  it('guardians sleep until a commune starts, then fight the communer', () => {
    const { w, leader } = withLeader();
    w.monuments = [stone(20, 26, { guards: { warrior: 2 } })];
    w.spawnGuards();
    const guards = w.units.filter((u) => u.guardOf === 0);
    expect(guards.length).toBe(2);
    const passer = w.spawn('warrior', 'player', 22, 24);
    run(w, 5);
    expect(passer.hp).toBe(passer.maxHp); // asleep: they let you walk by
    expect(w.foes(passer, guards[0])).toBe(false);
    passer.hp = 0;
    run(w, 0.1);
    w.orderWorship([leader.id], 0);
    run(w, 4);
    expect(w.monuments[0].guardsAwake).toBe(true);
    expect(guards.some((g) => g.task === 'attack')).toBe(true);
    expect(leader.hp < leader.maxHp || leader.task !== 'worship').toBe(true);
  });

  it('an aggressive rival answers a ritual with a raiding party', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { builds: false } }]));
    const leader = w.spawn('shaman', 'player', 60, 62);
    const raiders = [0, 1, 2].map((i) => w.spawn('warrior', 'red', 84 + i, 84));
    w.monuments = [stone(60, 64, { communeSeconds: 120 })];
    w.orderWorship([leader.id], 0);
    run(w, 6);
    expect(raiders.some((r) => r.goal && Math.hypot(r.goal.x - 60, r.goal.z - 65) < 6)).toBe(true);
  });

  it('an AI leader brings an escort to a great stone', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: true, personality: { passive: true } }]));
    w.spawn('shaman', 'player', 20, 20);
    const leader = w.spawn('shaman', 'red', 84, 84);
    const escort = [0, 1, 2].map((i) => w.spawn('warrior', 'red', 86 + i, 86));
    w.monuments = [stone(84, 100, { spell: 'earthquake' })];
    run(w, 5);
    expect(leader.task).toBe('worship');
    expect(escort.filter((e) => e.goal && Math.hypot(e.goal.x - 84, e.goal.z - 102) < 6).length).toBeGreaterThanOrEqual(2);
  });
});

describe('stranded kin and massing hosts', () => {
  it('stranded people join the moment a route reaches them', () => {
    const w = flatWorld();
    w.spawn('shaman', 'player', 20, 20);
    // An islet at 50,20 across open water.
    for (let z = 0; z < 128; z++) for (let x = 30; x < 70; x++) w.map.heights[z * 128 + x] = -3;
    for (let z = 16; z <= 24; z++) for (let x = 46; x <= 54; x++) w.map.heights[z * 128 + x] = 2;
    w.map.version++;
    const kin = [0, 1, 2].map((i) => {
      const u = w.spawn('brave', 'wild', 49 + i, 20);
      u.joins = 'player';
      return u;
    });
    run(w, 3);
    expect(kin.every((u) => u.tribe === 'wild')).toBe(true);
    expect(w.tribePopulation('player')).toBe(1);
    for (let x = 28; x <= 48; x++) for (let z = 19; z <= 21; z++) w.map.heights[z * 128 + x] = 2;
    w.map.version++;
    run(w, 1.5);
    expect(kin.every((u) => u.tribe === 'player' && !u.joins)).toBe(true);
    expect(eventsOf(w, 'rescued').length).toBe(3);
    expect(w.statsOf('player').joined).toBe(3);
  });

  it('a host told to hold waits on its beach, then its god sends it', () => {
    const w = flatWorld(rulesFor(
      [{ id: 'player', ai: false }, { id: 'violet', ai: true, personality: { builds: false, defends: false, harassAt: 1, assaultAt: 1, target: 'player' }, loadout: { startUnits: { shaman: 0, brave: 0 } } }],
      { events: [{ when: { type: 'time', at: 1 }, actions: [{ type: 'spawn', tribe: 'violet', units: { warrior: 5 }, x: 70, z: 70, march: { x: 60, z: 60 }, hold: 30 }] }] },
    ));
    w.spawn('shaman', 'player', 20, 20);
    run(w, 3);
    expect(eventsOf(w, 'landing').length).toBe(1);
    run(w, 22);
    const host = w.units.filter((u) => u.tribe === 'violet');
    expect(host.length).toBe(5);
    expect(host.every((u) => w.distTo(u, 60, 60) < 7)).toBe(true);
    run(w, 25);
    expect(host.some((u) => w.distTo(u, 60, 60) > 12)).toBe(true);
  });
});

describe('the scenario language: triggers, actions, staged objectives', () => {
  it('spellCast / joined / killed / commune / any triggers, delay, openStone, defeat, message focus', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false }], {
      events: [
        { when: { type: 'spellCast', spell: 'blast', x: 30, z: 20, radius: 3 }, message: 'boom', focus: { x: 30, z: 20 }, actions: [{ type: 'openStone', index: 0 }] },
        { when: { type: 'commune', index: 0 }, delay: 2, actions: [{ type: 'message', text: 'they kneel', focus: { x: 1, z: 2 } }] },
        { when: { type: 'any', of: [{ type: 'time', at: 999 }, { type: 'killed', tribe: 'red', count: 2 }] }, actions: [{ type: 'message', text: 'two down' }] },
        { when: { type: 'joined', count: 1 }, actions: [{ type: 'message', text: 'kin' }] },
        { when: { type: 'killed', tribe: 'player', count: 3, kind: 'brave' }, actions: [{ type: 'defeat', reason: 'Too many have fallen.' }] },
      ],
    }));
    const leader = w.spawn('shaman', 'player', 20, 20);
    w.monuments = [stone(22, 24, { asleep: true, communeSeconds: 60 })];
    expect(w.monumentAvailable(w.monuments[0])).toBe(false);
    w.orderCast('player', 'blast', 30, 20);
    run(w, 1.5);
    expect(w.messages.at(-1)).toMatchObject({ text: 'boom', focus: { x: 30, z: 20 } });
    expect(w.monumentAvailable(w.monuments[0])).toBe(true);
    w.orderWorship([leader.id], 0);
    run(w, 3);
    expect(w.messages.some((m) => m.text === 'they kneel')).toBe(false); // the delay
    run(w, 2);
    expect(w.messages.find((m) => m.text === 'they kneel')?.focus).toEqual({ x: 1, z: 2 });
    for (let i = 0; i < 2; i++) w.spawn('warrior', 'red', 90, 90 + i).hp = 0;
    run(w, 0.2);
    expect(w.messages.some((m) => m.text === 'two down')).toBe(true);
    const kin = w.spawn('brave', 'wild', 24, 20);
    kin.joins = 'player';
    run(w, 1.2);
    expect(w.messages.some((m) => m.text === 'kin')).toBe(true);
    for (let i = 0; i < 3; i++) w.spawn('brave', 'player', 40, 40 + i).hp = 0;
    run(w, 0.2);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/fallen/);
  });

  it('objectives in steps: `after` keeps one hidden until the last is done, and counts start then', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false, loadout: { spells: ['blast', 'convert'] } }, { id: 'red', ai: false }], {
      objectives: [
        { objective: { type: 'convertWanderers', count: 2 }, text: 'Kindle two' },
        { objective: { type: 'castSpell', spell: 'blast', x: 30, z: 20, radius: 4 }, text: 'Blast the rock', after: 0 },
        { objective: { type: 'killUnits', tribe: 'red', count: 1 }, text: 'Kill one', after: 1 },
        { objective: { type: 'loseAtMost', count: 0, kind: 'brave' }, text: 'Lose nobody', optional: true },
        { objective: { type: 'winWithin', seconds: 600 }, text: 'Quickly', optional: true },
        { objective: { type: 'loseAtMost', count: 0 }, text: 'Lose nobody at all', optional: true },
      ],
    }));
    w.spawn('shaman', 'player', 20, 20);
    w.spawn('warrior', 'player', 18, 18).hp = 0; // a fighter dies: breaks only the "at all" one
    w.spawn('warrior', 'red', 100, 100).hp = 0; // killed BEFORE "Kill one" is active: does not count
    run(w, 0.2);
    expect(w.objectives.map((o) => o.active)).toEqual([true, false, false, true, true, true]);
    w.orderCast('player', 'blast', 30, 20); // before its step: does not count
    run(w, 1.5);
    for (let i = 0; i < 2; i++) w.spawn('wildman', 'wild', 25 + i, 25);
    w.orderCast('player', 'convert', 25, 25);
    run(w, 1.5);
    expect(w.objectives[0].done).toBe(true);
    run(w, 0.2);
    expect(w.objectives[1].active).toBe(true);
    expect(w.objectives[1].done).toBe(false);
    w.orderCast('player', 'blast', 31, 21);
    run(w, 1.5);
    expect(w.objectives[1].done).toBe(true);
    run(w, 0.2);
    expect(w.objectives[2].active).toBe(true);
    expect(w.objectives[2].done).toBe(false);
    w.spawn('warrior', 'red', 100, 100).hp = 0;
    run(w, 0.2);
    expect(w.gameOver).toBe('victory');
    expect(w.objectives[3].done).toBe(true);
    expect(w.objectives[4].done).toBe(true);
    expect(w.objectives[5].failed).toBe(true);
    expect(w.objectives[5].done).toBe(false);
  });

  it('rescueStranded counts the kin who reach you', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'red', ai: false }], {
      objectives: [{ objective: { type: 'rescueStranded', count: 2 }, text: 'Bring them home' }],
    }));
    w.spawn('shaman', 'player', 20, 20);
    for (let i = 0; i < 2; i++) w.spawn('brave', 'wild', 30 + i, 20).joins = 'player';
    run(w, 1.5);
    expect(w.gameOver).toBe('victory');
  });
});
