/**
 * Story-aware UI: in a scripted chapter the hint chip explains the current
 * objective (ui/objective-advice.ts) and never asks for the impossible;
 * the briefing lists defeats written as story beats (scriptedDefeats).
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioRules } from '../src/sim/catalog';
import { scriptedDefeats } from '../src/ui/campaign-screens';
import { currentObjective, isGuided, objectiveAdvice } from '../src/ui/objective-advice';
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

  it('follows the first active, unfinished objective', () => {
    const w = flatWorld();
    w.objectives = [
      { objective: { type: 'destroyAll' }, text: 'a', done: true, progress: 1, optional: false, active: true, failed: false },
      { objective: { type: 'castSpell', spell: 'landbridge' }, text: 'b', done: false, progress: 0, optional: false, active: false, failed: false },
      { objective: { type: 'buildCount', kind: 'hut', count: 2 }, text: 'c', done: false, progress: 0, optional: false, active: true, failed: false },
    ];
    expect(currentObjective(w)?.text).toBe('c');
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
});
