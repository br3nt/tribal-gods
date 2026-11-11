/**
 * assets/models/buildings/landmarks.ts — the places of power.
 *
 * THE HOME CIRCLE. Each tribe's heart: a ring of tall, weathered standing
 * stones about 9.5 world units across, three pairs bridged by lintels
 * (trilithons), a gap facing the door side (+Z) as the way in, worn ground
 * inside, and at the back of the ring the tribe's focus glowing in its
 * colour — where the leader returns from death. Per civilisation:
 *
 *   forest  — mossy grey-green stones daubed with team ochre, a carved
 *             totem with a fire bowl
 *   dynasty — dressed sandstone pillars with gold caps, a stepped altar
 *             with a gold brazier
 *   north   — dark granite with glowing cut runes, a rune-stone over a
 *             stone-ringed fire pit
 *
 * THE STANDING STONES (monuments). Each carries the spell it holds as a
 * great carved rune (glyphs.ts) on both faces, lit in the spell's colour
 * (SPELL_LOOK in render/look.ts). Grandeur reads the tier: tier 3 stones
 * are taller, ringed by a full circle of lesser stones, and glow harder.
 * Teaching stones wear a slow crown of light; lending (gift) stones hold
 * one floating charged pebble per cast they will give. Asleep or claimed,
 * a stone goes dark and cold. While a leader communes, the rune fills with
 * light from the bottom up, runes rise from the ground, and a thread of
 * light joins leader and stone, thickening as the ritual nears completion.
 *
 * Both are built at their centre's ground height; `setGround` re-seats
 * every stone on the drawn ground under IT (slopes, sculpting), and drapes
 * ground decals, so nothing floats or sinks.
 */

import * as THREE from 'three';
import { Civ } from '../../../config';
import { SpellId, spellDef, Tribe, TRIBE_COLORS } from '../../../sim/catalog';
import { HIGHLIGHT, SPELL_LOOK, SPELL_LOOK_DEFAULT } from '../../../render/look';
import { blob, cone, cyl, G, lathe, merge, paint, place, rbox, shine, tint, torus } from '../geometry';
import { disposeModelMaterial, glowMaterial, modelMaterial, sharedMaterials, tintedMaterial } from '../materials';
import { rng } from '../rng';
import { glyphGeometry } from './glyphs';

export type GroundFn = (lx: number, lz: number) => number;

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** A weathered standing stone, base at y=0, long axis along X (its faces look ±Z). */
function standingStone(w: number, h: number, d: number, seed: number, flatFace = false): G {
  const g = blob(w / 2, h / 2, d / 2, 12, 14, 0.06 + 0.02 * (seed % 3), seed, 1.6);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // taper toward a rounded crown, square the shoulders, flat foot
    const t = (y + h / 2) / h;
    const k = 1 - Math.max(0, t - 0.55) * 0.55;
    x *= k;
    z *= k * (flatFace ? 1 : 0.95);
    if (flatFace && Math.abs(z) > d * 0.32) z = Math.sign(z) * (d * 0.32 + (Math.abs(z) - d * 0.32) * 0.15);
    y = Math.max(-h / 2 + 0.02, y);
    pos.setXYZ(i, x, y + h / 2 - 0.25, z); // sunk a little into the ground
  }
  g.computeVertexNormals();
  return g;
}

/** Lichen, moss at the foot, streaks of weather. */
function weather(g: G, base: number, moss: number, lichen: number, seed: number): void {
  paint(g, (p) => {
    const n = Math.sin(p.x * 7 + seed) * Math.sin(p.y * 5 + p.z * 6 + seed * 0.7);
    if (p.y < 0.35 + 0.25 * Math.sin(p.x * 4 + p.z * 3 + seed)) return moss;
    if (n > 0.55) return lichen;
    if (Math.sin(p.x * 13 + p.y * 2 + seed) > 0.85) return tint(base, 0.82); // rain streaks
    return n < -0.5 ? tint(base, 0.92) : base;
  });
}

/** A flat ring (or disc) on the ground, dense enough to drape over the terrain. */
function groundRing(r0: number, r1: number, segs = 48, rings = 3): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(Math.max(0.001, r0), r1, segs, rings);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Re-seat a geometry's vertices on the ground: y = rest.y + ground(x, z) + lift. */
function drapeGeo(geo: THREE.BufferGeometry, rest: Float32Array, ground: GroundFn, lift: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  for (let i = 0; i < a.length; i += 3) a[i + 1] = rest[i + 1] + ground(rest[i], rest[i + 2]) + lift;
  pos.needsUpdate = true;
}

/** Highlight variants (shared): see render/highlight.ts. */
export function highlightMaterial(m: THREE.Material): THREE.Material {
  return tintedMaterial(m, 'highlight', {
    color: HIGHLIGHT.color, emissive: HIGHLIGHT.emissive, rim: HIGHLIGHT.rim, roughnessShift: -0.05,
  });
}

/** Swap every mesh under root between its base material and the highlight variant. */
export function applyHighlight(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    if (m.userData.noHighlight) return;
    if (on) {
      if (!m.userData.baseMat) m.userData.baseMat = m.material;
      const base = m.userData.baseMat as THREE.Material;
      if ((base as THREE.MeshBasicMaterial).blending === THREE.AdditiveBlending) return;
      m.material = highlightMaterial(base);
    } else if (m.userData.baseMat) {
      m.material = m.userData.baseMat as THREE.Material;
      m.userData.baseMat = undefined;
    }
  });
}

// ---------------------------------------------------------------------------
// The home circle
// ---------------------------------------------------------------------------

/** Outer radius of the stone ring (world units) — the sim's clear zone must cover it. */
export const HOME_RING_OUTER = 4.75;
const HOME_RING_R = 4.3;

interface CivStones {
  base: number; moss: number; lichen: number; lintel: number;
}
function civStones(civ: Civ): CivStones {
  switch (civ.roof) {
    case 'stepped': return { base: 0xcfb284, moss: 0xb89c6c, lichen: 0xdcc59a, lintel: 0xc4a674 };
    case 'gabled': return { base: 0x5f5e5b, moss: 0x4a5040, lichen: 0x76756e, lintel: 0x55544f };
    default: return { base: 0x8b8f86, moss: 0x5f7044, lichen: 0xa3a88f, lintel: 0x7f8279 };
  }
}

export interface HomeCircle {
  root: THREE.Group;
  /** Fire emitters (model-local), for the building renderer's flames. */
  flames: THREE.Vector3[];
  /** Re-seat stones and decals on the drawn ground (ground(0,0) is the root's height). */
  setGround(ground: GroundFn): void;
  /** Animate the glow (seconds). */
  update(t: number): void;
  dispose(): void;
}

interface StoneSpec { x: number; z: number; ry: number; w: number; h: number; d: number; lean: number; seed: number }

export function buildStoneCircle(tribe: Tribe, civ: Civ): HomeCircle {
  const team = TRIBE_COLORS[tribe] ?? TRIBE_COLORS.wild;
  const pal = civStones(civ);
  const r = rng(civ.id.length * 131 + 7);
  const mats = sharedMaterials();

  // --- The ring: 11 stones, a gap at +Z as the way in; three trilithons ---
  const N = 12;
  const specs: StoneSpec[] = [];
  const pairs = new Set([2, 3, 5, 6, 9, 10]); // stones that carry lintels (in pairs 2-3, 5-6, 9-10)
  for (let i = 1; i < N; i++) {
    const a = (i / N) * Math.PI * 2; // a = 0 is +Z: left empty as the entrance
    const pair = pairs.has(i);
    const h = pair ? 3.7 : 2.4 + r.next() * 1.3 + (i % 2 ? 0.3 : 0);
    specs.push({
      x: Math.sin(a) * HOME_RING_R, z: Math.cos(a) * HOME_RING_R, ry: a,
      w: civ.roof === 'stepped' ? 1.0 : 1.05 + r.next() * 0.35, h, d: civ.roof === 'stepped' ? 0.62 : 0.6 + r.next() * 0.2,
      lean: pair ? 0 : (r.next() - 0.5) * 0.12, seed: i * 7 + 3,
    });
  }

  const stoneMesh = new THREE.Mesh(new THREE.BufferGeometry(), mats.matte);
  stoneMesh.castShadow = stoneMesh.receiveShadow = true;
  const glossMesh = new THREE.Mesh(new THREE.BufferGeometry(), mats.glossy);
  glossMesh.castShadow = true;

  // --- The worn floor and a soft team glow on it (draped) ---
  const floor = groundRing(0, HOME_RING_R + 0.9, 56, 5);
  const floorG = merge([floor]);
  paint(floorG, (p) => {
    const rr = Math.hypot(p.x, p.z);
    const ringPath = Math.abs(rr - 2.6) < 0.35; // a trodden processional ring
    return ringPath ? 0x7d6648 : Math.sin(p.x * 3.1 + p.z * 2.3) > 0.4 ? 0x8a7454 : 0x957d5a;
  });
  const floorRest = (floorG.attributes.position.array as Float32Array).slice();
  const floorMesh = new THREE.Mesh(floorG, mats.matte);
  floorMesh.receiveShadow = true;
  floorMesh.userData.noHighlight = true;
  // feathered edge: shrink the outer ring a touch so the terrain's own wear shows round it
  const glowGeo = groundRing(0.6, 3.4, 48, 4);
  const gcol = new Float32Array(glowGeo.attributes.position.count * 3);
  for (let i = 0; i < glowGeo.attributes.position.count; i++) {
    const rr = Math.hypot(glowGeo.attributes.position.getX(i), glowGeo.attributes.position.getZ(i));
    const k = Math.max(0, 1 - Math.abs(rr - 2.6) / 0.8);
    gcol[i * 3] = gcol[i * 3 + 1] = gcol[i * 3 + 2] = k * k;
  }
  glowGeo.setAttribute('color', new THREE.BufferAttribute(gcol, 3));
  const glowRest = (glowGeo.attributes.position.array as Float32Array).slice();
  const glowMat = glowMaterial(team, 0.35);
  glowMat.vertexColors = true;
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.renderOrder = 2;
  glowMesh.userData.noHighlight = true;

  const root = new THREE.Group();
  root.add(floorMesh, glowMesh, stoneMesh, glossMesh);

  // The focus, at the back of the ring (−Z), leaving the middle for the leader.
  const focusZ = -2.25;
  const flames: THREE.Vector3[] = [];

  const build = (ground: GroundFn) => {
    const body: G[] = [];
    const gloss: G[] = [];
    const tops = new Map<number, number>();
    specs.forEach((s, k) => {
      const i = k + 1;
      const y0 = ground(s.x, s.z);
      const st = civ.roof === 'stepped'
        ? rbox(s.w, s.h + 0.25, s.d, 0.12, 2)
        : standingStone(s.w, s.h + 0.25, s.d, s.seed, civ.roof === 'gabled');
      if (civ.roof === 'stepped') st.translate(0, (s.h + 0.25) / 2 - 0.25, 0);
      weather(st, pal.base, pal.moss, pal.lichen, s.seed);
      // team paint: a band of ochre-and-colour handprints on the inner face
      if (i % 2 === 1 || civ.roof === 'gabled') {
        const band = civ.roof === 'gabled' ? 0 : 1;
        if (band) {
          const mark = rbox(s.w * 0.55, 0.16, 0.05, 0.03, 1);
          place(mark, 0, s.h * 0.55, -s.d * 0.42);
          paint(mark, team);
          shine(mark, team, 0.25);
          mark.rotateY(0);
          mark.applyMatrix4(new THREE.Matrix4().makeRotationZ(s.lean));
          mark.rotateY(s.ry);
          mark.translate(s.x, y0, s.z);
          body.push(mark);
        }
      }
      st.applyMatrix4(new THREE.Matrix4().makeRotationZ(s.lean));
      st.rotateY(s.ry);
      st.translate(s.x, y0, s.z);
      body.push(st);
      tops.set(i, y0 + s.h);
      if (civ.roof === 'gabled') {
        // cut runes on the inner face, glowing faintly in the team colour
        const rune = glyphGeometry(['ward', 'warsong', 'cyclone', 'lightning'][i % 4], 0.32, 0.09, 0.05);
        shine(rune, team, 1.2);
        paint(rune, 0x2a2a2a);
        rune.rotateY(Math.PI);
        place(rune, 0, s.h * 0.55, -s.d * 0.36);
        rune.rotateY(s.ry);
        rune.translate(s.x, y0, s.z);
        body.push(rune);
      }
      if (civ.roof === 'stepped') {
        const cap = cone(s.w * 0.42, 0.4, 4);
        place(cap, 0, s.h + 0.2, 0, 0, Math.PI / 4, 0);
        paint(cap, 0xe8bb4a);
        cap.rotateY(s.ry);
        cap.translate(s.x, y0, s.z);
        gloss.push(cap);
      }
    });
    // lintels across the paired stones
    for (const [a, b] of [[2, 3], [5, 6], [9, 10]]) {
      const sa = specs[a - 1], sb = specs[b - 1];
      const ya = tops.get(a)!, yb = tops.get(b)!;
      const len = Math.hypot(sb.x - sa.x, sb.z - sa.z) + 1.0;
      const lin = civ.roof === 'stepped' ? rbox(len, 0.5, 0.75, 0.08, 2) : standingStone(len, 0.62, 0.75, a * 13, true);
      if (civ.roof !== 'stepped') {
        // standingStone stands up along Y; lay this one flat: it's already long in X, short in Y
        lin.translate(0, -0.06, 0);
      }
      weather(lin, pal.lintel, pal.lintel, pal.lichen, a * 3);
      lin.rotateY(Math.atan2(sb.x - sa.x, sb.z - sa.z) - Math.PI / 2);
      lin.translate((sa.x + sb.x) / 2, Math.max(ya, yb) - 0.12, (sa.z + sb.z) / 2);
      body.push(lin);
    }
    // the focus
    const fy = ground(0, focusZ);
    flames.length = 0;
    if (civ.roof === 'thatch') {
      // carved totem: stacked faces, team paint, wings; a fire bowl before it
      for (let i = 0; i < 3; i++) {
        const hh = 0.85;
        const seg = lathe([[0.4, 0], [0.46, 0.15], [0.43, hh * 0.6], [0.48, hh * 0.85], [0.38, hh]], 12);
        place(seg, 0, fy + 0.3 + i * hh, focusZ - 0.5);
        paint(seg, (p) => (Math.abs(p.y - (fy + 0.3 + i * hh + hh * 0.85)) < 0.06 ? 0xe8dcc0 : i % 2 ? team : 0x8a6038));
        body.push(seg);
        for (const sx of [-1, 1]) {
          const eye = blob(0.09, 0.06, 0.05, 7, 5);
          place(eye, sx * 0.17, fy + 0.3 + i * hh + hh * 0.6, focusZ - 0.5 + 0.43);
          paint(eye, 0xf0e8d8);
          shine(eye, 0xfff0c0, i === 2 ? 1.2 : 0.2);
          body.push(eye);
        }
      }
      const wings = rbox(2.2, 0.2, 0.28, 0.08);
      place(wings, 0, fy + 0.3 + 3 * 0.85 - 0.15, focusZ - 0.5);
      paint(wings, (p) => (Math.abs(p.x) > 0.8 ? team : 0x6a4a2c));
      body.push(wings);
      const crest = cone(0.4, 0.9, 6);
      place(crest, 0, fy + 0.3 + 3 * 0.85 + 0.4, focusZ - 0.5);
      paint(crest, team);
      shine(crest, team, 0.6);
      body.push(crest);
      const plinth = cyl(0.7, 0.85, 0.45, 12);
      place(plinth, 0, fy + 0.1, focusZ - 0.5);
      paint(plinth, pal.base);
      body.push(plinth);
      const bowl = lathe([[0.05, 0], [0.5, 0.05], [0.62, 0.35], [0.55, 0.4]], 14);
      place(bowl, 0, fy + 0.02, focusZ + 0.55);
      paint(bowl, 0x5a5048);
      body.push(bowl);
      const coals = blob(0.45, 0.1, 0.45, 8, 4, 0.04, 2, 9);
      place(coals, 0, fy + 0.32, focusZ + 0.55);
      paint(coals, 0xffa040);
      shine(coals, 0xff5010, 2.6);
      body.push(coals);
      flames.push(new THREE.Vector3(0, fy + 0.45, focusZ + 0.55));
    } else if (civ.roof === 'stepped') {
      // stepped altar with a gold brazier
      for (let i = 0; i < 3; i++) {
        const s = rbox(2.2 - i * 0.55, 0.32, 1.6 - i * 0.4, 0.05);
        place(s, 0, fy + 0.16 + i * 0.32, focusZ);
        paint(s, i === 2 ? team : tint(pal.base, 1 - i * 0.04));
        body.push(s);
      }
      const bowl = lathe([[0.05, 0], [0.18, 0.05], [0.12, 0.35], [0.45, 0.55], [0.5, 0.62]], 14);
      place(bowl, 0, fy + 0.96, focusZ);
      paint(bowl, 0xe8bb4a);
      gloss.push(bowl);
      flames.push(new THREE.Vector3(0, fy + 1.6, focusZ));
    } else {
      // a rune-stone over a fire pit
      const rs = standingStone(1.0, 2.6, 0.6, 99, true);
      weather(rs, pal.base, pal.moss, pal.lichen, 5);
      place(rs, 0, fy, focusZ - 0.6);
      body.push(rs);
      const rune = glyphGeometry('warsong', 0.42, 0.1, 0.06);
      paint(rune, 0x262626);
      shine(rune, team, 2.2);
      place(rune, 0, fy + 1.4, focusZ - 0.6 + 0.2);
      body.push(rune);
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const st = blob(0.2, 0.15, 0.18, 6, 4, 0.04, i, 3);
        place(st, Math.sin(a) * 0.7, fy + 0.08, focusZ + 0.6 + Math.cos(a) * 0.7);
        paint(st, i % 2 ? pal.base : pal.lichen);
        body.push(st);
      }
      const coals = blob(0.5, 0.1, 0.5, 8, 4, 0.04, 2, 9);
      place(coals, 0, fy + 0.06, focusZ + 0.6);
      paint(coals, 0xffa040);
      shine(coals, 0xff5010, 2.6);
      body.push(coals);
      flames.push(new THREE.Vector3(0, fy + 0.25, focusZ + 0.6));
    }
    stoneMesh.geometry.dispose();
    stoneMesh.geometry = merge(body);
    glossMesh.geometry.dispose();
    glossMesh.geometry = gloss.length ? merge(gloss) : new THREE.BufferGeometry();
    glossMesh.visible = gloss.length > 0;
    drapeGeo(floorG, floorRest, ground, 0.04);
    drapeGeo(glowGeo, glowRest, ground, 0.07);
  };
  build(() => 0);

  return {
    root,
    flames,
    setGround: build,
    update(t) {
      glowMat.opacity = 0.28 + 0.1 * Math.sin(t * 1.3);
    },
    dispose() {
      stoneMesh.geometry.dispose();
      glossMesh.geometry.dispose();
      floorG.dispose();
      glowGeo.dispose();
      disposeModelMaterial(glowMat);
    },
  };
}

// ---------------------------------------------------------------------------
// The standing stones (monuments)
// ---------------------------------------------------------------------------

export interface MonumentState {
  /** Asleep or claimed: dark and cold. */
  dark: boolean;
  mode: 'teach' | 'gift';
  /** Gift stones: casts it will lend (one floating pebble each). */
  charges: number;
  /** 0..1 while a leader communes, else null. */
  ritual: number | null;
  /** The communing tribe's colour. */
  ritualColor: number;
  /** Where the communing leader's chest is, model-local (null: none drawn). */
  leader: THREE.Vector3 | null;
  /** Seconds (animation clock). */
  t: number;
}

export interface MonumentModel {
  root: THREE.Group;
  spell: string;
  tier: number;
  /** World units from the ground to the stone's top. */
  height: number;
  /** Rune centre (model-local, front face). */
  runeAt: THREE.Vector3;
  setGround(ground: GroundFn): void;
  update(s: MonumentState): void;
  dispose(): void;
}

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

export function buildMonumentStone(spell: SpellId | string, tierIn?: number): MonumentModel {
  let tier = tierIn ?? 1;
  try {
    tier = tierIn ?? spellDef(spell as SpellId).tier;
  } catch {
    tier = 1;
  }
  tier = Math.max(1, Math.min(3, tier));
  const look = SPELL_LOOK[spell] ?? SPELL_LOOK_DEFAULT;
  const mats = sharedMaterials();
  const H = [5.0, 6.3, 8.0][tier - 1];
  const W = 1.3 + tier * 0.15;
  const D = 0.95 + tier * 0.05;

  // --- the great stone (flat dressed faces front and back) ---
  const stone = standingStone(W, H + 0.25, D, 17 + tier, true);
  weather(stone, 0xb6b1a6, 0x74805e, 0xc6c1b2, 3);
  const stoneMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(stone, mats.matte);
  stoneMesh.castShadow = stoneMesh.receiveShadow = true;

  // --- the rune, both faces: its own material so it can fill with light ---
  const runeSize = Math.min(W * 0.42, 0.95) * (1 + (tier - 1) * 0.08);
  const runeY = H * 0.5;
  const faceZ = D * 0.32 + 0.02;
  const front = glyphGeometry(spell, runeSize, 0.085, 0.07);
  front.translate(0, runeY, faceZ);
  const back = glyphGeometry(spell, runeSize, 0.085, 0.07);
  back.rotateY(Math.PI);
  back.translate(0, runeY, -faceZ);
  const runeGeo = merge([front, back]);
  const runeColor = new THREE.Color(look.glow);
  const uFill = { value: 1e6 };
  const uLit = { value: 1.0 };
  const uBase = { value: 1.0 };
  const runeMat = modelMaterial({ roughness: 0.6, glow: false, emissive: look.glow, emissiveIntensity: 1 });
  {
    const prev = runeMat.onBeforeCompile;
    runeMat.onBeforeCompile = (shader, renderer) => {
      prev.call(runeMat, shader, renderer);
      shader.uniforms.uFill = uFill;
      shader.uniforms.uLit = uLit;
      shader.uniforms.uBase = uBase;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vRuneY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRuneY = position.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRuneY;\nuniform float uFill, uLit, uBase;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           // filled part blazes, the rest smoulders; a bright edge at the fill line
           float tgF = smoothstep(uFill + 0.05, uFill - 0.05, vRuneY);
           float tgEdge = 1.0 - smoothstep(0.0, 0.12, abs(vRuneY - uFill));
           totalEmissiveRadiance *= mix(uBase, uLit, tgF) + tgEdge * uLit * 0.8;`,
        );
    };
    runeMat.customProgramCacheKey = () => 'tg-rune';
  }
  const runeMesh = new THREE.Mesh(runeGeo, runeMat);
  runeMesh.userData.noHighlight = true;

  // --- lesser stones: more, taller and in a full circle as the tier rises ---
  const lesserN = [3, 5, 8][tier - 1];
  const lesserR = [3.0, 3.5, 4.4][tier - 1];
  const lesser: Array<{ x: number; z: number; geo: G }> = [];
  for (let i = 0; i < lesserN; i++) {
    const a = tier === 3 ? (i / lesserN) * Math.PI * 2 + 0.2 : Math.PI * (0.65 + (1.7 * i) / Math.max(1, lesserN - 1)) + 0.0;
    const h = (tier === 3 ? 2.0 : 1.2) + (i % 3) * 0.45;
    const g = standingStone(0.8 + (i % 2) * 0.2, h, 0.55, i * 5 + 3);
    weather(g, i % 2 ? 0xaaa69c : 0x98948b, 0x6c7652, 0xb8b4a8, i);
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ((i % 2 ? 1 : -1) * 0.08));
    g.rotateY(a);
    lesser.push({ x: Math.sin(a) * lesserR, z: Math.cos(a) * lesserR, geo: g });
  }
  const lesserMesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.BufferGeometry(), mats.matte);
  lesserMesh.castShadow = lesserMesh.receiveShadow = true;

  // --- the paved ring and the halo of light on it (draped) ---
  const paveR = lesserR + 0.9;
  const pave = merge([groundRing(0, paveR, 48, 5)]);
  paint(pave, (p) => {
    const rr = Math.hypot(p.x, p.z);
    if (rr > paveR - 0.5) return 0x6f6a62;
    return Math.sin(Math.atan2(p.x, p.z) * 9) * Math.sin(rr * 4) > 0.2 ? 0x8a8478 : 0x9a9488;
  });
  const paveRest = (pave.attributes.position.array as Float32Array).slice();
  const paveMesh = new THREE.Mesh(pave, mats.matte);
  paveMesh.receiveShadow = true;
  paveMesh.userData.noHighlight = true;
  const halo = groundRing(0.4, paveR + 0.4, 48, 4);
  const hc = new Float32Array(halo.attributes.position.count * 3);
  for (let i = 0; i < halo.attributes.position.count; i++) {
    const rr = Math.hypot(halo.attributes.position.getX(i), halo.attributes.position.getZ(i));
    const k = Math.max(0, 1 - rr / (paveR + 0.4)) ** 0.7;
    hc[i * 3] = hc[i * 3 + 1] = hc[i * 3 + 2] = k;
  }
  halo.setAttribute('color', new THREE.BufferAttribute(hc, 3));
  const haloRest = (halo.attributes.position.array as Float32Array).slice();
  const haloMat = glowMaterial(look.glow, 0.12 + tier * 0.05);
  haloMat.vertexColors = true;
  const haloMesh = new THREE.Mesh(halo, haloMat);
  haloMesh.renderOrder = 2;
  haloMesh.userData.noHighlight = true;

  // --- teach: a slow crown of light; gift: floating charged pebbles ---
  const crownMat = glowMaterial(look.glow, 0.7);
  const crown = new THREE.Mesh(merge([torus(0.75 + tier * 0.12, 0.05, 6, 40)]), crownMat);
  crown.rotation.x = Math.PI / 2;
  crown.position.y = H + 0.9;
  crown.userData.noHighlight = true;
  const pebbleGeo = merge([blob(0.22, 0.2, 0.22, 10, 8, 0.05, 4, 3)]);
  paint(pebbleGeo, 0x3c3a38);
  shine(pebbleGeo, look.glow, 2.6);
  const pebbles: THREE.Mesh[] = [];
  const pebbleRoot = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(pebbleGeo, mats.matte);
    p.castShadow = true;
    p.userData.noHighlight = true;
    pebbles.push(p);
    pebbleRoot.add(p);
  }

  // --- the ritual: a thread of light to the leader, runes rising round the stone ---
  const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 6, true).translate(0, 0.5, 0);
  const beamMat = glowMaterial(look.glow, 0.6);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.visible = false;
  beam.renderOrder = 7;
  beam.userData.noHighlight = true;
  const beamCore = new THREE.Mesh(beamGeo, glowMaterial(0xffffff, 0.75));
  beamCore.renderOrder = 7;
  beam.add(beamCore);
  const riseMat = glowMaterial(look.glow, 0.8);
  const riseGeo = merge([glyphGeometry(spell, 0.32, 0.12, 0.02)]);
  const risers: THREE.Mesh[] = [];
  const riseRoot = new THREE.Group();
  riseRoot.visible = false;
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(riseGeo, riseMat);
    m.renderOrder = 7;
    m.userData.noHighlight = true;
    risers.push(m);
    riseRoot.add(m);
  }

  const root = new THREE.Group();
  root.add(paveMesh, haloMesh, stoneMesh, runeMesh, lesserMesh, crown, pebbleRoot, beam, riseRoot);

  let coldOn = false;
  const coldMat = tintedMaterial(mats.matte, 'cold-stone', { color: 0x9aa6b8, emissive: 0x000000, desaturate: 0.65, roughnessShift: -0.1 });
  let groundAt: GroundFn = () => 0;

  const model: MonumentModel = {
    root, spell, tier, height: H,
    runeAt: new THREE.Vector3(0, runeY, faceZ),
    setGround(ground) {
      groundAt = ground;
      const parts = lesser.map((l) => {
        const g = l.geo.clone();
        g.translate(l.x, ground(l.x, l.z), l.z);
        return g;
      });
      lesserMesh.geometry.dispose();
      lesserMesh.geometry = merge(parts);
      drapeGeo(pave, paveRest, ground, 0.04);
      drapeGeo(halo, haloRest, ground, 0.08);
    },
    update(s) {
      // dark and cold when asleep/claimed
      if (s.dark !== coldOn) {
        coldOn = s.dark;
        const m: THREE.Material = s.dark ? coldMat : mats.matte;
        if (!stoneMesh.userData.baseMat) stoneMesh.material = m;
        else stoneMesh.userData.baseMat = m;
        if (!lesserMesh.userData.baseMat) lesserMesh.material = m;
        else lesserMesh.userData.baseMat = m;
      }
      const tierGlow = 0.9 + tier * 0.55;
      const breathe = 0.85 + 0.15 * Math.sin(s.t * 1.7);
      haloMesh.visible = !s.dark;
      crown.visible = !s.dark && s.mode === 'teach';
      pebbleRoot.visible = !s.dark && s.mode === 'gift';
      if (s.dark) {
        uBase.value = 0.0;
        uLit.value = 0.0;
        uFill.value = -1e6;
        runeMat.emissiveIntensity = 0;
      } else if (s.ritual !== null) {
        const p = Math.max(0, Math.min(1, s.ritual));
        runeMat.emissiveIntensity = 1;
        uBase.value = 0.35 * tierGlow;
        uLit.value = (2.4 + 2.5 * p) * tierGlow * (0.9 + 0.1 * Math.sin(s.t * 9));
        uFill.value = runeY - runeSize + 2 * runeSize * p;
      } else {
        runeMat.emissiveIntensity = 1;
        uBase.value = tierGlow * breathe;
        uLit.value = tierGlow * breathe;
        uFill.value = 1e6;
      }
      crown.rotation.z = s.t * 0.4;
      crown.position.y = H + 0.9 + Math.sin(s.t * 0.9) * 0.15;
      crownMat.opacity = 0.45 + 0.2 * Math.sin(s.t * 2.1);
      const n = Math.min(pebbles.length, Math.max(0, Math.round(s.charges)));
      for (let i = 0; i < pebbles.length; i++) {
        const p = pebbles[i];
        p.visible = i < n;
        if (!p.visible) continue;
        const a = s.t * 0.6 + (i / Math.max(1, n)) * Math.PI * 2;
        const rr = W * 0.9 + 0.5;
        p.position.set(Math.sin(a) * rr, H * 0.45 + Math.sin(s.t * 1.3 + i) * 0.25, Math.cos(a) * rr);
        p.rotation.set(s.t * 0.7 + i, s.t * 0.5, 0);
      }
      // the ritual
      const ritual = s.ritual !== null && !s.dark;
      riseRoot.visible = ritual;
      beam.visible = ritual && s.leader !== null;
      if (ritual) {
        const p = Math.max(0, Math.min(1, s.ritual!));
        const col = _c.setHex(s.ritualColor);
        riseMat.color.copy(col).lerp(runeColor, 0.35);
        beamMat.color.copy(col).lerp(runeColor, 0.3);
        for (let i = 0; i < risers.length; i++) {
          const m = risers[i];
          const a = (i / risers.length) * Math.PI * 2 + s.t * (0.3 + p * 0.9);
          const rr = lesserR * 0.72;
          const lx = Math.sin(a) * rr, lz = Math.cos(a) * rr;
          const lift = 0.08 + p * (1.6 + (i % 3) * 0.5) + Math.sin(s.t * 2 + i) * 0.12 * p;
          m.position.set(lx, groundAt(lx, lz) + lift, lz);
          m.rotation.set(0, a + Math.PI, 0);
          m.scale.setScalar(0.6 + p * 0.7);
        }
        riseMat.opacity = 0.35 + 0.6 * p;
        if (s.leader) {
          const from = model.runeAt;
          _dir.subVectors(s.leader, from);
          const len = _dir.length();
          beam.position.copy(from);
          beam.quaternion.setFromUnitVectors(_up, _dir.normalize());
          const r = 0.04 + 0.26 * p;
          beam.scale.set(r, len, r);
          beamCore.scale.set(0.35, 1, 0.35);
          beamMat.opacity = 0.35 + 0.45 * p * (0.85 + 0.15 * Math.sin(s.t * 14));
        }
      }
    },
    dispose() {
      lesserMesh.geometry.dispose();
      for (const l of lesser) l.geo.dispose();
      stone.dispose();
      runeGeo.dispose();
      pave.dispose();
      halo.dispose();
      pebbleGeo.dispose();
      beamGeo.dispose();
      riseGeo.dispose();
      (crown.geometry as THREE.BufferGeometry).dispose();
      for (const m of [runeMat, haloMat, crownMat, beamMat, beamCore.material as THREE.Material, riseMat]) disposeModelMaterial(m);
    },
  };
  model.setGround(() => 0);
  model.update({ dark: false, mode: 'teach', charges: 0, ritual: null, ritualColor: 0xffffff, leader: null, t: 0 });
  return model;
}

const _c = new THREE.Color();
