/**
 * render/fleet.ts — raiders' boats: on the horizon, beaching, left as wrecks.
 *
 * Driven entirely by data the sim already has:
 *
 *   HORIZON. A scripted spawn with a `march` (a landing) waiting on a
 *   `delay` is a countdown: world.rules.events[i] with eventMemory[i]
 *   armed (armedAt set) but not yet fired. While it runs, a few sails ride
 *   in from far out to sea toward the landing beach, closing as the
 *   countdown runs down — the threat is visible before it lands.
 *
 *   LANDING. The `landing` event (x, z = where they came ashore, magnitude
 *   = how many, tribe = whose) beaches one boat per three or so raiders:
 *   they run in from the sea with spray at the bow and slide up the sand,
 *   then stay there, heeled over, as props for a couple of minutes before
 *   they settle into the shallows and are gone.
 *
 * Which way is the sea? The direction from the landing spot whose nearest
 * open water is closest (open = still sea a few tiles further on).
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { TRIBE_COLORS, Tribe } from '../sim/catalog';
import type { World } from '../sim/world-state';
import { buildBoat } from '../assets/models/boats';
import { curveObject } from '../world/curvature';
import type { EffectsRenderer } from './effects';

const WORLD_UNITS = WORLD_SIZE * TILE;

interface Boat {
  obj: THREE.Group;
  /** Start and end of the run in (tile coords). */
  sx: number; sz: number;
  ex: number; ez: number;
  yaw: number;
  age: number;
  /** Seconds the run in takes; then beached for `stay`. */
  run: number;
  stay: number;
  seed: number;
  /** Horizon boats: placed every frame by the countdown, never beach. */
  horizon: boolean;
  /** 0..1 how far along the horizon approach (horizon boats only). */
  p: number;
  sprayAcc: number;
}

/** Boat stays on the beach this long (seconds) before it settles away. */
const STAY = 150;
const SINK = 5;

export class Fleet {
  private boats: Boat[] = [];
  /** Horizon fleets by scenario event index. */
  private readonly horizon = new Map<number, Boat[]>();
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly fx: EffectsRenderer,
    private readonly scene: THREE.Scene,
  ) {}

  reset(): void {
    for (const b of this.boats) this.scene.remove(b.obj);
    for (const list of this.horizon.values()) for (const b of list) this.scene.remove(b.obj);
    this.boats = [];
    this.horizon.clear();
  }

  landing(x: number, z: number, count: number, tribe: string | undefined): void {
    const world = this.fx.worldNow;
    if (!world) return;
    const sea = seaward(world, x, z);
    if (!sea) return;
    const n = Math.max(1, Math.min(6, Math.ceil(count / 3)));
    const color = TRIBE_COLORS[(tribe ?? 'red') as Tribe] ?? TRIBE_COLORS.red;
    const px = -sea.uz, pz = sea.ux;
    for (let i = 0; i < n; i++) {
      const lat = (i - (n - 1) / 2) * 3.2 + (Math.random() - 0.5);
      // walk out from the beach (offset sideways) to this boat's own waterline
      const bx = x + px * lat, bz = z + pz * lat;
      let r = 0;
      while (r < 20 && world.map.sampleHeight(bx + sea.ux * r, bz + sea.uz * r) > -0.15) r += 0.5;
      const ex = bx + sea.ux * (r - 1.6);
      const ez = bz + sea.uz * (r - 1.6);
      const out = 12 + Math.random() * 3;
      this.add({
        sx: ex + sea.ux * out, sz: ez + sea.uz * out, ex, ez,
        yaw: Math.atan2(-sea.ux, -sea.uz) + (Math.random() - 0.5) * 0.25,
        run: 2.4 + Math.random() * 0.8, stay: STAY + Math.random() * 20, horizon: false, color, seed: i,
      });
    }
  }

  private add(o: { sx: number; sz: number; ex: number; ez: number; yaw: number; run: number; stay: number; horizon: boolean; color: number; seed: number }): Boat {
    const obj = buildBoat(o.color, o.seed);
    curveObject(obj);
    this.scene.add(obj);
    const b: Boat = { obj, sx: o.sx, sz: o.sz, ex: o.ex, ez: o.ez, yaw: o.yaw, age: 0, run: o.run, stay: o.stay, seed: o.seed * 1.7 + Math.random(), horizon: o.horizon, p: 0, sprayAcc: 0 };
    if (!o.horizon) this.boats.push(b);
    return b;
  }

  sync(world: World, dt: number): void {
    this.syncHorizon(world);
    for (const list of this.horizon.values()) for (const b of list) this.place(b, world, dt);
    for (const b of this.boats) {
      b.age += dt;
      this.place(b, world, dt);
    }
    const gone = this.boats.filter((b) => b.age > b.run + b.stay + SINK);
    for (const b of gone) this.scene.remove(b.obj);
    if (gone.length) this.boats = this.boats.filter((b) => !gone.includes(b));
  }

  /** Countdowns to a landing put sails on the horizon. */
  private syncHorizon(world: World): void {
    const events = world.rules?.events ?? [];
    const mem = world.eventMemory ?? [];
    const live = new Set<number>();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const m = mem[i];
      if (!ev.delay || !m || m.armedAt === undefined || m.fired > 0) continue;
      const spawn = ev.actions.find((a) => a.type === 'spawn' && a.march);
      if (!spawn || spawn.type !== 'spawn') continue;
      const p = Math.min(1, Math.max(0, (world.elapsed - m.armedAt) / ev.delay));
      live.add(i);
      let list = this.horizon.get(i);
      if (!list) {
        const sea = seaward(world, spawn.x, spawn.z);
        if (!sea) continue;
        const total = Object.values(spawn.units).reduce((a: number, b) => a + (b ?? 0), 0);
        const n = Math.max(2, Math.min(7, Math.ceil(total / 2.5)));
        const color = TRIBE_COLORS[spawn.tribe] ?? TRIBE_COLORS.red;
        const px = -sea.uz, pz = sea.ux;
        list = [];
        for (let k = 0; k < n; k++) {
          const lat = (k - (n - 1) / 2) * 4.5 + (Math.random() - 0.5) * 2;
          const lag = Math.random() * 6;
          const near = 14 + lag;
          const far = 52 + lag * 2;
          list.push(this.add({
            sx: spawn.x + px * lat + sea.ux * far, sz: spawn.z + pz * lat + sea.uz * far,
            ex: spawn.x + px * lat + sea.ux * near, ez: spawn.z + pz * lat + sea.uz * near,
            yaw: Math.atan2(-sea.ux, -sea.uz) + (Math.random() - 0.5) * 0.3, run: 1, stay: 0, horizon: true, color, seed: k,
          }));
        }
        this.horizon.set(i, list);
      }
      for (const b of list) b.p = p;
    }
    for (const [i, list] of this.horizon) {
      if (live.has(i)) continue;
      for (const b of list) this.scene.remove(b.obj);
      this.horizon.delete(i);
    }
  }

  private place(b: Boat, world: World, dt: number): void {
    let t: number;
    if (b.horizon) t = 1 - Math.pow(1 - b.p, 1.4);
    else t = 1 - Math.pow(1 - Math.min(1, b.age / b.run), 3);
    const dx = wrapDelta(b.ex - b.sx, WORLD_SIZE);
    const dz = wrapDelta(b.ez - b.sz, WORLD_SIZE);
    const tx = b.sx + dx * t;
    const tz = b.sz + dz * t;
    const cam = this.fx.camTargetNow;
    const relX = wrapDelta(tx * TILE - cam.x, WORLD_UNITS);
    const relZ = wrapDelta(tz * TILE - cam.z, WORLD_UNITS);
    const ground = world.map.sampleHeight(tx, tz);
    const clock = performance.now() / 1000 + b.seed * 3;
    const bob = Math.sin(clock * 1.3) * 0.12;
    const afloat = ground < -0.4;
    let y = afloat ? -0.18 + bob : Math.max(ground, -0.6) - 0.15;
    let roll = afloat ? Math.sin(clock * 1.1) * 0.06 : 0.14;
    let pitch = afloat ? Math.sin(clock * 0.9 + 1) * 0.04 : -0.05;
    if (!b.horizon) {
      const sinking = b.age - (b.run + b.stay);
      if (sinking > 0) {
        y -= sinking * 0.5;
        roll += sinking * 0.05;
      }
      // spray at the bow while it runs in; a hiss of foam as it grounds
      if (b.age < b.run + 0.3) {
        b.sprayAcc += dt * 30 * this.fx.detail;
        const fwdX = Math.sin(b.yaw), fwdZ = Math.cos(b.yaw);
        for (; b.sprayAcc >= 1; b.sprayAcc--) {
          const p = this.fx.at(tx + fwdX * 1.7, tz + fwdZ * 1.7, 0.1);
          const side = Math.random() < 0.5 ? -1 : 1;
          this.fx.matter.emit({
            x: p.x, y: p.y, z: p.z,
            vx: fwdZ * side * (2 + Math.random() * 2) + fwdX * 2, vy: 2 + Math.random() * 3, vz: -fwdX * side * (2 + Math.random() * 2) + fwdZ * 2,
            life: 0.7, size: 0.3, sizeEnd: 0.12, r: 0.85, g: 0.95, b: 1, alpha: 0.9, gravity: 16, shape: 3, fadeIn: 0.01,
          });
        }
        if (b.age > b.run - 0.25 && b.age - dt <= b.run - 0.25) {
          this.fx.ring(tx, tz, 0xeaf8ff, 7, 1, 1.4, 0.12);
          this.fx.dust(tx, tz, 6, 2, 0xd8c9a0, 2);
        }
      }
    } else {
      // far sails fade in out of the haze
      b.obj.visible = b.p > 0.02;
    }
    b.obj.position.set(cam.x + relX, y, cam.z + relZ);
    b.obj.rotation.set(pitch, b.yaw, roll, 'YXZ');
    void this.tmp;
  }
}

/** The direction from (x, z) toward the nearest OPEN water, and how far the shore is (tiles). */
export function seaward(world: World, x: number, z: number): { ux: number; uz: number; shore: number } | null {
  let best: { ux: number; uz: number; shore: number } | null = null;
  const map = world.map;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const ux = Math.cos(a), uz = Math.sin(a);
    for (let r = 0; r <= 30; r += 0.5) {
      if (map.sampleHeight(x + ux * r, z + uz * r) >= -0.6) continue;
      // open water: still sea a good way further out
      if (map.sampleHeight(x + ux * (r + 5), z + uz * (r + 5)) < -0.6 && map.sampleHeight(x + ux * (r + 10), z + uz * (r + 10)) < -0.6) {
        if (!best || r < best.shore) best = { ux, uz, shore: r };
      }
      break;
    }
  }
  return best;
}
