/**
 * sim/scenario-events.ts — scripted happenings in a scenario.
 *
 * ScenarioRules.events is a list of { when, repeat?, actions, message? }
 * rows (see catalog.ts). Every tick this module checks each row's trigger —
 * a time, a tribe stepping into a circle, an objective completing — and
 * runs its actions: raiders landing, alliances turning, a passive god
 * waking, the sea itself casting Undertow on the lowlands.
 *
 * It is pure data → behaviour: nothing here knows which scenario is
 * running. A repeating row fires `times` times, `every` seconds apart,
 * counting from its first firing.
 */

import { ScenarioAction, ScenarioEvent, ScenarioTrigger, TribeId, UnitKind } from './catalog';
import { wrapDelta } from '../core/util';
import { WORLD_SIZE } from '../config';
import { castSpell } from './spells';
import type { World } from './world-state';

/** Per-event running memory, parallel to rules.events. */
export interface EventMemory {
  fired: number;
  /** Sim time of the next repeat (when fired > 0). */
  next: number;
  /** Sim time the trigger first held (events with a `delay`). */
  armedAt?: number;
}

export function initEventMemory(events: ScenarioEvent[] | undefined): EventMemory[] {
  return (events ?? []).map(() => ({ fired: 0, next: 0 }));
}

function holds(world: World, w: ScenarioTrigger): boolean {
  switch (w.type) {
    case 'time':
      return world.elapsed >= w.at;
    case 'zone': {
      const tribe = w.tribe ?? 'player';
      const want = w.count ?? 1;
      let n = 0;
      for (const u of world.units) {
        if (u.tribe !== tribe || u.hidden || (w.kind && u.kind !== w.kind) || world.distTo(u, w.x, w.z) > w.radius) continue;
        if (++n >= want) return true;
      }
      return false;
    }
    case 'objective':
      return !!world.objectives[w.index]?.done;
    case 'spellCast': {
      const tribe = w.tribe ?? 'player';
      if (!world.tribes[tribe]) return false;
      return world.statsOf(tribe).casts.some((c) => (!w.spell || c.spell === w.spell) &&
        (w.x === undefined || w.z === undefined || Math.hypot(wrapDelta(c.x - w.x, WORLD_SIZE), wrapDelta(c.z - w.z, WORLD_SIZE)) <= (w.radius ?? 0)));
    }
    case 'joined': {
      const tribe = w.tribe ?? 'player';
      return !!world.tribes[tribe] && world.statsOf(tribe).joined >= w.count;
    }
    case 'killed': {
      if (!world.tribes[w.tribe]) return false;
      const st = world.statsOf(w.tribe);
      return (w.kind ? st.lost[w.kind] ?? 0 : st.lostTotal) >= w.count;
    }
    case 'commune': {
      const m = world.monuments[w.index];
      return !!m && (!!m.communing || (m.communeProgress ?? 0) > 0 || !!m.claimer) && (!w.tribe || m.communer === w.tribe || m.claimer === w.tribe);
    }
    case 'any':
      return w.of.some((t) => holds(world, t));
    default:
      return false;
  }
}

function triggered(world: World, ev: ScenarioEvent, mem: EventMemory): boolean {
  if (!ev.delay) return holds(world, ev.when);
  if (mem.armedAt === undefined) {
    if (!holds(world, ev.when)) return false;
    mem.armedAt = world.elapsed;
  }
  return world.elapsed >= mem.armedAt + ev.delay;
}

export function tickScenarioEvents(world: World): void {
  const events = world.rules.events;
  if (!events || world.gameOver) return;
  events.forEach((ev, i) => {
    const mem = world.eventMemory[i];
    if (!mem) return;
    const times = ev.repeat?.times ?? 1;
    if (mem.fired >= times) return;
    if (mem.fired === 0 ? !triggered(world, ev, mem) : world.elapsed < mem.next) return;
    mem.fired++;
    mem.next = world.elapsed + (ev.repeat?.every ?? 0);
    if (ev.message) world.say(ev.message, ev.focus);
    for (const a of ev.actions) runAction(world, a);
  });
}

export function runAction(world: World, a: ScenarioAction): void {
  switch (a.type) {
    case 'spawn': {
      const spawned = [];
      let slot = 0;
      for (const [kind, n] of Object.entries(a.units) as Array<[UnitKind, number]>) {
        for (let i = 0; i < n; i++) {
          const ang = slot * 2.4;
          const r = 1 + Math.sqrt(slot) * 1.1;
          slot++;
          const u = world.spawnNearWalkable(kind, a.tribe, a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r, !!a.joins);
          if (u) spawned.push(u);
        }
      }
      for (const u of spawned) {
        if (a.joins) {
          u.tribe = 'wild';
          u.joins = a.joins;
        }
        if (a.march && a.hold) {
          u.holdAt = { x: a.march.x, z: a.march.z };
          u.holdUntil = world.elapsed + a.hold;
        }
      }
      if (a.march) {
        for (const u of spawned) world.sendTo(u, a.march.x + (world.random() * 4 - 2), a.march.z + (world.random() * 4 - 2));
        if (spawned.length) world.events.push({ type: 'landing', x: a.x, z: a.z, x2: a.march.x, z2: a.march.z, magnitude: spawned.length, tribe: a.tribe });
      }
      return;
    }
    case 'allies': {
      const t = world.tribes[a.tribe];
      if (!t) return;
      t.allies = a.allies.filter((id) => id !== a.tribe && world.tribes[id]);
      for (const id of world.activeTribes()) {
        if (id === a.tribe) continue;
        const o = world.tribes[id]!;
        const want = t.allies.includes(id);
        o.allies = o.allies.filter((x) => x !== a.tribe);
        if (want) o.allies.push(a.tribe);
      }
      return;
    }
    case 'wake': {
      const ai = world.tribes[a.tribe]?.ai;
      if (ai) ai.awake = true;
      return;
    }
    case 'teach':
      world.tribes[a.tribe]?.known.add(a.spell);
      return;
    case 'gift': {
      const t = world.tribes[a.tribe];
      if (t) t.spells[a.spell].gifted += a.charges;
      return;
    }
    case 'strike': {
      const x = world.map.wrap(Math.round(a.x));
      const z = world.map.wrap(Math.round(a.z));
      castSpell(world, a.spell, x, z, x, z, a.tribe as TribeId);
      return;
    }
    case 'message':
      world.say(a.text, a.focus);
      return;
    case 'openStone': {
      const m = world.monuments[a.index];
      if (m) m.asleep = false;
      return;
    }
    case 'defeat':
      world.endGame('defeat', a.reason);
      return;
  }
}
