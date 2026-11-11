/**
 * sim/spells.ts — what each spell actually does to the world.
 *
 * Definitions (names, charge costs, ranges, radii, durations) live in
 * catalog.ts; this module is behaviour only. Three shapes of spell:
 *
 *   INSTANT — blast, convert, lightning, swamp: the whole effect lands the
 *   moment the leader finishes casting.
 *
 *   BUFF — ward, warsong: stamp a timer on the caster's people in the
 *   circle, and leave an aura record for the renderer.
 *
 *   JOB — landbridge, flatten, earthquake, volcano, bloom, cyclone,
 *   emberfall, sink: a SpellJob the sim ticks for `duration` seconds. A
 *   volcano GROWS, a cyclone WANDERS, the land SINKS.
 *
 * Terrain effects are heightmap edits; side effects on creatures and
 * buildings go through World helpers so the rules (armor, ward, warden
 * spell resistance, fire) stay in one place. Visuals are not here: spells
 * push GameEvents (catalog EFFECT_EVENTS) and the renderer draws them.
 * All chance goes through world.random() so the sim stays deterministic.
 */

import { BUFFS, MAX_HEIGHT, MIN_HEIGHT, WALK_MIN_HEIGHT, WORLD_SIZE } from '../config';
import { hash2 } from '../core/noise';
import { clamp, smoothstep, wrapDelta } from '../core/util';
import { spellDef, SpellId, TribeId, UNITS } from './catalog';
import { tileIndex } from './pathfinding';
import type { Unit, World } from './world-state';

export type { SpellId } from './catalog';
/** Spell rows now live in the catalog; re-exported for older imports. */
export { SPELLS, spellDef, spellDef as spellMeta } from './catalog';

export type AuraKind = 'ward' | 'warsong' | 'bloom' | 'emberfall' | 'sink' | 'cyclone';

/** A timed effect in the world, as plain data for the renderer. */
export interface Aura {
  kind: AuraKind;
  x: number;
  z: number;
  radius: number;
  /** Seconds elapsed. */
  t: number;
  duration: number;
  tribe: TribeId;
}

/** A spell effect that plays out over several seconds of sim time. */
export interface SpellJob {
  spell: SpellId;
  x: number;
  z: number;
  t: number; // elapsed seconds
  duration: number;
  /** Quake fault angle / cyclone heading; meaning depends on the spell. */
  angle: number;
  /** Landbridge start point (the leader's feet when she cast it). */
  fromX: number;
  fromZ: number;
  seed: number;
  tribe: TribeId;
  /** Countdown to the next pulse (cyclone touch, ember strike). */
  timer: number;
  aura?: Aura;
  /** Sink: the heights under the circle when it was cast. */
  base?: Map<number, number>;
}

const N = WORLD_SIZE;
const dist = (ax: number, az: number, bx: number, bz: number) =>
  Math.hypot(wrapDelta(ax - bx, N), wrapDelta(az - bz, N));

/**
 * A crater that dents land without drowning it: ground that was dry keeps
 * its floor just above the sea. Craters still break a hillside and scatter
 * people, but a fight on a causeway no longer sinks the causeway.
 */
function crater(world: World, x: number, z: number, r: number, depth: number): void {
  const R = Math.ceil(r);
  const cx = Math.round(x);
  const cz = Math.round(z);
  const floor = WALK_MIN_HEIGHT + 0.4;
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(cx + dx - x, cz + dz - z);
      if (d > r) continue;
      const f = 0.5 * (1 + Math.cos((Math.PI * d) / r));
      const i = tileIndex(cx + dx, cz + dz);
      const h = world.map.heights[i];
      let nh = h - depth * f;
      if (h >= WALK_MIN_HEIGHT) nh = Math.max(nh, Math.min(h, floor));
      world.map.heights[i] = clamp(nh, MIN_HEIGHT, MAX_HEIGHT);
    }
  }
  world.map.version++;
}

function addAura(world: World, kind: AuraKind, x: number, z: number, radius: number, duration: number, tribe: TribeId): Aura {
  const aura: Aura = { kind, x, z, radius, t: 0, duration, tribe };
  world.auras.push(aura);
  return aura;
}

function pushJob(world: World, job: Omit<SpellJob, 't' | 'timer' | 'seed' | 'angle' | 'fromX' | 'fromZ'> & Partial<SpellJob>): SpellJob {
  const full: SpellJob = {
    t: 0,
    timer: 0,
    seed: (world.random() * 1e9) | 0,
    angle: 0,
    fromX: job.x,
    fromZ: job.z,
    ...job,
  };
  world.jobs.push(full);
  return full;
}

// ---------------------------------------------------------------------------
// Casting: the moment the leader's staff comes down
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
  const def = spellDef(id);
  const R = def.radius;
  switch (id) {
    case 'blast': {
      // Punch a crater and throw everyone nearby outward.
      crater(world, x, z, 3, 2.4);
      for (const u of world.units) {
        if (u.hidden) continue;
        const dx = wrapDelta(u.x - x, N);
        const dz = wrapDelta(u.z - z, N);
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const falloff = 1 - d / R;
        world.hurtUnit(u, 9 * falloff, { spell: true });
        const inv = 1 / Math.max(d, 0.3);
        world.displaceUnit(u, dx * inv * 2.2 * falloff, dz * inv * 2.2 * falloff);
      }
      for (const b of world.buildings) {
        const d = dist(b.x, b.z, x, z);
        if (d < R) world.hurtBuildingFrac(b, 0.45 * (1 - d / R));
      }
      world.events.push({ type: 'explosion', x, z });
      return;
    }

    case 'convert': {
      // Wanderers in the circle join whichever tribe's leader is preaching.
      for (const u of world.units) {
        if (u.kind !== 'wildman') continue;
        if (dist(u.x, u.z, x, z) > R) continue;
        u.kind = 'brave';
        u.tribe = casterTribe;
        u.joins = null;
        world.statsOf(casterTribe).converted++;
        u.hp = u.maxHp = UNITS.brave.hp;
        world.events.push({ type: 'convert', x: u.x, z: u.z });
      }
      return;
    }

    case 'lightning': {
      // One bolt: kills what it hits, arcs to two more, sets wood alight.
      crater(world, x, z, 1.4, 0.5);
      const hit = new Set<number>();
      for (const u of world.units) {
        if (u.hidden || dist(u.x, u.z, x, z) > R + 0.5) continue;
        world.hurtUnit(u, 30, { spell: true });
        hit.add(u.id);
      }
      const arcs = world.units
        .filter((u) => !u.hidden && !hit.has(u.id) && world.foeOfTribe(casterTribe, u))
        .map((u) => ({ u, d: dist(u.x, u.z, x, z) }))
        .filter((c) => c.d < 6)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const { u } of arcs) {
        world.hurtUnit(u, 20, { spell: true });
        world.events.push({ type: 'lightning', x: u.x, z: u.z, x2: x, z2: z, magnitude: 0.5 });
      }
      for (const b of world.buildings) {
        if (dist(b.x, b.z, x, z) > R + b.size / 2 + 0.5) continue;
        world.hurtBuildingFrac(b, 0.3);
        world.ignite(b);
      }
      world.igniteTreesNear(x, z, R);
      world.events.push({ type: 'lightning', x, z });
      return;
    }

    case 'swamp': {
      // A terrain TYPE edit, not a height edit: tiles that swallow walkers.
      const r = Math.ceil(R);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dz) > R - 0.8) continue;
          const tx = world.map.wrap(Math.round(x + dx));
          const tz = world.map.wrap(Math.round(z + dz));
          if (world.map.heightAt(tx, tz) < 0.2) continue; // can't swamp the sea
          world.swamp.set(tz * N + tx, def.duration);
        }
      }
      world.events.push({ type: 'swamp', x, z });
      return;
    }

    case 'ward': {
      for (const u of world.units) {
        if (u.hidden || !world.friendly(casterTribe, u.tribe)) continue;
        if (dist(u.x, u.z, x, z) <= R) u.wardTime = def.duration;
      }
      for (const b of world.buildings) {
        if (!world.friendly(casterTribe, b.tribe)) continue;
        if (dist(b.x, b.z, x, z) <= R + b.size / 2) b.wardTime = def.duration;
      }
      addAura(world, 'ward', x, z, R, def.duration, casterTribe);
      world.events.push({ type: 'wardCast', x, z, magnitude: R });
      return;
    }

    case 'warsong': {
      for (const u of world.units) {
        if (u.hidden || !world.friendly(casterTribe, u.tribe)) continue;
        if (u.kind === 'brave' || u.kind === 'wildman') continue; // fighters (and the leader) only
        if (dist(u.x, u.z, x, z) <= R) u.warsongTime = def.duration;
      }
      addAura(world, 'warsong', x, z, R, def.duration, casterTribe);
      world.events.push({ type: 'warsongCast', x, z, magnitude: R });
      return;
    }

    case 'bloom': {
      // Felled trees regrow at once; a few new ones sprout on open ground.
      const occupied = new Set<number>();
      for (const t of world.trees) {
        occupied.add(tileIndex(t.x, t.z));
        if (dist(t.x, t.z, x, z) > R) continue;
        t.burning = 0;
        if (!t.alive) {
          t.alive = true;
          t.regrow = 0;
        }
      }
      let sprouted = 0;
      for (let attempt = 0; attempt < 60 && sprouted < 6; attempt++) {
        const a = world.random() * Math.PI * 2;
        const r = Math.sqrt(world.random()) * R;
        const tx = world.map.wrap(Math.round(x + Math.cos(a) * r));
        const tz = world.map.wrap(Math.round(z + Math.sin(a) * r));
        const ti = tileIndex(tx, tz);
        if (occupied.has(ti) || world.obstacles.has(ti)) continue;
        if (world.map.heightAt(tx, tz) < WALK_MIN_HEIGHT + 0.6) continue;
        world.trees.push({ x: tx, z: tz, alive: true, regrow: 0, burning: 0 });
        occupied.add(ti);
        sprouted++;
      }
      world.treesVersion++;
      const job = pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe });
      job.aura = addAura(world, 'bloom', x, z, R, def.duration, casterTribe);
      world.events.push({ type: 'bloomCast', x, z, magnitude: R });
      return;
    }

    case 'cyclone': {
      const job = pushJob(world, {
        spell: id, x, z, duration: def.duration, tribe: casterTribe,
        angle: Math.atan2(wrapDelta(z - casterZ, N), wrapDelta(x - casterX, N)),
      });
      job.aura = addAura(world, 'cyclone', x, z, R, def.duration, casterTribe);
      world.events.push({ type: 'cycloneTouch', x, z, magnitude: 0 });
      return;
    }

    case 'emberfall': {
      const job = pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe });
      job.aura = addAura(world, 'emberfall', x, z, R, def.duration, casterTribe);
      world.events.push({ type: 'emberStrike', x, z, magnitude: 0 });
      return;
    }

    case 'sink': {
      const base = new Map<number, number>();
      const r = Math.ceil(R);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dz) > R) continue;
          const i = tileIndex(Math.round(x + dx), Math.round(z + dz));
          base.set(i, world.map.heights[i]);
        }
      }
      const job = pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe, base });
      job.aura = addAura(world, 'sink', x, z, R, def.duration, casterTribe);
      world.events.push({ type: 'sinkRumble', x, z, magnitude: 0.4 });
      return;
    }

    case 'landbridge':
      pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe, fromX: casterX, fromZ: casterZ });
      world.events.push({ type: 'rumbleSmall', x, z });
      return;
    case 'flatten':
      pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe });
      world.events.push({ type: 'rumbleSmall', x, z });
      return;
    case 'earthquake': {
      // The fault runs along the line from the leader to the mark.
      const dx = wrapDelta(x - casterX, N);
      const dz = wrapDelta(z - casterZ, N);
      const angle = Math.hypot(dx, dz) > 0.5 ? Math.atan2(dz, dx) : world.random() * Math.PI;
      pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe, angle });
      world.events.push({ type: 'quakeStart', x, z });
      return;
    }
    case 'volcano':
      pushJob(world, { spell: id, x, z, duration: def.duration, tribe: casterTribe });
      world.events.push({ type: 'volcanoStart', x, z });
      return;
  }
}

// ---------------------------------------------------------------------------
// Jobs: spells that take their time
// ---------------------------------------------------------------------------

/** Advance every running spell job and aura by dt. Called from World.tick. */
export function tickJobs(world: World, dt: number): void {
  for (const job of world.jobs) {
    job.t += dt;
    switch (job.spell) {
      case 'landbridge': tickLandbridge(world, job, dt); break;
      case 'flatten': world.map.flatten(job.x, job.z, spellDef('flatten').radius, dt * 1.1); break;
      case 'earthquake': tickEarthquake(world, job, dt); break;
      case 'volcano': tickVolcano(world, job, dt); break;
      case 'bloom': tickBloom(world, job, dt); break;
      case 'cyclone': tickCyclone(world, job, dt); break;
      case 'emberfall': tickEmberfall(world, job, dt); break;
      case 'sink': tickSink(world, job, dt); break;
      default: break;
    }
  }
  world.jobs = world.jobs.filter((j) => j.t < j.duration);

  for (const a of world.auras) a.t += dt;
  world.auras = world.auras.filter((a) => a.t < a.duration);
}

function tickLandbridge(world: World, job: SpellJob, dt: number): void {
  const dx = wrapDelta(job.x - job.fromX, N);
  const dz = wrapDelta(job.z - job.fromZ, N);
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const frontier = Math.min(1, job.t / (job.duration * 0.7)) * len;
  for (let s = 0; s <= Math.min(frontier, len); s += 0.6) {
    const px = job.fromX + (dx / len) * s;
    const pz = job.fromZ + (dz / len) * s;
    const halfW = Math.max(1, Math.round(spellDef('landbridge').radius / 2));
    // One shoulder tile each side slopes into the sea: without it the edge
    // tiles sit on a cliff (unwalkable), leaving a one-tile path that a
    // diagonal causeway breaks into corner-cuts nobody may take.
    for (let w = -halfW - 1; w <= halfW + 1; w++) {
      const tx = world.map.wrap(Math.round(px - (dz / len) * w));
      const tz = world.map.wrap(Math.round(pz + (dx / len) * w));
      const i = tz * N + tx;
      const shoulder = Math.abs(w) > halfW;
      const target = shoulder ? -0.6 : 1.5 + hash2(tx, tz, 31) * 0.6;
      if (world.map.heights[i] < target) {
        world.map.heights[i] = Math.min(target, world.map.heights[i] + dt * 9);
      }
    }
  }
  world.map.version++;
}

function tickEarthquake(world: World, job: SpellJob, dt: number): void {
  const cos = Math.cos(job.angle);
  const sin = Math.sin(job.angle);
  const k = 7 * (4 / job.duration);
  const len = Math.round(spellDef('earthquake').radius * 1.45);
  for (let s = -len; s <= len; s++) {
    for (let w = -2; w <= 2; w++) {
      const tx = world.map.wrap(Math.round(job.x + cos * s - sin * w));
      const tz = world.map.wrap(Math.round(job.z + sin * s + cos * w));
      const i = tz * N + tx;
      const bias = hash2(tx, tz, job.seed) - 0.62;
      world.map.heights[i] = clamp(world.map.heights[i] + bias * k * dt, MIN_HEIGHT, MAX_HEIGHT);
    }
  }
  world.map.version++;

  for (const b of [...world.buildings]) {
    const bx = wrapDelta(b.x - job.x, N);
    const bz = wrapDelta(b.z - job.z, N);
    const along = Math.abs(bx * cos + bz * sin);
    const across = Math.abs(-bx * sin + bz * cos);
    if (along < len + 1 && across < 3 + b.size / 2) world.hurtBuildingFrac(b, dt * 0.5);
  }
  if (Math.floor(job.t / 0.4) !== Math.floor((job.t - dt) / 0.4)) {
    world.events.push({ type: 'shake', x: job.x, z: job.z, magnitude: 0.5 });
  }
}

function tickVolcano(world: World, job: SpellJob, dt: number): void {
  const R = spellDef('volcano').radius - 0.5;
  const ease = smoothstep(0, 1, job.t / (job.duration * 0.75));
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > R) continue;
      let profile = 15 * Math.pow(1 - d / R, 1.35);
      if (d < 2) profile -= (2 - d) * 2.5;
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

  // Per-tick area effects ask the spatial hash who is near (sim/spatial.ts).
  world.forEachUnitNear(job.x, job.z, 7, (u) => {
    if (dist(u.x, u.z, job.x, job.z) < 7) world.hurtUnit(u, dt * 6, { spell: true });
  });
  for (const b of [...world.buildings]) {
    if (dist(b.x, b.z, job.x, job.z) < 8) {
      world.hurtBuildingFrac(b, dt * 0.3);
      if (world.random() < dt * 0.5) world.ignite(b);
    }
  }
  world.igniteTreesNear(job.x, job.z, 6, dt * 2);
  if (Math.floor(job.t / 0.6) !== Math.floor((job.t - dt) / 0.6)) {
    world.events.push({ type: 'plume', x: job.x, z: job.z });
    world.events.push({ type: 'shake', x: job.x, z: job.z, magnitude: 0.35 });
  }
}

/** Heal the caster's people in the circle over the duration. */
function tickBloom(world: World, job: SpellJob, dt: number): void {
  const R = spellDef('bloom').radius;
  world.forEachUnitNear(job.x, job.z, R, (u) => {
    if (!world.friendly(job.tribe, u.tribe) || dist(u.x, u.z, job.x, job.z) > R) return;
    u.hp = Math.min(u.maxHp, u.hp + u.maxHp * BUFFS.bloomHealPerSecond * dt);
  });
}

/** A wandering funnel: drifts, flings whoever it touches, peels roofs. */
function tickCyclone(world: World, job: SpellJob, dt: number): void {
  const R = spellDef('cyclone').radius;
  job.angle += (world.random() - 0.5) * 2.4 * dt;
  const speed = 1.6;
  job.x = world.map.wrap(job.x + Math.cos(job.angle) * speed * dt);
  job.z = world.map.wrap(job.z + Math.sin(job.angle) * speed * dt);
  if (job.aura) {
    job.aura.x = job.x;
    job.aura.z = job.z;
  }
  job.timer -= dt;
  if (job.timer > 0) return;
  job.timer = 0.5;
  let touched = 0;
  // Collect first, then fling: displacing people while walking the hash's buckets is fine
  // (the buckets don't move), but sorting by id keeps the random draws in a stable order.
  const caught: Unit[] = [];
  world.forEachUnitNear(job.x, job.z, R, (u) => {
    if (Math.hypot(wrapDelta(u.x - job.x, N), wrapDelta(u.z - job.z, N)) <= R) caught.push(u);
  });
  caught.sort((a, b) => a.id - b.id);
  for (const u of caught) {
    const dx = wrapDelta(u.x - job.x, N);
    const dz = wrapDelta(u.z - job.z, N);
    touched++;
    world.hurtUnit(u, 3, { spell: true });
    // Lifted and dropped somewhere else: spun round the funnel and out.
    const a = Math.atan2(dz, dx) + 1.2 + world.random() * 0.8;
    const fling = 1.5 + world.random() * 1.5;
    world.displaceUnit(u, Math.cos(a) * fling, Math.sin(a) * fling);
    u.lifted = 0.6;
  }
  for (const b of [...world.buildings]) {
    if (dist(b.x, b.z, job.x, job.z) > R + b.size / 2) continue;
    touched++;
    world.hurtBuildingFrac(b, 0.04);
  }
  if (touched > 0) world.events.push({ type: 'cycloneTouch', x: job.x, z: job.z, magnitude: touched });
}

/** Burning stones rain on the circle, a couple per second. */
function tickEmberfall(world: World, job: SpellJob, dt: number): void {
  const R = spellDef('emberfall').radius;
  job.timer -= dt;
  if (job.timer > 0) return;
  job.timer = 0.45;
  // Stones are drawn to what burns: some fall on a target in the circle.
  let sx: number;
  let sz: number;
  const targets = [
    ...world.buildings.filter((b) => dist(b.x, b.z, job.x, job.z) < R),
    ...world.units.filter((u) => !u.hidden && dist(u.x, u.z, job.x, job.z) < R),
  ];
  if (targets.length > 0 && world.random() < 0.4) {
    const t = world.rng.pick(targets);
    sx = t.x + world.random() * 2 - 1;
    sz = t.z + world.random() * 2 - 1;
  } else {
    const a = world.random() * Math.PI * 2;
    const r = Math.sqrt(world.random()) * R;
    sx = job.x + Math.cos(a) * r;
    sz = job.z + Math.sin(a) * r;
  }
  sx = world.map.wrap(sx);
  sz = world.map.wrap(sz);
  crater(world, sx, sz, 1.2, 0.25);
  world.events.push({ type: 'emberStrike', x: sx, z: sz, x2: job.x, z2: job.z });
  world.forEachUnitNear(sx, sz, 1.6, (u) => {
    if (dist(u.x, u.z, sx, sz) < 1.6) world.hurtUnit(u, 9, { spell: true });
  });
  for (const b of [...world.buildings]) {
    if (dist(b.x, b.z, sx, sz) > b.size / 2 + 1) continue;
    world.hurtBuildingFrac(b, 0.06);
    if (world.random() < 0.6) world.ignite(b);
  }
  world.igniteTreesNear(sx, sz, 1.6);
}

/** The circle slides under the sea, steadily, for good. */
function tickSink(world: World, job: SpellJob, dt: number): void {
  const R = spellDef('sink').radius;
  const DEPTH = -2.5;
  const finish = job.duration / 1.2;
  const k = Math.min(1, job.t / finish);
  for (const [i, h0] of job.base!) {
    const x = i % N;
    const z = (i / N) | 0;
    const d = dist(x, z, job.x, job.z);
    // Full depth across the inner 70%, a beach-like slope at the rim.
    const f = 1 - smoothstep(R * 0.7, R, d);
    const target = h0 + (Math.min(h0, DEPTH) - h0) * f;
    const want = h0 + (target - h0) * k;
    if (world.map.heights[i] > want) world.map.heights[i] = want;
  }
  world.map.version++;
  if (Math.floor(job.t / 0.8) !== Math.floor((job.t - dt) / 0.8)) {
    world.events.push({ type: 'sinkRumble', x: job.x, z: job.z, magnitude: 0.3 });
  }
}
