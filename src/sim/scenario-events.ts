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

import { ScenarioAction, ScenarioEvent, TribeId, UnitKind } from './catalog';
import { castSpell } from './spells';
import type { World } from './world-state';

/** Per-event running memory, parallel to rules.events. */
export interface EventMemory {
  fired: number;
  /** Sim time of the next repeat (when fired > 0). */
  next: number;
}

export function initEventMemory(events: ScenarioEvent[] | undefined): EventMemory[] {
  return (events ?? []).map(() => ({ fired: 0, next: 0 }));
}

function triggered(world: World, ev: ScenarioEvent): boolean {
  const w = ev.when;
  switch (w.type) {
    case 'time':
      return world.elapsed >= w.at;
    case 'zone': {
      const tribe = w.tribe ?? 'player';
      return world.units.some((u) => u.tribe === tribe && !u.hidden && world.distTo(u, w.x, w.z) <= w.radius);
    }
    case 'objective':
      return !!world.objectives[w.index]?.done;
  }
}

export function tickScenarioEvents(world: World): void {
  const events = world.rules.events;
  if (!events || world.gameOver) return;
  events.forEach((ev, i) => {
    const mem = world.eventMemory[i];
    if (!mem) return;
    const times = ev.repeat?.times ?? 1;
    if (mem.fired >= times) return;
    if (mem.fired === 0 ? !triggered(world, ev) : world.elapsed < mem.next) return;
    mem.fired++;
    mem.next = world.elapsed + (ev.repeat?.every ?? 0);
    if (ev.message) world.say(ev.message);
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
          const u = world.spawnNearWalkable(kind, a.tribe, a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r);
          if (u) spawned.push(u);
        }
      }
      if (a.march) {
        for (const u of spawned) world.sendTo(u, a.march.x + (world.random() * 4 - 2), a.march.z + (world.random() * 4 - 2));
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
      world.say(a.text);
      return;
  }
}
