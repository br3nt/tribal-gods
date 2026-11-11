/**
 * Landings by sea, war bands without a home, and villagers who fight back
 * (fb-integrate):
 *   - a spawn that comes by boat emits `landing` at once and puts the crews
 *     ashore LANDING.seconds later (the boats' run in), saved mid-run;
 *   - a raider-only tribe is `homeless` in the sim (no home circle), until
 *     it has a building of its own;
 *   - struck villagers turn on the attacker and their neighbours help.
 */
import { describe, expect, it } from 'vitest';
import { hasHomeCircle } from '../src/render/unit-visual-state';
import type { ScenarioAction, ScenarioRules } from '../src/sim/catalog';
import { restoreWorld, saveWorld, SaveData } from '../src/sim/save';
import { comesBySea, LANDING } from '../src/sim/scenario-events';
import { World } from '../src/sim/world-state';
import { eventsOf, flatWorld, rulesFor, run } from './helpers';

const WAR_BAND = { builds: false, defends: false, harassAt: 1, assaultAt: 1, target: 'player' as const };

function coastWorld(events: ScenarioRules['events'], violet: Partial<ScenarioRules['tribes'][number]> = { personality: WAR_BAND }): World {
  const w = flatWorld(rulesFor(
    [{ id: 'player', ai: false }, { id: 'violet', ai: true, loadout: { startUnits: { shaman: 0, brave: 0 } }, ...violet }],
    { events, objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }] },
  ));
  // Sea east of x = 96.
  for (let z = 0; z < 128; z++) for (let x = 96; x < 128; x++) w.map.heights[z * 128 + x] = -3;
  w.map.version++;
  w.spawn('shaman', 'player', 20, 20);
  return w;
}

const raid = (extra: Partial<Extract<ScenarioAction, { type: 'spawn' }>> = {}): Extract<ScenarioAction, { type: 'spawn' }> => ({
  type: 'spawn', tribe: 'violet', units: { warrior: 4 }, x: 90, z: 60, march: { x: 70, z: 60 }, ...extra,
});
const violet = (w: World) => w.units.filter((u) => u.tribe === 'violet');

describe('landings: the boats come in first, then the crews', () => {
  it('a war band from a shore: `landing` at once, nobody on the sand until the hulls ground', () => {
    const w = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid()] }]);
    run(w, 1.2);
    expect(eventsOf(w, 'landing')).toHaveLength(1);
    expect(eventsOf(w, 'landing')[0].magnitude).toBe(4);
    expect(violet(w)).toHaveLength(0);
    run(w, LANDING.seconds - 0.6);
    expect(violet(w)).toHaveLength(0);
    run(w, 0.6);
    expect(violet(w)).toHaveLength(4);
    expect(violet(w).every((u) => w.distTo(u, 90, 60) < 6)).toBe(true);
    expect(violet(w).every((u) => u.state === 'moving')).toBe(true);
  });

  it('a hold counts from the order, so a host masses as long as it was told to', () => {
    const w = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid({ hold: 20 })] }]);
    run(w, 1.2 + LANDING.seconds);
    expect(violet(w)).toHaveLength(4);
    for (const u of violet(w)) {
      expect(u.holdUntil).toBeGreaterThanOrEqual(20.9);
      expect(u.holdUntil).toBeLessThan(21.2);
    }
  });

  it('by land: a settled tribe, an inland point, or `by: land` appear at once with no boats', () => {
    const settled = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid()] }], { personality: {} });
    run(settled, 1.2);
    expect(violet(settled)).toHaveLength(4);
    expect(eventsOf(settled, 'landing')).toHaveLength(0);

    const inland = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid({ x: 40, z: 60 })] }]);
    run(inland, 1.2);
    expect(violet(inland)).toHaveLength(4);

    const told = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid({ by: 'land' })] }]);
    run(told, 1.2);
    expect(violet(told)).toHaveLength(4);
    expect(comesBySea(told, raid({ by: 'sea', x: 40 }))).toBe(true);
    expect(comesBySea(told, raid({ joins: 'player' }))).toBe(false);
  });

  it('a save taken while the boats are running in lands the crews after Continue', () => {
    const w = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid()] }]);
    run(w, 2);
    expect(w.landings).toHaveLength(1);
    const copy = new World();
    restoreWorld(copy, JSON.parse(JSON.stringify(saveWorld(w))) as SaveData);
    expect(copy.landings).toHaveLength(1);
    run(copy, LANDING.seconds);
    expect(violet(copy)).toHaveLength(4);
    expect(copy.landings).toHaveLength(0);
  });

  it('a new scenario drops boats still at sea from the last one', () => {
    const w = coastWorld([{ when: { type: 'time', at: 1 }, actions: [raid()] }]);
    run(w, 2);
    w.reset(3, { playerCiv: 'forest', difficulty: 'normal' }, rulesFor());
    expect(w.landings).toHaveLength(0);
  });
});

describe('homeless war bands', () => {
  it('the sim marks a raider-only tribe homeless; a settled one is not; a building of its own ends it', () => {
    const w = coastWorld([]);
    expect(w.tribes.violet!.homeless).toBe(true);
    expect(w.tribes.player!.homeless).toBe(false);
    expect(hasHomeCircle(w.tribes.violet!, 0)).toBe(false);
    expect(hasHomeCircle(w.tribes.player!, 0)).toBe(true);
    w.spawnBuilding('violet', 'hut', 60, 60);
    expect(w.tribes.violet!.homeless).toBe(false);
    expect(hasHomeCircle(w.tribes.violet!, 1)).toBe(true);
  });

  it('survives a save', () => {
    const w = coastWorld([]);
    const copy = new World();
    restoreWorld(copy, JSON.parse(JSON.stringify(saveWorld(w))) as SaveData);
    expect(copy.tribes.violet!.homeless).toBe(true);
  });
});

describe('villagers fight back', () => {
  it('a wounded raider walking into a crowd of villagers is pulled down, not handed the village', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'violet', ai: false }], { objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }] }));
    for (let i = 0; i < 6; i++) w.spawn('brave', 'player', 40 + (i % 3), 40 + Math.floor(i / 3));
    const raider = w.spawn('warrior', 'violet', 44, 41);
    raider.hp = 6;
    run(w, 25);
    expect(raider.hp).toBeLessThanOrEqual(0);
    expect(w.statsOf('player').lostTotal).toBeLessThanOrEqual(2);
  });

  it('the one struck turns on the attacker and close villagers join; one further off carries on', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'violet', ai: false }], { objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }] }));
    const hit = w.spawn('brave', 'player', 40, 40);
    const near = w.spawn('brave', 'player', 41.5, 40.5);
    const far = w.spawn('brave', 'player', 50, 50);
    const raider = w.spawn('warrior', 'violet', 40.8, 39.4);
    run(w, 1 / 15);
    w.hurtUnit(hit, 1, { by: raider });
    expect(hit.task).toBe('attack');
    expect(hit.targetUnit).toBe(raider.id);
    expect(near.task).toBe('attack');
    expect(far.task).not.toBe('attack');
  });

  it('against a war band a struck villager runs for home instead of feeding the spears', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'violet', ai: false }], { objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }] }));
    const hit = w.spawn('brave', 'player', 40, 40);
    const near = w.spawn('brave', 'player', 41.5, 40.5);
    const a = w.spawn('warrior', 'violet', 40.8, 39.4);
    w.spawn('warrior', 'violet', 42, 38);
    run(w, 1 / 15);
    w.hurtUnit(hit, 1, { by: a });
    expect(hit.task).not.toBe('attack');
    expect(hit.state).toBe('moving');
    expect(near.task).not.toBe('attack');
    // no dwelling: straight away from the blow
    run(w, 2);
    expect(Math.hypot(hit.x - 40.8, hit.z - 39.4)).toBeGreaterThan(2.5);
  });

  it('a fleeing villager shelters in a dwelling with a free bed, away from the attacker', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'violet', ai: false }], { objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }] }));
    const hut = w.spawnBuilding('player', 'hut', 40, 48);
    const hit = w.spawn('brave', 'player', 40, 42);
    const a = w.spawn('warrior', 'violet', 40, 40.8);
    w.spawn('warrior', 'violet', 41, 39);
    run(w, 1 / 15);
    w.hurtUnit(hit, 1, { by: a });
    expect(hit.task).toBe('goHome');
    expect(hit.targetBuilding).toBe(hut.id);
    run(w, 9);
    expect(hit.hidden).toBe(true);
    expect(hut.residents).toBe(1);
  });

  it('a host holding its beach chases no further than its leash: no early spears in the village', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'violet', ai: false }], { objectives: [{ objective: { type: 'survive', seconds: 99999 }, text: 'wait' }] }));
    const spear = w.spawn('warrior', 'violet', 60, 60);
    spear.holdAt = { x: 60, z: 60 };
    spear.holdUntil = 200;
    const villager = w.spawn('brave', 'player', 66, 60);
    w.orderMove([villager.id], 20, 60); // walks home, away from the beach
    run(w, 30);
    expect(w.distTo(spear, 60, 60)).toBeLessThan(12);
    expect(villager.hp).toBeGreaterThan(0);
  });
});

