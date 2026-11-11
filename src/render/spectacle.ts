/**
 * render/spectacle.ts — the big casts, played out over seconds.
 *
 * effects.ts draws the instant of an event. The terrain spells are not
 * instants: the sim runs them as SpellJobs (world.jobs: spell, x, z, t,
 * duration, angle, fromX/fromZ) for several seconds while the heightmap
 * moves. This module reads those jobs every frame and stages each one:
 *
 *   VOLCANO   the ground swells and tears open in glowing fissures; a cone
 *             rises with a lava-lit crater; fire fountains and lava bombs
 *             (ballistic, trailing smoke, bursting where they land); a
 *             towering ash column with lightning flickering inside it;
 *             pyroclastic dust rolling down the flanks; lava rivulets that
 *             find their way downhill (traced on the live heightmap), boil
 *             the sea where they reach it, and cool to black basalt. When
 *             the job ends a VENT stays behind and smokes for minutes.
 *   CAUSEWAY  the sea heaves at the rising front; water pours off the new
 *             land in sheets; the earth comes up wet and dark and dries;
 *             rings run out across the sea when it's done.
 *   LEVEL     dust curtains rise round the rim while clods tumble; site
 *             levelling (buildings with levelT < 1) puffs builders' dust.
 *   QUAKE     a fissure tears outward from the mark along the fault, glowing
 *             at its core; chunks drop into it; a wall of dust stands up.
 *   UNDERTOW  a whirlpool opens on the drowning ground (only where it is
 *             already sea), foam rings surge inward, the rim slumps.
 *
 * What the land keeps afterwards is painted into the ground itself
 * (world/surface-fx.ts: heat → basalt, wet, fissures), so the aftermath is
 * readable at a glance. Particle counts scale with the quality tier
 * (fx.n / fx.detail) and every sustained emitter is rate-based (per
 * second, not per frame), so frame rate never changes how much is drawn.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { spellDef } from '../sim/catalog';
import type { SpellJob } from '../sim/spells';
import type { World } from '../sim/world-state';
import { FxChannel } from '../world/surface-fx';
import { clearWear, setWear } from '../world/wear';
import type { TerrainMesh } from '../world/terrain-mesh';
import { CastGather } from './cast-gather';
import { CHUNK, EffectsRenderer, fxMaterial, GLOW, MeshFx, PETAL, SMOKE } from './effects';
import { Fleet } from './fleet';

const N = WORLD_SIZE;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A lava rivulet: a downhill path (tile coords) and how far the molten front has run. */
interface Rivulet {
  pts: number[];
  /** Points reached so far (fractional). */
  front: number;
  /** Points per second. */
  speed: number;
  /** Index where it met the sea (-1 = never). */
  seaAt: number;
}

interface JobState {
  spell: string;
  /** Seconds since we first saw the job (render clock). */
  age: number;
  seen: boolean;
  /** Rate accumulators (particles owed). */
  acc: Float32Array;
  rivulets: Rivulet[];
  waves: number;
  meshes: MeshFx[];
  /** Quake: fault already torn to this half-length (tiles). */
  torn: number;
  job: SpellJob;
}

/** A spent volcano: smokes, glows and steams for a while. */
interface Vent {
  x: number;
  z: number;
  age: number;
  life: number;
  rivulets: Rivulet[];
  acc: Float32Array;
}

/** Owed particles at `rate` per second; returns how many to emit now. */
function owed(acc: Float32Array, i: number, rate: number, dt: number): number {
  acc[i] += rate * dt;
  const n = Math.floor(acc[i]);
  acc[i] -= n;
  return n;
}

export class Spectacle {
  private readonly states = new Map<SpellJob, JobState>();
  private vents: Vent[] = [];
  private readonly gather: CastGather;
  private readonly fleet: Fleet;
  private siteAcc = 0;
  /** Freshly levelled ground shows as bare cut earth for a while (world/wear.ts patches). */
  private cuts: { key: string; ttl: number }[] = [];
  private cutSeq = 0;

  constructor(
    private readonly fx: EffectsRenderer,
    scene: THREE.Scene,
    private readonly terrain?: TerrainMesh,
  ) {
    this.gather = new CastGather(fx);
    this.fleet = new Fleet(fx, scene);
  }

  /** Forget everything (a new world was loaded). */
  reset(): void {
    for (const s of this.states.values()) for (const m of s.meshes) m.ttl = m.age;
    this.states.clear();
    this.vents = [];
    this.fleet.reset();
    for (const c of this.cuts) clearWear(c.key);
    this.cuts = [];
  }

  /** A landing came ashore: boats beach at (x, z). Called from the effects registry. */
  landing(x: number, z: number, count: number, tribe: string | undefined): void {
    this.fleet.landing(x, z, count, tribe);
  }

  sync(world: World, dt: number): void {
    for (const s of this.states.values()) s.seen = false;
    for (const job of world.jobs) {
      let s = this.states.get(job);
      if (!s) {
        s = { spell: job.spell, age: 0, seen: true, acc: new Float32Array(12), rivulets: [], waves: 0, meshes: [], torn: 0, job };
        this.states.set(job, s);
        this.begin(s, world);
      }
      s.seen = true;
      s.age += dt;
      switch (job.spell) {
        case 'volcano': this.volcano(s, world, dt); break;
        case 'landbridge': this.causeway(s, world, dt); break;
        case 'flatten': this.level(s, world, dt); break;
        case 'earthquake': this.quake(s, world, dt); break;
        case 'sink': this.undertow(s, world, dt); break;
        default: break;
      }
    }
    for (const [job, s] of this.states) {
      if (s.seen) continue;
      this.end(s, world);
      this.states.delete(job);
    }
    for (const v of this.vents) this.vent(v, world, dt);
    this.vents = this.vents.filter((v) => v.age < v.life);
    this.siteDust(world, dt);
    if (this.cuts.length) {
      for (const c of this.cuts) if ((c.ttl -= dt) <= 0) clearWear(c.key);
      this.cuts = this.cuts.filter((c) => c.ttl > 0);
    }
    this.gather.sync(world, dt);
    this.fleet.sync(world, dt);
  }

  // -------------------------------------------------------------------------

  private begin(s: JobState, world: World): void {
    const j = s.job;
    if (s.spell === 'sink') s.meshes.push(this.whirlpool(j.x, j.z, spellDef('sink').radius * TILE));
    if (s.spell === 'flatten') {
      this.fx.ring(j.x, j.z, 0xd8c09a, spellDef('flatten').radius * TILE * 1.25, 0.9, 1.6, 0.12);
      this.fx.shake(0.35);
    }
    if (s.spell === 'landbridge') this.fx.shake(0.3);
    void world;
  }

  private end(s: JobState, world: World): void {
    const j = s.job;
    for (const m of s.meshes) m.ttl = m.age + 2;
    if (s.spell === 'volcano') {
      this.vents.push({ x: j.x, z: j.z, age: 0, life: 210, rivulets: s.rivulets, acc: new Float32Array(6) });
    } else if (s.spell === 'landbridge') {
      // rings run out across the sea from the new road
      const dx = wrapDelta(j.x - j.fromX, N);
      const dz = wrapDelta(j.z - j.fromZ, N);
      for (const k of [0.25, 0.6, 0.95]) {
        const px = j.fromX + dx * k;
        const pz = j.fromZ + dz * k;
        this.fx.ring(px, pz, 0xe4f6ff, 26 + k * 10, 2.6, 1.1, 0.05);
        this.fx.ring(px, pz, 0xe4f6ff, 14, 1.6, 1.3, 0.08);
      }
    } else if (s.spell === 'flatten') {
      const R = spellDef('flatten').radius;
      this.fx.dust(j.x, j.z, this.fx.n(30, 8), R * TILE, 0xb59e7c, 2.2);
      // the shaved ground stays bare, raw earth until the turf creeps back
      const key = `lv:${this.cutSeq++}`;
      setWear(key, { x: j.x, z: j.z, r: R * 0.85, round: true, k: 0.75 });
      this.cuts.push({ key, ttl: 75 });
    } else if (s.spell === 'earthquake') {
      // a dark scar where the fault tore
      const len = Math.round(spellDef('earthquake').radius * 1.45);
      const c = Math.cos(j.angle), sn = Math.sin(j.angle);
      for (let t = -len; t <= len; t += 2) this.fx.scorch(j.x + c * t, j.z + sn * t, 0.9, 0.35);
    }
    void world;
  }

  // -------------------------------------------------------------------------
  // VOLCANO
  // -------------------------------------------------------------------------

  private volcano(s: JobState, world: World, dt: number): void {
    const fx = this.fx;
    const j = s.job;
    const surf = fx.surface;
    const T = j.t;
    const D = j.duration;
    const R = spellDef('volcano').radius;
    const acc = s.acc;
    const grow = Math.min(1, T / (D * 0.75));
    const crater = fx.at(j.x, j.z, 0);
    const cx = crater.x, cy = crater.y, cz = crater.z;

    // 1. SWELLING: the ground tears in a glowing network, hottest at the heart.
    if (surf && T < D * 0.8) {
      for (let n = owed(acc, 0, 40, dt); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * R * 0.9;
        const k = 1 - r / R;
        surf.paint(FxChannel.Crack, j.x + Math.cos(a) * r, j.z + Math.sin(a) * r, 1.6, 0.08 + 0.12 * k, 0.4 + 0.5 * k);
        if (Math.random() < 0.3) fx.dust(j.x + Math.cos(a) * r, j.z + Math.sin(a) * r, 1, 0.5, 0x8a7a64, 1.2);
      }
    }
    // the cone is cinder and ash, not turf (and never takes the snow)
    if (surf) {
      for (let n = owed(acc, 9, 30, dt); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (R + 1);
        surf.paint(FxChannel.Basalt, j.x + Math.cos(a) * r, j.z + Math.sin(a) * r, 2.2, 0.08, 0.42 + 0.1 * (1 - r / (R + 1)));
      }
    }
    // the crater fills with lava as the cone stands up
    if (surf && T > 1.2) {
      for (let n = owed(acc, 1, 6, dt); n > 0; n--) surf.paint(FxChannel.Heat, j.x + rand(-0.6, 0.6), j.z + rand(-0.6, 0.6), 2.2, 0.35);
    }
    if (T < 2 && Math.random() < dt * 4) fx.shake(0.5 + T * 0.2);

    // 2. CRATER GLOW: big soft light pulses over the vent (lights the ash from below).
    for (let n = owed(acc, 2, 12, dt); n > 0; n--) {
      fx.glow.emit({
        x: cx + rand(-1, 1), y: cy + 1.5 + Math.random() * 2, z: cz + rand(-1, 1),
        vy: 2, life: 0.35, size: 2.2 + 1.5 * grow, sizeEnd: 3 + 2 * grow,
        r: 1.4, g: 0.45, b: 0.08, alpha: 0.4, shape: GLOW, fadeIn: 0.3,
      });
    }

    // 3. FIRE FOUNTAINS
    if (T > 1.5) {
      const rate = fx.detail * (T < D * 0.85 ? 42 : 18);
      for (let n = owed(acc, 3, rate, dt); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const h = rand(0, 4) * (0.5 + grow);
        fx.glow.emit({
          x: cx + rand(-0.8, 0.8), y: cy + 0.5, z: cz + rand(-0.8, 0.8),
          vx: Math.cos(a) * h, vy: rand(12, 24) * (0.6 + 0.5 * grow), vz: Math.sin(a) * h,
          life: rand(0.9, 1.6), size: rand(0.5, 0.95), sizeEnd: 0.15,
          r: 4.2, g: 1.4, b: 0.25, r2: 1.6, g2: 0.15, b2: 0.02, gravity: 20, drag: 0.3, shape: GLOW, fadeIn: 0.01,
        });
      }
    }

    // 4. LAVA BOMBS
    if (T > 2 && T < D + 0.5) {
      for (let n = owed(acc, 4, 3.2 * (0.4 + 0.6 * fx.detail), dt); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const sp = rand(1.5, 5); // tiles/s outward
        fx.bomb(j.x, j.z, cy + 1, Math.cos(a) * sp, Math.sin(a) * sp, rand(13, 22), rand(0.7, 1.3));
      }
    }

    // 5. ASH COLUMN, lit from below near the vent, dark and towering above.
    {
      const rate = fx.detail * (10 + 30 * grow);
      for (let n = owed(acc, 5, rate, dt); n > 0; n--) {
        const v = rand(0.05, 0.09);
        const lit = Math.random() < 0.3;
        fx.matter.emit({
          x: cx + rand(-1.2, 1.2), y: cy + 1.5, z: cz + rand(-1.2, 1.2),
          vx: rand(-1.5, 1.5) + 1.2, vy: rand(14, 21), vz: rand(-1.5, 1.5),
          life: rand(7, 9.5), size: rand(3.5, 5), sizeEnd: rand(22, 32),
          r: lit ? 0.9 : 0.25, g: lit ? 0.35 : 0.12, b: lit ? 0.1 : 0.06, r2: v, g2: v * 0.95, b2: v * 0.92,
          alpha: 1, drag: 0.3, shape: SMOKE, fadeIn: 0.03,
        });
      }
    }

    // 6. LIGHTNING IN THE ASH
    if (T > 3.5) {
      for (let n = owed(acc, 6, 1.1, dt); n > 0; n--) {
        const ox = rand(-3, 3), oz = rand(-3, 3);
        const lift = rand(20, 34);
        fx.bolt(j.x + ox, j.z + oz, 0xe2d4ff, 0.28, { top: rand(6, 12), lift, width: 0.16, branches: 2, hdr: 6 });
        const p = fx.at(j.x + ox, j.z + oz, lift + 4);
        fx.glow.emit({ x: p.x, y: p.y, z: p.z, life: 0.2, size: 5, sizeEnd: 6, r: 0.7, g: 0.65, b: 1, alpha: 0.5, shape: GLOW, fadeIn: 0.01 });
      }
    }

    // 7. PYROCLASTIC DUST rolling down the flanks
    if (T > D * 0.35) {
      const rate = fx.detail * 45;
      for (let n = owed(acc, 7, rate, dt); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        const r = rand(2, R * 0.95);
        const tx = j.x + Math.cos(a) * r;
        const tz = j.z + Math.sin(a) * r;
        const p = fx.at(tx, tz, 0.6);
        const sp = rand(3, 7);
        const v = rand(0.28, 0.4);
        fx.matter.emit({
          x: p.x, y: p.y, z: p.z,
          vx: Math.cos(a) * sp, vy: rand(-1.5, 0.6), vz: Math.sin(a) * sp,
          life: rand(1.8, 3), size: rand(1.8, 2.8), sizeEnd: rand(5, 8),
          r: v, g: v * 0.92, b: v * 0.85, alpha: 0.65, gravity: 1.5, drag: 0.7, shape: SMOKE, fadeIn: 0.1,
        });
      }
    }

    // 8. LAVA RIVULETS, traced downhill on the live heightmap.
    if (T > 3 && s.waves === 0) this.spawnRivulets(s, world, 3);
    if (T > 6.5 && s.waves === 1) this.spawnRivulets(s, world, 3);
    if (T > 10 && s.waves === 2) this.spawnRivulets(s, world, 2);
    this.flowRivulets(s.rivulets, acc, 8, dt, 1);

    if (Math.random() < dt * 1.5) fx.shake(0.4);
  }

  private spawnRivulets(s: JobState, world: World, n: number): void {
    s.waves++;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const riv = traceDownhill(world, s.job.x + Math.cos(a) * 1.9, s.job.z + Math.sin(a) * 1.9, Math.cos(a), Math.sin(a));
      if (riv.pts.length >= 6) s.rivulets.push(riv);
    }
  }

  /** Advance molten fronts and keep the flows hot (`heat` 0..1 scales the refresh). */
  private flowRivulets(rivs: Rivulet[], acc: Float32Array, slot: number, dt: number, heat: number): void {
    const fx = this.fx;
    const surf = fx.surface;
    if (!surf) return;
    const refresh = owed(acc, slot, 2.5, dt) > 0;
    for (const r of rivs) {
      const before = Math.floor(r.front);
      if (heat > 0.5) r.front = Math.min(r.pts.length / 2 - 1, r.front + r.speed * dt);
      const after = Math.floor(r.front);
      for (let i = before; i <= after; i++) {
        const x = r.pts[i * 2], z = r.pts[i * 2 + 1];
        surf.paint(FxChannel.Heat, x, z, 0.5, 0.9);
        fx.scorch(x, z, 0.5, 0.3);
      }
      // the leading edge spits and smokes
      const hx = r.pts[after * 2], hz = r.pts[after * 2 + 1];
      const sea = r.seaAt >= 0 && after >= r.seaAt;
      if (heat > 0.05) {
        if (sea) {
          if (Math.random() < dt * 14 * heat * fx.detail + dt * 2) fx.steam(hx, hz, 1, 1.4, 4);
          if (Math.random() < dt * 4 * heat) fx.spray(hx, hz, 3, 3);
          if (Math.random() < dt * 0.8 * heat) fx.ring(hx, hz, 0xeaf6ff, 5, 1.1, 1.2, 0.1);
        } else if (Math.random() < dt * 10 * heat) {
          const p = fx.at(hx, hz, 0.4);
          fx.glow.emit({ x: p.x, y: p.y, z: p.z, vy: rand(1, 3), vx: rand(-1, 1), vz: rand(-1, 1), life: 0.6, size: 0.5, sizeEnd: 0.1, r: 6, g: 2, b: 0.3, gravity: 6, shape: GLOW, fadeIn: 0.01 });
          if (Math.random() < 0.4) fx.smoke(hx, hz, 1, { lift: 0.6, dark: 0.12, rise: 2, size: 1, life: 2 });
        }
      }
      if (refresh && heat > 0) {
        for (let i = 0; i <= after; i += 2) surf.paint(FxChannel.Heat, r.pts[i * 2], r.pts[i * 2 + 1], 0.5, 0.25 * heat, 0.8);
      }
    }
  }

  /** A spent volcano: the crater glows and cools, the vent smokes, the shore steams. */
  private vent(v: Vent, world: World, dt: number): void {
    const fx = this.fx;
    v.age += dt;
    const k = 1 - v.age / v.life;
    const hot = Math.max(0, 1 - v.age / 30);
    const p = fx.at(v.x, v.z, 0);
    const cx = p.x, cy = p.y, cz = p.z;
    for (let n = owed(v.acc, 0, fx.detail * (1 + 9 * k * k), dt); n > 0; n--) {
      const g = rand(0.08, 0.16) + 0.25 * (1 - k);
      fx.matter.emit({
        x: cx + rand(-1, 1), y: cy + 1, z: cz + rand(-1, 1),
        vx: rand(-0.5, 0.5) + 1.2, vy: rand(3, 6), vz: rand(-0.5, 0.5),
        life: rand(5, 8), size: rand(2, 3), sizeEnd: rand(8, 13),
        r: g, g: g * 0.96, b: g * 0.93, alpha: 0.7 * (0.4 + 0.6 * k), drag: 0.4, shape: SMOKE, fadeIn: 0.1,
      });
    }
    if (hot > 0) {
      for (let n = owed(v.acc, 1, 8 * hot, dt); n > 0; n--) {
        fx.glow.emit({ x: cx + rand(-1, 1), y: cy + 1, z: cz + rand(-1, 1), vy: 2, life: 0.4, size: 1.5 * hot + 1.2, sizeEnd: 2.5, r: 1.2, g: 0.4, b: 0.08, alpha: 0.4, shape: GLOW, fadeIn: 0.3 });
      }
      for (let n = owed(v.acc, 2, 12 * hot * fx.detail, dt); n > 0; n--) {
        fx.glow.emit({
          x: cx + rand(-0.6, 0.6), y: cy + 0.5, z: cz + rand(-0.6, 0.6),
          vx: rand(-2, 2), vy: rand(8, 15), vz: rand(-2, 2), life: rand(0.8, 1.3), size: 0.7, sizeEnd: 0.15,
          r: 7, g: 3, b: 0.7, r2: 2, g2: 0.25, b2: 0.03, gravity: 20, shape: GLOW, fadeIn: 0.01,
        });
      }
      if (owed(v.acc, 3, 2.5, dt) > 0) fx.surface?.paint(FxChannel.Heat, v.x, v.z, 2, 0.3 * hot, 1);
      if (v.age < 5) for (let n = owed(v.acc, 4, 1.2, dt); n > 0; n--) {
        const a = Math.random() * Math.PI * 2;
        fx.bomb(v.x, v.z, cy + 1, Math.cos(a) * rand(1, 3), Math.sin(a) * rand(1, 3), rand(10, 16), 0.8);
      }
    }
    this.flowRivulets(v.rivulets, v.acc, 5, dt, Math.max(0, 1 - v.age / 12));
    void world;
  }

  // -------------------------------------------------------------------------
  // CAUSEWAY
  // -------------------------------------------------------------------------

  private causeway(s: JobState, world: World, dt: number): void {
    const fx = this.fx;
    const j = s.job;
    const dx = wrapDelta(j.x - j.fromX, N);
    const dz = wrapDelta(j.z - j.fromZ, N);
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const ux = dx / len, uz = dz / len;
    const px = -uz, pz = ux; // across the road
    const frontier = Math.min(1, j.t / (j.duration * 0.7)) * len;
    const halfW = Math.max(1, Math.round(spellDef('landbridge').radius / 2)) + 0.6;
    const acc = s.acc;
    const fxs = fx.surface;
    const rising = frontier < len - 0.01;
    const fX = j.fromX + ux * frontier;
    const fZ = j.fromZ + uz * frontier;
    if (rising) {
      // the sea heaves at the rising front
      for (let n = owed(acc, 0, fx.detail * 55, dt); n > 0; n--) {
        const w = rand(-halfW - 1, halfW + 1);
        const p = fx.at(fX + px * w, fZ + pz * w, 0.2);
        const up = rand(5, 10);
        fx.matter.emit({
          x: p.x, y: p.y, z: p.z, vx: px * w * 0.6 + ux * rand(1, 3), vy: up, vz: pz * w * 0.6 + uz * rand(1, 3),
          life: rand(0.7, 1.1), size: rand(0.25, 0.4), sizeEnd: 0.15, r: 0.85, g: 0.95, b: 1, alpha: 0.9, gravity: 18, shape: PETAL, fadeIn: 0.01,
        });
      }
      for (let n = owed(acc, 1, fx.detail * 18, dt); n > 0; n--) {
        const w = rand(-halfW - 1.5, halfW + 1.5);
        const p = fx.at(fX + px * w + ux * rand(-1, 1), fZ + pz * w + uz * rand(-1, 1), 0.3);
        fx.matter.emit({
          x: p.x, y: p.y, z: p.z, vx: px * Math.sign(w) * rand(1, 3), vy: rand(0.8, 2), vz: pz * Math.sign(w) * rand(1, 3),
          life: rand(1, 1.6), size: rand(1.2, 1.8), sizeEnd: rand(3, 4.5), r: 0.92, g: 0.96, b: 1, alpha: 0.6, drag: 1.2, shape: SMOKE, fadeIn: 0.05,
        });
      }
      if (owed(acc, 2, 3.5, dt) > 0) fx.ring(fX, fZ, 0xeaf8ff, 9, 0.9, 1.3, 0.12);
      if (Math.random() < dt * 6) fx.debris(fX, fZ, 3, 6, 0x4e3a2a, 0.3);
      fxs?.paint(FxChannel.Wet, fX, fZ, halfW + 1.2, 1);
      if (Math.random() < dt * 3) fx.shake(0.25);
    }
    // water pours off the new land in sheets (strongest just behind the front)
    for (let n = owed(acc, 3, fx.detail * 90, dt); n > 0; n--) {
      const back = Math.pow(Math.random(), 1.6) * Math.min(frontier, 9);
      const at = frontier - back;
      const side = Math.random() < 0.5 ? -1 : 1;
      const tx = j.fromX + ux * at + px * side * halfW;
      const tz = j.fromZ + uz * at + pz * side * halfW;
      const p = fx.at(tx, tz, 0.6);
      const out = rand(1.5, 3.5);
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: px * side * out, vy: rand(-0.5, 1.5), vz: pz * side * out,
        life: rand(0.5, 0.9), size: rand(0.3, 0.5), sizeEnd: 0.2, r: 0.8, g: 0.92, b: 1, alpha: 0.85, gravity: 16, shape: PETAL, fadeIn: 0.01,
      });
      if (Math.random() < 0.12) {
        fx.matter.emit({
          x: p.x, y: p.y - 0.4, z: p.z, vx: px * side * 1.5, vy: 0.6, vz: pz * side * 1.5,
          life: 1.2, size: 1, sizeEnd: 2.6, r: 0.95, g: 0.98, b: 1, alpha: 0.45, drag: 1.5, shape: SMOKE, fadeIn: 0.05,
        });
      }
    }
    void world;
  }

  // -------------------------------------------------------------------------
  // LEVEL
  // -------------------------------------------------------------------------

  private level(s: JobState, world: World, dt: number): void {
    const fx = this.fx;
    const j = s.job;
    const R = spellDef('flatten').radius;
    const acc = s.acc;
    const k = 1 - j.t / j.duration;
    // dust curtains stand up round the rim
    for (let n = owed(acc, 0, fx.detail * 110 * (0.4 + 0.6 * k), dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const r = R * rand(0.85, 1.08);
      const p = fx.at(j.x + Math.cos(a) * r, j.z + Math.sin(a) * r, 0.3);
      const v = rand(0.55, 0.75);
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * rand(0.3, 1.2), vy: rand(2, 5), vz: Math.sin(a) * rand(0.3, 1.2),
        life: rand(1.6, 2.6), size: rand(2, 3), sizeEnd: rand(6, 9),
        r: v * 0.95, g: v * 0.75, b: v * 0.5, alpha: 0.72, drag: 1.1, shape: SMOKE, fadeIn: 0.1,
      });
    }
    // clods tumble outward and down as the high ground is shaved away
    for (let n = owed(acc, 1, fx.detail * 45 * k + 5, dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * R;
      const p = fx.at(j.x + Math.cos(a) * r, j.z + Math.sin(a) * r, 0.4);
      const sp = rand(2, 5);
      const c = Math.random() < 0.3 ? [0.22, 0.32, 0.12] : [0.32, 0.22, 0.14];
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * sp, vy: rand(3, 6), vz: Math.sin(a) * sp,
        life: rand(0.8, 1.3), size: rand(0.3, 0.6), r: c[0], g: c[1], b: c[2], gravity: 22, shape: CHUNK, fadeIn: 0.01,
      });
    }
    // shear lines: low dust skidding across the ground toward the rim
    for (let n = owed(acc, 2, fx.detail * 30, dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * R * 0.8;
      const p = fx.at(j.x + Math.cos(a) * r, j.z + Math.sin(a) * r, 0.2);
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * rand(4, 7), vy: 0.3, vz: Math.sin(a) * rand(4, 7),
        life: rand(0.8, 1.3), size: 0.8, sizeEnd: 2.4, r: 0.6, g: 0.5, b: 0.38, alpha: 0.5, drag: 2, shape: SMOKE, fadeIn: 0.05,
      });
    }
    if (owed(acc, 3, 3.3, dt) > 0) fx.shake(0.22);
    void world;
  }

  /** Builders' dust over sites still levelling their footprint. */
  private siteDust(world: World, dt: number): void {
    this.siteAcc += dt;
    if (this.siteAcc < 0.12) return;
    const step = this.siteAcc;
    this.siteAcc = 0;
    const fx = this.fx;
    for (const b of world.buildings) {
      if (b.levelT === undefined || b.levelT >= 1) continue;
      if (Math.random() > step * 6 * fx.detail + 0.1) continue;
      const h = b.size / 2;
      const x = b.x + rand(-h, h), z = b.z + rand(-h, h);
      fx.dust(x, z, 2, 1.2, 0xbfa883, 1.5);
      if (Math.random() < 0.5) fx.debris(x, z, 2, 3.5, 0x5a4532, 0.22);
    }
  }

  // -------------------------------------------------------------------------
  // QUAKE
  // -------------------------------------------------------------------------

  private quake(s: JobState, world: World, dt: number): void {
    const fx = this.fx;
    const j = s.job;
    const surf = fx.surface;
    const len = Math.round(spellDef('earthquake').radius * 1.45);
    const c = Math.cos(j.angle), sn = Math.sin(j.angle);
    const acc = s.acc;
    const seed = (j.seed % 1000) * 0.01;
    const wig = (t: number) => Math.sin(t * 1.3 + seed) * 0.55 + Math.sin(t * 0.47 + seed * 2) * 0.8;
    const P = (t: number, w = 0) => {
      const o = wig(t) + w;
      return { x: j.x + c * t - sn * o, z: j.z + sn * t + c * o };
    };
    // the tear runs outward from the mark both ways
    const L = len * Math.min(1, j.t / 1.4);
    if (surf) {
      for (let t = s.torn; t <= L; t += 0.4) {
        for (const sign of [-1, 1]) {
          const q = P(t * sign);
          surf.paint(FxChannel.Crack, q.x, q.z, 0.9, 1);
          surf.paint(FxChannel.Crack, q.x, q.z, 2.4, 0.3, 0.45);
          if (Math.random() < 0.35) fx.debris(q.x, q.z, this.fx.n(3, 1), 6, 0x5a4a38, 0.35);
        }
      }
      s.torn = Math.max(s.torn, L);
      if (owed(acc, 0, 3, dt) > 0) {
        for (let t = -L; t <= L; t += 1) {
          const q = P(t);
          surf.paint(FxChannel.Crack, q.x, q.z, 0.8, 0.2);
        }
      }
    }
    // a wall of dust stands up along the fault
    for (let n = owed(acc, 1, fx.detail * 80, dt); n > 0; n--) {
      const t = rand(-L, L);
      const q = P(t, rand(-1.2, 1.2));
      const p = fx.at(q.x, q.z, 0.3);
      const v = rand(0.45, 0.62);
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: rand(-1, 1), vy: rand(2.5, 6), vz: rand(-1, 1),
        life: rand(1.6, 2.8), size: rand(1.8, 2.6), sizeEnd: rand(6, 9),
        r: v * 0.9, g: v * 0.78, b: v * 0.62, alpha: 0.55, drag: 0.9, shape: SMOKE, fadeIn: 0.08,
      });
    }
    // chunks of ground break off the lips and drop in
    for (let n = owed(acc, 2, fx.detail * 50, dt); n > 0; n--) {
      const t = rand(-L, L);
      const side = Math.random() < 0.5 ? -1 : 1;
      const q = P(t, side * rand(1, 2));
      const p = fx.at(q.x, q.z, 0.4);
      const inx = sn * side, inz = -c * side; // toward the fault
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: inx * rand(1, 3), vy: rand(1, 4), vz: inz * rand(1, 3),
        life: rand(0.8, 1.3), size: rand(0.35, 0.7), r: 0.3, g: 0.23, b: 0.16, gravity: 24, shape: CHUNK, fadeIn: 0.01,
      });
    }
    // sparks and heat spit from the deepest part of the tear
    for (let n = owed(acc, 3, fx.detail * 35, dt); n > 0; n--) {
      const q = P(rand(-L, L) * 0.7);
      const p = fx.at(q.x, q.z, 0.1);
      fx.glow.emit({
        x: p.x, y: p.y, z: p.z, vx: rand(-1, 1), vy: rand(3, 7), vz: rand(-1, 1),
        life: rand(0.5, 0.9), size: 0.45, sizeEnd: 0.1, r: 6, g: 2.2, b: 0.4, gravity: 10, shape: GLOW, fadeIn: 0.01,
      });
    }
    void world;
  }

  // -------------------------------------------------------------------------
  // UNDERTOW
  // -------------------------------------------------------------------------

  private undertow(s: JobState, world: World, dt: number): void {
    const fx = this.fx;
    const j = s.job;
    const R = spellDef('sink').radius;
    const acc = s.acc;
    const k = Math.min(1, j.t / (j.duration / 1.2));
    for (const m of s.meshes) {
      m.tx = j.x;
      m.tz = j.z;
      m.ttl = Infinity;
      for (const mat of m.mats) mat.uniforms.uK.value = k;
    }
    // foam rings surge inward
    if (owed(acc, 0, 1.1, dt) > 0) fx.ring(j.x, j.z, 0xf0faff, R * TILE * 1.15, 1.5, 1.4, 0.1, true);
    // foam swirling in round the rim
    for (let n = owed(acc, 1, fx.detail * 50, dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const r = R * rand(0.4, 1.05);
      const tx = j.x + Math.cos(a) * r, tz = j.z + Math.sin(a) * r;
      if (world.map.sampleHeight(tx, tz) > 0.15) continue;
      const p = fx.at(tx, tz, 0.15);
      const c = fx.at(j.x, j.z, 0);
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: -Math.cos(a) * 1.5, vy: 0.3, vz: -Math.sin(a) * 1.5,
        life: rand(1.2, 2), size: rand(0.8, 1.4), sizeEnd: rand(2, 3), r: 0.95, g: 0.98, b: 1, alpha: 0.6,
        drag: 0.5, shape: SMOKE, fadeIn: 0.1, swirl: 1.4, ax: c.x, az: c.z,
      });
    }
    // the rim slumps: earth slides in, wet behind it
    for (let n = owed(acc, 2, fx.detail * 30, dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const r = R * rand(0.75, 1);
      const tx = j.x + Math.cos(a) * r, tz = j.z + Math.sin(a) * r;
      if (world.map.sampleHeight(tx, tz) < 0.1) continue;
      const p = fx.at(tx, tz, 0.4);
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: -Math.cos(a) * rand(1, 3), vy: rand(0.5, 2), vz: -Math.sin(a) * rand(1, 3),
        life: rand(0.8, 1.2), size: rand(0.3, 0.55), r: 0.33, g: 0.26, b: 0.18, gravity: 18, shape: CHUNK, fadeIn: 0.01,
      });
      if (Math.random() < 0.4) fx.dust(tx, tz, 1, 0.6, 0x9a8a70, 1.2);
      fx.surface?.paint(FxChannel.Wet, tx, tz, 1.5, 0.5);
    }
    // waves slap the slumping shore
    if (owed(acc, 3, 4, dt) > 0) {
      const a = Math.random() * Math.PI * 2;
      fx.spray(j.x + Math.cos(a) * R * 0.85, j.z + Math.sin(a) * R * 0.85, fx.n(14, 4), 6);
    }
  }

  /** A whirlpool draped on the sinking ground: drawn only where the sea already is. */
  private whirlpool(tx: number, tz: number, radius: number): MeshFx {
    const mat = fxMaterial(
      this.terrain?.uniforms.uHeightTex ?? { value: null },
      /* glsl */ `
        float r = length(vLocal.xz);
        float ang = atan(vLocal.z, vLocal.x);
        float spiral = sin(ang * 3.0 + log(max(r, 0.02)) * 9.0 + uTime * 4.0);
        float foam = smoothstep(0.55, 0.95, spiral) * (0.35 + 0.65 * r);
        float eye = 1.0 - smoothstep(0.0, 0.22, r);
        float edge = 1.0 - smoothstep(0.85, 1.0, r);
        float wet = 1.0 - smoothstep(-0.05, 0.12, vGround);
        vec3 col = mix(vec3(0.03, 0.12, 0.16), vec3(0.92, 0.97, 1.0), foam);
        float a = (foam * 0.85 + eye * 0.75 + 0.18) * edge * wet * uK;
        gl_FragColor = vec4(col, a * uAlpha);
      `,
      { uK: { value: 0 } },
      { drape: true, additive: false },
    );
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 64, 0, Math.PI * 2).rotateX(-Math.PI / 2), mat);
    disc.renderOrder = 7;
    disc.scale.set(radius, 1, radius);
    return this.fx.addFx(disc, [mat], tx, tz, 0, Infinity, (f) => {
      f.obj.position.y = 0;
      mat.uniforms.uAlpha.value = Math.min(1, f.age * 1.5) * Math.min(1, (f.ttl - f.age) * 0.6);
    });
  }
}

/**
 * Trace a lava path downhill from (x, z), heading (dx, dz): steepest
 * descent among headings within ~75° of the current one, a little wander,
 * half a tile per step; stops in the sea (and a few steps beyond, so the
 * front visibly boils into it), in a hollow, or after 24 tiles.
 */
function traceDownhill(world: World, x: number, z: number, dx: number, dz: number): Rivulet {
  const map = world.map;
  const pts: number[] = [x, z];
  let hx = dx, hz = dz;
  let flat = 0;
  let seaAt = -1;
  const step = 0.5;
  for (let i = 0; i < 32; i++) {
    const h0 = map.sampleHeight(x, z);
    let best = Infinity;
    let bx = hx, bz = hz;
    const base = Math.atan2(hz, hx);
    for (let k = -3; k <= 3; k++) {
      const a = base + k * 0.42 + (Math.random() - 0.5) * 0.35;
      const cx = Math.cos(a), cz = Math.sin(a);
      const h = map.sampleHeight(x + cx * step, z + cz * step) + Math.abs(k) * 0.02;
      if (h < best) {
        best = h;
        bx = cx;
        bz = cz;
      }
    }
    if (best >= h0 - 0.01) flat++;
    else flat = 0;
    if (flat > 3) break;
    hx = hx * 0.35 + bx * 0.65;
    hz = hz * 0.35 + bz * 0.65;
    const l = Math.hypot(hx, hz) || 1;
    hx /= l;
    hz /= l;
    x = map.wrap(x + hx * step);
    z = map.wrap(z + hz * step);
    pts.push(x, z);
    if (seaAt < 0 && map.sampleHeight(x, z) < 0.05) seaAt = pts.length / 2 - 1;
    if (seaAt >= 0 && pts.length / 2 - 1 > seaAt + 3) break;
  }
  return { pts, front: 0, speed: rand(4, 7), seaAt };
}
