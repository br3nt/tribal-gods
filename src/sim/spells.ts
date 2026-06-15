/**
 * sim/spells.ts — the spell book: definitions, costs, and what each one
 * actually does to the world.
 *
 * Two kinds of spell live here:
 *
 *   INSTANT spells (blast, convert, lightning, swamp) apply their whole
 *   effect the moment the shaman finishes casting.
 *
 *   JOB spells (landbridge, flatten, earthquake, volcano) spawn a SpellJob
 *   that the sim ticks for several seconds — a volcano GROWS, a quake
 *   RIPS. Animated terrain violence is the soul of this game; a volcano
 *   that popped into existence fully formed would be a stage prop.
 *
 * Every terrain effect is, underneath, just edits to the heightmap (see
 * world/heightmap.ts) — these functions are where "spell" and "array
 * write" meet. Side effects on creatures and buildings (damage, knockback,
 * conversion) go through World's helper methods so the rules stay in one
 * place.
 *
 * Visuals and audio are NOT here: spells push GameEvents onto world.events
 * and the render side (render/effects.ts) turns those into fireballs,
 * bolts, shakes and booms. The sim stays headless and testable.
 */

import { MAX_HEIGHT, MIN_HEIGHT, WORLD_SIZE } from '../config';
import { hash2 } from '../core/noise';
import { clamp, smoothstep, wrapDelta } from '../core/util';
import type { TribeId, World } from './world-state';

export type SpellId =
  | 'blast'
  | 'convert'
  | 'lightning'
  | 'swamp'
  | 'landbridge'
  | 'flatten'
  | 'earthquake'
  | 'volcano';

export interface SpellMeta {
  id: SpellId;
  name: string;
  icon: string;
  cost: number;
  blurb: string;
}

/** Display order = panel order = number-key order (3..9, 0). */
export const SPELLS: SpellMeta[] = [
  { id: 'blast', name: 'Blast', icon: '💥', cost: 12, blurb: 'A crater and a crowd sent flying' },
  { id: 'convert', name: 'Convert', icon: '✨', cost: 10, blurb: 'Wildmen nearby join the tribe' },
  { id: 'lightning', name: 'Lightning', icon: '⚡', cost: 25, blurb: 'One bolt, no survivors underneath' },
  { id: 'swamp', name: 'Swamp', icon: '🌿', cost: 30, blurb: 'Ground that swallows whoever steps in' },
  { id: 'landbridge', name: 'Landbridge', icon: '🌉', cost: 35, blurb: 'Raise a causeway from the shaman outward' },
  { id: 'flatten', name: 'Flatten', icon: '▦', cost: 20, blurb: 'Level ground, ready for building' },
  { id: 'earthquake', name: 'Quake', icon: '〰', cost: 80, blurb: 'A fault line rips the land open' },
  { id: 'volcano', name: 'Volcano', icon: '🌋', cost: 140, blurb: 'The showstopper. Save up.' },
];

export const spellMeta = (id: SpellId): SpellMeta => SPELLS.find((s) => s.id === id)!;

/** A spell effect that plays out over several seconds of sim time. */
export interface SpellJob {
  spell: SpellId;
  x: number;
  z: number;
  t: number; // elapsed seconds
  duration: number;
  /** Quake fault angle / bridge direction; meaning depends on the spell. */
  angle: number;
  /** Landbridge start point (the shaman's feet when she cast it). */
  fromX: number;
  fromZ: number;
  seed: number;
}

const N = WORLD_SIZE;

// ---------------------------------------------------------------------------
// Casting: the moment the shaman's staff comes down
// ---------------------------------------------------------------------------

export function castSpell(
  world: World,
  id: SpellId,
  x: number,
  z: number,
  casterX: number,
  casterZ: number,
  casterTribe: TribeId,
): void {
  switch (id) {
    case 'blast': {
      // Punch a crater and throw everyone nearby outward. The knockback is
      // half the fun — Populous crowds were made to be bowled over.
      world.map.raise(x, z, 3, -2.4);
      for (const u of world.units) {
        if (u.hidden) continue;
        const dx = wrapDelta(u.x - x, N);
        const dz = wrapDelta(u.z - z, N);
        const d = Math.hypot(dx, dz);
        if (d > 4.5) continue;
        const falloff = 1 - d / 4.5;
        world.hurtUnit(u, 9 * falloff);
        // Fling away from the center (normalized; epsilon dodges divide-by-zero
        // for a direct hit, who goes... somewhere).
        const inv = 1 / Math.max(d, 0.3);
        world.displaceUnit(u, dx * inv * 2.2 * falloff, dz * inv * 2.2 * falloff);
      }
      for (const b of world.buildings) {
        const d = Math.hypot(wrapDelta(b.x - x, N), wrapDelta(b.z - z, N));
        if (d < 4) world.hurtBuilding(b, 0.45 * (1 - d / 4));
      }
      world.events.push({ type: 'explosion', x, z });
      return;
    }

    case 'convert': {
      // The recruiting spell: nearby wildmen see the light (and join
      // whichever tribe's shaman is preaching).
      for (const u of world.units) {
        if (u.kind !== 'wildman') continue;
        if (Math.hypot(wrapDelta(u.x - x, N), wrapDelta(u.z - z, N)) > 5) continue;
        u.kind = 'brave';
        u.tribe = casterTribe;
        u.hp = 10;
        world.events.push({ type: 'convert', x: u.x, z: u.z });
      }
      return;
    }

    case 'lightning': {
      // Surgical: huge damage, tiny radius, small scorch mark.
      world.map.raise(x, z, 1.4, -0.5);
      for (const u of world.units) {
        if (u.hidden) continue;
        if (Math.hypot(wrapDelta(u.x - x, N), wrapDelta(u.z - z, N)) > 2) continue;
        world.hurtUnit(u, 30);
      }
      for (const b of world.buildings) {
        if (Math.hypot(wrapDelta(b.x - x, N), wrapDelta(b.z - z, N)) > 2.5) continue;
        world.hurtBuilding(b, 0.6);
      }
      world.events.push({ type: 'lightning', x, z });
      return;
    }

    case 'swamp': {
      // Mark a blob of tiles as swamp — a terrain TYPE edit, not a height
      // edit. Anyone who steps in sinks (see the environment check in
      // world-state's tick). Expires after a while.
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (Math.hypot(dx, dz) > 3.2) continue;
          const tx = world.map.wrap(Math.round(x + dx));
          const tz = world.map.wrap(Math.round(z + dz));
          if (world.map.heightAt(tx, tz) < 0.2) continue; // can't swamp the sea
          world.swamp.set(tz * N + tx, 45);
        }
      }
      world.events.push({ type: 'swamp', x, z });
      return;
    }

    // Job spells: spawn the slow-burn effect.
    case 'landbridge':
      world.jobs.push({
        spell: id, x, z, t: 0, duration: 2.5,
        angle: 0, fromX: casterX, fromZ: casterZ, seed: (Math.random() * 1e9) | 0,
      });
      world.events.push({ type: 'rumbleSmall', x, z });
      return;
    case 'flatten':
      world.jobs.push({ spell: id, x, z, t: 0, duration: 1.2, angle: 0, fromX: x, fromZ: z, seed: 0 });
      return;
    case 'earthquake':
      world.jobs.push({
        spell: id, x, z, t: 0, duration: 4,
        angle: Math.random() * Math.PI, fromX: x, fromZ: z, seed: (Math.random() * 1e9) | 0,
      });
      world.events.push({ type: 'quakeStart', x, z });
      return;
    case 'volcano':
      world.jobs.push({ spell: id, x, z, t: 0, duration: 9, angle: 0, fromX: x, fromZ: z, seed: 0 });
      world.events.push({ type: 'volcanoStart', x, z });
      return;
  }
}

// ---------------------------------------------------------------------------
// Jobs: spells that take their time
// ---------------------------------------------------------------------------

/** Advance every running spell job by dt. Called from World.tick. */
export function tickJobs(world: World, dt: number): void {
  for (const job of world.jobs) {
    job.t += dt;
    switch (job.spell) {
      case 'landbridge': tickLandbridge(world, job, dt); break;
      case 'flatten': world.map.flatten(job.x, job.z, 5, dt * 2.2); break;
      case 'earthquake': tickEarthquake(world, job, dt); break;
      case 'volcano': tickVolcano(world, job, dt); break;
      default: break;
    }
  }
  world.jobs = world.jobs.filter((j) => j.t < j.duration);
}

/**
 * The causeway grows from the shaman toward the target — a frontier sweeps
 * along the line and seafloor behind it rises to just above sea level.
 * Watching the path assemble ahead of your marching tribe never gets old.
 */
function tickLandbridge(world: World, job: SpellJob, dt: number): void {
  const dx = wrapDelta(job.x - job.fromX, N);
  const dz = wrapDelta(job.z - job.fromZ, N);
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const frontier = (job.t / job.duration) * len;
  // March along the line in sub-tile steps; widen each step sideways.
  for (let s = 0; s <= Math.min(frontier, len); s += 0.6) {
    const px = job.fromX + (dx / len) * s;
    const pz = job.fromZ + (dz / len) * s;
    for (let w = -1; w <= 1; w++) {
      const tx = world.map.wrap(Math.round(px - (dz / len) * w));
      const tz = world.map.wrap(Math.round(pz + (dx / len) * w));
      const i = tz * N + tx;
      // A pinch of per-tile noise keeps the causeway looking geological.
      const target = 1.5 + hash2(tx, tz, 31) * 0.6;
      if (world.map.heights[i] < target) {
        world.map.heights[i] = Math.min(target, world.map.heights[i] + dt * 9);
      }
    }
  }
  world.map.version++;
}

/**
 * A fault line through the target: tiles in a band along a random angle
 * get hammered with signed noise, biased downward — cracks, slumps, chaos.
 * Buildings caught in the band shake apart.
 */
function tickEarthquake(world: World, job: SpellJob, dt: number): void {
  const cos = Math.cos(job.angle);
  const sin = Math.sin(job.angle);
  for (let s = -13; s <= 13; s++) {
    for (let w = -2; w <= 2; w++) {
      const tx = world.map.wrap(Math.round(job.x + cos * s - sin * w));
      const tz = world.map.wrap(Math.round(job.z + sin * s + cos * w));
      const i = tz * N + tx;
      // Per-tile fixed random in [-0.62, 0.38]: mostly down, some up = ridges.
      const bias = hash2(tx, tz, job.seed) - 0.62;
      world.map.heights[i] = clamp(world.map.heights[i] + bias * 7 * dt, MIN_HEIGHT, MAX_HEIGHT);
    }
  }
  world.map.version++;

  for (const b of world.buildings) {
    // Distance from the fault LINE (not the epicenter): project onto the normal.
    const bx = wrapDelta(b.x - job.x, N);
    const bz = wrapDelta(b.z - job.z, N);
    const along = Math.abs(bx * cos + bz * sin);
    const across = Math.abs(-bx * sin + bz * cos);
    if (along < 14 && across < 4) world.hurtBuilding(b, dt * 0.5);
  }

  // Rattle the camera in pulses while the ground tears.
  if (Math.floor(job.t / 0.4) !== Math.floor((job.t - dt) / 0.4)) {
    world.events.push({ type: 'shake', x: job.x, z: job.z, magnitude: 0.5 });
  }
}

/**
 * THE SHOWSTOPPER. A cone of rock erupts out of the ground over nine
 * seconds: each tick, terrain under the volcano grows toward an eased
 * fraction of the final cone profile (peak ~15 units, crater dip in the
 * middle). Everything near it burns; buildings crumble; the camera shakes;
 * the renderer pumps out smoke plumes. Permanent terrain — the planet
 * remembers what you did.
 */
function tickVolcano(world: World, job: SpellJob, dt: number): void {
  const R = 8.5;
  const ease = smoothstep(0, 1, job.t / job.duration);
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > R) continue;
      let profile = 15 * Math.pow(1 - d / R, 1.35);
      if (d < 2) profile -= (2 - d) * 2.5; // the crater
      const want = profile * ease;
      const tx = world.map.wrap(Math.round(job.x + dx));
      const tz = world.map.wrap(Math.round(job.z + dz));
      const i = tz * N + tx;
      if (world.map.heights[i] < want) {
        world.map.heights[i] = clamp(Math.min(want, world.map.heights[i] + dt * 7), MIN_HEIGHT, MAX_HEIGHT);
      }
    }
  }
  world.map.version++;

  // The mountain does not care whose village this was.
  for (const u of world.units) {
    if (u.hidden) continue;
    if (Math.hypot(wrapDelta(u.x - job.x, N), wrapDelta(u.z - job.z, N)) < 7) {
      world.hurtUnit(u, dt * 6);
    }
  }
  for (const b of world.buildings) {
    if (Math.hypot(wrapDelta(b.x - job.x, N), wrapDelta(b.z - job.z, N)) < 8) {
      world.hurtBuilding(b, dt * 0.35);
    }
  }

  // Smoke plumes and tremors, throttled to a few per second.
  if (Math.floor(job.t / 0.6) !== Math.floor((job.t - dt) / 0.6)) {
    world.events.push({ type: 'plume', x: job.x, z: job.z });
    world.events.push({ type: 'shake', x: job.x, z: job.z, magnitude: 0.35 });
  }
}
