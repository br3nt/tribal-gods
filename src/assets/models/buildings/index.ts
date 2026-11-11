/**
 * assets/models/buildings/index.ts — buildings that rise, wear and burn.
 *
 * A building model is a handful of meshes over cached geometry:
 *
 *   body     — everything matte, merged into ONE geometry whose triangles
 *              are SORTED BY HEIGHT. Construction then needs no stages and
 *              no scaling tricks: draw only the triangles below a rising
 *              line (geometry.drawRange). Footings, then walls course by
 *              course, then the roof — a smooth build-up from the dirt.
 *   gloss    — gold, bells, crystals (same reveal rule)
 *   cloth    — banners and prayer flags, wind-bent in the vertex shader
 *   site     — stakes, rope and dug earth while it's a building site,
 *              DRAPED over the real ground (setGround)
 *   foundation — a levelled terrace under the footprint whose walls reach
 *              below the lowest ground there: no floating corners on a
 *              slope; it rises out of the plot as building starts
 *   scaffold — poles and boards climbing ahead of the walls
 *   rubble   — broken stone and planks once it's badly hurt
 *
 * Damage takes the top off (the reveal line drops: holed roofs) and drops
 * rubble; burning and smoke are particles drawn by the building renderer
 * from the emitter points each model exposes.
 */

import * as THREE from 'three';
import { Civ, TILE } from '../../../config';
import { BuildingKind, BUILDINGS, Tribe, TRIBE_COLORS } from '../../../sim/catalog';
import { merge } from '../geometry';
import { sharedMaterials } from '../materials';
import { rng } from '../rng';
import { Kit, rubble, scaffold, stakes, STONE, terrace, tint, WOOD_DARK } from './kit';
import { fillKit } from './kinds';

export { garrisonSpot, TOWER_PLATFORM_Y } from './constants';

export interface BuildingState {
  /** Construction 0..1. */
  progress: number;
  /** Health fraction 0..1. */
  hpFrac: number;
  burning: boolean;
  dt: number;
}

export interface BuildingModel {
  root: THREE.Group;
  kind: BuildingKind;
  tier: number;
  /** Footprint half-width in world units. */
  half: number;
  /** Emitters in model-local space. */
  smoke: THREE.Vector3[];
  fire: THREE.Vector3[];
  flames: THREE.Vector3[];
  /** What should be emitting right now (set by update). */
  emit: { smoke: boolean; fire: boolean; flames: boolean; hurt: number };
  update(s: BuildingState): void;
  /**
   * Meet the ground. The model's origin is placed at `base` (the renderer
   * uses the HIGHEST drawn ground under the footprint, so nothing pokes
   * through the floor); `lo` is the lowest. `ground(lx, lz)` is the drawn
   * ground height at a model-local point. The foundation terrace is sized
   * to reach below `lo`; the plot (stakes, rope, dug earth) and rubble are
   * draped over the real ground.
   */
  setGround(base: number, lo: number, ground: (lx: number, lz: number) => number): void;
  dispose(): void;
}

interface SortedGeo {
  geo: THREE.BufferGeometry;
  /** Triangle centroid heights, ascending. */
  ys: Float32Array;
  minY: number;
  maxY: number;
}

interface Cached {
  body: SortedGeo;
  gloss: SortedGeo | null;
  cloth: THREE.BufferGeometry | null;
  site: THREE.BufferGeometry;
  scaffold: SortedGeo;
  rubble: THREE.BufferGeometry;
  smoke: THREE.Vector3[];
  fire: THREE.Vector3[];
  flames: THREE.Vector3[];
  top: number;
}

/** Reorder an indexed geometry's triangles bottom-to-top. */
function sortByHeight(geo: THREE.BufferGeometry): SortedGeo {
  const idx = geo.index!.array as Uint32Array;
  const pos = geo.attributes.position;
  const n = idx.length / 3;
  const order = new Array<number>(n);
  const cy = new Float32Array(n);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let t = 0; t < n; t++) {
    order[t] = t;
    const y = (pos.getY(idx[t * 3]) + pos.getY(idx[t * 3 + 1]) + pos.getY(idx[t * 3 + 2])) / 3;
    const xz = pos.getX(idx[t * 3]) * 0.013 + pos.getZ(idx[t * 3]) * 0.007; // tiny tie-break: build round, not in stripes
    cy[t] = y + xz * 0.02;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  order.sort((a, b) => cy[a] - cy[b]);
  const out = new Uint32Array(idx.length);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = order[i];
    out[i * 3] = idx[t * 3];
    out[i * 3 + 1] = idx[t * 3 + 1];
    out[i * 3 + 2] = idx[t * 3 + 2];
    ys[i] = cy[t];
  }
  geo.setIndex(new THREE.BufferAttribute(out, 1));
  geo.computeBoundingSphere();
  return { geo, ys, minY, maxY };
}

/** How many triangles lie below height y (binary search). */
function countBelow(ys: Float32Array, y: number): number {
  let lo = 0;
  let hi = ys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const cache = new Map<string, Cached>();

/** Foundation terraces, cached per (civ, footprint, depth step). */
const terraceCache = new Map<string, THREE.BufferGeometry>();
const TERRACE_STEP = 0.25;
function terraceGeo(civ: Civ, w: number, depth: number): THREE.BufferGeometry {
  const q = Math.max(1, Math.ceil(depth / TERRACE_STEP));
  const key = `${civ.id}|${w}|${q}`;
  let g = terraceCache.get(key);
  if (!g) {
    g = terrace(civ, w, w, q * TERRACE_STEP);
    terraceCache.set(key, g);
  }
  return g;
}

/** A per-instance copy of a geometry that SHARES every attribute but position (which it owns, for draping). */
function drapeView(g: THREE.BufferGeometry): { geo: THREE.BufferGeometry; rest: Float32Array } {
  const v = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) if (name !== 'position') v.setAttribute(name, attr);
  const rest = (g.attributes.position.array as Float32Array).slice();
  v.setAttribute('position', new THREE.BufferAttribute(rest.slice(), 3));
  v.setIndex(g.index);
  v.boundingSphere = g.boundingSphere;
  return { geo: v, rest };
}

/**
 * Drape: every vertex keeps its height ABOVE THE GROUND instead of above
 * the model origin, i.e. y += ground(x, z) − base. Stakes stay upright
 * (their vertices share an x, z), rope sags between them, dug earth hugs
 * every bump.
 */
function drape(geo: THREE.BufferGeometry, rest: Float32Array, base: number, ground: (lx: number, lz: number) => number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  for (let i = 0; i < a.length; i += 3) {
    a[i + 1] = rest[i + 1] + ground(rest[i], rest[i + 2]) - base;
  }
  pos.needsUpdate = true;
}

function build(kind: BuildingKind, tribe: Tribe, civ: Civ, tier: number): Cached {
  const key = `${kind}|${tribe}|${civ.id}|${tier}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const k: Kit = {
    body: [], gloss: [], cloth: [], smoke: [], fire: [], flames: [], glow: [],
    rng: rng(kind.length * 977 + tier * 31 + civ.id.length * 7),
    team: TRIBE_COLORS[tribe] ?? TRIBE_COLORS.wild,
    civ,
  };
  fillKit(k, kind, tier);
  const body = sortByHeight(merge(k.body));
  const half = BUILDINGS[kind]?.size ?? 3;
  const c: Cached = {
    body,
    gloss: k.gloss.length ? sortByHeight(merge(k.gloss)) : null,
    cloth: k.cloth.length ? merge(k.cloth) : null,
    site: stakes(k, half - 0.4),
    scaffold: sortByHeight(scaffold(Math.min(half - 0.6, 2.6 + (half > 3 ? 1.5 : 0)), Math.min(body.maxY * 0.8, 5.5), 1)),
    rubble: rubble(half - 0.8, k.rng, civ.roof === 'stepped' ? civ.wallColor : STONE),
    smoke: k.smoke,
    fire: k.fire,
    flames: k.flames,
    top: body.maxY,
  };
  cache.set(key, c);
  return c;
}

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export function buildBuilding(kind: BuildingKind, tribe: Tribe, civ: Civ, tier: number): BuildingModel {
  const c = build(kind, tribe, civ, kind === 'hut' ? tier : 0);
  const mats = sharedMaterials();
  const root = new THREE.Group();
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  // Each instance needs its own drawRange, so give it a shallow geometry clone
  // that SHARES the attribute buffers (cheap) but owns its range.
  const view = (g: THREE.BufferGeometry) => {
    const v = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) v.setAttribute(name, attr);
    v.setIndex(g.index);
    v.boundingSphere = g.boundingSphere;
    return v;
  };
  const body = mk(view(c.body.geo), mats.matte);
  const gloss = c.gloss ? mk(view(c.gloss.geo), mats.glossy) : null;
  const cloth = c.cloth ? mk(c.cloth, mats.foliage) : null;
  const siteView = drapeView(c.site);
  const site = mk(siteView.geo, mats.matte);
  site.receiveShadow = true;
  site.castShadow = true;
  const scaf = mk(view(c.scaffold.geo), mats.matte);
  const rubView = drapeView(c.rubble);
  const rub = mk(rubView.geo, mats.matte);
  rub.visible = false;
  const half = ((BUILDINGS[kind]?.size ?? 3) * TILE) / 2;
  // The foundation: its geometry is swapped (from a small cache) when the
  // ground under the footprint changes depth. Hidden while it's a bare plot.
  const footW = half * 2 + 0.3;
  let footDepth = 0.6;
  const foot = mk(terraceGeo(civ, footW, footDepth), mats.matte);
  foot.visible = false;
  /** How far the terrace has risen out of the plot (0 → 1 over the first build steps). */
  let footRise = 0;
  let groundBase = 0;
  let groundLo = 0;

  let last = -1;
  const model: BuildingModel = {
    root, kind, tier, half,
    smoke: c.smoke, fire: c.fire, flames: c.flames,
    emit: { smoke: false, fire: false, flames: false, hurt: 0 },
    update(s) {
      const p = Math.min(1, Math.max(0, s.progress));
      const hp = Math.min(1, Math.max(0, s.hpFrac));
      const done = p >= 1;
      // the build line rises from the footings to the roof tip
      const rev = done ? 1 : smooth((p - 0.06) / 0.9);
      const cap = hp > 0.6 ? 1 : hp > 0.3 ? 0.9 : 0.78;
      const key = Math.round(rev * 2000) * 10 + Math.round(cap * 10);
      if (key !== last) {
        last = key;
        const line = (sg: SortedGeo) => sg.minY + (sg.maxY - sg.minY) * Math.min(rev, cap) + (rev >= 1 && cap >= 1 ? 1 : 0);
        body.geometry.setDrawRange(0, countBelow(c.body.ys, line(c.body)) * 3);
        if (gloss && c.gloss) gloss.geometry.setDrawRange(0, countBelow(c.gloss.ys, rev >= 0.98 ? line(c.gloss) : -1e9) * 3);
        const sl = c.scaffold.minY + (c.scaffold.maxY - c.scaffold.minY) * smooth(p / 0.45) + 0.01;
        scaf.geometry.setDrawRange(0, countBelow(c.scaffold.ys, sl) * 3);
      }
      if (cloth) cloth.visible = rev >= 0.97 && hp > 0.3;
      // The terrace is laid first: it rises out of the dug plot over the
      // first steps of construction, before the footings.
      footRise = done ? 1 : smooth(p / 0.06);
      foot.visible = footRise > 0.001;
      foot.position.y = -(1 - footRise) * (groundBase - groundLo + 0.2);
      site.visible = !done;
      scaf.visible = !done && p > 0.02;
      rub.visible = hp < 0.6 && p > 0.3;
      this.emit.smoke = done && c.smoke.length > 0;
      this.emit.fire = s.burning;
      this.emit.flames = done && c.flames.length > 0;
      this.emit.hurt = done ? (hp < 0.3 ? 2 : hp < 0.6 ? 1 : 0) : 0;
    },
    setGround(base, lo, ground) {
      groundBase = base;
      groundLo = lo;
      // reach 0.3 below the lowest ground under the footprint
      footDepth = Math.max(0.5, base - lo + 0.3);
      const g = terraceGeo(civ, footW, footDepth);
      if (foot.geometry !== g) foot.geometry = g;
      foot.position.y = -(1 - footRise) * (base - lo + 0.2);
      drape(siteView.geo, siteView.rest, base, ground);
      drape(rubView.geo, rubView.rest, base, ground);
    },
    dispose() {
      // These are VIEWS sharing the cached attribute buffers: detach the
      // attributes first so dispose() frees only this view's VAO, never the
      // GPU buffers every other building of the same key still draws from.
      for (const g of [body.geometry, gloss?.geometry, scaf.geometry, siteView.geo, rubView.geo]) {
        if (!g) continue;
        for (const n of Object.keys(g.attributes)) g.deleteAttribute(n);
        g.setIndex(null);
        g.dispose();
      }
    },
  };
  model.update({ progress: 0, hpFrac: 1, burning: false, dt: 0 });
  return model;
}

// Landmarks (the home circle, the standing stones) live in ./landmarks.ts.
export { buildStoneCircle, buildMonumentStone, HOME_RING_OUTER, applyHighlight, highlightMaterial } from './landmarks';
export type { HomeCircle, MonumentModel, MonumentState } from './landmarks';

export { tint, WOOD_DARK };
