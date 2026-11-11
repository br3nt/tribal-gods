/**
 * render/model-particles.ts — chimney smoke, flames and embers for models.
 *
 * One THREE.Points draw call per look (soft smoke, additive fire), however
 * many buildings are smoking. Particles live in the space of the object
 * that emitted them (a building's root), so when the camera pans and the
 * renderer re-anchors that building — wrap, curvature drop — its smoke
 * column moves with it instead of hanging where it used to be.
 *
 * Simulation is plain CPU work: position += velocity·dt, a little drift
 * and buoyancy, size grows, alpha fades in then out. A few hundred
 * particles is nothing.
 *
 * Anchors sit at UNBENT world positions (like every model); the point
 * shader bends each particle with the planet, so smoke rises from the
 * chimney it belongs to at any distance.
 */

import * as THREE from 'three';
import { glowTexture } from '../assets/models/people/figure';
import { curvatureGlsl, curvatureUniforms } from '../world/curvature';

interface P {
  anchor: THREE.Object3D;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  life: number;
  size: number;
  grow: number;
  r: number; g: number; b: number;
  a: number;
}

const VERT = /* glsl */ `
  ${curvatureGlsl}
  attribute float size;
  attribute vec4 rgba;
  varying vec4 vRgba;
  void main() {
    vRgba = rgba;
    // Positions are UNBENT world space (anchors are placed unbent); bend
    // them like the ground beneath.
    vec4 w = modelMatrix * vec4(position, 1.0);
    w.xyz = applyCurvature(w.xyz);
    vec4 mv = viewMatrix * w;
    gl_PointSize = size * (520.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  uniform sampler2D map;
  varying vec4 vRgba;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vRgba.rgb, vRgba.a * t.a);
  }
`;

export class ParticlePool {
  readonly points: THREE.Points;
  private readonly ps: P[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly siz: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly v = new THREE.Vector3();
  /** Dead particles kept for reuse (no allocation once the pool is warm). */
  private readonly free: P[] = [];

  constructor(scene: THREE.Scene, private readonly max: number, additive: boolean) {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.siz = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('rgba', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: glowTexture() },
        uCamTarget: curvatureUniforms.uCamTarget,
        uCurvature: curvatureUniforms.uCurvature,
        uLimb: curvatureUniforms.uLimb,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.userData.gpuCurved = true;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
  }

  emit(anchor: THREE.Object3D, local: THREE.Vector3, o: {
    vx?: number; vy?: number; vz?: number; life?: number; size?: number; grow?: number; color?: number; alpha?: number; spread?: number;
  }): void {
    if (this.ps.length >= this.max) return;
    const s = o.spread ?? 0.15;
    const c = _col.setHex(o.color ?? 0xffffff);
    const p = this.free.pop() ?? ({} as P);
    p.anchor = anchor;
    p.x = local.x + (Math.random() - 0.5) * s; p.y = local.y; p.z = local.z + (Math.random() - 0.5) * s;
    p.vx = (o.vx ?? 0) + (Math.random() - 0.5) * 0.3; p.vy = o.vy ?? 1; p.vz = (o.vz ?? 0) + (Math.random() - 0.5) * 0.3;
    p.age = 0; p.life = o.life ?? 3; p.size = o.size ?? 0.8; p.grow = o.grow ?? 1;
    p.r = c.r; p.g = c.g; p.b = c.b; p.a = o.alpha ?? 0.6;
    this.ps.push(p);
  }

  /** Drop every particle belonging to an anchor (building removed). */
  forget(anchor: THREE.Object3D): void {
    for (let i = this.ps.length - 1; i >= 0; i--) {
      if (this.ps[i].anchor !== anchor) continue;
      const p = this.ps.splice(i, 1)[0];
      p.anchor = DETACHED;
      this.free.push(p);
    }
  }

  update(dt: number, wind = 0.35): void {
    let n = 0;
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      p.age += dt;
      if (p.age >= p.life || !p.anchor.parent) {
        this.ps[i] = this.ps[this.ps.length - 1];
        this.ps.pop();
        p.anchor = DETACHED; // don't keep a dead building alive through the free list
        this.free.push(p);
        continue;
      }
      p.x += (p.vx + wind * (p.age / p.life)) * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy *= 1 - dt * 0.15;
    }
    for (const p of this.ps) {
      if (!p.anchor.visible) continue;
      const t = p.age / p.life;
      this.v.set(p.x, p.y, p.z).applyMatrix4(p.anchor.matrixWorld);
      this.pos[n * 3] = this.v.x;
      this.pos[n * 3 + 1] = this.v.y;
      this.pos[n * 3 + 2] = this.v.z;
      const fade = Math.min(1, t * 6) * (1 - t);
      this.col[n * 4] = p.r;
      this.col[n * 4 + 1] = p.g;
      this.col[n * 4 + 2] = p.b;
      this.col[n * 4 + 3] = p.a * fade;
      this.siz[n] = p.size * (1 + p.grow * t);
      n++;
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    (this.geo.attributes.rgba as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

const _col = new THREE.Color();
const _lift = new THREE.Vector3();
const DETACHED = new THREE.Object3D();

/** Chimney/fire emission for one model this frame. Rates are per second. */
export class ModelFx {
  readonly smoke: ParticlePool;
  readonly fire: ParticlePool;
  private acc = new WeakMap<object, number[]>();

  constructor(scene: THREE.Scene) {
    this.smoke = new ParticlePool(scene, 900, false);
    this.fire = new ParticlePool(scene, 700, true);
  }

  /** Whole particles due now from emitter (key, slot) at `rate` per second (for custom emitters). */
  count(key: object, slot: number, rate: number, dt: number): number {
    return this.tick(key, slot, rate, dt);
  }

  /** Fractional emission accumulator per (anchor, slot) → whole particles due now. */
  private tick(key: object, slot: number, rate: number, dt: number): number {
    let arr = this.acc.get(key);
    if (!arr) this.acc.set(key, (arr = []));
    let a = (arr[slot] ?? Math.random()) + rate * dt;
    const n = Math.floor(a);
    a -= n;
    arr[slot] = a;
    return n;
  }

  /** Emit for a building model given its emit flags. */
  building(root: THREE.Object3D, m: {
    smoke: THREE.Vector3[]; fire: THREE.Vector3[]; flames: THREE.Vector3[];
    emit: { smoke: boolean; fire: boolean; flames: boolean; hurt: number };
  }, dt: number): void {
    if (m.emit.smoke) {
      for (let j = 0; j < m.smoke.length; j++) {
        const s = m.smoke[j];
        for (let i = this.tick(root, j, 1.6, dt); i > 0; i--) {
          this.smoke.emit(root, s, { vy: 0.9, life: 4.5, size: 0.7, grow: 2.2, color: 0xd8d4cc, alpha: 0.42, spread: 0.2 });
        }
      }
    }
    if (m.emit.flames) {
      for (let j = 0; j < m.flames.length; j++) {
        const f = m.flames[j];
        for (let i = this.tick(root, 10 + j, 14, dt); i > 0; i--) {
          this.fire.emit(root, f, { vy: 1.4, life: 0.55, size: 0.75, grow: -0.6, color: Math.random() < 0.5 ? 0xff8a2a : 0xffc050, alpha: 0.85, spread: 0.35 });
        }
        if (Math.random() < dt * 3) this.smoke.emit(root, _lift.copy(f).setY(f.y + 0.6), { vy: 0.8, life: 2.5, size: 0.4, grow: 2, color: 0x6a6460, alpha: 0.3 });
      }
    }
    if (m.emit.hurt > 0) {
      const p = m.fire[0];
      if (p) for (let i = this.tick(root, 20, m.emit.hurt * 2.5, dt); i > 0; i--) {
        this.smoke.emit(root, p, { vy: 1.1, life: 4, size: 1.0, grow: 2.5, color: 0x3a3634, alpha: 0.5, spread: 1.2 });
      }
    }
    if (m.emit.fire) {
      for (let j = 0; j < m.fire.length; j++) {
        const p = m.fire[j];
        for (let i = this.tick(root, 30 + j, 22, dt); i > 0; i--) {
          this.fire.emit(root, p, { vy: 2.4, life: 0.8, size: 1.5, grow: -0.5, color: Math.random() < 0.4 ? 0xff5a10 : 0xffa030, alpha: 0.9, spread: 1.6 });
        }
        for (let i = this.tick(root, 40 + j, 3, dt); i > 0; i--) {
          this.smoke.emit(root, _lift.copy(p).setY(p.y + 1.2), { vy: 1.6, life: 4, size: 1.4, grow: 2.5, color: 0x2a2624, alpha: 0.55, spread: 1.4 });
        }
      }
    }
  }

  update(dt: number): void {
    this.smoke.update(dt);
    this.fire.update(dt, 0.15);
  }
}
