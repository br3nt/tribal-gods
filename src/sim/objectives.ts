/**
 * sim/objectives.ts — evaluates a scenario's ScenarioRules every tick.
 *
 * Objectives are the human player's ('player'). Each evaluates to a
 * done flag + progress; once done it stays done (a scenario remembers that
 * you held the hill). Victory = every non-optional objective done. Defeat =
 * the player's tribe is gone (always implied) or any listed fail condition
 * trips. world.gameOver latches the first result, with a reason string.
 *
 * A story in steps: an objective with `after: i` stays inactive (hidden,
 * not evaluated) until objective i is done; counting objectives (casts,
 * kindlings, kills, rescues) count from the moment they become active.
 * HELD objectives (loseAtMost, winWithin) are true until broken: `failed`
 * latches when they break, and the survivors are marked done at victory.
 */

import { BUILDINGS, FailCondition, Objective, ObjectiveState, ScenarioRules, TribeId } from './catalog';
import { wrapDelta } from '../core/util';
import { WORLD_SIZE } from '../config';
import type { World } from './world-state';

export const ME: TribeId = 'player';

/** Per-objective running memory (hold timers). Parallel to world.objectives. */
export interface ObjectiveMemory {
  hold: number;
  /** Sim time it became active, and the tally it counts from (counting objectives). */
  since?: number;
  base?: number;
}

export function initObjectives(rules: ScenarioRules): { states: ObjectiveState[]; memory: ObjectiveMemory[] } {
  return {
    states: rules.objectives.map((o) => ({
      objective: o.objective,
      text: o.text,
      done: false,
      progress: 0,
      optional: !!o.optional,
      active: o.after === undefined,
      failed: false,
    })),
    memory: rules.objectives.map(() => ({ hold: 0 })),
  };
}

function rivalsOf(world: World, me: TribeId): TribeId[] {
  return world.activeTribes().filter((t) => t !== me && world.hostile(me, t));
}

const isHeld = (o: Objective) => o.type === 'loseAtMost' || o.type === 'winWithin';

/** The running tally a counting objective counts (null = not a counting objective). */
function tally(world: World, o: Objective): number | null {
  const st = world.tribes[ME] ? world.statsOf(ME) : null;
  switch (o.type) {
    case 'castSpell': {
      if (!st) return 0;
      const r = o.radius ?? 0;
      return st.casts.filter((c) => c.spell === o.spell && (o.x === undefined || o.z === undefined ||
        Math.hypot(wrapDelta(c.x - o.x, WORLD_SIZE), wrapDelta(c.z - o.z, WORLD_SIZE)) <= r)).length;
    }
    case 'convertWanderers': return st?.converted ?? 0;
    case 'rescueStranded': return st?.joined ?? 0;
    case 'killUnits': return world.tribes[o.tribe] ? world.statsOf(o.tribe).lostTotal : 0;
    default: return null;
  }
}

function evaluate(world: World, o: Objective, mem: ObjectiveMemory, dt: number): { done: boolean; progress: number; failed?: boolean } {
  const counted = tally(world, o);
  if (counted !== null) {
    const want = o.type === 'castSpell' ? o.count ?? 1 : (o as { count: number }).count;
    const n = counted - (mem.base ?? 0);
    return { done: n >= want, progress: Math.min(1, n / Math.max(1, want)) };
  }
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
    case 'chargeSpell': {
      const want = o.charges ?? 1;
      const s = world.spellState(ME, o.spell);
      if (!s.known) return { done: false, progress: 0 };
      return { done: s.charges >= want, progress: Math.min(1, (s.charges + s.progress) / want) };
    }
    case 'loseAtMost': {
      const st = world.statsOf(ME);
      const lost = o.kind ? st.lost[o.kind] ?? 0 : st.lostTotal;
      return { done: false, progress: lost <= o.count ? 1 : 0, failed: lost > o.count };
    }
    case 'winWithin':
      return { done: false, progress: world.elapsed <= o.seconds ? 1 - world.elapsed / o.seconds : 0, failed: world.elapsed > o.seconds };
    default:
      return { done: false, progress: 0 };
  }
}

/** Victory: every held objective that was never broken is met. (World.endGame calls this.) */
export function finishHeldObjectives(world: World): void {
  for (const s of world.objectives) {
    if (!s.active || s.done || s.failed || !isHeld(s.objective)) continue;
    const o = s.objective;
    if (o.type === 'winWithin' && world.elapsed > o.seconds) continue;
    s.done = true;
    s.progress = 1;
  }
}

function failReason(world: World, f: FailCondition): string | null {
  switch (f.type) {
    default:
      return null;
    case 'tribeDestroyed':
      return null; // checked unconditionally below
    case 'leaderDies':
      return world.leaderLost(ME) ? 'Your leader has fallen.' : null;
    case 'timeLimit':
      return world.elapsed >= f.seconds ? 'Time ran out.' : null;
    case 'buildingLost':
      return world.lostBuildingKinds(ME).has(f.kind) ? `Your ${BUILDINGS[f.kind].name} was lost.` : null;
    case 'monumentTaken': {
      const m = world.monuments[f.index];
      return m?.firstClaimer && m.firstClaimer !== ME ? 'A rival reached the stone first.' : null;
    }
  }
}

export function tickObjectives(world: World, dt: number): void {
  if (world.gameOver) return;
  const me = world.tribes[ME];

  world.objectives.forEach((state, i) => {
    const mem = (world.objectiveMemory[i] ??= { hold: 0 });
    if (state.active === undefined) state.active = true; // an old save
    if (!state.active) {
      const after = world.rules.objectives[i]?.after;
      if (after === undefined || world.objectives[after]?.done) {
        state.active = true;
        mem.since = world.elapsed;
        mem.base = tally(world, state.objective) ?? 0;
      } else return;
    }
    if (state.done || state.failed) return;
    if (mem.base === undefined) mem.base = 0;
    const r = evaluate(world, state.objective, mem, dt);
    state.progress = r.done ? 1 : r.progress;
    if (r.failed) state.failed = true;
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
