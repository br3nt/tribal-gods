/**
 * assets/models/buildings/kit.ts — architecture as a box of parts.
 *
 * A building is collected into a Kit: lists of geometry for the shared
 * surfaces (matte body, glossy trim, wind-blown cloth) plus emitter points
 * for chimney smoke and fire. kit.ts holds the civ-neutral pieces (posts,
 * planks, log piles, banners, doors, windows) and the three civ styles:
 *
 *   forest  — round wattle-and-daub walls under deep layered thatch cones
 *   dynasty — sandstone blocks, stepped flat roofs, painted lintels, gold
 *   north   — log walls on stone footings, steep gabled roofs, carved
 *             crossed gable horns
 *
 * `house(kit, civ, w, d, h)` builds the civ's core structure for a
 * footprint; every building kind composes one or more houses and adds its
 * own props. That's how all eight kinds get per-civ architecture without
 * eight × three hand-written models.
 *
 * Coordinates: origin at the footprint centre on the ground, +Z is the door
 * side (the sim's door is on the south edge, which is +Z in world space).
 */

import * as THREE from 'three';
import { Civ } from '../../../config';
import {
  blob, box, cone, cyl, displace, G, lathe, merge, mix, paint, place, rbox, setSway, shine, tint, torus, tube,
} from '../geometry';
import { Rng } from '../rng';

export interface Kit {
  body: G[];
  gloss: G[];
  cloth: G[];
  smoke: THREE.Vector3[];
  fire: THREE.Vector3[];
  /** Always-lit flames (braziers, altar fires). */
  flames: THREE.Vector3[];
  /** Points that glow warm (windows/doors) — used for flicker lights later. */
  glow: THREE.Vector3[];
  rng: Rng;
  team: number;
  civ: Civ;
}

export const WOOD = 0x7a5534;
export const WOOD_DARK = 0x4e3520;
export const WOOD_LIGHT = 0xa47a4c;
export const STONE = 0x9a958c;
export const STONE_DARK = 0x6f6a62;
export const THATCH = 0xc9a24f;
export const WARM = 0xffb25a;

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

export function post(k: Kit, x: number, z: number, h: number, r = 0.12, color = WOOD, y0 = 0): void {
  const g = cyl(r * 0.9, r, h, 7);
  place(g, x, y0 + h / 2, z);
  paint(g, (p) => (Math.sin(p.y * 13 + x * 5) > 0.7 ? tint(color, 0.85) : color));
  k.body.push(g);
}

/** A plank/beam between two points. */
export function beam(k: Kit, a: THREE.Vector3, b: THREE.Vector3, w = 0.12, h = 0.12, color = WOOD): void {
  const len = a.distanceTo(b);
  const g = rbox(w, h, len, 0.02, 1);
  const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0));
  if (Math.abs(b.x - a.x) < 1e-4 && Math.abs(b.z - a.z) < 1e-4) m.lookAt(a, b, new THREE.Vector3(1, 0, 0));
  g.applyMatrix4(m);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  paint(g, color);
  k.body.push(g);
}

/** Stack of logs lying along X. */
export function logPile(k: Kit, x: number, z: number, rows = 3, len = 1.8, r = 0.17, rotY = 0): void {
  const parts: G[] = [];
  for (let row = 0; row < rows; row++) {
    const n = rows - row + 1;
    for (let i = 0; i < n; i++) {
      const g = cyl(r, r, len * (0.9 + 0.2 * k.rng.next()), 8);
      place(g, 0, r + row * r * 1.75, (i - (n - 1) / 2) * r * 2.02, 0, 0, Math.PI / 2);
      paint(g, (p) => (Math.abs(p.x) > len * 0.43 ? 0xd9b67e : Math.sin(Math.atan2(p.y, p.z) * 5 + p.x * 9) > 0.4 ? 0x5e4028 : 0x74512f));
      parts.push(g);
    }
  }
  const g = merge(parts);
  place(g, x, 0, z, 0, rotY, 0);
  k.body.push(g);
}

/** Door: frame + dark opening + plank leaf, on the +Z face at z. */
export function door(k: Kit, x: number, z: number, w = 0.9, h = 1.5, frame = WOOD_DARK, glowK = 0.35, rotY = 0): void {
  const parts: G[] = [];
  const hole = rbox(w, h, 0.12, 0.03);
  place(hole, 0, h / 2, 0);
  paint(hole, 0x2a1c12);
  shine(hole, WARM, glowK, (p) => (p.y < h * 0.7 ? 1 : 0.4));
  parts.push(hole);
  for (const sx of [-1, 1]) {
    const jamb = rbox(0.14, h + 0.1, 0.18, 0.03);
    place(jamb, sx * (w / 2 + 0.06), h / 2, 0.02);
    paint(jamb, frame);
    parts.push(jamb);
  }
  const lintel = rbox(w + 0.4, 0.18, 0.22, 0.04);
  place(lintel, 0, h + 0.08, 0.03);
  paint(lintel, frame);
  parts.push(lintel);
  const g = merge(parts);
  place(g, x, 0, z, 0, rotY, 0);
  k.body.push(g);
  k.glow.push(v3(x, h * 0.5, z));
}

/** A small glowing window with shutters, facing along the given yaw. */
export function windowAt(k: Kit, x: number, y: number, z: number, rotY: number, w = 0.42, h = 0.38): void {
  const parts: G[] = [];
  const pane = rbox(w, h, 0.1, 0.02);
  paint(pane, 0x3a2410);
  shine(pane, WARM, 1.4);
  parts.push(pane);
  const frame = rbox(w + 0.14, 0.08, 0.16, 0.02);
  place(frame, 0, -h / 2 - 0.04, 0.02);
  paint(frame, WOOD_DARK);
  parts.push(frame);
  for (const sx of [-1, 1]) {
    const sh = rbox(w * 0.45, h + 0.06, 0.04, 0.01);
    place(sh, sx * (w * 0.75), 0, 0.04, 0, sx * 0.5, 0);
    paint(sh, WOOD);
    parts.push(sh);
  }
  const g = merge(parts);
  place(g, x, y, z, 0, rotY, 0);
  k.body.push(g);
  k.glow.push(v3(x, y, z));
}

/** A team banner on a pole. Cloth goes to the wind-blown list. */
export function banner(k: Kit, x: number, z: number, h = 4, w = 0.7, len = 1.4, rotY = 0, emblem = 0xf0e6cc): void {
  post(k, x, z, h, 0.06, WOOD_DARK);
  const knob = blob(0.1, 0.1, 0.1, 8, 6);
  place(knob, x, h + 0.05, z);
  paint(knob, 0xd8b048);
  k.gloss.push(knob);
  // cross-bar + hanging cloth with a swallow-tail
  const bar = cyl(0.03, 0.03, w + 0.2, 5);
  place(bar, x, h - 0.15, z, 0, rotY, Math.PI / 2);
  paint(bar, WOOD_DARK);
  k.body.push(bar);
  const cloth = new THREE.PlaneGeometry(w, len, 3, 6);
  cloth.translate(0, -len / 2, 0);
  const pos = cloth.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const yy = pos.getY(i);
    const xx = pos.getX(i);
    if (yy < -len * 0.85) pos.setY(i, yy + (1 - Math.abs(xx) / (w / 2)) * len * 0.15); // swallow-tail
  }
  const g = clean2(cloth);
  paint(g, (p) => {
    const cy = -len * 0.42;
    const d = Math.hypot(p.x, p.y - cy);
    if (d < w * 0.22) return emblem;
    if (p.y > -0.12) return tint(k.team, 0.7);
    return k.team;
  });
  setSway(g, (p) => Math.min(1, -p.y / len) * 1.2);
  place(g, x, h - 0.15, z + 0.05, 0, rotY, 0);
  k.cloth.push(g);
}

function clean2(g: THREE.BufferGeometry): G {
  // route through merge() normalisation
  return merge([g]);
}

/** A ring of rope-tied stakes marking a building plot (shown while it's a site). */
export function stakes(k: Kit, half: number): G {
  const parts: G[] = [];
  const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
  for (const [x, z] of corners) {
    const s = cyl(0.05, 0.07, 0.9, 5);
    place(s, x, 0.45, z, 0.08 * Math.sign(z), 0, -0.08 * Math.sign(x));
    paint(s, WOOD_LIGHT);
    parts.push(s);
    const tipC = cone(0.08, 0.15, 5);
    place(tipC, x, 0.95, z);
    paint(tipC, k.team);
    parts.push(tipC);
  }
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i];
    const [bx, bz] = corners[(i + 1) % 4];
    const rope = tube([v3(ax, 0.75, az), v3((ax + bx) / 2, 0.62, (az + bz) / 2), v3(bx, 0.75, bz)], 0.015, 8, 3);
    paint(rope, 0xd8c79a);
    parts.push(rope);
  }
  // dug earth patch
  const dirt = cyl(half * 1.25, half * 1.3, 0.12, 20);
  place(dirt, 0, 0.0, 0, 0, 0, 0, 1, 1, 1);
  paint(dirt, (p) => (Math.sin(p.x * 3 + p.z * 4) > 0.3 ? 0x7a5e3e : 0x8a6c48));
  dirt.scale(1, 1, 1);
  parts.push(dirt);
  return merge(parts);
}

/** Scaffolding cage around a box (poles, ledgers, diagonal braces). */
export function scaffold(half: number, h: number, seed: number): G {
  const parts: G[] = [];
  const pole = (x: number, z: number) => {
    const g = cyl(0.05, 0.06, h + 0.6, 5);
    place(g, x, (h + 0.6) / 2, z);
    paint(g, 0xb8915c);
    parts.push(g);
  };
  const n = Math.max(2, Math.round(half / 1.1));
  const H = half + 0.35;
  for (let i = 0; i <= n; i++) {
    const t = -H + (2 * H * i) / n;
    pole(t, H); pole(t, -H); if (i > 0 && i < n) { pole(H, t); pole(-H, t); }
  }
  for (let y = 1.2; y < h; y += 1.4) {
    for (const [a, b] of [[[-H, H], [H, H]], [[-H, -H], [H, -H]], [[H, -H], [H, H]], [[-H, -H], [-H, H]]]) {
      const g = rbox(0.06, 0.06, 2 * H, 0.01, 1);
      const horizontalX = a[1] === b[1];
      place(g, (a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, 0, horizontalX ? Math.PI / 2 : 0, 0);
      paint(g, 0xa58252);
      parts.push(g);
      // walk boards
      const plank = rbox(horizontalX ? 2 * H : 0.4, 0.05, horizontalX ? 0.4 : 2 * H, 0.01, 1);
      place(plank, (a[0] + b[0]) / 2 * (horizontalX ? 1 : 0.92), y + 0.04, (a[1] + b[1]) / 2 * (horizontalX ? 0.92 : 1));
      paint(plank, 0xc29a62);
      parts.push(plank);
    }
  }
  // diagonal braces on the front and back
  for (const zz of [H, -H]) {
    const g = tube([v3(-H, 0.1, zz), v3(H, Math.min(h, 2.6), zz)], 0.035, 2, 4);
    paint(g, 0x9a7646);
    parts.push(g);
  }
  void seed;
  return merge(parts);
}

/** Rubble and broken planks for the damaged state. */
export function rubble(half: number, rng: Rng, color = STONE): G {
  const parts: G[] = [];
  for (let i = 0; i < 9; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = half * (0.75 + rng.next() * 0.4);
    if (i % 2) {
      const g = blob(0.25 + rng.next() * 0.2, 0.15, 0.22, 6, 4, 0.05, i, 3);
      place(g, Math.cos(a) * r, 0.08, Math.sin(a) * r);
      paint(g, tint(color, 0.8 + rng.next() * 0.3));
      parts.push(g);
    } else {
      const g = rbox(0.12, 0.06, 1.0 + rng.next(), 0.01, 1);
      place(g, Math.cos(a) * r, 0.1, Math.sin(a) * r, 0.1, rng.next() * 3, 0.15);
      paint(g, 0x3a2a1c);
      parts.push(g);
    }
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Civ cores
// ---------------------------------------------------------------------------

export interface HouseOpts {
  /** Door on the +Z face (default true). */
  door?: boolean;
  windows?: number;
  /** Chimney / smoke hole. */
  smoke?: boolean;
  /** Roof colour override (e.g. soot-black, hide). */
  roof?: number;
  wall?: number;
  /** Centre offset. */
  x?: number;
  z?: number;
  /** Extra roof height factor. */
  steep?: number;
}

/** Ground plinth that hides the seam with the terrain. */
export function plinth(k: Kit, w: number, d: number, color: number, round = false, x = 0, z = 0): void {
  const g = round ? cyl(w / 2 + 0.25, w / 2 + 0.45, 1.2, 20) : rbox(w + 0.5, 1.2, d + 0.5, 0.15, 2);
  place(g, x, -0.48, z);
  paint(g, (p) => (Math.sin(p.x * 5 + p.z * 7) > 0.5 ? tint(color, 0.9) : color));
  k.body.push(g);
}

/** The civ's core structure for a w×d footprint, wall height h. Returns roof apex height. */
export function house(k: Kit, w: number, d: number, h: number, o: HouseOpts = {}): number {
  switch (k.civ.roof) {
    case 'thatch': return roundhouse(k, Math.min(w, d) / 2, h, o);
    case 'stepped': return blockhouse(k, w, d, h, o);
    default: return longhall(k, w, d, h, o);
  }
}

function roundhouse(k: Kit, r: number, h: number, o: HouseOpts): number {
  const x = o.x ?? 0;
  const z = o.z ?? 0;
  const wall = o.wall ?? k.civ.wallColor;
  plinth(k, r * 2, r * 2, 0x7a6a50, true, x, z);
  // daub wall with a painted team band and a darker skirt of splashed mud
  const w = lathe([[r * 1.02, 0], [r, 0.3], [r * 0.98, h * 0.6], [r * 0.97, h]], 24);
  paint(w, (p) => {
    if (p.y < 0.35) return tint(wall, 0.72);
    if (Math.abs(p.y - h * 0.62) < 0.1) return k.team;
    if (Math.abs(p.y - h * 0.62) < 0.16 && Math.sin(Math.atan2(p.x, p.z) * 16) > 0) return k.team;
    return Math.sin(p.y * 9 + Math.atan2(p.x, p.z) * 4) > 0.8 ? tint(wall, 0.9) : wall;
  });
  place(w, x, 0, z);
  k.body.push(w);
  // timber posts set into the wall
  const n = Math.round(r * 3.2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.2;
    if (Math.abs(Math.sin(a / 2)) < 0.12) continue; // keep the door clear (+Z, a≈0)
    post(k, x + Math.sin(a) * (r + 0.02), z + Math.cos(a) * (r + 0.02), h + 0.15, 0.11, WOOD_DARK);
  }
  if (o.door !== false) door(k, x, z + r - 0.02, 0.85, Math.min(1.6, h * 0.82));
  const win = o.windows ?? 2;
  for (let i = 0; i < win; i++) {
    const a = (i % 2 ? 1 : -1) * (1.1 + Math.floor(i / 2) * 1.2);
    windowAt(k, x + Math.sin(a) * (r + 0.02), h * 0.62, z + Math.cos(a) * (r + 0.02), a, 0.36, 0.32);
  }
  // thatch: a layered cone with a deep overhang; rings of bundled straw
  const roofH = r * 1.25 * (o.steep ?? 1);
  const over = 0.55;
  const prof: Array<[number, number]> = [];
  const rings = 6;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const rr = (r + over) * (1 - t) + 0.12 * t;
    prof.push([rr, h - 0.25 + roofH * t]);
    if (i < rings) prof.push([rr * 0.97 - 0.05, h - 0.25 + roofH * (t + 0.02)]);
  }
  const roof = lathe(prof, 26);
  displace(roof, 0.04, k.rng.int(999), 4);
  const roofC = o.roof ?? k.civ.roofColor;
  paint(roof, (p) => {
    const s = Math.sin(Math.atan2(p.x, p.z) * 40 + p.y * 3);
    const base = s > 0.5 ? tint(roofC, 1.1) : s < -0.6 ? tint(roofC, 0.85) : roofC;
    return p.y < h - 0.1 ? tint(base, 0.78) : base;
  });
  place(roof, x, 0, z);
  k.body.push(roof);
  // underside of the eaves (so the overhang isn't see-through from below)
  const under = cyl(r + over, r * 0.9, 0.1, 24);
  place(under, x, h - 0.3, z);
  paint(under, tint(roofC, 0.55));
  k.body.push(under);
  // top knot + team finial
  const knot = torus(0.2, 0.08, 6, 12);
  place(knot, x, h - 0.25 + roofH * 0.95, z, Math.PI / 2, 0, 0);
  paint(knot, tint(roofC, 0.7));
  k.body.push(knot);
  const fin = cone(0.14, 0.7, 6);
  place(fin, x, h - 0.25 + roofH + 0.25, z);
  paint(fin, k.team);
  k.body.push(fin);
  if (o.smoke !== false) k.smoke.push(v3(x, h - 0.25 + roofH, z));
  k.fire.push(v3(x, h + roofH * 0.4, z), v3(x + r * 0.5, h * 0.6, z));
  return h - 0.25 + roofH + 0.6;
}

function blockhouse(k: Kit, w: number, d: number, h: number, o: HouseOpts): number {
  const x = o.x ?? 0;
  const z = o.z ?? 0;
  const wall = o.wall ?? k.civ.wallColor;
  plinth(k, w, d, 0xb39a70, false, x, z);
  // sandstone block walls: course lines painted in
  const body = rbox(w, h, d, 0.12, 2);
  place(body, x, h / 2, z);
  paint(body, (p) => {
    const course = Math.floor(p.y / 0.42);
    const off = course % 2 ? 0.45 : 0;
    const joint = Math.abs(((p.y + 0.0) % 0.42)) < 0.035 || Math.abs((((p.x + p.z + off) % 0.9) + 0.9) % 0.9) < 0.035;
    if (p.y > h - 0.32) return k.team; // painted frieze
    return joint ? tint(wall, 0.82) : course % 3 === 0 ? tint(wall, 1.05) : wall;
  });
  k.body.push(body);
  // cornice
  const cornice = rbox(w + 0.35, 0.2, d + 0.35, 0.05);
  place(cornice, x, h + 0.08, z);
  paint(cornice, tint(wall, 1.08));
  k.body.push(cornice);
  // stepped roof terraces
  const steps = 3;
  let y = h + 0.18;
  let sw = w;
  let sd = d;
  const roofC = o.roof ?? k.civ.roofColor;
  for (let i = 0; i < steps; i++) {
    sw *= 0.72;
    sd *= 0.72;
    const sh = 0.5 * (o.steep ?? 1);
    const s = rbox(sw, sh, sd, 0.06);
    place(s, x, y + sh / 2, z);
    paint(s, (p) => (p.y > sh / 2 - 0.08 ? tint(roofC, 1.1) : i === steps - 1 ? k.team : roofC));
    k.body.push(s);
    y += sh;
  }
  // gold capstone
  const cap = cone(Math.min(sw, sd) * 0.35, 0.6, 4);
  place(cap, x, y + 0.3, z, 0, Math.PI / 4, 0);
  paint(cap, 0xe8bb4a);
  k.gloss.push(cap);
  // portico: two columns and a painted lintel framing the door
  if (o.door !== false) {
    const dz = z + d / 2;
    door(k, x, dz + 0.02, 0.9, Math.min(1.7, h * 0.7), 0x8a6a40);
    for (const sx of [-1, 1]) {
      const col = lathe([[0.2, 0], [0.16, 0.2], [0.15, h * 0.85], [0.22, h * 0.9], [0.22, h * 0.95]], 10);
      place(col, x + sx * 0.95, 0, dz + 0.35);
      paint(col, (p) => (p.y > h * 0.86 ? 0xe8bb4a : tint(wall, 1.1)));
      k.body.push(col);
    }
    const lintel = rbox(2.5, 0.3, 0.55, 0.04);
    place(lintel, x, h * 0.97, dz + 0.3);
    paint(lintel, (p) => (Math.abs(p.y) < 0.06 ? 0xe8bb4a : k.team));
    k.body.push(lintel);
  }
  const win = o.windows ?? 2;
  for (let i = 0; i < win; i++) {
    const side = i % 2 ? 1 : -1;
    windowAt(k, x + side * (w / 2 + 0.02), h * 0.55, z + (Math.floor(i / 2) - 0.0) * 0.8 - 0.2, side * Math.PI / 2, 0.32, 0.5);
  }
  if (o.smoke !== false) k.smoke.push(v3(x + w * 0.25, y, z - d * 0.2));
  k.fire.push(v3(x, h + 0.5, z), v3(x - w * 0.3, h * 0.5, z + d * 0.3));
  return y + 0.6;
}

function longhall(k: Kit, w: number, d: number, h: number, o: HouseOpts): number {
  const x = o.x ?? 0;
  const z = o.z ?? 0;
  const wall = o.wall ?? k.civ.wallColor;
  // stone footing
  const foot = rbox(w + 0.3, 0.7, d + 0.3, 0.1, 2);
  place(foot, x, 0.0, z);
  displace(foot, 0.04, 5, 3);
  paint(foot, (p) => (Math.sin(p.x * 6) * Math.sin(p.z * 6) > 0.2 ? STONE_DARK : STONE));
  k.body.push(foot);
  plinth(k, w, d, STONE_DARK, false, x, z);
  // log walls: horizontal logs along each side
  const logs = Math.max(3, Math.round(h / 0.32));
  const lr = h / logs / 2;
  for (let i = 0; i < logs; i++) {
    const y = 0.35 + lr + i * lr * 2;
    if (y > h) break;
    for (const [lx, lz, len, ry] of [[x, z + d / 2, w, 0], [x, z - d / 2, w, 0], [x + w / 2, z, d, Math.PI / 2], [x - w / 2, z, d, Math.PI / 2]] as const) {
      const g = cyl(lr * 1.05, lr * 1.05, len + 0.35, 7);
      place(g, lx, y, lz, 0, ry, Math.PI / 2);
      paint(g, (p) => (Math.abs(p.x) > len / 2 + 0.05 ? 0xc9a070 : i % 2 ? wall : tint(wall, 0.9)));
      k.body.push(g);
    }
  }
  // fill behind the logs (no light leaks)
  const core = box(w - 0.1, h, d - 0.1);
  place(core, x, h / 2, z);
  paint(core, tint(wall, 0.6));
  k.body.push(core);
  // steep gabled roof: a prism along X with turf-dark shingles
  const roofH = Math.max(w, d) * 0.55 * (o.steep ?? 1);
  const roofC = o.roof ?? k.civ.roofColor;
  const over = 0.45;
  const half = d / 2 + over;
  const len = w + over * 2;
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0);
  shape.lineTo(0, roofH);
  shape.lineTo(half, 0);
  shape.lineTo(half - 0.25, 0);
  shape.lineTo(0, roofH - 0.3);
  shape.lineTo(-half + 0.25, 0);
  shape.closePath();
  const ext = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false, steps: 1 });
  ext.translate(0, 0, -len / 2);
  ext.rotateY(Math.PI / 2);
  const roof = merge([ext]);
  paint(roof, (p) => {
    const row = Math.floor((roofH - p.y) / 0.28);
    const sh = Math.sin(p.x * 9 + row * 1.7) > 0.3;
    return sh ? tint(roofC, 1.12) : row % 2 ? roofC : tint(roofC, 0.9);
  });
  place(roof, x, h - 0.1, z);
  k.body.push(roof);
  // gable ends (triangles) in planks + team paint
  for (const sx of [-1, 1]) {
    const tri = new THREE.Shape();
    tri.moveTo(-d / 2, 0);
    tri.lineTo(0, roofH - 0.3);
    tri.lineTo(d / 2, 0);
    tri.closePath();
    const g = merge([new THREE.ShapeGeometry(tri)]);
    g.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
    place(g, x + sx * (w / 2 + 0.05), h - 0.1, z);
    paint(g, (p) => (p.y < 0.5 && Math.abs(p.z - z) < d * 0.12 ? k.team : Math.sin(p.z * 14) > 0.6 ? tint(WOOD, 0.8) : WOOD));
    k.body.push(g);
    // crossed carved gable horns
    for (const s2 of [-1, 1]) {
      const horn = tube([
        v3(x + sx * (w / 2 + over), h - 0.1 + roofH - 0.35, z + s2 * 0.25),
        v3(x + sx * (w / 2 + over + 0.1), h - 0.1 + roofH + 0.35, z - s2 * 0.25),
        v3(x + sx * (w / 2 + over + 0.25), h - 0.1 + roofH + 0.75, z - s2 * 0.55),
      ], 0.07, 8, 5, 0.4);
      paint(horn, WOOD_DARK);
      k.body.push(horn);
    }
  }
  if (o.door !== false) door(k, x, z + d / 2 + 0.12, 0.95, Math.min(1.7, h * 0.85), WOOD_DARK);
  const win = o.windows ?? 2;
  for (let i = 0; i < win; i++) {
    const side = i % 2 ? 1 : -1;
    windowAt(k, x + side * (w * 0.3), h * 0.6, z + d / 2 + 0.15, 0, 0.36, 0.3);
  }
  // team shields hung on the long wall
  for (const sx of [-1, 1]) {
    const sh = cyl(0.36, 0.36, 0.08, 14);
    place(sh, x + sx * (w * 0.3), h * 0.55, z - d / 2 - 0.18, Math.PI / 2, 0, 0);
    paint(sh, (p) => (Math.hypot(p.x, p.z) < 0.12 ? 0xd8d0b8 : Math.sin(Math.atan2(p.x, p.z) * 4) > 0 ? k.team : tint(k.team, 0.6)));
    k.body.push(sh);
  }
  if (o.smoke !== false) {
    const ch = rbox(0.5, 1.2, 0.5, 0.06);
    place(ch, x + w * 0.28, h + roofH * 0.6, z - d * 0.15);
    paint(ch, STONE);
    k.body.push(ch);
    k.smoke.push(v3(x + w * 0.28, h + roofH * 0.6 + 0.65, z - d * 0.15));
  }
  k.fire.push(v3(x, h + roofH * 0.5, z), v3(x + w * 0.3, h * 0.5, z + d * 0.4));
  return h - 0.1 + roofH + 0.8;
}

export { blob, box, cone, cyl, displace, lathe, merge, mix, paint, place, rbox, setSway, shine, tint, torus, tube, v3 };
