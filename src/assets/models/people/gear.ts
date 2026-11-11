/**
 * assets/models/people/gear.ts — tools, weapons and regalia.
 *
 * Gear is authored in its prop bone's local space, which is the hand's
 * space: with the arm hanging at rest, −Y runs down the fingers, +Z is
 * forward (the thumb side), +X is the figure's left. A fist grips a shaft
 * along Z, so a staff held with the forearm bent forward stands upright,
 * and a striking head should face −Y (the direction the swing travels).
 */

import * as THREE from 'three';
import { blob, capsule, cone, cyl, G, lathe, merge, mix, paint, place, rbox, shine, tint, torus, tube } from '../geometry';

const WOOD = 0x7a5532;
const WOOD_DARK = 0x55391f;
const STONE = 0x8d8a84;
const FLINT = 0x4c4f55;
const CORD = 0xcdb98a;

/** A shaft along +Z from z0 to z1. */
function shaft(r: number, z0: number, z1: number, color = WOOD, segs = 7): G {
  const g = cyl(r, r * 1.08, z1 - z0, segs);
  place(g, 0, 0, (z0 + z1) / 2, Math.PI / 2, 0, 0);
  paint(g, (p) => (Math.sin(p.z * 40) > 0.85 ? tint(color, 0.85) : color));
  return g;
}

/** Cord binding wraps around a shaft at z. */
function binding(r: number, z: number, n = 3, color = CORD): G[] {
  const out: G[] = [];
  for (let i = 0; i < n; i++) {
    const t = torus(r * 1.25, r * 0.35, 4, 10);
    place(t, 0, 0, z + i * r * 0.9);
    paint(t, color);
    out.push(t);
  }
  return out;
}

export function axe(): G {
  const parts: G[] = [shaft(0.028, -0.12, 0.62, WOOD)];
  const head = rbox(0.05, 0.2, 0.13, 0.015);
  // blade flares toward −Y
  const pos = head.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0) pos.setZ(i, pos.getZ(i) * (1 + (-y / 0.1) * 0.5));
    pos.setX(i, pos.getX(i) * (y < -0.05 ? 0.35 : 1));
  }
  head.computeVertexNormals();
  place(head, 0, -0.07, 0.56);
  paint(head, (p) => (p.y < -0.12 ? 0xb8b4aa : FLINT));
  parts.push(head, ...binding(0.03, 0.47, 2));
  return merge(parts);
}

export function hammer(): G {
  const parts: G[] = [shaft(0.026, -0.1, 0.48, WOOD)];
  const head = rbox(0.12, 0.2, 0.12, 0.03);
  place(head, 0, -0.02, 0.48);
  paint(head, STONE);
  parts.push(head, ...binding(0.03, 0.4, 2));
  return merge(parts);
}

/** The carried log, centred on the log bone, lying across the chest (along X). */
export function log(): G {
  const g = cyl(0.13, 0.14, 1.15, 9);
  place(g, 0, 0, 0, 0, 0, Math.PI / 2);
  paint(g, (p) => (Math.abs(p.x) > 0.56 ? 0xd8b680 : Math.sin(p.x * 25 + Math.atan2(p.y, p.z) * 3) > 0.5 ? 0x5a3e26 : 0x6e4c2e));
  const stub = capsule(0.04, 0.03, 0.14, 5);
  place(stub, 0.2, 0.1, 0.02, 0, 0, -0.8);
  paint(stub, 0x5a3e26);
  return merge([g, stub]);
}

export function spear(team: number, len = 2.5): G {
  const z0 = -0.85;
  const z1 = z0 + len;
  const parts: G[] = [shaft(0.03, z0, z1, WOOD)];
  // leaf-shaped flint tip
  const tip = lathe([[0.001, 0], [0.06, 0.08], [0.05, 0.2], [0.001, 0.32]], 6, 1, 0.35);
  place(tip, 0, 0, z1 - 0.02, Math.PI / 2, 0, 0);
  paint(tip, (p) => (p.y > 0.2 ? 0xc9c6bd : FLINT));
  parts.push(tip, ...binding(0.032, z1 - 0.1, 3));
  // pennant in team colour below the tip
  const flag = rbox(0.015, 0.16, 0.26, 0.006);
  place(flag, 0, -0.1, z1 - 0.32);
  paint(flag, team);
  parts.push(flag);
  // feathers hanging from the binding
  for (const sx of [1, -1]) {
    const f = blob(0.02, 0.09, 0.008, 5, 4);
    place(f, sx * 0.03, -0.1, z1 - 0.16, 0, 0, sx * 0.3);
    paint(f, (p) => (p.y < -0.06 ? 0x1c1a18 : 0xf0e8d8));
    parts.push(f);
  }
  return merge(parts);
}

/** Round hide shield facing −Y (forward in the guard pose). */
export function roundShield(team: number, trim: number, r = 0.36): G {
  const disc = lathe([[0.001, 0.05], [r * 0.5, 0.045], [r * 0.92, 0.02], [r, -0.01], [r * 0.95, -0.03], [0.001, -0.02]], 18);
  place(disc, 0, -0.06, 0.02);
  paint(disc, (p) => {
    const d = Math.hypot(p.x, p.z - 0.02);
    if (d > r * 0.88) return 0x5b3f26; // rawhide rim
    if (d < r * 0.22) return trim;
    const a = Math.atan2(p.x, p.z - 0.02);
    if (d < r * 0.62 && Math.abs(Math.sin(a * 3)) > 0.75) return trim;
    return team;
  });
  disc.rotateX(0); // axis already along Y
  // flip so the domed face is toward −Y
  disc.scale(1, -1, 1);
  flipWinding(disc);
  const boss = blob(r * 0.16, r * 0.1, r * 0.16, 8, 5);
  place(boss, 0, -0.12, 0.02);
  paint(boss, 0xd9cfb6);
  const rim = torus(r * 0.98, 0.02, 4, 24);
  place(rim, 0, -0.07, 0.02, Math.PI / 2, 0, 0);
  paint(rim, 0x4a3321);
  return merge([disc, boss, rim]);
}

/** A tall plank shield, held vertical along Z, facing −Y. */
export function towerShield(team: number, trim: number): G {
  const parts: G[] = [];
  const w = 0.78;
  const h = 1.55;
  const planks = 5;
  for (let i = 0; i < planks; i++) {
    const x = -w / 2 + (w / planks) * (i + 0.5);
    const p = rbox(w / planks - 0.008, 0.07, h - Math.abs(i - 2) * 0.05, 0.02);
    const curveZ = -(x * x) * 0.35; // curved toward the body
    place(p, x, -0.12 - curveZ, 0.08);
    paint(p, (q) => {
      // painted chevrons in team colour, trim band at top/bottom
      const zz = q.z - 0.08;
      if (Math.abs(zz) > h * 0.42) return trim;
      const chev = Math.abs(q.x) * 1.4 + zz;
      if (Math.floor(chev / 0.22) % 2 === 0) return team;
      return tint(team, 0.6);
    });
    parts.push(p);
  }
  for (const zz of [-h * 0.33, h * 0.33]) {
    const strap = rbox(w + 0.04, 0.03, 0.06, 0.01);
    place(strap, 0, -0.17, 0.08 + zz);
    paint(strap, 0x3c3a38);
    parts.push(strap);
  }
  const boss = blob(0.11, 0.06, 0.11, 8, 5);
  place(boss, 0, -0.2, 0.08);
  paint(boss, 0x9a9690);
  parts.push(boss);
  return merge(parts);
}

/** Stone maul: long haft, huge lashed stone head at +Z. */
export function maul(): G {
  const parts: G[] = [shaft(0.04, -0.35, 1.05, WOOD_DARK, 8)];
  const head = rbox(0.3, 0.26, 0.42, 0.07, 2);
  place(head, 0, 0, 1.02, 0, 0, 0);
  // knobbly: offset vertices a little
  const pos = head.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const n = Math.sin(i * 1.7) * 0.012;
    pos.setXYZ(i, pos.getX(i) + n, pos.getY(i) + n, pos.getZ(i));
  }
  head.computeVertexNormals();
  place(head, 0, 0, 0);
  paint(head, (p) => (Math.sin(p.x * 30 + p.z * 20) > 0.6 ? 0x76736d : STONE));
  parts.push(head);
  for (const zz of [0.92, 1.12]) {
    const t = torus(0.17, 0.025, 4, 14);
    place(t, 0, 0, zz);
    t.scale(1.05, 0.95, 1);
    paint(t, 0x4a3426);
    parts.push(t);
  }
  return merge(parts);
}

/** The ember pot: a clay pot on a short chain hanging from the hand, embers glowing. */
export function emberPot(): G {
  const parts: G[] = [];
  const chain = tube([new THREE.Vector3(0, 0, 0.01), new THREE.Vector3(0, -0.12, 0.0), new THREE.Vector3(0, -0.2, 0)], 0.008, 6, 4);
  paint(chain, 0x2a2420);
  parts.push(chain);
  const pot = lathe([[0.001, -0.42], [0.08, -0.41], [0.12, -0.34], [0.11, -0.25], [0.07, -0.21], [0.08, -0.2]], 12);
  paint(pot, (p) => (p.y > -0.26 ? 0x3a2a20 : p.y < -0.38 ? 0x4a3020 : 0x8a4a2c));
  // soot-licked holes glow
  shine(pot, 0xff7a20, 1.2, (p) => (p.y > -0.32 && p.y < -0.26 && Math.sin(Math.atan2(p.x, p.z) * 5) > 0.6 ? 1 : 0));
  parts.push(pot);
  const embers = blob(0.075, 0.04, 0.075, 8, 5, 0.012, 7, 30);
  place(embers, 0, -0.205, 0);
  paint(embers, 0xffb347);
  shine(embers, 0xff6a10, 3.2);
  parts.push(embers);
  return merge(parts);
}

/** A sling: two cords and a pouch dangling from the fist. */
export function sling(): G {
  const a = tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.02, -0.2, 0.02), new THREE.Vector3(0, -0.38, 0.03)], 0.008, 8, 4);
  const b = tube([new THREE.Vector3(0, 0, 0), new THREE.Vector3(-0.02, -0.2, -0.01), new THREE.Vector3(0, -0.38, -0.02)], 0.008, 8, 4);
  const pouch = blob(0.05, 0.035, 0.045, 7, 5);
  place(pouch, 0, -0.4, 0.005);
  for (const g of [a, b]) paint(g, CORD);
  paint(pouch, 0x5a3c26);
  const coal = blob(0.035, 0.035, 0.035, 6, 5);
  place(coal, 0, -0.38, 0.005);
  paint(coal, 0xffa040);
  shine(coal, 0xff5a10, 2.4);
  return merge([a, b, pouch, coal]);
}

export type StaffKind = 'chanter' | 'forest' | 'dynasty' | 'north';

/**
 * Staffs: the leader's symbol of office, held upright. Returns the shaft
 * geometry (on propR) and a separate head (on `charm`, at the staff top) so
 * the focus can sway and glow independently. `top` is the charm-bone Z.
 */
export function staff(kind: StaffKind, team: number, accent: number): { shaft: G; head: G; top: number } {
  const parts: G[] = [];
  const head: G[] = [];
  let top = 1.6;
  switch (kind) {
    case 'chanter': {
      top = 1.65;
      parts.push(shaft(0.03, -0.95, top + 0.12, 0x6a4a2c));
      // a bent-wood hoop strung with bells and charms (on the charm bone so they
      // swing). Staff-local +Z is UP when the staff is held upright, so things hang along −Z.
      const hoop = torus(0.2, 0.018, 5, 22);
      place(hoop, 0, 0, 0.0, Math.PI / 2, 0, 0);
      paint(hoop, 0x5a3e24);
      head.push(hoop);
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * (0.15 + (i / 5) * 0.7) + Math.PI;
        const hx = Math.cos(a) * 0.2;
        const hz = Math.sin(a) * 0.2 * -1;
        const len = 0.1 + (i % 2) * 0.08;
        const cord = cyl(0.006, 0.006, len, 3);
        place(cord, hx, 0, hz - len / 2, Math.PI / 2, 0, 0);
        paint(cord, CORD);
        const bell = i % 2 === 0 ? lathe([[0.001, 0.05], [0.025, 0.045], [0.04, 0.0], [0.045, -0.02]], 8) : blob(0.03, 0.012, 0.045, 6, 5);
        place(bell, hx, 0, hz - len - 0.02, i % 2 === 0 ? Math.PI / 2 : 0, 0, 0);
        paint(bell, i % 2 === 0 ? 0xd6a840 : i === 1 ? team : 0xe8dcc0);
        if (i % 2 === 0) shine(bell, 0xffc040, 0.25);
        head.push(cord, bell);
      }
      const knob = blob(0.06, 0.06, 0.08, 8, 6);
      place(knob, 0, 0, 0.24);
      paint(knob, team);
      head.push(knob);
      break;
    }
    case 'forest': {
      top = 1.7;
      // gnarled shaft: a wobbling tube
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const z = -1.0 + (i / 8) * (top + 1.0);
        pts.push(new THREE.Vector3(Math.sin(i * 1.9) * 0.025, Math.cos(i * 1.3) * 0.02, z));
      }
      const s = tube(pts, 0.04, 20, 6, 0.8);
      paint(s, (p) => (Math.sin(p.z * 22) > 0.7 ? 0x4a3420 : 0x6e5030));
      parts.push(s);
      // roots curling round the orb
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const root = tube([
          new THREE.Vector3(0, 0, -0.18),
          new THREE.Vector3(Math.cos(a) * 0.16, Math.sin(a) * 0.16, 0.0),
          new THREE.Vector3(Math.cos(a + 0.6) * 0.1, Math.sin(a + 0.6) * 0.1, 0.17),
          new THREE.Vector3(Math.cos(a + 1.2) * 0.02, Math.sin(a + 1.2) * 0.02, 0.24),
        ], 0.018, 10, 4, 0.4);
        paint(root, 0x5a4028);
        head.push(root);
      }
      const orb = blob(0.12, 0.12, 0.12, 12, 9);
      paint(orb, mix(accent, 0xffffff, 0.4));
      shine(orb, accent, 3.5);
      head.push(orb);
      // dangling feathers
      for (const sx of [1, -1]) {
        const f = blob(0.025, 0.11, 0.008, 5, 4);
        place(f, sx * 0.1, 0, -0.32, 0, 0, sx * 0.2);
        paint(f, (p) => (p.y < -0.07 ? team : 0xf2ead8));
        head.push(f);
      }
      break;
    }
    case 'dynasty': {
      top = 1.75;
      const s = shaft(0.032, -1.0, top - 0.1, 0x2c2420);
      // gold bands
      parts.push(s);
      for (let i = 0; i < 6; i++) {
        const band = torus(0.036, 0.012, 4, 10);
        place(band, 0, 0, -0.6 + i * 0.42);
        paint(band, 0xe6b84a);
        parts.push(band);
      }
      // sun disc: a ring with a glowing centre, standing in the XZ plane? face forward (−Y is fwd in rest; staff upright → face +Y/−Y)
      const ring = torus(0.2, 0.035, 6, 22);
      place(ring, 0, 0, 0.14, Math.PI / 2, 0, 0);
      paint(ring, 0xf0c75e);
      head.push(ring);
      const disc = cyl(0.15, 0.15, 0.03, 18);
      place(disc, 0, 0, 0.14);
      paint(disc, 0xffe8a0);
      shine(disc, accent, 3.2);
      head.push(disc);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const ray = cone(0.03, 0.12, 4);
        // cone points +Y; Rz(−π/2) turns it to +X, then Ry(−a) fans it round the disc
        place(ray, Math.cos(a) * 0.27, 0, 0.14 + Math.sin(a) * 0.27, 0, -a, -Math.PI / 2);
        paint(ray, 0xf0c75e);
        head.push(ray);
      }
      const neck = lathe([[0.03, -0.12], [0.07, -0.06], [0.05, 0.0]], 10);
      place(neck, 0, 0, -0.06, Math.PI / 2, 0, 0);
      paint(neck, 0xe6b84a);
      head.push(neck);
      break;
    }
    case 'north': {
      top = 1.7;
      const s = shaft(0.036, -1.0, top - 0.05, 0x5a4a3a);
      paint(s, (p) => (Math.abs(Math.sin(p.z * 9)) > 0.93 ? 0x9ad0e0 : 0x5a4a3a)); // carved runes
      shine(s, accent, 0.9, (p) => (Math.abs(Math.sin(p.z * 9)) > 0.93 ? 1 : 0));
      parts.push(s);
      // iron fork cradling a crystal
      for (const sx of [1, -1]) {
        const prong = tube([
          new THREE.Vector3(0, 0, -0.12), new THREE.Vector3(sx * 0.1, 0, 0.0), new THREE.Vector3(sx * 0.08, 0, 0.18),
        ], 0.016, 8, 4);
        paint(prong, 0x5c6066);
        head.push(prong);
      }
      const crystal = lathe([[0.001, -0.14], [0.08, -0.02], [0.07, 0.12], [0.001, 0.3]], 6);
      place(crystal, 0, 0, 0.04, Math.PI / 2, 0, 0);
      paint(crystal, mix(accent, 0xffffff, 0.5));
      shine(crystal, accent, 3.4);
      head.push(crystal);
      // wolf-tooth charms
      for (const sx of [1, -1]) {
        const tooth = cone(0.018, 0.08, 5);
        place(tooth, sx * 0.08, 0, -0.18, Math.PI, 0, 0);
        paint(tooth, 0xf0ead8);
        head.push(tooth);
      }
      break;
    }
  }
  return { shaft: merge(parts), head: merge(head), top };
}

function flipWinding(geo: G): void {
  const idx = geo.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  geo.computeVertexNormals();
}
