/**
 * assets/models/flora.ts — trees, stumps, bushes, rocks and grass.
 *
 * Flora is drawn INSTANCED: one geometry per species variant, one draw call
 * for every tree of that variant on the planet. Trunk and canopy are merged
 * into a single vertex-coloured geometry with a `sway` channel (0 at the
 * roots, 1 at the leaf tips) that the foliage material bends in the wind
 * (materials.ts) — so a whole forest moves for free on the GPU.
 *
 * Species follow the land (see pickSpecies): palms on low coastal ground,
 * conifers high up and toward the poles, broadleaf everywhere between.
 * Canopies are clusters of noise-displaced blobs, lit from above by their
 * own vertex colours (lighter crowns, darker undersides) so they read as
 * foliage rather than green balls even before the lighting does its work.
 */

import * as THREE from 'three';
import { blob, cone, cross, cyl, displace, G, lathe, merge, mix, paint, place, setSway, shade, tint, tube } from './geometry';
import { rng } from './rng';
import { sharedMaterials } from './materials';

export type Species = 'broadleaf' | 'conifer' | 'palm';
export const SPECIES: Species[] = ['broadleaf', 'conifer', 'palm'];
export const VARIANTS_PER_SPECIES = 3;

const swayBy = (h0: number, h1: number) => (p: THREE.Vector3) => Math.min(1, Math.max(0, (p.y - h0) / (h1 - h0)));

/** Light from above: crowns brighter, undersides darker. */
function leafPaint(base: number, seed: number) {
  const r = rng(seed);
  const hi = tint(base, 1.25 + r.next() * 0.1);
  const lo = tint(base, 0.62);
  return (p: THREE.Vector3, n: THREE.Vector3) => {
    const k = n.y * 0.5 + 0.5;
    const speck = Math.sin(p.x * 7.1 + p.y * 5.3 + p.z * 6.7) > 0.75 ? 1.12 : 1;
    const c = new THREE.Color(lo).lerp(new THREE.Color(hi), k);
    return c.multiplyScalar(speck);
  };
}

export function treeGeometry(species: Species, variant: number): G {
  const r = rng(variant * 101 + species.length * 7);
  const parts: G[] = [];
  if (species === 'broadleaf') {
    const H = 2.3 + r.next() * 0.5;
    const trunk = lathe([[0.42, 0], [0.3, 0.25], [0.22, 0.8], [0.19, H], [0.12, H + 0.6]], 9);
    displace(trunk, 0.03, variant, 6);
    paint(trunk, (p) => (Math.sin(p.y * 14 + Math.atan2(p.x, p.z) * 3) > 0.5 ? 0x4e3a28 : 0x5f4630));
    parts.push(trunk);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + r.next();
      const br = tube([
        new THREE.Vector3(0, H * 0.75, 0),
        new THREE.Vector3(Math.cos(a) * 0.6, H + 0.4, Math.sin(a) * 0.6),
        new THREE.Vector3(Math.cos(a) * 1.0, H + 1.0, Math.sin(a) * 1.0),
      ], 0.09, 6, 5, 0.5);
      paint(br, 0x54402c);
      parts.push(br);
    }
    const green = [0x4f8a36, 0x5e9a3c, 0x6a9a32, 0x477e3a][variant % 4];
    const lumps = 6 + r.int(3);
    for (let i = 0; i < lumps; i++) {
      const a = (i / lumps) * Math.PI * 2 + r.next() * 0.5;
      const rad = i === 0 ? 0 : 0.8 + r.next() * 0.5;
      const s = (i === 0 ? 1.55 : 1.0 + r.next() * 0.45) * (0.95 + variant * 0.05);
      const y = H + 1.3 + (i === 0 ? 0.6 : r.next() * 0.9);
      const g = blob(s, s * 0.85, s, 12, 9, s * 0.13, variant * 13 + i, 2.2);
      place(g, Math.cos(a) * rad, y, Math.sin(a) * rad);
      paint(g, leafPaint(green, variant * 7 + i));
      parts.push(g);
    }
  } else if (species === 'conifer') {
    const H = 6.2 + r.next() * 1.2;
    const trunk = lathe([[0.32, 0], [0.22, 0.4], [0.16, H * 0.6], [0.04, H]], 8);
    paint(trunk, 0x4a3424);
    parts.push(trunk);
    const tiers = 5;
    const green = [0x2f5f3a, 0x35684a, 0x2c5530][variant % 3];
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const rad = 1.85 * (1 - t * 0.78);
      const y0 = 1.0 + t * (H - 2.0);
      const h = 1.9 - t * 0.6;
      // drooping skirt: concave profile with a ragged lower edge
      const g = lathe([[rad, y0], [rad * 0.85, y0 + 0.15], [rad * 0.45, y0 + h * 0.55], [0.02, y0 + h]], 12);
      displace(g, 0.08, variant * 5 + i, 3.5);
      paint(g, leafPaint(green, variant * 3 + i));
      parts.push(g);
    }
  } else {
    // palm: a leaning ringed trunk, a crown of drooping fronds, coconuts
    const H = 5.2 + r.next() * 0.8;
    const lean = 0.6 + r.next() * 0.5;
    const pts = [0, 0.3, 0.6, 1].map((t) => new THREE.Vector3(Math.sin(t * 1.4) * lean, t * H, 0));
    const trunk = tube(pts, 0.2, 14, 7, 0.65);
    paint(trunk, (p) => (Math.sin(p.y * 9) > 0.3 ? 0x8a6c48 : 0x6e5438));
    parts.push(trunk);
    const top = pts[3];
    const fronds = 8;
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * Math.PI * 2 + r.next() * 0.3;
      const len = 2.4 + r.next() * 0.6;
      const f = new THREE.PlaneGeometry(len, 0.7, 8, 2);
      const pos = f.attributes.position;
      for (let j = 0; j < pos.count; j++) {
        const x = pos.getX(j) + len / 2; // 0..len along the frond
        const y = pos.getY(j);
        const w = Math.sin((x / len) * Math.PI) * (0.55 + 0.25 * Math.sin(x * 9)); // leaflet zig-zag
        pos.setXYZ(j, x, -(x * x) * 0.16 + Math.abs(y) * 0.25, y * w);
      }
      const g = merge([f]);
      paint(g, (p) => (Math.abs(p.z) < 0.05 ? 0x6a7a30 : mix(0x4a8a30, 0x7aa83a, Math.min(1, p.x / len))));
      place(g, top.x, top.y, top.z, 0, a, 0.25);
      parts.push(g);
    }
    for (let i = 0; i < 3; i++) {
      const c = blob(0.16, 0.18, 0.16, 7, 5);
      place(c, top.x + Math.cos(i * 2.1) * 0.22, top.y - 0.2, Math.sin(i * 2.1) * 0.22);
      paint(c, 0x6a4a26);
      parts.push(c);
    }
  }
  const g = merge(parts);
  g.computeBoundingBox();
  const h = g.boundingBox!.max.y;
  setSway(g, swayBy(h * 0.25, h));
  return g;
}

export function stumpGeometry(): G {
  const s = lathe([[0.42, 0], [0.32, 0.15], [0.26, 0.45], [0.27, 0.5], [0.001, 0.52]], 10);
  paint(s, (p) => (p.y > 0.46 ? (Math.sin(Math.hypot(p.x, p.z) * 60) > 0 ? 0xd8b680 : 0xc49a62) : 0x5a4230));
  return s;
}

export function bushGeometry(variant: number): G {
  const parts: G[] = [];
  const r = rng(variant * 31 + 5);
  const green = [0x4f8236, 0x5c8a2e, 0x3f7a40][variant % 3];
  for (let i = 0; i < 4; i++) {
    const s = 0.45 + r.next() * 0.3;
    const g = blob(s, s * 0.8, s, 9, 7, s * 0.15, variant * 7 + i, 3);
    place(g, (r.next() - 0.5) * 0.8, s * 0.6, (r.next() - 0.5) * 0.8);
    paint(g, leafPaint(green, i + variant));
    parts.push(g);
  }
  if (variant % 3 === 1) {
    for (let i = 0; i < 5; i++) {
      const b = blob(0.06);
      place(b, (r.next() - 0.5) * 0.9, 0.6 + r.next() * 0.3, (r.next() - 0.5) * 0.9);
      paint(b, 0xc8323a);
      parts.push(b);
    }
  }
  const g = merge(parts);
  setSway(g, (p) => Math.min(1, p.y / 1.2) * 0.4);
  return g;
}

export function rockGeometry(variant: number): G {
  const r = rng(variant * 17 + 3);
  const g = blob(0.7 + r.next() * 0.5, 0.45 + r.next() * 0.3, 0.6 + r.next() * 0.4, 10, 8, 0.15, variant * 3, 1.8);
  g.translate(0, 0.15, 0);
  paint(g, (p, n) => (n.y > 0.75 ? 0x6e7d48 : Math.sin(p.x * 5 + p.z * 4) > 0.4 ? 0x8d8a83 : 0x7b786f));
  shade(g, (p) => 0.8 + 0.2 * Math.min(1, p.y + 0.3));
  setSway(g, () => 0);
  return g;
}

export function grassGeometry(variant: number): G {
  const parts: G[] = [];
  const r = rng(variant * 13 + 1);
  for (let i = 0; i < 3; i++) {
    const g = cross(0.5 + r.next() * 0.3, 0.45 + r.next() * 0.35);
    place(g, (r.next() - 0.5) * 0.4, 0, (r.next() - 0.5) * 0.4, 0, r.next() * 3, 0);
    parts.push(g);
  }
  const g = merge(parts);
  const base = [0x5e8a34, 0x7a9a3a, 0x6a8e44][variant % 3];
  paint(g, (p) => mix(tint(base, 0.55), tint(base, 1.3), Math.min(1, p.y / 0.6)));
  setSway(g, (p) => Math.min(1, p.y / 0.6));
  return g;
}

/** A flower patch variant of the grass tuft (a dash of colour in the meadows). */
export function flowerGeometry(variant: number): G {
  const g = grassGeometry(variant + 7);
  const r = rng(variant * 19);
  const parts: G[] = [g];
  for (let i = 0; i < 5; i++) {
    const f = blob(0.06, 0.04, 0.06, 6, 4);
    place(f, (r.next() - 0.5) * 0.5, 0.45 + r.next() * 0.2, (r.next() - 0.5) * 0.5);
    paint(f, [0xf2e05a, 0xf0f0f0, 0xd85a8a, 0x8a6ad8][variant % 4]);
    setSway(f, () => 1);
    parts.push(f);
  }
  return merge(parts);
}

/** Gallery helper: one of everything in a row. */
export function buildFloraPreview(): THREE.Group {
  const g = new THREE.Group();
  const mats = sharedMaterials();
  let x = -15;
  for (const s of SPECIES) {
    for (let v = 0; v < VARIANTS_PER_SPECIES; v++) {
      const m = new THREE.Mesh(treeGeometry(s, v), mats.foliage);
      m.position.set(x, 0, 0);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      x += 3.6;
    }
  }
  const extras: Array<[G, number]> = [[stumpGeometry(), 0], [bushGeometry(0), 1], [bushGeometry(1), 1], [rockGeometry(0), 0], [rockGeometry(1), 0], [grassGeometry(0), 1], [flowerGeometry(1), 1]];
  x = -9;
  for (const [geo, wind] of extras) {
    const m = new THREE.Mesh(geo, wind ? mats.foliage : mats.bark);
    m.position.set(x, 0, 4);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    x += 3;
  }
  return g;
}

void cyl; void cone;
