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
 *   site     — stakes, rope and dug earth while it's a building site
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
import { disposeModelMaterial, glowMaterial, sharedMaterials } from '../materials';
import { rng } from '../rng';
import {
  blob, cone, cyl, displace, Kit, lathe, paint, place, rbox, rubble, scaffold, shine, stakes, STONE, STONE_DARK, tint, torus, v3, WOOD_DARK,
} from './kit';
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
  const site = mk(c.site, mats.matte);
  const scaf = mk(view(c.scaffold.geo), mats.matte);
  const rub = mk(c.rubble, mats.matte);
  rub.visible = false;
  const half = ((BUILDINGS[kind]?.size ?? 3) * TILE) / 2;

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
      site.visible = !done;
      scaf.visible = !done && p > 0.02;
      rub.visible = hp < 0.6 && p > 0.3;
      this.emit.smoke = done && c.smoke.length > 0;
      this.emit.fire = s.burning;
      this.emit.flames = done && c.flames.length > 0;
      this.emit.hurt = done ? (hp < 0.3 ? 2 : hp < 0.6 ? 1 : 0) : 0;
    },
    dispose() {
      // These are VIEWS sharing the cached attribute buffers: detach the
      // attributes first so dispose() frees only this view's VAO, never the
      // GPU buffers every other building of the same key still draws from.
      for (const g of [body.geometry, gloss?.geometry, scaf.geometry]) {
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

// ---------------------------------------------------------------------------
// Landmarks: the home circle (totem) and the standing stones (monuments)
// ---------------------------------------------------------------------------

/** The tribe's home circle: a carved totem pole in team colours, a ring of stones, a fire pit. */
export function buildTotem(tribe: Tribe, civ: Civ): { root: THREE.Group; flames: THREE.Vector3[]; dispose(): void } {
  const team = TRIBE_COLORS[tribe] ?? TRIBE_COLORS.wild;
  const parts: THREE.BufferGeometry[] = [];
  const gl: THREE.BufferGeometry[] = [];
  // the pole: stacked carved faces, alternating natural wood and team paint
  const faces = 4;
  for (let i = 0; i < faces; i++) {
    const h = 0.9;
    const seg = lathe([[0.42, 0], [0.48, 0.15], [0.45, h * 0.6], [0.5, h * 0.85], [0.4, h]], 12);
    place(seg, 0, i * h, 0);
    const col = i % 2 ? team : 0x8a6038;
    paint(seg, (p) => (Math.abs(p.y - (i * h + h * 0.85)) < 0.06 ? 0xe8dcc0 : col));
    parts.push(seg);
    for (const sx of [-1, 1]) {
      const eye = blob(0.1, 0.07, 0.05, 7, 5);
      place(eye, sx * 0.18, i * h + h * 0.6, 0.45);
      paint(eye, 0xf0e8d8);
      shine(eye, 0xfff0c0, i === faces - 1 ? 0.8 : 0);
      parts.push(eye);
    }
    const mouth = rbox(0.3, 0.08, 0.06, 0.02);
    place(mouth, 0, i * h + h * 0.28, 0.47);
    paint(mouth, 0x1c1410);
    parts.push(mouth);
  }
  // wings and a crest on top
  const wings = rbox(2.4, 0.22, 0.3, 0.08);
  place(wings, 0, faces * 0.9 - 0.2, 0);
  displace(wings, 0.03, 3, 5);
  paint(wings, (p) => (Math.abs(p.x) > 0.9 ? team : 0x6a4a2c));
  parts.push(wings);
  const crest = cone(0.45, 1.0, 6);
  place(crest, 0, faces * 0.9 + 0.5, 0);
  paint(crest, team);
  parts.push(crest);
  const gem = blob(0.16, 0.2, 0.16, 8, 6);
  place(gem, 0, faces * 0.9 + 0.05, 0.42);
  paint(gem, 0xfff0c0);
  shine(gem, civ.accent, 2.5);
  gl.push(gem);
  const base = cyl(0.7, 0.8, 0.4, 12);
  place(base, 0, 0.0, 0);
  paint(base, STONE);
  parts.push(base);
  // the pole stands at the back of the circle, leaving the middle for the leader
  for (const g of [...parts, ...gl]) g.translate(0, 0, -1.7);
  // ring of stones and a fire pit
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const st = blob(0.35, 0.3 + (i % 3) * 0.12, 0.3, 7, 5, 0.06, i, 3);
    place(st, Math.sin(a) * 2.7, 0.1, Math.cos(a) * 2.7, 0, a, 0);
    paint(st, i % 2 ? STONE : STONE_DARK);
    parts.push(st);
  }
  const pit = torus(0.6, 0.18, 6, 12);
  place(pit, 1.7, 0.1, 0.5, Math.PI / 2, 0, 0);
  paint(pit, STONE_DARK);
  parts.push(pit);
  const coals = blob(0.5, 0.1, 0.5, 8, 4, 0.04, 2, 9);
  place(coals, 1.7, 0.1, 0.5);
  paint(coals, 0xffa040);
  shine(coals, 0xff5010, 2.6);
  gl.push(coals);
  const root = new THREE.Group();
  const mats = sharedMaterials();
  for (const [list, mat] of [[parts, mats.matte], [gl, mats.matte]] as const) {
    const m = new THREE.Mesh(merge(list), mat);
    m.castShadow = m.receiveShadow = true;
    root.add(m);
  }
  return {
    root,
    flames: [v3(1.7, 0.25, 0.5)],
    dispose() {
      root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    },
  };
}

/**
 * A monument: a great standing stone (~6 units) carved with a face and a
 * spiral that burns with light while it holds a spell. Ringed by lesser
 * stones. Claimed (or sleeping) stones go dark.
 */
export function buildMonument(): { root: THREE.Group; setClaimed(c: boolean): void; dispose(): void } {
  const parts: THREE.BufferGeometry[] = [];
  const glowParts: THREE.BufferGeometry[] = [];
  const stone = blob(1.25, 3.0, 0.85, 14, 14, 0.1, 17, 1.4);
  // flatten the base, taper the top
  const pos = stone.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = 1 - Math.max(0, y / 3) * 0.35;
    pos.setXYZ(i, pos.getX(i) * k, Math.max(-2.6, y), pos.getZ(i) * k);
  }
  stone.computeVertexNormals();
  place(stone, 0, 2.75, 0);
  paint(stone, (p) => (Math.sin(p.y * 3 + p.x * 2) > 0.7 ? 0x7c8a70 : Math.sin(p.x * 9 + p.y * 4) > 0.5 ? 0x8e8b84 : 0x9c988f));
  parts.push(stone);
  // carved face: heavy brow, long nose, closed mouth
  const brow = rbox(1.5, 0.3, 0.4, 0.1);
  place(brow, 0, 4.2, 0.62);
  paint(brow, 0x85827a);
  parts.push(brow);
  const nose = rbox(0.35, 1.1, 0.4, 0.1);
  place(nose, 0, 3.55, 0.72, -0.1, 0, 0);
  paint(nose, 0x8e8a82);
  parts.push(nose);
  const lip = rbox(0.8, 0.18, 0.3, 0.06);
  place(lip, 0, 2.75, 0.7);
  paint(lip, 0x75726b);
  parts.push(lip);
  // the eyes and a spiral of light below
  for (const sx of [-1, 1]) {
    const eye = blob(0.22, 0.12, 0.08, 8, 5);
    place(eye, sx * 0.42, 3.95, 0.84);
    paint(eye, 0xbff4ff);
    shine(eye, 0x5fd8ff, 3);
    glowParts.push(eye);
  }
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const a = t * Math.PI * 5;
    pts.push(new THREE.Vector3(Math.cos(a) * t * 0.5, 1.6 + Math.sin(a) * t * 0.5, 0.86));
  }
  const spiral = merge([new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.04, 4, false)]);
  paint(spiral, 0xbff4ff);
  shine(spiral, 0x5fd8ff, 2.5);
  glowParts.push(spiral);
  // lesser stones
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const h = 1.0 + (i % 3) * 0.4;
    const s = blob(0.45, h, 0.35, 8, 7, 0.06, i + 3, 2);
    place(s, Math.sin(a) * 3.2, h * 0.8, Math.cos(a) * 3.2, 0, a, (i % 2 ? 1 : -1) * 0.12);
    paint(s, i % 2 ? 0x8e8b84 : 0x7a776f);
    parts.push(s);
  }
  const ring = cyl(3.9, 4.1, 0.2, 28);
  place(ring, 0, -0.05, 0);
  paint(ring, (p) => (Math.hypot(p.x, p.z) > 3.5 ? 0x6f6a62 : 0x8a8478));
  parts.push(ring);
  const root = new THREE.Group();
  const mats = sharedMaterials();
  const m = new THREE.Mesh(merge(parts), mats.matte);
  m.castShadow = m.receiveShadow = true;
  const gm = new THREE.Mesh(merge(glowParts), mats.matte);
  const dark = new THREE.Mesh(gm.geometry.clone(), mats.matte);
  // dark copy: same carving, no light
  const g = dark.geometry.attributes.glow as THREE.BufferAttribute;
  (g.array as Float32Array).fill(0);
  paint(dark.geometry, 0x3c4648);
  dark.visible = false;
  const halo = new THREE.Mesh(new THREE.CircleGeometry(4.2, 32).rotateX(-Math.PI / 2), glowMaterial(0x5fd8ff, 0.18));
  halo.position.y = 0.08;
  root.add(m, gm, dark, halo);
  return {
    root,
    setClaimed(c) {
      gm.visible = !c;
      halo.visible = !c;
      dark.visible = c;
    },
    dispose() {
      root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      disposeModelMaterial(halo.material as THREE.Material);
    },
  };
}

export { tint, WOOD_DARK };
