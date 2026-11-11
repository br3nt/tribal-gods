/**
 * assets/models/people/rig.ts — one skeleton for every person.
 *
 * Every figure, from a villager to a God-King, is a single SkinnedMesh on
 * the same 30-bone skeleton. One mesh = one draw call per person, which is
 * what lets 300+ of them share the screen. The skeleton:
 *
 *   root ─ hips ─┬ spine ─ chest ─┬ neck ─ head ─ tail (hair/braids)
 *                │                ├ clavL ─ armL ─ foreL ─ handL ─ propL
 *                │                ├ clavR ─ armR ─ foreR ─ handR ─┬ propR ─ charm
 *                │                ├ cloak1 ─ cloak2 ─ cloak3      ├ axe
 *                │                └ log                           └ hammer
 *                ├ thighL ─ shinL ─ footL
 *                └ thighR ─ shinR ─ footR
 *
 * Two-bone limbs (upper/fore, thigh/shin) bend at real elbows and knees.
 * Parts are authored in their bone's LOCAL space (a forearm hangs from the
 * elbow along −Y), then `Rig.add` moves them into the bind pose and stamps
 * skin weights. Rigid by default; `soft` blends the vertices near a joint
 * with the parent bone so elbows and knees bend smoothly instead of
 * kinking, and `weights` lets cloth (skirts, robes) follow the legs.
 *
 * Props live on bones too. Hiding a prop = scaling its bone to zero, which
 * collapses its vertices: an axe that appears only while chopping costs
 * nothing the rest of the time.
 *
 * Conventions: figures face +Z, up is +Y, the figure's LEFT is +X. A limb
 * hanging down swings FORWARD with negative rotation.x.
 */

import * as THREE from 'three';
import { G, merge } from '../geometry';

export const BONES = [
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'clavL', 'armL', 'foreL', 'handL',
  'clavR', 'armR', 'foreR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
  'propR', 'propL', 'cloak1', 'cloak2', 'cloak3', 'tail', 'log', 'axe', 'hammer', 'charm',
] as const;
export type BoneName = (typeof BONES)[number];
export const NB = BONES.length;
/** Length of each cloak bone: a floor-length cloak bends at two 'knees'. */
export const CLOAK_SEG = 0.46;
/** Bone name → index. */
export const BI = Object.fromEntries(BONES.map((b, i) => [b, i])) as Record<BoneName, number>;

const PARENT: Record<BoneName, BoneName | null> = {
  root: null, hips: 'root', spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  clavL: 'chest', armL: 'clavL', foreL: 'armL', handL: 'foreL',
  clavR: 'chest', armR: 'clavR', foreR: 'armR', handR: 'foreR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR',
  propR: 'handR', propL: 'handL', cloak1: 'chest', cloak2: 'cloak1', cloak3: 'cloak2', tail: 'head',
  log: 'chest', axe: 'handR', hammer: 'handR', charm: 'propR',
};
export const PARENT_INDEX = BONES.map((b) => (PARENT[b] ? BI[PARENT[b]!] : -1));

/** Body proportions in world units, before the final height scale. */
export interface Body {
  /** Hip joint → ankle. */
  legLen: number;
  /** Ankle height above the sole. */
  footH: number;
  /** Hip joint → shoulder line. */
  torsoLen: number;
  neckLen: number;
  headR: number;
  /** Half distance between shoulder joints. */
  shoulderW: number;
  /** Half distance between hip joints. */
  hipW: number;
  /** Shoulder → wrist. */
  armLen: number;
  handR: number;
  /** Torso half-widths (x) and depth factor. */
  chestR: number;
  waistR: number;
  hipR: number;
  depth: number;
  /** Limb thickness multiplier. */
  limb: number;
  /** Forward stoop of the spine at rest (radians). */
  hunch: number;
  female: boolean;
}

export function defaultBody(): Body {
  return {
    legLen: 0.8, footH: 0.085, torsoLen: 0.64, neckLen: 0.09, headR: 0.262,
    shoulderW: 0.27, hipW: 0.1, armLen: 0.7, handR: 0.088,
    chestR: 0.22, waistR: 0.18, hipR: 0.19, depth: 0.72, limb: 1, hunch: 0, female: false,
  };
}

/** Bone rest offsets (relative to parent) for a body. Props get placed later by the recipe. */
export function restOffsets(b: Body): Float32Array {
  const o = new Float32Array(NB * 3);
  const set = (n: BoneName, x: number, y: number, z: number) => {
    const i = BI[n] * 3;
    o[i] = x; o[i + 1] = y; o[i + 2] = z;
  };
  const upper = b.armLen * 0.52;
  const fore = b.armLen * 0.48;
  const thigh = b.legLen * 0.52;
  const shin = b.legLen * 0.48;
  set('root', 0, 0, 0);
  set('hips', 0, b.footH + b.legLen, 0);
  set('spine', 0, 0.06, 0);
  set('chest', 0, b.torsoLen * 0.42, 0);
  set('neck', 0, b.torsoLen * 0.52, 0);
  set('head', 0, b.neckLen, 0.0);
  set('clavL', 0.05, b.torsoLen * 0.42, -0.01);
  set('clavR', -0.05, b.torsoLen * 0.42, -0.01);
  set('armL', b.shoulderW - 0.05, 0, 0);
  set('armR', -(b.shoulderW - 0.05), 0, 0);
  set('foreL', 0, -upper, 0);
  set('foreR', 0, -upper, 0);
  set('handL', 0, -fore, 0);
  set('handR', 0, -fore, 0);
  set('thighL', b.hipW, -0.04, 0);
  set('thighR', -b.hipW, -0.04, 0);
  set('shinL', 0, -thigh, 0);
  set('shinR', 0, -thigh, 0);
  set('footL', 0, -shin, 0);
  set('footR', 0, -shin, 0);
  set('propR', 0, -b.handR * 1.1, 0.0);
  set('propL', 0, -b.handR * 1.1, 0.0);
  set('axe', 0, -b.handR * 1.1, 0.0);
  set('hammer', 0, -b.handR * 1.1, 0.0);
  set('charm', 0, 0, 1.4);
  set('cloak1', 0, b.torsoLen * 0.45, -b.chestR * b.depth - 0.02);
  set('cloak2', 0, -CLOAK_SEG, 0);
  set('cloak3', 0, -CLOAK_SEG, 0);
  set('tail', 0, b.headR * 0.9, -b.headR * 0.85);
  set('log', 0, 0.02, b.chestR * b.depth + 0.22);
  return o;
}

type Weight = Array<[BoneName, number]>;

export interface AddOpts {
  /** Blend vertices within this distance of the joint (local y≈0) with the parent bone. */
  soft?: number;
  /** Custom per-vertex weights from the local position (overrides soft). */
  weights?: (p: THREE.Vector3) => Weight;
}

/**
 * Builds the bind pose and collects skinned parts. Usage:
 *   const rig = new Rig(offsets); rig.add('foreL', capsule(...), { soft: 0.08 }); ... rig.finish()
 */
export class Rig {
  readonly world: THREE.Vector3[] = [];
  private parts: G[] = [];

  constructor(readonly offsets: Float32Array) {
    for (let i = 0; i < NB; i++) {
      const p = new THREE.Vector3(offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2]);
      const parent = PARENT_INDEX[i];
      if (parent >= 0) p.add(this.world[parent]);
      this.world.push(p);
    }
  }

  /** Bind-pose world position of a bone (rest pose has no rotations). */
  at(b: BoneName): THREE.Vector3 {
    return this.world[BI[b]].clone();
  }

  /** Add a part authored in `bone`'s local space. */
  add(bone: BoneName, geo: G, opts: AddOpts = {}): void {
    const bi = BI[bone];
    const pi = PARENT_INDEX[bi];
    const pos = geo.attributes.position;
    const n = pos.count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      let w: Weight;
      if (opts.weights) w = opts.weights(v);
      else if (opts.soft && pi >= 0) {
        const k = THREE.MathUtils.clamp(0.5 + v.y / (2 * opts.soft), 0, 1);
        w = k > 0.001 ? [[bone, 1 - k], [BONES[pi], k]] : [[bone, 1]];
      } else w = [[bone, 1]];
      let total = 0;
      for (let j = 0; j < Math.min(4, w.length); j++) total += w[j][1];
      for (let j = 0; j < Math.min(4, w.length); j++) {
        si[i * 4 + j] = BI[w[j][0]];
        sw[i * 4 + j] = total > 0 ? w[j][1] / total : j === 0 ? 1 : 0;
      }
    }
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    const o = this.world[bi];
    geo.translate(o.x, o.y, o.z);
    this.parts.push(geo);
  }

  /** Merge everything into one skinned geometry. */
  finish(): G {
    const g = merge(this.parts);
    // Baked ambient occlusion: feet in shadow, head in the light. Cheap depth.
    const pos = g.attributes.position;
    const col = g.attributes.color;
    const top = Math.max(1e-3, this.world[BI.head].y + 0.3);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.max(0, pos.getY(i) / top));
      const k = 0.72 + 0.28 * Math.sqrt(t);
      col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
    }
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

/** Instantiate bones for a rest-offset table. Returns bones[], bones[0] is the root. */
export function makeBones(offsets: Float32Array): THREE.Bone[] {
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < NB; i++) {
    const b = new THREE.Bone();
    b.name = BONES[i];
    b.position.set(offsets[i * 3], offsets[i * 3 + 1], offsets[i * 3 + 2]);
    bones.push(b);
    const p = PARENT_INDEX[i];
    if (p >= 0) bones[p].add(b);
  }
  return bones;
}
