/**
 * assets/models/boats.ts — raiders' boats.
 *
 * An original, simple design: a long, shallow plank hull with a high
 * curled stem and stern post, a row of painted hide shields along each
 * side, a single mast with a square sail in the tribe's colour (a pale
 * band and a dark eye painted across it), and a few oars. Bow is +Z,
 * waterline y = 0, about 7 world units long (a villager is ~2.3).
 *
 * Geometry is built once per (tribe colour, variant) and shared; each
 * boat is a Group of two meshes (hull: shared matte material; sail:
 * double-sided). The caller curves it (curveObject) like any model.
 */

import * as THREE from 'three';
import { blob, box, cyl, merge, paint, panel, place, tube, warp } from './geometry';
import { modelMaterial, sharedMaterials } from './materials';

const LEN = 3.5; // half-length of the hull

const cache = new Map<string, { hull: THREE.BufferGeometry; sail: THREE.BufferGeometry }>();
let sailMat: THREE.MeshStandardMaterial | null = null;

function parts(color: number, variant: number) {
  const key = `${color}|${variant}`;
  let p = cache.get(key);
  if (p) return p;
  const wood = variant % 2 ? 0x5e3e26 : 0x6b4a2e;
  const dark = 0x3a2616;
  // Hull: a stretched blob, flattened into a deck above the waterline and
  // swept up at both ends.
  const hull = warp(blob(1.05, 0.62, LEN, 18, 10), (q) => {
    const end = Math.pow(Math.abs(q.z) / LEN, 3);
    const top = q.y > 0 ? -q.y * 0.55 : 0;
    return [-q.x * end * 0.5, top + end * 0.9 + 0.05, 0];
  });
  paint(hull, (q) => (Math.sin(q.y * 26) > 0.82 ? dark : q.y > 0.3 ? 0x8a6a46 : wood));
  // Stem and stern posts curling inward.
  const stem = tube([
    new THREE.Vector3(0, 0.6, LEN * 0.92), new THREE.Vector3(0, 1.5, LEN * 1.05),
    new THREE.Vector3(0, 2.15, LEN * 0.98), new THREE.Vector3(0, 2.2, LEN * 0.82),
  ], 0.13, 10, 6, 0.55);
  paint(stem, wood);
  const stern = tube([
    new THREE.Vector3(0, 0.6, -LEN * 0.92), new THREE.Vector3(0, 1.3, -LEN * 1.03), new THREE.Vector3(0, 1.75, -LEN * 0.96),
  ], 0.12, 8, 6, 0.6);
  paint(stern, wood);
  // Shields along both rails, alternating the tribe colour and ochre.
  const shields: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const z = -LEN * 0.6 + i * (LEN * 1.2) / 4;
    for (const s of [-1, 1]) {
      const sh = place(cyl(0.3, 0.3, 0.06, 10), s * 0.78, 0.48, z, 0, 0, Math.PI / 2);
      paint(sh, (q) => (Math.hypot(q.y - 0.48, q.z - z) < 0.09 ? 0xd8c8a0 : (i + (s > 0 ? 1 : 0)) % 2 ? color : 0xc8962e));
      shields.push(sh);
    }
  }
  // Oars, angled out and down.
  const oars: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      const z = -LEN * 0.35 + i * LEN * 0.35;
      // a bar along x, its outer end dipped toward the water
      const o2 = place(box(2.6, 0.07, 0.12), s * 1.85, 0.2, z, 0, 0, -s * 0.38);
      paint(o2, 0x7a5a38);
      oars.push(o2);
    }
  }
  const mast = place(cyl(0.09, 0.12, 4.6, 8), 0, 2.4, 0.3);
  paint(mast, dark);
  const yard = place(cyl(0.06, 0.06, 3.6, 6), 0, 4.1, 0.3, 0, 0, Math.PI / 2);
  paint(yard, dark);
  const hullGeo = merge([hull, stem, stern, ...shields, ...oars, mast, yard]);
  // Sail: square, bellied forward, hanging from the yard.
  const pale = new THREE.Color(color).lerp(new THREE.Color(0xf4ead2), 0.65).getHex();
  const shadeC = new THREE.Color(color).multiplyScalar(0.45).getHex();
  const sail = place(panel(3.3, 2.7, 8, 8, -0.09, 0.03), 0, 4.05, 0.42);
  paint(sail, (q) => {
    const y = q.y - 2.7;
    const eye = Math.hypot(q.x * 0.8, (y - 0.15) * 1.6);
    if (eye < 0.28) return shadeC;
    if (eye < 0.4) return pale;
    if (Math.abs(y - 0.15) < 0.16) return pale;
    return color;
  });
  p = { hull: hullGeo, sail };
  cache.set(key, p);
  return p;
}

/** A boat in `color` (variant picks the wood tone). Bow +Z, waterline y = 0. */
export function buildBoat(color: number, variant = 0): THREE.Group {
  const p = parts(color, variant % 2);
  const root = new THREE.Group();
  const hull = new THREE.Mesh(p.hull, sharedMaterials().matte);
  hull.castShadow = hull.receiveShadow = true;
  sailMat ??= modelMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  const sail = new THREE.Mesh(p.sail, sailMat);
  sail.castShadow = true;
  sail.name = 'sail';
  root.add(hull, sail);
  return root;
}
