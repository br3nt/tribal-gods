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
    case 'noCasts': {
      const t = world.tribes[w.tribe ?? 'player'];
      if (!t) return false;
      const sp = t.spells[w.spell];
      return sp.gifted <= 0 && !(t.known.has(w.spell) && sp.charges > 0);
    }
    case 'any':
      return w.of.some((t) => holds(world, t));
    case 'all':
      return w.of.every((t) => holds(world, t));
    case 'not':
      return !holds(world, w.of);
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
    if (ev.repeat?.while) {
      // A `while` event fires each time its trigger has HELD for a whole
      // `every` (the first time too): a recovery that lends another cast only
      // while one is needed, never the moment one is spent.
      if (!holds(world, ev.when)) {
        mem.armedAt = undefined;
        return;
      }
      mem.armedAt ??= world.elapsed;
      if (world.elapsed - mem.armedAt < ev.repeat.every) return;
      mem.armedAt = world.elapsed;
    } else if (mem.fired === 0 ? !triggered(world, ev, mem) : world.elapsed < mem.next) return;
    mem.fired++;
    mem.next = world.elapsed + (ev.repeat?.every ?? 0);
    if (ev.message) world.say(ev.message, ev.focus);
    for (const a of ev.actions) runAction(world, a);
  });
}

/**
 * LANDINGS. A spawn that comes by sea (comesBySea: `by: 'sea'`, or a
 * homeless war band marching from a shore) comes by boat:
 * the `landing` event goes out the moment it is ordered (the renderer runs
 * the boats in from the sea, the alerts shout), and the crews themselves
 * step onto the sand LANDING.seconds later, when the hulls ground. Without
 * the lead, raiders stood on the beach while their boats were still out at
 * sea. Everything else spawns at once, as before.
 * Pending landings live in world.landings (saved, so a resume keeps them).
 */
export const LANDING = {
  /** Seconds from the order to the crews stepping ashore (render/fleet.ts runs the boats in over exactly this). */
  seconds: 3,
  /** A spawn point counts as a shore when open sea lies within this many tiles. */
  shore: 14,
};

export interface PendingLanding {
  /** Sim time the crews step ashore. */
  at: number;
  action: Extract<ScenarioAction, { type: 'spawn' }>;
  /** Sim time it was ordered (a `hold` counts from here, so a host masses as long as it was told to). */
  orderedAt: number;
}

/** Is there sea within LANDING.shore tiles of (x, z)? (Eight rays: cheap, and only asked when a spawn is ordered.) */
export function byTheSea(world: World, x: number, z: number): boolean {
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    for (let r = 1; r <= LANDING.shore; r++) {
      if (world.map.heightAt(world.map.wrap(Math.round(x + Math.cos(a) * r)), world.map.wrap(Math.round(z + Math.sin(a) * r))) < -0.6) return true;
    }
  }
  return false;
}

/** Does this spawn come by boat? (catalog.ts `by`; omitted = a homeless war band marching from a shore.) */
export function comesBySea(world: World, a: Extract<ScenarioAction, { type: 'spawn' }>): boolean {
  if (a.joins || a.by === 'land') return false;
  if (a.by === 'sea') return true;
  if (!a.march) return false;
  const t = a.tribe === 'wild' ? undefined : world.tribes[a.tribe];
  return !!t && (t.homeless ?? t.personality.builds === false) && byTheSea(world, a.x, a.z);
}

/** Bring ashore every landing whose boats have grounded. */
export function tickLandings(world: World): void {
  if (!world.landings.length) return;
  const due = world.landings.filter((l) => world.elapsed >= l.at);
  if (!due.length) return;
  world.landings = world.landings.filter((l) => world.elapsed < l.at);
  for (const l of due) spawnNow(world, l.action, l.orderedAt);
}

function spawnNow(world: World, a: Extract<ScenarioAction, { type: 'spawn' }>, orderedAt: number): void {
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
      u.holdUntil = orderedAt + a.hold;
    }
  }
  if (a.march) for (const u of spawned) world.sendTo(u, a.march.x + (world.random() * 4 - 2), a.march.z + (world.random() * 4 - 2));
}

export function runAction(world: World, a: ScenarioAction): void {
  switch (a.type) {
    case 'spawn': {
      if (comesBySea(world, a)) {
        const n = Object.values(a.units).reduce((s: number, k) => s + (k ?? 0), 0);
        if (n > 0) {
          world.events.push({ type: 'landing', x: a.x, z: a.z, x2: a.march?.x, z2: a.march?.z, magnitude: n, tribe: a.tribe });
          world.landings.push({ at: world.elapsed + LANDING.seconds, action: a, orderedAt: world.elapsed });
        }
        return;
      }
      spawnNow(world, a, world.elapsed);
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
