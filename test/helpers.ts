/**
 * Test helpers: a flat, empty, deterministic planet with no AI, so each
 * test sets up exactly the pieces it is about.
 */
import type { ScenarioRules, TribeId } from '../src/sim/catalog';
import { World } from '../src/sim/world-state';

export function rulesFor(
  tribes: ScenarioRules['tribes'] = [
    { id: 'player', ai: false },
    { id: 'red', ai: false },
  ],
  extra: Partial<ScenarioRules> = {},
): ScenarioRules {
  return {
    tribes,
    objectives: [{ objective: { type: 'destroyAll' }, text: 'Destroy every rival' }],
    briefing: { title: 'Test', body: '', tips: [] },
    ...extra,
  };
}

export const HOMES: Record<TribeId, { x: number; z: number }> = {
  player: { x: 20, z: 20 },
  red: { x: 84, z: 84 },
  gold: { x: 20, z: 84 },
  violet: { x: 84, z: 20 },
};

/** Flat land at height 2 everywhere, no trees, units, buildings or monuments. */
export function flatWorld(rules: ScenarioRules = rulesFor(), seed = 1): World {
  const w = new World();
  w.reset(seed, { playerCiv: 'forest', difficulty: 'normal' }, rules);
  w.map.heights.fill(2);
  w.map.version++;
  w.trees = [];
  w.units = [];
  w.buildings = [];
  w.monuments = [];
  w.events = [];
  w.jobs = [];
  w.auras = [];
  w.obstacles.clear();
  for (const id of w.activeTribes()) {
    w.tribes[id]!.home = { ...HOMES[id] };
  }
  return w;
}

export function run(w: World, seconds: number, dt = 1 / 15): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) w.tick(dt);
}

export function eventsOf(w: World, type: string) {
  return w.events.filter((e) => e.type === type);
}
