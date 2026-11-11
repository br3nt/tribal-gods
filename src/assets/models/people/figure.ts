/**
 * assets/models/people/figure.ts — recipe → living figure.
 *
 * Building a person's geometry is the expensive part (a few thousand
 * vertices merged from ~60 parts), so it's cached by appearance VARIANT:
 * each (kind, tribe, civ) has a handful of variants, and a unit's id picks
 * one. Three hundred villagers therefore share ~8 geometries, but each
 * gets its own skeleton — and so its own pose, gait phase and glance.
 *
 * A FigureModel is:
 *   root     — the renderer moves/turns this (world placement)
 *   scaler   — uniform scale to the catalog height
 *   mesh     — one SkinnedMesh (plus a glossy one for gold-wearers)
 *   bones    — the shared skeleton, driven by render/figure-animator.ts
 *   aura/focus — the leader's ground glow and staff light (additive)
 */

import * as THREE from 'three';
import { Civ } from '../../../config';
import { Tribe, UnitKind } from '../../../sim/catalog';
import { disposeModelMaterial, glowMaterial, sharedMaterials } from '../materials';
import { buildRecipe, FigureStyle, Recipe } from './recipes';
import { BI, BoneName, makeBones } from './rig';

export interface FigureModel {
  root: THREE.Group;
  scaler: THREE.Group;
  mesh: THREE.SkinnedMesh;
  meshes: THREE.SkinnedMesh[];
  bones: THREE.Bone[];
  /** Unscaled rest offsets per bone (xyz). */
  rest: Float32Array;
  style: FigureStyle;
  /** World units per model unit. */
  scale: number;
  /** Hip joint → sole, world units (for stride/foot sync). */
  legLen: number;
  /** World height of the head top. */
  height: number;
  aura: THREE.Mesh | null;
  focus: THREE.Sprite | null;
  kind: UnitKind;
  /** Show/hide a prop bone (axe, hammer, log, propR, propL). */
  setProp(name: BoneName, on: boolean): void;
  /** Release per-instance resources (geometry is cached and shared). */
  dispose(): void;
}

/** Number of distinct looks per (kind, tribe, civ). Leaders are unique. */
const VARIANTS: Record<UnitKind, number> = { brave: 10, warrior: 6, firewarrior: 4, warden: 3, chanter: 3, shaman: 1, wildman: 5 };

const cache = new Map<string, Recipe>();

function recipeFor(kind: UnitKind, tribe: Tribe, civ: Civ, seed: number): Recipe {
  const v = Math.abs(seed | 0) % (VARIANTS[kind] ?? 4);
  const key = `${kind}|${tribe}|${civ.id}|${v}`;
  let r = cache.get(key);
  if (!r) {
    r = buildRecipe(kind, tribe, civ, v + 1);
    cache.set(key, r);
  }
  return r;
}

let glowTex: THREE.Texture | null = null;
/** Soft radial dot for glows (one shared canvas texture). */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

let ringGeo: THREE.BufferGeometry | null = null;
function auraGeometry(): THREE.BufferGeometry {
  if (ringGeo) return ringGeo;
  // A soft disc on the ground, brightest in a ring: vertex alpha via colour.
  const g = new THREE.RingGeometry(0.3, 1.6, 40, 3);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    const k = Math.max(0, 1 - Math.abs(r - 1.05) / 0.6);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ringGeo = g;
  return g;
}

export function buildFigure(kind: UnitKind, tribe: Tribe, civ: Civ, seed: number, targetHeight: number): FigureModel {
  const rec = recipeFor(kind, tribe, civ, seed);
  const mats = sharedMaterials();
  const root = new THREE.Group();
  const scaler = new THREE.Group();
  root.add(scaler);
  const bones = makeBones(rec.offsets);
  scaler.add(bones[0]);
  scaler.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  const meshes: THREE.SkinnedMesh[] = [];
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.bind(skeleton, new THREE.Matrix4());
    // Generous fixed bounds (in model units) so culling never needs a
    // per-vertex skinned recompute.
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, rec.headTop * 0.5, 0), rec.headTop * 0.95);
    scaler.add(m);
    meshes.push(m);
    return m;
  };
  const mesh = mk(rec.geo, mats.matte);
  if (rec.gloss) mk(rec.gloss, mats.glossy);

  // Scale so the head top lands at the catalog height (leaders' crowns rise above it).
  const s = rec.style.leader ? (targetHeight * 0.94) / rec.headTop : targetHeight / rec.headTop;
  scaler.scale.setScalar(s);

  let aura: THREE.Mesh | null = null;
  let focus: THREE.Sprite | null = null;
  if (rec.aura !== null) {
    const am = glowMaterial(rec.aura, 0.38);
    am.vertexColors = true;
    aura = new THREE.Mesh(auraGeometry(), am);
    aura.position.y = 0.06;
    aura.renderOrder = 2;
    root.add(aura);
    const sm = new THREE.SpriteMaterial({
      map: glowTexture(), color: rec.aura, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9,
    });
    focus = new THREE.Sprite(sm);
    focus.scale.setScalar(0.9 / s);
    bones[BI.charm].add(focus);
  }

  const legLen = (rec.offsets[BI.hips * 3 + 1]) * s;
  const fig: FigureModel = {
    root, scaler, mesh, meshes, bones, rest: rec.offsets, style: rec.style, scale: s, legLen,
    height: rec.headTop * s, aura, focus, kind,
    setProp(name, on) {
      const b = bones[BI[name]];
      const v = on ? 1 : 0.0001;
      if (b.scale.x !== v) b.scale.setScalar(v);
    },
    dispose() {
      skeleton.dispose();
      if (aura) disposeModelMaterial(aura.material as THREE.Material);
      if (focus) focus.material.dispose();
    },
  };
  if (rec.style.tools) {
    fig.setProp('axe', false);
    fig.setProp('hammer', false);
    fig.setProp('log', false);
  }
  return fig;
}

/** Drop cached geometry (e.g. between gallery reloads). */
export function clearFigureCache(): void {
  for (const r of cache.values()) {
    r.geo.dispose();
    r.gloss?.dispose();
  }
  cache.clear();
}
