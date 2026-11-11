/**
 * sim/chant.ts — Chanters (see CHANT in catalog.ts).
 *
 * A chanter whose task is 'chant' holds up to CHANT.maxListeners hostile
 * units within pacifyRadius: they cannot attack while they hear it. After
 * convertSeconds of UNINTERRUPTED listening a listener defects to the
 * chanter's tribe. An enemy chanter within pacifyRadius drowns the chant
 * out (both are silenced while they stand that close). Leaders and Wardens
 * can be pacified but never defect. A chanter taking damage resets its
 * listeners' progress (World.hurtUnit calls breakChant).
 */

import { CHANT } from './catalog';
import type { Unit, World } from './world-state';

/** How long a pacify "sticks" after the chant stops reaching a listener. */
const PACIFY_LINGER = 0.35;

const immune = (u: Unit) => u.kind === 'shaman' || u.kind === 'warden';

export function tickChant(world: World, dt: number): void {
  for (const u of world.units) if (u.pacified > 0) u.pacified = Math.max(0, u.pacified - dt);

  const heard = new Set<number>();
  for (const c of world.units) {
    if (c.kind !== 'chanter' || c.task !== 'chant' || c.hidden || c.hp <= 0) continue;
    // Counter-chant: an enemy chanter in earshot silences this one.
    const countered = world.units.some(
      (q) => q.kind === 'chanter' && !q.hidden && q.tribe !== 'wild' && world.hostile(c.tribe, q.tribe) &&
        world.distTo(c, q.x, q.z) <= CHANT.pacifyRadius,
    );
    if (countered) {
      // Drowned out: give up after a moment rather than stand there forever.
      c.workTimer += dt;
      if (c.workTimer > 3) {
        c.workTimer = 0;
        c.task = 'none';
        c.state = 'idle';
      }
      continue;
    }
    c.workTimer = 0;

    const listeners = world.units
      .filter((q) => !q.hidden && q.kind !== 'chanter' && q.tribe !== 'wild' && world.hostile(c.tribe, q.tribe))
      .map((q) => ({ q, d: world.distTo(c, q.x, q.z) }))
      .filter((e) => e.d <= CHANT.pacifyRadius)
      .sort((a, b) => a.d - b.d)
      .slice(0, CHANT.maxListeners);

    if (listeners.length === 0) {
      c.task = 'none';
      c.state = 'idle';
      continue;
    }
    for (const { q } of listeners) {
      if (heard.has(q.id)) continue;
      heard.add(q.id);
      q.pacified = PACIFY_LINGER;
      if (q.chantBy !== c.id) {
        q.chantBy = c.id;
        q.chantProgress = 0;
      }
      q.chantProgress += dt;
      if (q.chantProgress >= CHANT.convertSeconds && !immune(q)) world.defect(q, c);
    }
  }
  for (const u of world.units) {
    if (u.chantBy >= 0 && !heard.has(u.id)) {
      u.chantBy = -1;
      u.chantProgress = 0;
    }
  }
}

/** A chanter was struck: whoever was listening to it starts over. */
export function breakChant(world: World, chanter: Unit): void {
  for (const u of world.units) {
    if (u.chantBy === chanter.id) u.chantProgress = 0;
  }
}
