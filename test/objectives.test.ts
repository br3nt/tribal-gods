import { describe, expect, it } from 'vitest';
import type { Objective, ScenarioRules } from '../src/sim/catalog';
import { eventsOf, flatWorld, rulesFor, run } from './helpers';

function scenario(objectives: Objective[], fail: ScenarioRules['fail'] = [], optional = false) {
  return rulesFor(undefined, {
    objectives: objectives.map((o) => ({ objective: o, text: o.type, optional })),
    fail,
  });
}

/** Player + red each with a leader and a villager, so nobody is dead on tick 1. */
function populated(rules: ScenarioRules) {
  const w = flatWorld(rules);
  w.spawn('shaman', 'player', 20, 20);
  w.spawn('brave', 'player', 22, 20);
  w.spawn('shaman', 'red', 84, 84);
  w.spawn('brave', 'red', 86, 84);
  return w;
}

describe('objectives', () => {
  it('absent rules = classic destroy-all skirmish', () => {
    const w = populated(rulesFor());
    expect(w.objectives.length).toBe(1);
    expect(w.objectives[0].objective.type).toBe('destroyAll');
    run(w, 1);
    expect(w.gameOver).toBeNull();
    w.units = w.units.filter((u) => u.tribe !== 'red');
    run(w, 0.2);
    expect(w.gameOver).toBe('victory');
    expect(w.gameOverReason).toBeTruthy();
    expect(eventsOf(w, 'objectiveDone').length).toBe(1);
  });

  it('destroyTribe targets one tribe only', () => {
    const w = populated(
      rulesFor(
        [{ id: 'player', ai: false }, { id: 'red', ai: false }, { id: 'gold', ai: false }],
        { objectives: [{ objective: { type: 'destroyTribe', tribe: 'red' }, text: 'x' }] },
      ),
    );
    w.spawn('brave', 'gold', 20, 84);
    w.units = w.units.filter((u) => u.tribe !== 'red');
    run(w, 0.2);
    expect(w.gameOver).toBe('victory');
  });

  it('survive tracks progress and completes on time', () => {
    const w = populated(scenario([{ type: 'survive', seconds: 10 }]));
    run(w, 5);
    expect(w.objectives[0].progress).toBeCloseTo(0.5, 1);
    expect(w.gameOver).toBeNull();
    run(w, 5.2);
    expect(w.gameOver).toBe('victory');
    expect(w.elapsed).toBeGreaterThan(10);
  });

  it('reachPopulation', () => {
    const w = populated(scenario([{ type: 'reachPopulation', count: 5 }]));
    run(w, 0.2);
    expect(w.objectives[0].progress).toBeCloseTo(2 / 5);
    for (let i = 0; i < 3; i++) w.spawn('brave', 'player', 24, 24);
    run(w, 0.2);
    expect(w.objectives[0].done).toBe(true);
  });

  it('claimMonument', () => {
    const w = populated(scenario([{ type: 'claimMonument', index: 0 }]));
    w.monuments = [{ x: 26, z: 20, spell: 'lightning', mode: 'teach', claimedBy: null, claimer: null, sleep: 0, communeSeconds: 6 }];
    const leader = w.units.find((u) => u.kind === 'shaman' && u.tribe === 'player')!;
    w.orderWorship([leader.id], 0);
    run(w, 15);
    expect(w.tribes.player!.known.has('lightning')).toBe(true);
    expect(w.gameOver).toBe('victory');
  });

  it('buildCount counts completed buildings', () => {
    const w = populated(scenario([{ type: 'buildCount', kind: 'hut', count: 2 }]));
    w.spawnBuilding('player', 'hut', 40, 40);
    w.spawnBuilding('player', 'hut', 50, 40, { complete: false });
    run(w, 0.2);
    expect(w.objectives[0].done).toBe(false);
    expect(w.objectives[0].progress).toBeCloseTo(0.5);
    w.buildings[1].progress = 1;
    run(w, 0.2);
    expect(w.gameOver).toBe('victory');
  });

  it('leaderReach', () => {
    const w = populated(scenario([{ type: 'leaderReach', x: 30, z: 20, radius: 2 }]));
    const leader = w.units.find((u) => u.kind === 'shaman' && u.tribe === 'player')!;
    w.orderMove([leader.id], 30, 20);
    run(w, 8);
    expect(w.gameOver).toBe('victory');
  });

  it('holdPoint needs uncontested presence for the full time', () => {
    const w = populated(scenario([{ type: 'holdPoint', x: 40, z: 40, radius: 3, seconds: 6 }]));
    const g = w.spawn('warrior', 'player', 40, 40);
    run(w, 3);
    expect(w.objectives[0].progress).toBeCloseTo(0.5, 1);
    const foe = w.spawn('brave', 'red', 41, 40);
    run(w, 0.5);
    expect(w.objectives[0].progress).toBe(0);
    w.units = w.units.filter((u) => u !== foe);
    run(w, 6.5);
    expect(w.gameOver).toBe('victory');
    expect(g.tribe).toBe('player');
  });

  it('optional objectives do not block victory', () => {
    const w = populated(
      rulesFor(undefined, {
        objectives: [
          { objective: { type: 'survive', seconds: 2 }, text: 'a' },
          { objective: { type: 'reachPopulation', count: 99 }, text: 'b', optional: true },
        ],
      }),
    );
    run(w, 2.2);
    expect(w.gameOver).toBe('victory');
    expect(w.objectives[1].done).toBe(false);
  });
});

describe('fail conditions', () => {
  it('tribeDestroyed is always implied', () => {
    const w = populated(scenario([{ type: 'survive', seconds: 100 }]));
    w.units = w.units.filter((u) => u.tribe !== 'player');
    run(w, 0.2);
    expect(w.gameOver).toBe('defeat');
  });

  it('leaderDies: no reincarnation, immediate defeat', () => {
    const w = populated(scenario([{ type: 'survive', seconds: 100 }], [{ type: 'leaderDies' }]));
    const leader = w.units.find((u) => u.kind === 'shaman' && u.tribe === 'player')!;
    w.hurtUnit(leader, 999);
    run(w, 0.2);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/leader/i);
  });

  it('without leaderDies the leader returns', () => {
    const w = populated(scenario([{ type: 'survive', seconds: 100 }]));
    const leader = w.units.find((u) => u.kind === 'shaman' && u.tribe === 'player')!;
    w.hurtUnit(leader, 999);
    run(w, 0.2);
    expect(eventsOf(w, 'leaderDown').length).toBe(1);
    expect(w.tribeSummary('player').leaderAlive).toBe(false);
    expect(w.tribeSummary('player').leaderRespawn).toBeGreaterThan(0);
    run(w, 20);
    expect(eventsOf(w, 'leaderReturn').length).toBe(1);
    expect(w.tribeSummary('player').leaderAlive).toBe(true);
    expect(w.gameOver).toBeNull();
  });

  it('timeLimit', () => {
    const w = populated(scenario([{ type: 'reachPopulation', count: 99 }], [{ type: 'timeLimit', seconds: 5 }]));
    run(w, 5.3);
    expect(w.gameOver).toBe('defeat');
  });

  it('buildingLost', () => {
    const w = populated(scenario([{ type: 'survive', seconds: 100 }], [{ type: 'buildingLost', kind: 'shrine' }]));
    const s = w.spawnBuilding('player', 'shrine', 40, 40);
    run(w, 1);
    expect(w.gameOver).toBeNull();
    w.hurtBuilding(s, 9999);
    run(w, 0.2);
    expect(w.gameOver).toBe('defeat');
  });
});

describe('monuments', () => {
  it('teach: the first leader learns it for good', () => {
    const w = populated(rulesFor());
    w.monuments = [{ x: 26, z: 20, spell: 'ward', mode: 'teach', claimedBy: null, claimer: null, sleep: 0 }];
    w.orderWorship([w.units.find((u) => u.kind === 'shaman' && u.tribe === 'player')!.id], 0);
    run(w, 15);
    expect(w.spellState('player', 'ward').known).toBe(true);
    expect(w.monuments[0].claimedBy).toBe('player');
  });

  it('gift: free casts, then the stone sleeps', () => {
    const w = populated(rulesFor());
    w.monuments = [{ x: 26, z: 20, spell: 'volcano', mode: 'gift', charges: 2, cooldown: 30, claimedBy: null, claimer: null, sleep: 0, communeSeconds: 6 }];
    const leader = w.units.find((u) => u.kind === 'shaman' && u.tribe === 'player')!;
    w.orderWorship([leader.id], 0);
    run(w, 15);
    const s = w.spellState('player', 'volcano');
    expect(s.gifted).toBe(2);
    expect(s.known).toBe(false);
    expect(eventsOf(w, 'giftClaimed').length).toBe(1);
    expect(w.monuments[0].sleep).toBeGreaterThan(0);
    w.orderWorship([leader.id], 0);
    run(w, 10);
    expect(w.spellState('player', 'volcano').gifted).toBe(2);
    run(w, 30);
    w.orderWorship([leader.id], 0);
    run(w, 10);
    expect(w.spellState('player', 'volcano').gifted).toBe(4);
  });

  it('legacy level monuments load as teach', async () => {
    const { OFFICIAL_LEVELS } = await import('../src/level/official-levels');
    const { World } = await import('../src/sim/world-state');
    const w = new World();
    const lvl = OFFICIAL_LEVELS[0];
    await w.loadLevel(await lvl.build(), { playerCiv: 'forest', difficulty: 'normal' });
    expect(w.monuments.length).toBeGreaterThan(0);
    expect(w.monuments.every((m) => m.mode === 'teach')).toBe(true);
    expect(w.objectives[0].objective.type).toBe('destroyAll');
  });
});
