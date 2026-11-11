/**
 * assets/models/people/recipes.ts — who wears what.
 *
 * One recipe per unit kind (and one leader per civilisation). A recipe
 * picks proportions, rolls the per-person dice (skin, hair, build, cloth
 * pattern — seeded, so a person always looks like themselves), then dresses
 * the shared skeleton layer by layer using parts.ts and gear.ts.
 *
 * Silhouette is the design brief. From the default camera you should be
 * able to name every class by outline alone:
 *   Villager     — tunic, no weapon; axe / hammer / log appear with the job
 *   Warrior      — broad, fur shoulders, tall spear + round shield, feathers
 *   Emberthrower — lean, hooded, short cape, glowing pot swinging at the hip
 *   Warden       — the wall: huge plank shield, stone maul, horns, furs
 *   Chanter      — floor-length robe, tall mask-crest, staff hung with bells
 *   Leader       — tallest, cloak to the ground, crown/antlers/wolf hood,
 *                  a staff whose head burns with light
 *   Wanderer     — hunched, wild hair, undyed rags, barefoot
 */

import * as THREE from 'three';
import { Civ } from '../../../config';
import { Tribe, TRIBE_COLORS, UnitKind } from '../../../sim/catalog';
import { blob, capsule, cone, dome, G, lathe, merge, mix, paint, place, rbox, shine, tint, torus, tube } from '../geometry';
import { Rng, rng } from '../rng';
import * as gear from './gear';
import {
  addBand, addBelt, addBody, addCloak, addFurMantle, addHair, addHead, addNecklace, addRobe, addSash, addSkirt,
  clothFn, feather, flip, HAIRS, headCentre, hipSpan, LEATHERS, Look, SKINS, TRIMS,
} from './parts';
import { BI, Body, defaultBody, Rig, restOffsets } from './rig';

export type AttackStyle = 'thrust' | 'smash' | 'chop' | 'throw' | 'none';

export interface FigureStyle {
  attack: AttackStyle;
  holdR: 'staff' | 'spear' | 'maul' | 'sling' | 'none';
  holdL: 'shield' | 'tower' | 'pot' | 'none';
  robe: boolean;
  /** 0 = nimble, 1 = lumbering (slower, heavier motion). */
  heavy: number;
  hunch: number;
  cloak: boolean;
  leader: boolean;
  female: boolean;
  /** Villager tools (axe, hammer, log) exist on this rig. */
  tools: boolean;
}

export interface Recipe {
  geo: G;
  /** Polished/metal parts (separate glossy mesh on the same skeleton), if any. */
  gloss: G | null;
  offsets: Float32Array;
  body: Body;
  /** World height of the top of the head (scale target). */
  stature: number;
  style: FigureStyle;
  /** Colour of the leader's aura / staff light, if any. */
  aura: number | null;
  /** Unscaled height of the head top (for scale). */
  headTop: number;
}

const style = (s: Partial<FigureStyle>): FigureStyle => ({
  attack: 'none', holdR: 'none', holdL: 'none', robe: false, heavy: 0, hunch: 0, cloak: false, leader: false, female: false, tools: false,
  ...s,
});

function baseLook(r: Rng, cloth: number): Look {
  return {
    skin: r.pick(SKINS),
    hair: r.pick(HAIRS),
    cloth,
    trim: r.pick(TRIMS),
    leather: r.pick(LEATHERS),
    hairStyle: 'cap',
    beard: false,
    pattern: r.int(4),
    eye: 0x1d140f,
  };
}

/** Torso cloth with a V neckline showing skin. */
function shirtFn(b: Body, look: Look, color: number, trim: number, vneck = true) {
  return (p: THREE.Vector3) => {
    const tl = b.torsoLen;
    // V neckline: opens upward from mid-chest, edged with trim
    const v = (p.y - tl * 0.36) * 0.75;
    if (vneck && p.z > 0.02 && Math.abs(p.x) < v - 0.018) return look.skin;
    if (vneck && p.z > 0.02 && Math.abs(p.x) < v + 0.012) return trim;
    return color;
  };
}

function headTop(rig: Rig, b: Body): number {
  return rig.at('head').y + headCentre(b).y + b.headR;
}

// ---------------------------------------------------------------------------

export function buildRecipe(kind: UnitKind, tribe: Tribe, civ: Civ, seed: number): Recipe {
  const team = TRIBE_COLORS[tribe] ?? TRIBE_COLORS.wild;
  const r = rng(seed * 7919 + kind.length * 131);
  switch (kind) {
    case 'brave': return villager(r, team);
    case 'warrior': return warrior(r, team);
    case 'firewarrior': return emberthrower(r, team);
    case 'warden': return warden(r, team);
    case 'chanter': return chanter(r, team);
    case 'shaman': return leader(r, team, civ);
    case 'wildman': return wanderer(r);
    default:
      console.warn(`[models] unknown unit kind "${kind}", using a villager`);
      return villager(r, team);
  }
}

// --- Villager ----------------------------------------------------------------

function villager(r: Rng, team: number): Recipe {
  const b = defaultBody();
  const female = r.chance(0.5);
  const build = r.range(0.92, 1.12);
  b.female = female;
  if (female) {
    Object.assign(b, { shoulderW: 0.245, chestR: 0.2, waistR: 0.155, hipR: 0.215, limb: 0.9, hipW: 0.105 });
  }
  b.chestR *= build;
  b.waistR *= build;
  b.limb *= 0.94 + (build - 1) * 0.8;
  b.legLen *= r.range(0.96, 1.04);
  const look = baseLook(r, team);
  look.hairStyle = female ? r.pick(['bun', 'long', 'braids', 'tail'] as const) : r.pick(['cap', 'crop', 'tail', 'mohawk', 'bald', 'braids', 'cap'] as const);
  look.beard = !female && r.chance(0.35);
  const offsets = restOffsets(b);
  const rig = new Rig(offsets);
  const cloth = mix(team, look.trim, r.range(0, 0.12));
  addBody(rig, b, look, {
    shirt: shirtFn(b, look, cloth, look.trim),
    sleeve: female || r.chance(0.5) ? cloth : null,
    legs: r.chance(0.4) ? tint(look.leather, 1.25) : null,
    feet: look.leather,
  });
  addSkirt(rig, b, clothFn(cloth, look.trim, look.pattern, female ? -0.56 : -0.34), female ? 0.56 : 0.34, female ? 0.12 : 0.07);
  addBelt(rig, b, look.leather, r.chance(0.6) ? tint(look.leather, 1.2) : undefined);
  addHair(rig, b, look, r);
  if (r.chance(0.3) && look.hairStyle !== 'mohawk') {
    const c = headCentre(b);
    const band = torus(b.headR * 1.02, 0.022, 5, 18);
    place(band, c.x, c.y + b.headR * 0.32, c.z, Math.PI / 2 - 0.25, 0, 0);
    paint(band, look.trim === look.hair ? 0xeadfc4 : look.trim);
    rig.add('head', band);
  }
  rig.add('axe', gear.axe());
  rig.add('hammer', gear.hammer());
  rig.add('log', gear.log());
  return {
    geo: rig.finish(), gloss: null, offsets, body: b, stature: 2.3 * r.range(0.97, 1.03),
    style: style({ attack: 'chop', tools: true, female }), aura: null, headTop: headTop(rig, b),
  };
}

// --- Warrior -----------------------------------------------------------------

function warrior(r: Rng, team: number): Recipe {
  const b = defaultBody();
  Object.assign(b, { shoulderW: 0.31, chestR: 0.25, waistR: 0.195, hipR: 0.2, limb: 1.18, torsoLen: 0.66, headR: 0.24, legLen: 0.9 });
  const look = baseLook(r, team);
  look.hairStyle = r.pick(['mohawk', 'tail', 'braids', 'crop'] as const);
  look.beard = r.chance(0.5);
  const paintC = r.pick([0xe9e1d0, 0x1d1a18, 0xb03a2a]);
  const offsets = restOffsets(b);
  offsets[BI.charm * 3 + 2] = 1.6; // charm unused
  const rig = new Rig(offsets);
  addBody(rig, b, look, {
    shirt: null,
    chestPaint: (p) => {
      // two slashes of war paint across the chest
      if (p.z > 0.05 && Math.abs(p.y - 0.18 - p.x * 0.7) < 0.025) return paintC;
      if (p.z > 0.05 && Math.abs(p.y - 0.06 - p.x * 0.7) < 0.02) return paintC;
      return null;
    },
    legs: null,
    feet: look.leather,
    sleeve: null,
  });
  // fierce face: a band of paint across the eyes
  addSkirt(rig, b, clothFn(team, look.trim, 2, -0.4), 0.4, 0.07, 0.16, true);
  addBelt(rig, b, look.leather);
  addSash(rig, b, look.leather, 0.045);
  addFurMantle(rig, b, r.pick([0x6b5440, 0x7a6a58, 0x4e3e30]), 0.72, r.int(99));
  addBand(rig, 'foreL', 0.06, -0.3, team, 0.06);
  addBand(rig, 'foreR', 0.06, -0.3, team, 0.06);
  addBand(rig, 'armL', 0.078, -0.12, look.leather, 0.04);
  addBand(rig, 'armR', 0.078, -0.12, look.leather, 0.04);
  addHair(rig, b, look, r);
  // face paint: rebuild skull paint by overlaying a mask band
  const c = headCentre(b);
  const band = dome(b.headR * 1.005, Math.PI, 16, 10);
  const pos = band.attributes.position;
  // keep only a band around the eyes: squash everything else inside the head
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (!(y > -b.headR * 0.05 && y < b.headR * 0.28 && z > -0.02)) pos.setXYZ(i, pos.getX(i) * 0.5, y * 0.5, z * 0.5);
  }
  paint(band, mix(paintC === 0xe9e1d0 ? 0xb03a2a : paintC, team, 0.25));
  place(band, c.x, c.y, c.z);
  rig.add('head', band);
  // headband + feathers
  const hb = torus(b.headR * 1.04, 0.03, 5, 18);
  place(hb, c.x, c.y + b.headR * 0.38, c.z, Math.PI / 2 - 0.2, 0, 0);
  paint(hb, team);
  rig.add('head', hb);
  for (let i = 0; i < 3; i++) {
    const f = feather(0.42 - i * 0.06, 0.05, 0xf2ead8, team);
    place(f, c.x + (i - 1) * 0.06, c.y + b.headR * 0.5, c.z - b.headR * 0.9, -0.5 + i * 0.05, 0, (i - 1) * 0.35);
    rig.add('head', f);
  }
  rig.add('propR', gear.spear(team));
  rig.add('propL', gear.roundShield(team, look.trim === team ? 0xeadfc4 : look.trim));
  return {
    geo: rig.finish(), gloss: null, offsets, body: b, stature: 2.5,
    style: style({ attack: 'thrust', holdR: 'spear', holdL: 'shield', heavy: 0.3 }), aura: null, headTop: headTop(rig, b),
  };
}

// --- Emberthrower ------------------------------------------------------------

function emberthrower(r: Rng, team: number): Recipe {
  const b = defaultBody();
  Object.assign(b, { shoulderW: 0.25, chestR: 0.19, waistR: 0.15, hipR: 0.17, limb: 0.86, legLen: 0.92, headR: 0.245 });
  const look = baseLook(r, team);
  look.hairStyle = 'crop';
  const soot = 0x2a2522;
  const offsets = restOffsets(b);
  const rig = new Rig(offsets);
  // Sleeves and leggings in warm scorched leather (not black — black limbs
  // read as a stick figure from the camera), bound with lighter wraps.
  const hideC = 0x5a4232;
  const wrapC = 0x9a7a58;
  addBody(rig, b, look, {
    shirt: (p) => (p.z > 0.04 && Math.abs(p.x) < 0.07 ? soot : team),
    sleeve: hideC,
    sleeveLen: 'long',
    legs: hideC,
    feet: look.leather,
  });
  // leg bindings spiralling down the shins, a leather bracer on each forearm
  for (const side of ['L', 'R'] as const) {
    for (let k = 0; k < 3; k++) {
      const w = torus(0.1 * (1 - k * 0.1), 0.016, 5, 14);
      place(w, 0, -0.1 - k * 0.11, 0, Math.PI / 2 + (k % 2 ? 0.25 : -0.25), 0, 0);
      paint(w, wrapC);
      rig.add(`shin${side}`, w);
    }
    const bracer = lathe([[0.082, -0.3], [0.09, -0.18], [0.096, -0.08]], 12);
    paint(bracer, (p) => (Math.abs(p.y + 0.19) < 0.02 ? team : 0x3a2a20));
    rig.add(`fore${side}`, bracer);
  }
  addSkirt(rig, b, clothFn(team, soot, 1, -0.3), 0.3, 0.05);
  // leather apron over the kilt, scorched at the hem
  const apron = rbox(0.24, 0.42, 0.02, 0.01);
  place(apron, 0, -0.14, hipSpan(b) * b.depth + 0.07, -0.08, 0, 0);
  paint(apron, (p) => (p.y < -0.28 ? 0x231c18 : look.leather));
  rig.add('hips', apron, { weights: (p) => [['hips', 1 - Math.min(0.5, -p.y)], ['thighL', Math.min(0.25, -p.y / 2)], ['thighR', Math.min(0.25, -p.y / 2)]] });
  addBelt(rig, b, 0x3a2a20);
  // bandolier with pouches of pitch
  addSash(rig, b, look.leather, 0.04, false);
  for (let i = 0; i < 4; i++) {
    const pouch = blob(0.045, 0.05, 0.035, 7, 5);
    place(pouch, -0.15 + i * 0.09, 0.08 + i * 0.075, b.chestR * b.depth + 0.03);
    paint(pouch, i % 2 ? 0x4a3020 : 0x5a3c26);
    rig.add('chest', pouch);
  }
  addHead(rig, b, look, {}); // underlying face (hood covers the rest)
  // hood/cowl
  const c = headCentre(b);
  const hood = dome(b.headR * 1.2, 1.95, 16, 9);
  place(hood, c.x, c.y + 0.01, c.z - b.headR * 0.18, -0.95, 0, 0);
  paint(hood, (p) => (p.z > b.headR * 0.25 ? tint(team, 0.7) : soot));
  rig.add('head', hood);
  const hoodTip = cone(b.headR * 0.4, b.headR * 0.9, 8);
  place(hoodTip, c.x, c.y + b.headR * 0.55, c.z - b.headR * 0.95, -1.9, 0, 0);
  paint(hoodTip, soot);
  rig.add('head', hoodTip);
  // scarf mask over the mouth and nose
  const scarf = blob(b.headR * 0.85, b.headR * 0.42, b.headR * 0.7, 12, 7);
  place(scarf, c.x, c.y - b.headR * 0.42, c.z + b.headR * 0.32);
  const scarfC = tint(team, 0.55);
  paint(scarf, (p) => (Math.sin(p.x * 50) > 0.6 ? tint(scarfC, 1.25) : scarfC));
  rig.add('head', scarf);
  // short cape
  addCloak(rig, b, (p) => (p.y < -0.5 ? tint(team, 0.6) : soot), team, 0.6, 0.85, undefined, { hem: 'points', folds: 5, drape: 0.08 });
  rig.add('propR', gear.sling());
  rig.add('propL', gear.emberPot());
  return {
    geo: rig.finish(), gloss: null, offsets, body: b, stature: 2.4,
    style: style({ attack: 'throw', holdR: 'sling', holdL: 'pot', cloak: true }), aura: null, headTop: headTop(rig, b),
  };
}

// --- Warden ------------------------------------------------------------------

function warden(r: Rng, team: number): Recipe {
  const b = defaultBody();
  Object.assign(b, {
    shoulderW: 0.37, chestR: 0.31, waistR: 0.27, hipR: 0.25, limb: 1.42, torsoLen: 0.72, legLen: 0.82, headR: 0.235, depth: 0.82, hipW: 0.13,
  });
  const look = baseLook(r, team);
  look.hairStyle = 'crop';
  look.beard = r.chance(0.7);
  const fur = r.pick([0x6a5a48, 0x7b6e60, 0x56483a]);
  const leather = 0x4a3426;
  const offsets = restOffsets(b);
  const rig = new Rig(offsets);
  // lamellar leather armour with a team-colour chest panel
  addBody(rig, b, look, {
    shirt: (p) => {
      if (p.z > 0.05 && Math.abs(p.x) < 0.11 && p.y > 0.0 && p.y < 0.36) return team;
      return Math.floor(p.y / 0.06) % 2 === 0 ? leather : tint(leather, 1.25);
    },
    sleeve: leather,
    sleeveLen: 'short',
    legs: 0x3e3028,
    feet: fur,
  });
  addSkirt(rig, b, (p) => (Math.floor(Math.atan2(p.x, p.z) * 3) % 2 === 0 ? leather : team), 0.42, 0.1, 0.16, true);
  addBelt(rig, b, 0x2e2420);
  addFurMantle(rig, b, fur, 1.35, r.int(99));
  addCloak(rig, b, (p) => (Math.sin(p.x * 30 + p.y * 9) > 0.3 ? tint(fur, 0.9) : fur), tint(fur, 0.7), 1.1, 1.15, undefined, { hem: 'ragged', folds: 6, drape: 0.14, seed: 5 });
  addBand(rig, 'foreL', 0.075, -0.25, team, 0.12);
  addBand(rig, 'foreR', 0.075, -0.25, team, 0.12);
  addHead(rig, b, look, { brow: 0.4, eyeScale: 0.85 });
  addHair(rig, b, look, r);
  // bone-and-hide helmet with horns and cheek guards
  const c = headCentre(b);
  const helm = dome(b.headR * 1.14, 1.55, 16, 8);
  place(helm, c.x, c.y + b.headR * 0.08, c.z - 0.01, -0.15, 0, 0);
  paint(helm, (p) => (p.y < b.headR * 0.32 ? team : 0xcfc3a6));
  rig.add('head', helm);
  const nose = rbox(0.04, b.headR * 0.7, 0.03, 0.01);
  place(nose, c.x, c.y + b.headR * 0.12, c.z + b.headR * 1.1, -0.15, 0, 0);
  paint(nose, 0xcfc3a6);
  rig.add('head', nose);
  for (const sx of [1, -1]) {
    const horn = tube([
      new THREE.Vector3(sx * b.headR * 0.85, c.y + b.headR * 0.3, c.z),
      new THREE.Vector3(sx * b.headR * 1.5, c.y + b.headR * 0.55, c.z + 0.02),
      new THREE.Vector3(sx * b.headR * 1.75, c.y + b.headR * 1.2, c.z + 0.08),
      new THREE.Vector3(sx * b.headR * 1.6, c.y + b.headR * 1.65, c.z + 0.12),
    ], b.headR * 0.17, 14, 7, 0.2);
    paint(horn, (p) => (p.y > c.y + b.headR * 1.3 ? 0x3a3530 : 0xe8ddc4));
    rig.add('head', horn);
    const guard = rbox(0.05, b.headR * 0.8, b.headR * 0.55, 0.02);
    place(guard, sx * b.headR * 0.98, c.y - b.headR * 0.3, c.z + b.headR * 0.2, 0, 0, sx * 0.1);
    paint(guard, 0xcfc3a6);
    rig.add('head', guard);
  }
  rig.add('propR', gear.maul());
  rig.add('propL', gear.towerShield(team, 0xd8cdb4));
  return {
    geo: rig.finish(), gloss: null, offsets, body: b, stature: 2.8,
    style: style({ attack: 'smash', holdR: 'maul', holdL: 'tower', heavy: 1, cloak: true }), aura: null, headTop: headTop(rig, b),
  };
}

// --- Chanter -----------------------------------------------------------------

function chanter(r: Rng, team: number): Recipe {
  const b = defaultBody();
  Object.assign(b, { shoulderW: 0.25, chestR: 0.2, waistR: 0.17, hipR: 0.2, limb: 0.92, headR: 0.25 });
  const look = baseLook(r, team);
  look.hairStyle = 'long';
  const offsets = restOffsets(b);
  const st = gear.staff('chanter', team, 0xffd27a);
  offsets[BI.charm * 3 + 2] = st.top; // charm bone at the staff head
  const rig = new Rig(offsets);
  const trim = r.pick([0xeadfc4, 0xd6a840, 0x2e2622]);
  const robeFn = clothFn(team, trim, 1, -(b.legLen + b.footH), 0.1);
  addBody(rig, b, look, {
    shirt: (p) => (p.z > 0.02 && Math.abs(p.x) < 0.05 ? trim : team),
    sleeve: team,
    sleeveLen: 'long',
    legs: tint(team, 0.7),
    feet: 0x4a3426,
    noLegs: true,
  });
  addRobe(rig, b, robeFn, 0.16);
  addBelt(rig, b, trim);
  // hanging charm strings from the belt
  for (let i = 0; i < 5; i++) {
    const a = -0.9 + i * 0.45;
    const s = capsule(0.012, 0.012, 0.22, 4);
    place(s, Math.sin(a) * b.waistR * 1.05, 0.07, Math.cos(a) * b.waistR * b.depth * 1.1);
    paint(s, 0xcdb98a);
    rig.add('spine', s);
    const charm = blob(0.025, 0.032, 0.018, 6, 5);
    place(charm, Math.sin(a) * b.waistR * 1.05, -0.17, Math.cos(a) * b.waistR * b.depth * 1.1 + 0.01);
    paint(charm, i % 2 ? 0xd6a840 : 0xeadfc4);
    rig.add('spine', charm);
  }
  addHead(rig, b, look, { masked: true });
  addHair(rig, b, look, r);
  // carved wooden mask
  const c = headCentre(b);
  const R = b.headR;
  const mz = c.z + R * 0.72;
  const mask = blob(R * 0.88, R * 1.2, R * 0.42, 16, 12);
  paint(mask, (p) => {
    if (Math.abs(p.x) < R * 0.07) return team; // centre stripe
    if (p.y > R * 0.5) return team; // crown band
    if (p.y < -R * 0.15 && Math.abs(Math.abs(p.x) - R * 0.42) < R * 0.08) return team; // cheek bars
    return 0xe8dcc0;
  });
  place(mask, c.x, c.y - R * 0.08, mz);
  rig.add('head', mask);
  // deep almond eye holes and a round singing mouth, raised so they read from afar
  for (const sx of [1, -1]) {
    const eye = blob(R * 0.2, R * 0.11, R * 0.08, 8, 6);
    place(eye, c.x + sx * R * 0.34, c.y + R * 0.12, mz + R * 0.36, 0, sx * 0.4, sx * -0.3);
    paint(eye, 0x120c08);
    rig.add('head', eye);
  }
  const mouth = torus(R * 0.13, R * 0.05, 6, 12);
  place(mouth, c.x, c.y - R * 0.5, mz + R * 0.33);
  paint(mouth, 0x8a3f2c);
  rig.add('head', mouth);
  const mouthHole = blob(R * 0.1, R * 0.1, R * 0.04, 8, 6);
  place(mouthHole, c.x, c.y - R * 0.5, mz + R * 0.34);
  paint(mouthHole, 0x120c08);
  rig.add('head', mouthHole);
  // tall crest of feathers fanning up behind the mask
  for (let i = 0; i < 7; i++) {
    const a = -0.75 + i * 0.25;
    const f = feather(0.55 - Math.abs(i - 3) * 0.06, 0.06, i % 2 ? team : 0xf2ead8, i % 2 ? 0x1d1a18 : team);
    place(f, c.x + Math.sin(a) * 0.12, c.y + b.headR * 0.55, c.z - b.headR * 0.25, -0.15, 0, -a);
    rig.add('head', f);
  }
  rig.add('propR', st.shaft);
  rig.add('charm', st.head);
  return {
    geo: rig.finish(), gloss: null, offsets, body: b, stature: 2.4,
    style: style({ attack: 'none', holdR: 'staff', robe: true }), aura: null, headTop: headTop(rig, b),
  };
}

// --- Leaders -----------------------------------------------------------------

function leader(r: Rng, team: number, civ: Civ): Recipe {
  const b = defaultBody();
  Object.assign(b, { legLen: 0.95, torsoLen: 0.68, headR: 0.255, shoulderW: 0.29, chestR: 0.235, waistR: 0.19, hipR: 0.2, limb: 1.05 });
  const look = baseLook(r, team);
  const offsets = restOffsets(b);
  const st = gear.staff(civ.id, team, civ.accent);
  offsets[BI.charm * 3 + 2] = st.top;
  const rig = new Rig(offsets);
  const gold = new Rig(offsets);
  const c = headCentre(b);
  let aura = civ.accent;

  if (civ.id === 'forest') {
    // THE SHAMAN — antlers, a fan of feathers, a feather cloak to the ground.
    look.skin = r.pick([0xb07546, 0x8f5a36, 0xcf9563]);
    look.hair = 0xe8e4dc;
    look.hairStyle = 'braids';
    const paintW = 0xf2ece0;
    addBody(rig, b, look, {
      shirt: null,
      chestPaint: (p) => (p.z > 0.04 && (Math.abs(p.x) < 0.02 || (Math.abs(p.y - 0.2) < 0.02 && Math.abs(p.x) < 0.15)) ? paintW : null),
      sleeve: null,
      legs: null,
      feet: 0x5a3c26,
    });
    addSkirt(rig, b, clothFn(team, 0xeadfc4, 1, -0.62, 0.08), 0.62, 0.12, 0.16, true);
    addBelt(rig, b, 0x4a3020);
    addBand(rig, 'armL', 0.075, -0.1, team, 0.05);
    addBand(rig, 'armR', 0.075, -0.1, team, 0.05);
    addNecklace(rig, b, 0xf0e8d8, 11, 0.032);
    const pend = blob(0.05, 0.06, 0.03);
    place(pend, 0, b.torsoLen * 0.36, b.chestR * b.depth + 0.05);
    paint(pend, mix(civ.accent, 0xffffff, 0.3));
    shine(pend, civ.accent, 2.5);
    rig.add('chest', pend);
    addHead(rig, b, look, {
      brow: 0.2,
      paint: (p) => (p.z > 0.1 && Math.abs(p.y + 0.02) < 0.02 && Math.abs(p.x) > 0.04 ? paintW : null),
    });
    addHair(rig, b, look, r);
    // feather cloak: three overlapping tiers of feathers with scalloped,
    // pale-tipped hems over a long cloak; each tier a shade deeper
    const featherFn = (p: THREE.Vector3) => {
      const streak = Math.sin(Math.atan2(p.x, -p.z + 0.15) * 8 + 3) > 0.55 ? 0.86 : 1; // quill lines along the folds
      return tint(team, (0.95 - Math.min(0.35, -p.y * 0.22)) * streak);
    };
    addCloak(rig, b, featherFn, tint(team, 0.5), 1.55, 1.15, 0xeadfc4, {
      hem: 'scallop', folds: 8, drape: 0.24, hemTrim: 0xeadfc4, tiers: [0.36, 0.6, 0.82], segs: 40,
      tierColor: (p) => {
        const streak = Math.sin(Math.atan2(p.x, -p.z + 0.15) * 8 + 3) > 0.55 ? 0.88 : 1;
        return tint(team, (1.12 - Math.min(0.4, -p.y * 0.3)) * streak);
      },
      mantle: (p) => (p.y < b.torsoLen * 0.64 - 0.17 ? tint(team, 1.15) : 0xf2ead8),
      mantleLen: 0.26,
    });
    // antlers
    for (const sx of [1, -1]) {
      const base = new THREE.Vector3(sx * b.headR * 0.55, c.y + b.headR * 0.7, c.z);
      const main = [base, base.clone().add(new THREE.Vector3(sx * 0.18, 0.18, -0.02)), base.clone().add(new THREE.Vector3(sx * 0.3, 0.42, -0.06)), base.clone().add(new THREE.Vector3(sx * 0.28, 0.68, -0.1))];
      const ant = tube(main, 0.035, 14, 5, 0.35);
      paint(ant, 0xe2d4b6);
      rig.add('head', ant);
      for (let k = 1; k <= 3; k++) {
        const s = main[k].clone().lerp(main[k - 1], 0.4);
        const tine = tube([s, s.clone().add(new THREE.Vector3(sx * 0.06 * (k % 2 ? 1 : -0.5), 0.16, 0.06))], 0.022, 5, 4, 0.3);
        paint(tine, 0xe2d4b6);
        rig.add('head', tine);
      }
    }
    // feather fan behind the head
    for (let i = 0; i < 9; i++) {
      const a = -1.1 + i * 0.275;
      const f = feather(0.55 - Math.abs(i - 4) * 0.035, 0.065, i % 2 ? 0xf2ead8 : team, i % 2 ? team : 0x1d1a18);
      place(f, c.x + Math.sin(a) * 0.1, c.y + b.headR * 0.2, c.z - b.headR * 0.8, -0.35, 0, -a);
      rig.add('head', f);
    }
    const band = torus(b.headR * 1.04, 0.035, 5, 18);
    place(band, c.x, c.y + b.headR * 0.35, c.z, Math.PI / 2 - 0.2, 0, 0);
    paint(band, (p) => (Math.sin(Math.atan2(p.x, p.z) * 10) > 0 ? team : 0xeadfc4));
    rig.add('head', band);
  } else if (civ.id === 'dynasty') {
    // THE GOD-KING — tall gold crown, broad jewelled collar, a cape of office.
    look.skin = r.pick([0xb07546, 0xcf9563, 0x8f5a36]);
    look.hair = 0x18120f;
    look.hairStyle = 'bald';
    const linen = 0xf0e8d6;
    addBody(rig, b, look, {
      shirt: (p) => (p.y < b.torsoLen * 0.35 ? linen : look.skin),
      sleeve: null,
      legs: null,
      feet: 0xc9a050,
    });
    addRobe(rig, b, (p) => {
      // pleated linen with a team-colour apron panel down the front
      if (p.z > 0.05 && Math.abs(p.x) < 0.09) return Math.floor(-p.y / 0.12) % 2 ? team : tint(team, 0.75);
      return Math.sin(Math.atan2(p.x, p.z) * 18) > 0.4 ? tint(linen, 0.9) : linen;
    }, 0.14);
    addBelt(rig, b, team);
    addHead(rig, b, look, {
      brow: 0.15,
      // kohl-lined eyes
      paint: (p) => (p.z > 0.1 && Math.abs(p.y + 0.0) < 0.035 && Math.abs(p.x) > 0.04 && Math.abs(p.x) < 0.16 ? 0x2a1c14 : null),
    });
    // gold collar (glossy)
    const collar = lathe([[b.chestR * 0.55, b.torsoLen * 0.6], [b.chestR * 1.05, b.torsoLen * 0.52], [b.chestR * 1.35, b.torsoLen * 0.4], [b.chestR * 1.38, b.torsoLen * 0.37]], 22, 1, b.depth * 1.15);
    paint(collar, (p) => {
      const rr = Math.hypot(p.x, p.z / b.depth);
      return Math.floor(rr / 0.045) % 2 ? 0xf0c75e : team;
    });
    gold.add('chest', collar);
    for (const side of ['L', 'R'] as const) {
      const cuff = torus(0.065, 0.022, 5, 14);
      place(cuff, 0, -0.38, 0, Math.PI / 2, 0, 0);
      paint(cuff, 0xf0c75e);
      gold.add(`fore${side}`, cuff);
      const arm = torus(0.078, 0.02, 5, 14);
      place(arm, 0, -0.14, 0, Math.PI / 2, 0, 0);
      paint(arm, 0xf0c75e);
      gold.add(`arm${side}`, arm);
    }
    // cape of office in team colour, gold-lined
    // cape of office: deep team colour, a gold sun disc on the back, a
    // shorter overcape with a gold-pointed hem, a tall flared collar
    const sunFn = (p: THREE.Vector3) => {
      const d = Math.hypot(p.x, p.y + 0.98);
      if (d < 0.1 || (d > 0.15 && d < 0.2)) return 0xf0c75e;
      return Math.abs(p.x) > 0.4 ? tint(team, 0.72) : tint(team, 0.92);
    };
    addCloak(rig, b, sunFn, 0xd8a840, 1.5, 1.12, 0xf0c75e, {
      hem: 'straight', folds: 9, drape: 0.22, hemTrim: 0xf0c75e, tiers: [0.42], seed: 2, segs: 44,
      tierColor: (p) => (Math.floor(Math.atan2(p.x, -p.z) * 5) % 2 ? tint(team, 0.6) : tint(team, 0.5)),
    });
    // the crown: a tall tiered white-and-gold mitre with a burning jewel
    const crown = lathe([
      [b.headR * 1.0, 0], [b.headR * 1.04, 0.08], [b.headR * 0.95, 0.2], [b.headR * 1.02, 0.34], [b.headR * 0.9, 0.5], [b.headR * 0.62, 0.66], [b.headR * 0.4, 0.74], [0.001, 0.76],
    ], 16);
    place(crown, c.x, c.y + b.headR * 0.42, c.z - 0.02, -0.12, 0, 0);
    paint(crown, (p) => {
      const y = p.y - (c.y + b.headR * 0.42);
      if (y < 0.08) return 0xf0c75e;
      if (y > 0.3 && y < 0.36) return 0xf0c75e;
      return y < 0.3 ? team : 0xf4ecd8;
    });
    gold.add('head', crown);
    const jewel = blob(0.05, 0.06, 0.03, 8, 6);
    place(jewel, c.x, c.y + b.headR * 0.62, c.z + b.headR * 1.0);
    paint(jewel, 0xffe9a0);
    shine(jewel, civ.accent, 3);
    gold.add('head', jewel);
    // cobra-like uraeus? no — a rising sun crest
    const crest = lathe([[0.001, 0], [0.08, 0.02], [0.1, 0.1], [0.001, 0.2]], 8, 1, 0.3);
    place(crest, c.x, c.y + b.headR * 0.8, c.z + b.headR * 0.95);
    paint(crest, 0xf0c75e);
    gold.add('head', crest);
    // gold earrings
    for (const sx of [1, -1]) {
      const ring = torus(0.035, 0.01, 4, 10);
      place(ring, c.x + sx * b.headR * 0.95, c.y - b.headR * 0.35, c.z);
      paint(ring, 0xf0c75e);
      gold.add('head', ring);
    }
  } else {
    // THE FAR-SEER — a wolf's head for a hood, a beard to the belt, furs to the ground.
    look.skin = r.pick([0xf0c8a2, 0xe2ae80]);
    look.hair = 0xd6d2ca;
    look.hairStyle = 'cap';
    look.beard = true;
    const wolf = 0x8a8478;
    addBody(rig, b, look, {
      shirt: shirtFn(b, look, team, 0xeadfc4, false),
      sleeve: team,
      sleeveLen: 'long',
      legs: 0x4a4038,
      feet: 0x6a5a48,
    });
    addSkirt(rig, b, clothFn(team, 0xeadfc4, 2, -0.7, 0.08), 0.7, 0.1);
    addBelt(rig, b, 0x3a2a20, 0x5a3c26);
    addFurMantle(rig, b, wolf, 1.15, 5);
    // wolf-pelt cloak: ragged fur in two layers over a team-coloured lining,
    // a dark fur hem, the wolf's tail hanging down the back
    const peltFn = (p: THREE.Vector3) => (Math.sin(p.x * 35 + p.y * 12) > 0.35 ? tint(wolf, 0.82) : Math.sin(p.x * 13 - p.y * 7) > 0.6 ? tint(wolf, 1.12) : wolf);
    addCloak(rig, b, peltFn, tint(team, 0.8), 1.55, 1.2, undefined, {
      hem: 'ragged', folds: 7, drape: 0.22, hemTrim: tint(team, 0.85), tiers: [0.5], seed: 7, segs: 36,
      // the pelt's dark dorsal stripe runs down the middle of the back
      tierColor: (p) => (Math.abs(p.x) < 0.07 + p.y * 0.05 ? tint(wolf, 0.6) : Math.sin(p.x * 40 + p.y * 20) > 0.2 ? tint(wolf, 1.15) : wolf),
    });
    const wtail = capsule(0.085, 0.04, 0.62, 9, 1, 0.8);
    paint(wtail, (p) => (p.y < -0.5 ? 0xeeeae2 : Math.sin(p.y * 40) > 0.4 ? tint(wolf, 0.6) : tint(wolf, 0.75)));
    place(wtail, 0, 0.12, -0.3, 0.2, 0, 0);
    rig.add('cloak3', wtail);
    addHead(rig, b, look, { brow: 0.3 });
    addHair(rig, b, look, r);
    // long braided beard extension
    const braid = capsule(b.headR * 0.18, b.headR * 0.08, 0.42, 7);
    place(braid, c.x, c.y - b.headR * 0.85, c.z + b.headR * 0.72, 0.15, 0, 0);
    paint(braid, (p) => (Math.sin(p.y * 60) > 0.3 ? 0xeeeae2 : 0xc8c4bc));
    rig.add('head', braid);
    // wolf hood: pelt over the head, snout above the brow, ears up
    const pelt = dome(b.headR * 1.22, 1.9, 16, 9);
    place(pelt, c.x, c.y + b.headR * 0.08, c.z - b.headR * 0.1, -0.45, 0, 0);
    paint(pelt, (p) => (Math.sin(p.x * 40 + p.z * 30) > 0.3 ? tint(wolf, 0.85) : wolf));
    rig.add('head', pelt);
    const snout = capsule(b.headR * 0.32, b.headR * 0.2, b.headR * 0.85, 9, 1, 0.8);
    place(snout, c.x, c.y + b.headR * 0.95, c.z + b.headR * 0.35, -1.75, 0, 0);
    paint(snout, (p) => (p.y < -b.headR * 0.7 ? 0x1d1a18 : wolf));
    rig.add('head', snout);
    for (const sx of [1, -1]) {
      const ear = cone(b.headR * 0.22, b.headR * 0.5, 5);
      place(ear, c.x + sx * b.headR * 0.45, c.y + b.headR * 1.15, c.z - b.headR * 0.1, -0.2, 0, -sx * 0.25);
      paint(ear, tint(wolf, 0.8));
      rig.add('head', ear);
      const eye = blob(0.025, 0.02, 0.02, 5, 4);
      place(eye, c.x + sx * b.headR * 0.28, c.y + b.headR * 1.1, c.z + b.headR * 0.62);
      paint(eye, 0xffd27a);
      shine(eye, 0xffb030, 1.5);
      rig.add('head', eye);
    }
    // pelt paws draped over the shoulders
    for (const sx of [1, -1]) {
      const paw = capsule(0.07, 0.05, 0.35, 7, 1, 0.6);
      place(paw, sx * 0.14, b.torsoLen * 0.55, b.chestR * b.depth + 0.04, 0.15, 0, 0);
      paint(paw, wolf);
      rig.add('chest', paw);
    }
    addNecklace(rig, b, 0xe8e0cc, 9, 0.026, 0x9ad0e0);
  }

  rig.add('propR', st.shaft);
  rig.add('charm', st.head);
  return {
    geo: rig.finish(), gloss: civ.id === 'dynasty' ? gold.finish() : null, offsets, body: b, stature: 2.82,
    style: style({ holdR: 'staff', leader: true, cloak: true, robe: civ.id === 'dynasty' }), aura, headTop: headTop(rig, b),
  };
}

// --- Wanderer ----------------------------------------------------------------

function wanderer(r: Rng): Recipe {
  const b = defaultBody();
  Object.assign(b, { limb: 0.9, chestR: 0.2, waistR: 0.16, hipR: 0.18, legLen: 0.84, headR: 0.25, shoulderW: 0.26 });
  const look = baseLook(r, TRIBE_COLORS.wild);
  look.skin = mix(look.skin, 0x6a5040, 0.15);
  look.hairStyle = 'wild';
  look.beard = r.chance(0.7);
  look.hair = r.pick([0x3b2a1e, 0x5a3a22, 0x6a6058, 0x2a1d15]);
  const hide = r.pick([0x8a7a62, 0x7a6a54, 0x958772]);
  const offsets = restOffsets(b);
  const rig = new Rig(offsets);
  addBody(rig, b, look, {
    shirt: null,
    chestPaint: (p) => (Math.sin(p.x * 31 + p.y * 17) > 0.92 ? mix(look.skin, 0x3a2a1e, 0.35) : null),
    legs: null,
    feet: null,
  });
  addSkirt(rig, b, (p) => (Math.sin(p.x * 25 + p.y * 40) > 0.5 ? tint(hide, 0.85) : hide), 0.38, 0.09, 0.14, true);
  // one-shoulder hide wrap
  addSash(rig, b, tint(hide, 0.9), 0.08);
  const cord = torus(b.waistR * 1.06, 0.018, 4, 16);
  place(cord, 0, 0.1, 0, Math.PI / 2, 0, 0);
  cord.scale(1, 1, b.depth * 1.05);
  paint(cord, 0x6a5a40);
  rig.add('spine', cord);
  addHead(rig, b, look, { brow: -0.1 });
  addHair(rig, b, look, r);
  // a walking stick, crooked
  const stick = tube([
    new THREE.Vector3(0, 0, -0.85), new THREE.Vector3(0.02, 0.02, -0.2), new THREE.Vector3(-0.02, 0, 0.3), new THREE.Vector3(0.03, -0.04, 0.45),
  ], 0.025, 10, 5);
  paint(stick, 0x6a5038);
  rig.add('propR', stick);
  return {
    geo: rig.finish(), gloss: null, offsets, body: b, stature: 2.2,
    style: style({ hunch: 0.38, holdR: 'staff' }), aura: null, headTop: headTop(rig, b),
  };
}

// keep tree-shakers honest about helpers used only in some recipes
void flip; void cone; void merge; void rbox;
