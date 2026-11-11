/**
 * render/ambient-life.ts — small life that makes the planet feel inhabited.
 *
 *   BIRDS        a few flocks wheeling over the land near the camera: two
 *                instanced wing meshes (left/right), flapping between glides.
 *   FISH         now and then a fish jumps in the shallows near the camera:
 *                a silver arc, a ring and a splash.
 *   BUTTERFLIES  pale flutters over grassy meadows near the camera.
 *
 * Everything is cosmetic, camera-local and cheap: ~30 instance matrices a
 * frame and a handful of particles a second. Off at the `low` tier.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { applyCurvatureTo } from '../world/curvature';
import type { World } from '../sim/world-state';
import { CHUNK, EffectsRenderer, PETAL } from './effects';

interface Bird {
  /** Circle centre (world units; re-seeded near the camera when it falls far behind), radius, angular speed, height. */
  cx: number; cz: number; r: number; w: number; y: number;
  a: number;
  phase: number;
  flap: number;
}

const FLOCKS = 3;
/** A flock farther than this (world units) from the camera target is re-seeded near it. */
const FLOCK_RANGE = 95;
/** Butterfly colours (linear rgb). */
const WINGS = [[1, 0.9, 0.4], [1, 1, 1], [1, 0.53, 0.75], [0.52, 0.75, 1]] as const;
const PER_FLOCK = 5;
const BIRDS = FLOCKS * PER_FLOCK;
const WORLD_UNITS = WORLD_SIZE * TILE;

export class AmbientLife {
  private readonly left: THREE.InstancedMesh;
  private readonly right: THREE.InstancedMesh;
  private readonly birds: Bird[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly p = new THREE.Vector3();
  private fishAcc = 0;
  private flutterAcc = 0;
  private clock = 0;

  constructor(
    private readonly fx: EffectsRenderer,
    scene: THREE.Scene,
  ) {
    // One wing: a swept triangle from the body (x = 0) out to x = 1.
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.35, 0, 0, -0.25, 1.0, 0, -0.45, 0, 0, 0.35, 1.0, 0, -0.45, 0.55, 0, 0.1], 3));
    wing.computeVertexNormals();
    const mirror = wing.clone().scale(-1, 1, 1);
    const mat = applyCurvatureTo(new THREE.MeshLambertMaterial({ color: 0x2a2622, side: THREE.DoubleSide }));
    this.left = new THREE.InstancedMesh(wing, mat, BIRDS);
    this.right = new THREE.InstancedMesh(mirror, mat, BIRDS);
    for (const im of [this.left, this.right]) {
      im.frustumCulled = false;
      im.castShadow = false;
      im.userData.gpuCurved = true;
      scene.add(im);
    }
    for (let f = 0; f < FLOCKS; f++) {
      // placed for real on the first frame (seeded round the camera)
      const cx = Infinity;
      const cz = Infinity;
      const r = 10 + Math.random() * 14;
      const w = (0.25 + Math.random() * 0.2) * (Math.random() < 0.5 ? -1 : 1);
      const y = 16 + Math.random() * 10;
      for (let i = 0; i < PER_FLOCK; i++) {
        this.birds.push({ cx, cz, r: r + (Math.random() - 0.5) * 4, w, y: y + (Math.random() - 0.5) * 3, a: Math.random() * 6.28, phase: Math.random() * 10, flap: 0 });
      }
    }
  }

  sync(world: World, cam: THREE.Vector3, dt: number): void {
    this.clock += dt;
    this.birdsTick(world, cam, dt);
    this.fishTick(world, dt);
    this.flutterTick(world, dt);
  }

  private birdsTick(world: World, cam: THREE.Vector3, dt: number): void {
    // Flocks live at world positions (so they stay put as the view pans);
    // one left far behind is re-seeded somewhere round the camera.
    for (let f = 0; f < FLOCKS; f++) {
      const lead = this.birds[f * PER_FLOCK];
      const dx = wrapDelta(lead.cx - cam.x, WORLD_UNITS);
      const dz = wrapDelta(lead.cz - cam.z, WORLD_UNITS);
      if (dx * dx + dz * dz < FLOCK_RANGE * FLOCK_RANGE) continue;
      const a = Math.random() * Math.PI * 2;
      const r = 25 + Math.random() * 45;
      for (let k = 0; k < PER_FLOCK; k++) {
        const b = this.birds[f * PER_FLOCK + k];
        b.cx = cam.x + Math.cos(a) * r;
        b.cz = cam.z + Math.sin(a) * r;
      }
    }
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      b.a += b.w * dt;
      // flocks drift so they don't hang over one spot forever
      b.cx += Math.sin(this.clock * 0.05 + ((i / PER_FLOCK) | 0)) * dt * 0.6;
      b.cz += Math.cos(this.clock * 0.04 + ((i / PER_FLOCK) | 0) * 0.7) * dt * 0.6;
      // draw the image of the flock nearest the camera (the planet wraps)
      const x = cam.x + wrapDelta(b.cx - cam.x, WORLD_UNITS) + Math.cos(b.a) * b.r;
      const z = cam.z + wrapDelta(b.cz - cam.z, WORLD_UNITS) + Math.sin(b.a) * b.r;
      const ground = Math.max(0, world.map.sampleHeight(x / TILE, z / TILE));
      const y = ground + b.y + Math.sin(this.clock * 0.7 + b.phase) * 1.2;
      // flap in bursts, glide between
      const burst = Math.sin(this.clock * 0.6 + b.phase) > 0.1 ? 1 : 0.12;
      b.flap = Math.sin(this.clock * 11 + b.phase * 3) * 0.75 * burst;
      const yaw = Math.atan2(-Math.sin(b.a) * Math.sign(b.w), Math.cos(b.a) * Math.sign(b.w));
      const bank = -0.35 * Math.sign(b.w);
      this.p.set(x, y, z);
      this.s.setScalar(0.8);
      this.wing(this.left, i, yaw, bank + b.flap);
      this.wing(this.right, i, yaw, bank - b.flap);
    }
    this.left.instanceMatrix.needsUpdate = true;
    this.right.instanceMatrix.needsUpdate = true;
  }

  private wing(im: THREE.InstancedMesh, i: number, yaw: number, roll: number): void {
    this.e.set(0, yaw, roll, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.p, this.q, this.s);
    im.setMatrixAt(i, this.m);
  }

  /** A fish jumps in the shallows, now and then, near the camera. */
  private fishTick(world: World, dt: number): void {
    this.fishAcc += dt;
    if (this.fishAcc < 1.1) return;
    this.fishAcc = Math.random() * 0.6;
    const fx = this.fx;
    const cam = fx.camTargetNow;
    for (let tries = 0; tries < 8; tries++) {
      const tx = cam.x / TILE + (Math.random() - 0.5) * 40;
      const tz = cam.z / TILE + (Math.random() - 0.5) * 40;
      const h = world.map.sampleHeight(tx, tz);
      if (h > -0.5 || h < -3) continue;
      const p = fx.at(tx, tz, 0.05);
      const a = Math.random() * Math.PI * 2;
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * 1.6, vy: 4.5, vz: Math.sin(a) * 1.6,
        life: 0.85, size: 0.35, r: 0.75, g: 0.82, b: 0.9, gravity: 11, shape: CHUNK, fadeIn: 0.01,
      });
      fx.ring(tx, tz, 0xeaf6ff, 1.6, 1.2, 1.2, 0.18);
      fx.spray(tx, tz, 4, 2.5);
      return;
    }
  }

  /** Butterflies: pale flutters over meadow grass near the camera. */
  private flutterTick(world: World, dt: number): void {
    this.flutterAcc += dt * 2.5;
    const fx = this.fx;
    const cam = fx.camTargetNow;
    for (; this.flutterAcc >= 1; this.flutterAcc--) {
      const tx = cam.x / TILE + (Math.random() - 0.5) * 22;
      const tz = cam.z / TILE + (Math.random() - 0.5) * 22;
      const h = world.map.sampleHeight(tx, tz);
      if (h < 1.6 || h > 9) continue;
      const p = fx.at(tx, tz, 0.6 + Math.random() * 0.8);
      const c = WINGS[(Math.random() * WINGS.length) | 0];
      fx.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 1.2, vy: 0.3, vz: (Math.random() - 0.5) * 1.2,
        life: 3.5, size: 0.28, r: c[0], g: c[1], b: c[2], alpha: 0.95, drag: 0.2, shape: PETAL, fadeIn: 0.15,
        swirl: (Math.random() - 0.5) * 3, ax: p.x + (Math.random() - 0.5) * 1.5, az: p.z + (Math.random() - 0.5) * 1.5,
      });
    }
  }
}
