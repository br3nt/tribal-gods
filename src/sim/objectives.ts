/**
 * sim/objectives.ts — evaluates a scenario's ScenarioRules every tick.
 *
 * Objectives are the human player's ('player'). Each evaluates to a
 * done flag + progress; once done it stays done (a scenario remembers that
 * you held the hill). Victory = every non-optional objective done. Defeat =
 * the player's tribe is gone (always implied) or any listed fail condition
 * trips. world.gameOver latches the first result, with a reason string.
 */

import { BUILDINGS, FailCondition, Objective, ObjectiveState, ScenarioRules, TribeId } from './catalog';
import type { World } from './world-state';

export const ME: TribeId = 'player';

/** Per-objective running memory (hold timers). Parallel to world.objectives. */
export interface ObjectiveMemory {
  hold: number;
}

export function initObjectives(rules: ScenarioRules): { states: ObjectiveState[]; memory: ObjectiveMemory[] } {
  return {
    states: rules.objectives.map((o) => ({
      objective: o.objective,
      text: o.text,
      done: false,
      progress: 0,
      optional: !!o.optional,
    })),
    memory: rules.objectives.map(() => ({ hold: 0 })),
  };
}

function rivalsOf(world: World, me: TribeId): TribeId[] {
  return world.activeTribes().filter((t) => t !== me && world.hostile(me, t));
}

function evaluate(world: World, o: Objective, mem: ObjectiveMemory, dt: number): { done: boolean; progress: number } {
  switch (o.type) {
    case 'destroyTribe': {
      const done = !world.tribes[o.tribe] || !world.tribeAlive(o.tribe);
      return { done, progress: done ? 1 : 0 };
    }
    case 'destroyAll': {
      const rivals = rivalsOf(world, ME);
      const dead = rivals.filter((t) => !world.tribeAlive(t)).length;
      // No rivals at all = nothing to destroy, not an instant win.
      return { done: rivals.length > 0 && dead === rivals.length, progress: rivals.length ? dead / rivals.length : 0 };
    }
    case 'survive':
      return { done: world.elapsed >= o.seconds, progress: Math.min(1, world.elapsed / o.seconds) };
    case 'reachPopulation': {
      const pop = world.tribePopulation(ME);
      return { done: pop >= o.count, progress: Math.min(1, pop / o.count) };
    }
    case 'claimMonument': {
      const m = world.monuments[o.index];
      const done = !!m && m.claimer === ME;
      return { done, progress: done ? 1 : 0 };
    }
    case 'buildCount': {
      const n = world.buildings.filter((b) => b.tribe === ME && b.kind === o.kind && b.progress >= 1).length;
      return { done: n >= o.count, progress: Math.min(1, n / o.count) };
    }
    case 'leaderReach': {
      const leader = world.leaderOf(ME);
      const done = !!leader && world.distTo(leader, o.x, o.z) <= o.radius;
      return { done, progress: done ? 1 : 0 };
    }
    case 'holdPoint': {
      let mine = false;
      let contested = false;
      for (const u of world.units) {
        if (u.hidden || world.distTo(u, o.x, o.z) > o.radius) continue;
        if (u.tribe === ME) mine = true;
        else if (u.tribe !== 'wild' && world.hostile(ME, u.tribe)) contested = true;
      }
      mem.hold = mine && !contested ? mem.hold + dt : 0;
      return { done: mem.hold >= o.seconds, progress: Math.min(1, mem.hold / o.seconds) };
    }
  }
}

function failReason(world: World, f: FailCondition): string | null {
  switch (f.type) {
    case 'tribeDestroyed':
      return null; // checked unconditionally below
    case 'leaderDies':
      return world.leaderLost(ME) ? 'Your leader has fallen.' : null;
    case 'timeLimit':
      return world.elapsed >= f.seconds ? 'Time ran out.' : null;
    case 'buildingLost':
      return world.lostBuildingKinds(ME).has(f.kind) ? `Your ${BUILDINGS[f.kind].name} was lost.` : null;
  }
}

export function tickObjectives(world: World, dt: number): void {
  if (world.gameOver) return;
  const me = world.tribes[ME];

  world.objectives.forEach((state, i) => {
    if (state.done) return;
    const r = evaluate(world, state.objective, world.objectiveMemory[i], dt);
    state.progress = r.done ? 1 : r.progress;
    if (r.done) {
      state.done = true;
      const home = me?.home ?? { x: 0, z: 0 };
      world.events.push({ type: 'objectiveDone', x: home.x, z: home.z, magnitude: i });
    }
  });

  // Defeat first: a fail on the same tick as the last objective still loses.
  if (me) {
    if (!world.tribeAlive(ME)) {
      world.endGame('defeat', 'Your tribe has been wiped out.');
      return;
    }
    for (const f of world.rules.fail ?? []) {
      const why = failReason(world, f);
      if (why) {
        world.endGame('defeat', why);
        return;
      }
    }
  }

  const required = world.objectives.filter((o) => !o.optional);
  if (required.length > 0 && required.every((o) => o.done)) {
    world.endGame('victory', required.length === 1 ? `${required[0].text} — done.` : 'Every objective complete.');
  }
}
