/**
 * assets/models/buildings/kinds.ts — one recipe per BuildingKind.
 *
 * Each recipe fills a Kit (see kit.ts): a civ-styled core from `house()`,
 * then the props that say what the building is FOR — log piles and a saw
 * frame at the lumberyard, a weapon rack and straw dummy at the War Lodge,
 * a roaring brazier at the Ember Lodge, a bell frame on the Chant Hall.
 * Function over decoration: a player should read the building's job from
 * across the map.
 */

import * as THREE from 'three';
import { BuildingKind } from '../../../sim/catalog';
import {
  banner, beam, blob, cone, cyl, door, house, Kit, lathe, logPile, merge, mix, paint, place, plinth, post, rbox, setSway, shine, STONE,
  STONE_DARK, tint, torus, tube, v3, WOOD, WOOD_DARK, WOOD_LIGHT,
} from './kit';
import { TOWER_PLATFORM_Y } from './constants';

export function fillKit(k: Kit, kind: BuildingKind, tier: number): void {
  switch (kind) {
    case 'hut': return dwelling(k, tier);
    case 'lumberyard': return lumberyard(k);
    case 'tower': return tower(k);
    case 'warriorHut': return warLodge(k);
    case 'fireHut': return emberLodge(k);
    case 'shrine': return shrine(k);
    case 'wardenHall': return wardenHall(k);
    case 'chantHall': return chantHall(k);
    default: return dwelling(k, 0);
  }
}

// --- Dwelling: three tiers -----------------------------------------------------

function dwelling(k: Kit, tier: number): void {
  const round = k.civ.roof === 'thatch';
  const t = Math.max(0, Math.min(2, tier));
  const sizes = [
    { w: 3.3, d: 3.0, h: 1.65 },
    { w: 4.2, d: 3.6, h: 1.95 },
    { w: 4.6, d: 3.8, h: 2.15 },
  ][t];
  if (round) sizes.w = sizes.d = [3.3, 4.2, 4.6][t];
  house(k, sizes.w, sizes.d, sizes.h, { windows: t === 0 ? 1 : 2, z: t === 2 ? 0.25 : 0, x: t === 2 ? 0.35 : 0 });
  if (t >= 1) {
    // a lean-to woodpile and a water jar by the door
    logPile(k, round ? 2.15 : sizes.w / 2 + 0.35, round ? 1.3 : 0.6, 2, 1.1, 0.13, Math.PI / 2);
    const jar = lathe([[0.001, 0], [0.2, 0.05], [0.26, 0.25], [0.18, 0.5], [0.12, 0.55], [0.15, 0.6]], 10);
    place(jar, -1.0, 0, (round ? sizes.d / 2 : sizes.d / 2) + 0.5);
    paint(jar, (p) => (p.y > 0.3 && p.y < 0.36 ? k.team : 0xb06a3a));
    k.body.push(jar);
  }
  if (t === 2) {
    // an annex and a little fenced garden: this family has done well
    const ax = round ? -1.75 : -1.55;
    house(k, round ? 2.0 : 2.0, round ? 2.0 : 1.9, sizes.h * 0.8, { x: ax, z: -1.75, door: false, windows: 0, smoke: false });
    for (let i = 0; i < 6; i++) {
      const x = 0.9 + i * 0.36;
      post(k, x, 2.7, 0.55, 0.035, WOOD_LIGHT);
    }
    beam(k, v3(0.9, 0.42, 2.7), v3(2.7, 0.42, 2.7), 0.05, 0.05, WOOD_LIGHT);
    for (let i = 0; i < 5; i++) {
      const b = blob(0.18, 0.16, 0.18, 6, 5, 0.04, i, 6);
      place(b, 1.05 + i * 0.35, 0.15, 2.35);
      paint(b, i % 2 ? 0x5d8a3a : 0x6f9a42);
      k.body.push(b);
    }
    banner(k, 2.5, -2.2, 3.6, 0.5, 1.0);
  }
}

// --- Lumberyard ----------------------------------------------------------------

function lumberyard(k: Kit): void {
  plinth(k, 5.2, 5.2, 0x7a6448);
  // open shed: four posts and a pitched roof in the civ's roof material
  const roofC = k.civ.roofColor;
  for (const [x, z] of [[-1.9, -1.9], [0.6, -1.9], [-1.9, -0.1], [0.6, -0.1]]) post(k, x, z, 2.5, 0.12, WOOD_DARK);
  const roof = rbox(3.2, 0.14, 2.6, 0.04);
  place(roof, -0.65, 2.55, -1.0, 0.22, 0, 0);
  paint(roof, (p) => (Math.sin(p.x * 12) > 0.6 ? tint(roofC, 0.85) : roofC));
  k.body.push(roof);
  const ridge = rbox(3.3, 0.18, 0.2, 0.04);
  place(ridge, -0.65, 2.9, -2.1);
  paint(ridge, k.team);
  k.body.push(ridge);
  // stacked timber under the shed and big log piles in the yard
  logPile(k, -0.65, -1.0, 3, 2.4, 0.16);
  logPile(k, 1.75, -1.2, 3, 1.9, 0.18, Math.PI / 2);
  logPile(k, 1.9, 1.5, 2, 1.6, 0.16, 0.3);
  // saw frame: two A-trestles holding a log, a long two-man saw in the cut
  for (const sx of [-1, 1]) {
    const x = -1.2 + sx * 0.75;
    beam(k, v3(x, 0, 1.0), v3(x, 0.95, 1.35), 0.08, 0.08, WOOD);
    beam(k, v3(x, 0, 1.7), v3(x, 0.95, 1.35), 0.08, 0.08, WOOD);
  }
  const log = cyl(0.2, 0.2, 2.4, 9);
  place(log, -1.2, 1.15, 1.35, 0, 0, Math.PI / 2);
  paint(log, (p) => (Math.abs(p.y) > 1.12 ? 0xd9b67e : 0x6e4c2e));
  k.body.push(log);
  const saw = rbox(1.6, 0.22, 0.02, 0.01);
  place(saw, -1.2, 1.5, 1.35, 0, 0, 0.1);
  paint(saw, (p) => (p.y < -0.06 ? 0xb8b4aa : 0x8a8680));
  k.gloss.push(saw);
  // chopping stump with an axe in it, and wood chips
  const stump = cyl(0.32, 0.36, 0.5, 10);
  place(stump, 0.8, 0.25, 1.9);
  paint(stump, (p) => (p.y > 0.2 ? 0xd2ad74 : 0x6a4a2c));
  k.body.push(stump);
  const handle = cyl(0.03, 0.03, 0.75, 5);
  place(handle, 0.95, 0.75, 1.9, 0, 0, -0.6);
  paint(handle, WOOD);
  k.body.push(handle);
  for (let i = 0; i < 10; i++) {
    const c = rbox(0.12, 0.03, 0.06, 0.01, 1);
    place(c, 0.8 + Math.cos(i * 2.4) * 0.7, 0.02, 1.9 + Math.sin(i * 2.4) * 0.6, 0, i, 0);
    paint(c, 0xd8b680);
    k.body.push(c);
  }
  banner(k, 2.4, -2.3, 3.4, 0.5, 1.0);
}

// --- Watchtower ----------------------------------------------------------------

function tower(k: Kit): void {
  const P = TOWER_PLATFORM_Y;
  plinth(k, 3.4, 3.4, STONE_DARK);
  // stone base course
  const base = lathe([[1.75, 0], [1.65, 0.7], [1.45, 1.1]], 8);
  place(base, 0, 0, 0, 0, Math.PI / 8, 0);
  paint(base, (p) => (Math.sin(p.x * 7) * Math.sin(p.y * 9) > 0.2 ? STONE_DARK : k.civ.roof === 'stepped' ? k.civ.wallColor : STONE));
  k.body.push(base);
  // four raked timber legs + cross braces
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [x, z] of legs) beam(k, v3(x * 1.3, 0.6, z * 1.3), v3(x * 0.95, P, z * 0.95), 0.2, 0.2, WOOD_DARK);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = legs[i];
    const [bx, bz] = legs[(i + 1) % 4];
    beam(k, v3(ax * 1.22, 1.4, az * 1.22), v3(bx * 1.05, P - 0.6, bz * 1.05), 0.08, 0.08, WOOD);
    beam(k, v3(bx * 1.22, 1.4, bz * 1.22), v3(ax * 1.05, P - 0.6, az * 1.05), 0.08, 0.08, WOOD);
  }
  // ladder on the door side
  for (const sx of [-1, 1]) beam(k, v3(sx * 0.25, 0, 1.75), v3(sx * 0.25, P, 1.15), 0.06, 0.06, WOOD_LIGHT);
  for (let y = 0.4; y < P; y += 0.42) {
    const zz = 1.75 - (y / P) * 0.6;
    beam(k, v3(-0.25, y, zz), v3(0.25, y, zz), 0.04, 0.04, WOOD_LIGHT);
  }
  // platform with railing
  const deck = rbox(2.6, 0.18, 2.6, 0.04);
  place(deck, 0, P - 0.09, 0);
  paint(deck, (p) => (Math.sin(p.x * 18) > 0.85 ? WOOD_DARK : WOOD_LIGHT));
  k.body.push(deck);
  for (const [x, z] of legs) post(k, x * 1.2, z * 1.2, 2.4, 0.08, WOOD_DARK, P);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = legs[i];
    const [bx, bz] = legs[(i + 1) % 4];
    beam(k, v3(ax * 1.2, P + 0.85, az * 1.2), v3(bx * 1.2, P + 0.85, bz * 1.2), 0.07, 0.1, WOOD);
    // team-colour hide hung on the railing
    const hide = rbox(Math.abs(bx - ax) * 1.0 + Math.abs(bz - az) * 0.04 + 0.04, 0.55, Math.abs(bz - az) * 1.0 + Math.abs(bx - ax) * 0.04 + 0.04, 0.02);
    place(hide, (ax + bx) * 0.6, P + 0.5, (az + bz) * 0.6);
    paint(hide, (p) => (Math.abs(p.y) > 0.2 ? tint(k.team, 0.7) : k.team));
    if (i !== 0) k.body.push(hide);
    else hide.dispose();
  }
  // canopy roof, civ-styled
  const roofC = k.civ.roofColor;
  if (k.civ.roof === 'thatch') {
    const r = lathe([[1.95, P + 2.3], [1.2, P + 2.8], [0.1, P + 3.6]], 16);
    paint(r, (p) => (Math.sin(Math.atan2(p.x, p.z) * 30) > 0.4 ? tint(roofC, 1.1) : roofC));
    k.body.push(r);
  } else if (k.civ.roof === 'stepped') {
    for (let i = 0; i < 3; i++) {
      const s = rbox(2.9 - i * 0.8, 0.35, 2.9 - i * 0.8, 0.05);
      place(s, 0, P + 2.5 + i * 0.35, 0);
      paint(s, i === 0 ? k.team : roofC);
      k.body.push(s);
    }
    const cap = cone(0.35, 0.6, 4);
    place(cap, 0, P + 3.65, 0, 0, Math.PI / 4, 0);
    paint(cap, 0xe8bb4a);
    k.gloss.push(cap);
  } else {
    const r = cone(2.2, 1.6, 4);
    place(r, 0, P + 3.15, 0, 0, Math.PI / 4, 0);
    paint(r, (p) => (Math.floor(p.y / 0.25) % 2 ? roofC : tint(roofC, 1.15)));
    k.body.push(r);
  }
  banner(k, 1.2, 1.2, P + 4.2 - P + P - 0.5, 0.45, 0.9);
  k.fire.push(v3(0, P, 0), v3(0, 1.5, 0));
}

// --- War Lodge -----------------------------------------------------------------

function warLodge(k: Kit): void {
  const round = k.civ.roof === 'thatch';
  const top = house(k, round ? 4.3 : 4.6, round ? 4.3 : 3.6, 2.1, { roof: k.civ.roof === 'stepped' ? undefined : 0x6b4a30, windows: 1, z: -0.3, steep: 1.1 });
  void top;
  // crossed spears and a big team shield over the door
  const dz = (round ? 2.15 : 1.8) - 0.3 + 0.35;
  const sh = cyl(0.5, 0.5, 0.1, 16);
  place(sh, 0, 2.15, dz + 0.1, Math.PI / 2, 0, 0);
  paint(sh, (p) => (Math.hypot(p.x, p.z) < 0.16 ? 0xe8dcc0 : Math.sin(Math.atan2(p.x, p.z) * 3) > 0 ? k.team : tint(k.team, 0.55)));
  k.body.push(sh);
  for (const s of [-1, 1]) {
    const sp = cyl(0.035, 0.035, 2.6, 5);
    place(sp, 0, 2.15, dz + 0.05, 0, 0, s * 0.7);
    paint(sp, WOOD);
    k.body.push(sp);
    const tip = cone(0.08, 0.3, 5);
    place(tip, -s * Math.sin(0.7) * 1.4, 2.15 + Math.cos(0.7) * 1.4, dz + 0.05, 0, 0, s * 0.7);
    paint(tip, 0x4c4f55);
    k.body.push(tip);
  }
  // weapon rack with spears and a shield
  beam(k, v3(1.4, 0.0, 2.3), v3(1.4, 1.1, 2.3), 0.1, 0.1);
  beam(k, v3(2.6, 0.0, 2.3), v3(2.6, 1.1, 2.3), 0.1, 0.1);
  beam(k, v3(1.35, 1.0, 2.3), v3(2.65, 1.0, 2.3), 0.08, 0.08);
  for (let i = 0; i < 4; i++) {
    const x = 1.55 + i * 0.3;
    beam(k, v3(x, 0.0, 2.05), v3(x + 0.05, 2.0, 2.38), 0.04, 0.04, WOOD_LIGHT);
    const tip = cone(0.06, 0.24, 5);
    place(tip, x + 0.055, 2.1, 2.4, 0.16, 0, 0);
    paint(tip, 0x4c4f55);
    k.body.push(tip);
  }
  // straw training dummy wearing a team rag
  post(k, -1.8, 2.1, 1.9, 0.07, WOOD_DARK);
  const straw = blob(0.32, 0.45, 0.25, 9, 7, 0.05, 3, 7);
  place(straw, -1.8, 1.35, 2.1);
  paint(straw, (p) => (Math.abs(p.y) < 0.1 ? k.team : 0xd6b25a));
  k.body.push(straw);
  const head = blob(0.2, 0.2, 0.2, 8, 6, 0.04, 9, 8);
  place(head, -1.8, 1.95, 2.1);
  paint(head, 0xcaa452);
  k.body.push(head);
  beam(k, v3(-2.35, 1.5, 2.1), v3(-1.25, 1.5, 2.1), 0.06, 0.06, WOOD_DARK);
  // horned skull totem on the roof line
  const skull = blob(0.22, 0.2, 0.26, 8, 6);
  place(skull, 0, 2.95, dz - 0.2);
  paint(skull, 0xe8dfc8);
  k.body.push(skull);
  for (const s of [-1, 1]) {
    const horn = tube([v3(s * 0.15, 3.0, dz - 0.2), v3(s * 0.5, 3.15, dz - 0.15), v3(s * 0.6, 3.5, dz - 0.1)], 0.06, 8, 5, 0.3);
    paint(horn, 0xe8dfc8);
    k.body.push(horn);
  }
  banner(k, -2.4, -1.9, 4.6, 0.6, 1.3);
  banner(k, 2.4, -1.9, 4.6, 0.6, 1.3);
}

// --- Ember Lodge ---------------------------------------------------------------

function emberLodge(k: Kit): void {
  const round = k.civ.roof === 'thatch';
  house(k, round ? 4.0 : 4.2, round ? 4.0 : 3.4, 2.0, { roof: k.civ.roof === 'stepped' ? 0x8a5a3a : 0x3e3430, windows: 2, z: -0.5, x: -0.3, smoke: false });
  // the kiln: a clay dome with a tall chimney, glowing mouth
  const kiln = lathe([[1.0, 0], [1.05, 0.5], [0.9, 1.1], [0.55, 1.6], [0.25, 1.75]], 16);
  place(kiln, 1.6, 0, -1.2);
  paint(kiln, (p) => (p.y > 1.2 ? 0x3a2c24 : p.y < 0.2 ? 0x6a4a34 : 0x9a5a3a));
  k.body.push(kiln);
  const mouth = blob(0.42, 0.36, 0.12, 10, 6);
  place(mouth, 1.6, 0.4, -0.2);
  paint(mouth, 0x3a1608);
  shine(mouth, 0xff6a18, 2.6);
  k.body.push(mouth);
  const chim = lathe([[0.32, 1.5], [0.26, 3.4], [0.32, 3.5], [0.3, 3.7]], 10);
  place(chim, 1.6, 0, -1.2);
  paint(chim, (p) => (p.y > 3.2 ? 0x1e1814 : 0x7a4a30));
  k.body.push(chim);
  k.smoke.push(v3(1.6, 3.8, -1.2));
  // brazier: a stone bowl on three legs, always burning
  const bx = -1.5;
  const bz = 1.9;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    beam(k, v3(bx + Math.cos(a) * 0.45, 0, bz + Math.sin(a) * 0.45), v3(bx + Math.cos(a) * 0.25, 0.85, bz + Math.sin(a) * 0.25), 0.07, 0.07, 0x2e2a28);
  }
  const bowl = lathe([[0.15, 0.75], [0.45, 0.85], [0.6, 1.1], [0.55, 1.15]], 14);
  place(bowl, bx, 0, bz);
  paint(bowl, 0x4a4440);
  k.body.push(bowl);
  const coals = blob(0.5, 0.12, 0.5, 10, 5, 0.05, 2, 9);
  place(coals, bx, 1.06, bz);
  paint(coals, 0xffa040);
  shine(coals, 0xff5010, 3.2);
  k.body.push(coals);
  k.flames.push(v3(bx, 1.15, bz));
  // pitch pots and a team-dyed awning
  for (let i = 0; i < 4; i++) {
    const pot = lathe([[0.001, 0], [0.18, 0.04], [0.22, 0.25], [0.14, 0.42], [0.16, 0.46]], 10);
    place(pot, 0.4 + i * 0.42, 0, 2.0 + (i % 2) * 0.25);
    paint(pot, (p) => (p.y > 0.38 ? 0x15100c : i % 2 ? 0x8a4a2c : 0x6a3a22));
    k.body.push(pot);
  }
  banner(k, 2.5, 1.6, 4.4, 0.55, 1.2);
  k.fire.push(v3(1.6, 1.7, -1.2));
}

// --- Shrine (5×5) --------------------------------------------------------------

function shrine(k: Kit): void {
  // paved circle
  const pave = cyl(4.3, 4.5, 0.3, 32);
  place(pave, 0, -0.05, 0);
  paint(pave, (p) => {
    const r = Math.hypot(p.x, p.z);
    const a = Math.atan2(p.x, p.z);
    if (r > 3.95) return STONE_DARK;
    if (Math.abs(r - 2.3) < 0.12) return k.team;
    return (Math.floor(r / 0.7) + Math.floor((a * 6) / Math.PI)) % 2 ? STONE : tint(STONE, 1.08);
  });
  k.body.push(pave);
  plinth(k, 8.6, 8.6, STONE_DARK, true);
  // standing stones, civ-flavoured
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const x = Math.sin(a) * 3.9;
    const z = Math.cos(a) * 3.9;
    const h = 2.6 + ((i * 37) % 5) * 0.2;
    if (k.civ.roof === 'stepped') {
      // obelisks with gold caps
      const ob = lathe([[0.42, 0], [0.36, h * 0.9], [0.001, h * 0.9 + 0.01]], 4);
      place(ob, x, 0, z, 0, a + Math.PI / 4, 0);
      paint(ob, (p) => (Math.abs(p.y - h * 0.5) < 0.12 ? k.team : k.civ.wallColor));
      k.body.push(ob);
      const cap = cone(0.37, 0.55, 4);
      place(cap, x, h * 0.9 + 0.27, z, 0, a + Math.PI / 4, 0);
      paint(cap, 0xe8bb4a);
      k.gloss.push(cap);
    } else {
      const st = blob(0.5, h / 2, 0.32, 8, 7, 0.06, i * 11, 2.2);
      place(st, x, h / 2 - 0.15, z, 0, a, (i % 2 ? 1 : -1) * 0.05);
      paint(st, (p) => (Math.sin(p.y * 2 + p.x * 3) > 0.6 ? 0x7d8a6a : STONE));
      // carved glowing runes on the inner face
      shine(st, k.civ.accent, 1.4, (p) => (Math.abs(p.x) < 0.12 && Math.sin(p.y * 9) > 0.55 && p.z < -0.15 ? 1 : 0));
      place(st, 0, 0, 0);
      k.body.push(st);
    }
  }
  // the altar: stepped stone with a team cloth, a glowing focus above it
  for (let i = 0; i < 3; i++) {
    const s = rbox(2.0 - i * 0.5, 0.35, 1.6 - i * 0.4, 0.06);
    place(s, 0, 0.17 + i * 0.35, 0);
    paint(s, i === 2 ? tint(STONE, 1.1) : STONE);
    k.body.push(s);
  }
  const cloth = rbox(0.6, 0.02, 1.9, 0.01);
  place(cloth, 0, 1.06, 0);
  paint(cloth, k.team);
  k.body.push(cloth);
  for (const sz of [-1, 1]) {
    const drape = rbox(0.6, 0.7, 0.03, 0.01);
    place(drape, 0, 0.72, sz * 0.62);
    paint(drape, (p) => (p.y < -0.25 ? 0xe8dcc0 : k.team));
    k.body.push(drape);
  }
  const plinthTop = cyl(0.25, 0.35, 0.5, 10);
  place(plinthTop, 0, 1.3, 0);
  paint(plinthTop, STONE_DARK);
  k.body.push(plinthTop);
  const focus = blob(0.42, 0.55, 0.42, 6, 4);
  place(focus, 0, 2.15, 0, 0, Math.PI / 4, 0);
  paint(focus, mix(k.civ.accent, 0xffffff, 0.5));
  shine(focus, k.civ.accent, 3.5);
  k.gloss.push(focus);
  k.flames.push(v3(0, 2.15, 0));
  // offering bowls with small fires
  for (const [x, z] of [[1.6, 1.6], [-1.6, 1.6], [1.6, -1.6], [-1.6, -1.6]]) {
    const bowl = lathe([[0.1, 0], [0.3, 0.3], [0.35, 0.4]], 10);
    place(bowl, x, 0, z);
    paint(bowl, 0x6a5a48);
    k.body.push(bowl);
    const ember = blob(0.22, 0.08, 0.22, 8, 4);
    place(ember, x, 0.36, z);
    paint(ember, 0xffb040);
    shine(ember, 0xff6a10, 2.2);
    k.body.push(ember);
  }
  banner(k, 0, -4.4, 4.2, 0.7, 1.5);
}

// --- Warden Hall (5×5) ---------------------------------------------------------

function wardenHall(k: Kit): void {
  const round = k.civ.roof === 'thatch';
  const wall = round ? 0x9a8a72 : k.civ.roof === 'stepped' ? k.civ.wallColor : 0x8a7a64;
  house(k, round ? 7.6 : 8.2, round ? 7.6 : 6.2, 2.8, { wall, windows: 4, z: -0.6, steep: round ? 0.75 : 0.75 });
  // stone buttresses
  const zFront = (round ? 3.8 : 3.1) - 0.6;
  for (const sx of [-1, 1]) {
    for (const zz of [-1.6, 0.8]) {
      if (round) continue;
      const b = rbox(0.6, 2.4, 0.9, 0.1);
      place(b, sx * 4.25, 1.2, zz, 0, 0, sx * 0.08);
      paint(b, STONE);
      k.body.push(b);
    }
  }
  // a great door with iron studs and two braziers
  door(k, 0, zFront + 0.25, 1.6, 2.3, 0x3a2a1c, 0.5);
  for (const sx of [-1, 1]) {
    const x = sx * 1.6;
    const z = zFront + 1.2;
    const col = cyl(0.22, 0.3, 1.1, 8);
    place(col, x, 0.55, z);
    paint(col, STONE_DARK);
    k.body.push(col);
    const bowl = lathe([[0.15, 1.05], [0.42, 1.15], [0.48, 1.35]], 12);
    place(bowl, x, 0, z);
    paint(bowl, 0x3a3634);
    k.body.push(bowl);
    const coal = blob(0.4, 0.1, 0.4, 8, 4);
    place(coal, x, 1.32, z);
    paint(coal, 0xffa040);
    shine(coal, 0xff5a10, 2.6);
    k.body.push(coal);
    k.flames.push(v3(x, 1.4, z));
    banner(k, sx * 3.3, zFront + 1.0, 5.2, 0.8, 1.8);
  }
  // a pair of giant tower shields flanking the door
  for (const sx of [-1, 1]) {
    const s = rbox(0.9, 1.7, 0.12, 0.05);
    place(s, sx * 2.6, 1.3, zFront + 0.3);
    paint(s, (p) => (Math.abs(p.y) > 0.7 ? 0xd8cdb4 : (Math.floor((Math.abs(p.x) * 1.4 + p.y) / 0.25) % 2 ? k.team : tint(k.team, 0.6))));
    k.body.push(s);
  }
  k.fire.push(v3(-2.5, 2.5, -0.6), v3(2.5, 2.8, -1.0));
}

// --- Chant Hall ----------------------------------------------------------------

function chantHall(k: Kit): void {
  const round = k.civ.roof === 'thatch';
  const top = house(k, round ? 3.9 : 4.2, round ? 3.9 : 3.4, 2.3, { windows: 2, smoke: false, z: 0.2 });
  // bell frame standing beside the hall: two tall posts, a beam, three bells
  const bx = 0;
  const bz = -2.25;
  const H = Math.max(4.6, top - 0.2);
  post(k, bx - 1.1, bz, H, 0.13, WOOD_DARK);
  post(k, bx + 1.1, bz, H, 0.13, WOOD_DARK);
  beam(k, v3(bx - 1.35, H - 0.15, bz), v3(bx + 1.35, H - 0.15, bz), 0.2, 0.22, WOOD_DARK);
  const cap = rbox(2.9, 0.12, 0.7, 0.03);
  place(cap, bx, H + 0.05, bz, 0, 0, 0);
  paint(cap, k.team);
  k.body.push(cap);
  for (let i = 0; i < 3; i++) {
    const x = bx - 0.65 + i * 0.65;
    const s = 0.8 + (i === 1 ? 0.35 : 0);
    const bell = lathe([[0.001, 0.0], [0.08 * s, 0.0], [0.18 * s, -0.12 * s], [0.22 * s, -0.4 * s], [0.32 * s, -0.55 * s], [0.3 * s, -0.6 * s]], 14);
    place(bell, x, H - 0.3, bz);
    paint(bell, 0xd6a840);
    k.gloss.push(bell);
    const rope = cyl(0.015, 0.015, H - 0.9, 3);
    place(rope, x + 0.05, (H - 0.9) / 2, bz + 0.05);
    paint(rope, 0xd8c79a);
    k.body.push(rope);
  }
  // prayer-ribbon lines from the bell frame to the hall
  for (const sx of [-1, 1]) {
    const a = v3(bx + sx * 1.1, H - 0.4, bz);
    const b = v3(sx * 1.9, 1.9, 1.8);
    const line = tube([a, a.clone().lerp(b, 0.5).add(v3(0, -0.4, 0)), b], 0.012, 10, 3);
    paint(line, 0xd8c79a);
    k.body.push(line);
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      const p = a.clone().lerp(b, t).add(v3(0, -Math.sin(t * Math.PI) * 0.4, 0));
      const flag = new THREE.PlaneGeometry(0.22, 0.32);
      flag.translate(0, -0.16, 0);
      const g = merge([flag]);
      paint(g, i % 3 === 0 ? 0xe8dcc0 : i % 3 === 1 ? k.team : 0xd6a840);
      setSway(g, (q) => 0.3 - q.y * 2);
      place(g, p.x, p.y, p.z, 0, Math.PI / 2, 0);
      k.cloth.push(g);
    }
  }
  banner(k, 2.3, 2.0, 4.0, 0.5, 1.2);
}

/** Re-exported so callers don't import kit.ts just for these. */
export { door, torus, rbox, STONE, WOOD };
