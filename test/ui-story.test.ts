/**
 * Story-aware UI: in a scripted chapter the hint chip explains the current
 * objective (ui/objective-advice.ts) and never asks for the impossible;
 * the briefing lists defeats written as story beats (scriptedDefeats).
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioRules } from '../src/sim/catalog';
import { scriptedDefeats } from '../src/ui/campaign-screens';
import { currentObjective, isGuided, objectiveAdvice } from '../src/ui/objective-advice';
import { World } from '../src/sim/world-state';
import { victoryBeat } from '../src/ui/victory-beat';
import { flatWorld, rulesFor } from './helpers';

describe('scriptedDefeats', () => {
  it('lists a killed→defeat event as a loss condition, and any other defeat by its reason', () => {
    const rules = {
      ...rulesFor(),
      events: [
        { when: { type: 'killed', tribe: 'player', count: 10, kind: 'brave' }, actions: [{ type: 'defeat', reason: 'Ten lie on the sand.' }] },
        { when: { type: 'time', at: 600 }, actions: [{ type: 'defeat', reason: 'The tide took the Hook.' }] },
        { when: { type: 'time', at: 5 }, actions: [{ type: 'message', text: 'hello' }] },
      ],
    } as ScenarioRules;
    expect(scriptedDefeats(rules)).toEqual(['If 10 Villagers die, it is over.', 'The tide took the Hook.']);
  });
});

describe('objective advice', () => {
  it('a skirmish is not guided; a chapter with scripted events is', () => {
    const w = flatWorld();
    expect(isGuided(w)).toBe(false);
    w.rules.events = [{ when: { type: 'time', at: 1 }, actions: [] }];
    expect(isGuided(w)).toBe(true);
  });

  it('follows the most recently activated unfinished required objective', () => {
    const w = flatWorld();
    w.objectives = [
      { objective: { type: 'destroyAll' }, text: 'a', done: true, progress: 1, optional: false, active: true, failed: false },
      { objective: { type: 'castSpell', spell: 'landbridge' }, text: 'b', done: false, progress: 0, optional: false, active: false, failed: false },
      { objective: { type: 'buildCount', kind: 'hut', count: 2 }, text: 'c', done: false, progress: 0, optional: false, active: true, failed: false },
      { objective: { type: 'convertWanderers', count: 2 }, text: 'd', done: false, progress: 0, optional: false, active: true, failed: false },
      { objective: { type: 'winWithin', seconds: 99 }, text: 'e', done: false, progress: 0, optional: true, active: true, failed: false },
    ];
    // Activated together: the first listed. A later step of the story wins once it activates.
    expect(currentObjective(w, new Map([[0, 0], [2, 0], [3, 0], [4, 0]]))?.text).toBe('c');
    expect(currentObjective(w, new Map([[0, 0], [2, 0], [3, 40], [4, 0]]))?.text).toBe('d');
  });

  it('never says "press" for a spell with nothing to cast — it says it is gathering power', () => {
    const w = flatWorld();
    const t = w.tribes.player!;
    if (!w.leaderOf('player')) w.spawnNearWalkable('shaman', 'player', 40, 40);
    t.known.add('landbridge');
    t.spells.landbridge.charges = 0;
    w.setSpellCharging('player', 'landbridge', true);
    const waiting = objectiveAdvice(w, { type: 'castSpell', spell: 'landbridge', x: 10, z: 10, radius: 4 }, true)!;
    expect(waiting).toMatch(/gathering power/);
    t.spells.landbridge.charges = 1;
    const ready = objectiveAdvice(w, { type: 'castSpell', spell: 'landbridge', x: 10, z: 10, radius: 4 }, true)!;
    expect(ready).toMatch(/^Pick Causeway <span class="kbd">J<\/span> and click the marked place/);
  });

  it('a stone objective follows the ritual: kneeling (with progress), held still, broken and fading', () => {
    const w = flatWorld();
    const l = w.leaderOf('player') ?? w.spawnNearWalkable('shaman', 'player', 40, 40);
    w.monuments = [World.monumentFrom({ x: 44, z: 40, spell: 'volcano', mode: 'gift', charges: 1 })];
    const o = { type: 'claimMonument' as const, index: 0 };
    expect(objectiveAdvice(w, o, true)).toMatch(/Select your leader .* click the Volcano stone/);
    l.hp = l.maxHp * 0.3;
    expect(objectiveAdvice(w, o, true)).toMatch(/wounded \(30%\).*mends on her own/);
    l.hp = l.maxHp;
    const m = w.monuments[0];
    m.communing = true;
    m.communer = 'player';
    m.communerId = l.id;
    m.communeProgress = 0.42;
    expect(objectiveAdvice(w, o, true)).toMatch(/kneeling at the Volcano stone \(42%\)/);
    m.contested = true;
    expect(objectiveAdvice(w, o, true)).toMatch(/held still \(42%\)/);
    m.communing = false;
    m.contested = false;
    m.communer = null;
    expect(objectiveAdvice(w, o, true)).toMatch(/broke at 42%.*kneel again/);
    // No leader (fallen, returning): never "select your leader".
    w.units = w.units.filter((u) => u.kind !== 'shaman');
    expect(objectiveAdvice(w, o, true)).toMatch(/has fallen and returns/);
    expect(objectiveAdvice(w, o, true)).not.toMatch(/Select your leader/);
  });

  it('waiting for raiders with a stone open: the chip points at the stone, like the narrator', () => {
    const w = flatWorld(rulesFor([{ id: 'player', ai: false }, { id: 'violet', ai: false }]));
    if (!w.leaderOf('player')) w.spawnNearWalkable('shaman', 'player', 40, 40);
    w.monuments = [World.monumentFrom({ x: 44, z: 40, spell: 'lightning', mode: 'gift', charges: 3 })];
    const o = { type: 'killUnits' as const, tribe: 'violet' as const, count: 3 };
    expect(objectiveAdvice(w, o, true)).toMatch(/Use the time: select your leader .* the Lightning stone/);
    w.monuments[0].asleep = true;
    expect(objectiveAdvice(w, o, true)).toMatch(/None of them in sight yet/);
  });

  it('a victory waits a beat before its card, longer while a great spell is erupting', () => {
    const w = flatWorld();
    expect(victoryBeat(w)).toBe(2.5);
    w.jobs.push({ spell: 'volcano', x: 1, z: 1, t: 1, duration: 14, angle: 0, fromX: 0, fromZ: 0, seed: 1, tribe: 'player', timer: 0 });
    expect(victoryBeat(w)).toBe(7);
    w.jobs[0].t = 12;
    expect(victoryBeat(w)).toBe(2.5);
  });
});
