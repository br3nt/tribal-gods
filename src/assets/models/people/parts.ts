/**
 * assets/models/people/parts.ts — the body-part kit.
 *
 * A person = base body (skin) + clothing layers + hair + gear. Each helper
 * here adds one layer to a Rig in the bone-local space of whatever it
 * hangs from. Recipes in recipes.ts call these in order, like dressing a
 * doll: body, then tunic, belt, sash, then hair, then the hat.
 *
 * Proportions are stylised on purpose: heads ~1/4.6 of the height, big
 * hands and feet, slightly long arms. At RTS distance a figure is ~60px
 * tall — exaggeration is what survives the trip.
 */

import * as THREE from 'three';
import {
  blob, capsule, cone, cyl, dome, G, hsl, lathe, mix, paint, place, rbox, setLatheStep, shade, shine, tint, torus, tube,
} from '../geometry';
import { Rng } from '../rng';
import { Body, BoneName, CLOAK_SEG, Rig } from './rig';

export type HairStyle = 'cap' | 'bun' | 'long' | 'tail' | 'braids' | 'mohawk' | 'wild' | 'bald' | 'crop';

export interface Look {
  skin: number;
  hair: number;
  /** Team colour — the main cloth. */
  cloth: number;
  /** Natural-dye trim colour. */
  trim: number;
  /** Leather. */
  leather: number;
  hairStyle: HairStyle;
  beard: boolean;
  /** 0 plain, 1 hem zigzag, 2 stripes, 3 checks. */
  pattern: number;
  eye: number;
}

export const SKINS = [0xf0c8a2, 0xe2ae80, 0xcf9563, 0xb07546, 0x8f5a36, 0x6e432a];
export const HAIRS = [0x2a1d15, 0x3b2a1e, 0x5a3a22, 0x7a4424, 0x18120f, 0x9a7444];
export const TRIMS = [0xeadfc4, 0x3a2f28, 0xc98c3a, 0x8a3f2c, 0x5f6b3a];
export const LEATHERS = [0x6b4a2e, 0x5a3c26, 0x7d5734, 0x4a3324];

const tmp = new THREE.Vector3();

/** Thigh-following weights for skirts/robes hanging from the hips. */
export function skirtWeights(reach: number, k = 0.85) {
  return (p: THREE.Vector3): Array<[BoneName, number]> => {
    const d = THREE.MathUtils.clamp(-p.y / reach, 0, 1) * k;
    const s = THREE.MathUtils.clamp(0.5 + p.x / 0.22, 0, 1);
    return [['hips', 1 - d], ['thighL', d * s], ['thighR', d * (1 - s)]];
  };
}

/** Patterned cloth colour: a function of position for paint(). */
export function clothFn(base: number, trim: number, pattern: number, hemY: number, hemH = 0.06) {
  const dark = tint(base, 0.78);
  return (p: THREE.Vector3) => {
    const ang = Math.atan2(p.x, p.z);
    if (pattern === 1) {
      const zig = Math.abs(((ang * 8) / Math.PI) % 2) - 1; // -1..1 triangle-ish
      if (p.y < hemY + hemH + zig * hemH * 0.6) return trim;
    } else if (pattern === 2) {
      if (p.y < hemY + hemH) return trim;
      if (Math.floor((p.y - hemY) / 0.07) % 3 === 0) return dark;
    } else if (pattern === 3) {
      if (p.y < hemY + hemH) return dark;
      if ((Math.floor(ang * 4) + Math.floor(p.y / 0.08)) % 2 === 0) return mix(base, trim, 0.25);
    } else if (p.y < hemY + hemH * 0.7) return dark;
    return base;
  };
}

// ---------------------------------------------------------------------------
// Base body
// ---------------------------------------------------------------------------

export interface BodyOpts {
  /** Colour of the upper arms (sleeves) — default skin. */
  sleeve?: number | null;
  sleeveLen?: 'none' | 'short' | 'long';
  /** Leg colour (leggings) — default skin. */
  legs?: number | null;
  /** Shoe/wrap colour — null = barefoot. */
  feet?: number | null;
  /** Hide the lower legs (long robes). */
  noLegs?: boolean;
  /** Torso clothing colour fn (null = bare skin). */
  shirt?: ((p: THREE.Vector3) => number) | null;
  /** Bare-chest paint (war paint etc.), applied over skin. */
  chestPaint?: (p: THREE.Vector3) => number | null;
}

/**
 * A muscled limb hanging from its joint (origin) down to y = −len, with
 * domed ends. `radii` samples the radius along t = 0 (joint) … 1 (end) and
 * is eased between samples; `front`/`back` add depth on the +z/−z side as
 * a function of t (biceps, quads, calves), `sx` squashes the width. The
 * profile is what makes a limb read as an arm rather than a dowel: full at
 * the shoulder, narrow at the elbow, a forearm belly, a slim wrist.
 */
export function limb(
  len: number,
  radii: Array<[number, number]>,
  segs = 10,
  o: { front?: (t: number) => number; back?: (t: number) => number; sx?: number } = {},
): G {
  const rAt = (t: number) => {
    if (t <= radii[0][0]) return radii[0][1];
    for (let i = 1; i < radii.length; i++) {
      const [t1, r1] = radii[i];
      const [t0, r0] = radii[i - 1];
      if (t <= t1) {
        const k = (t - t0) / Math.max(1e-6, t1 - t0);
        return r0 + (r1 - r0) * k * k * (3 - 2 * k);
      }
    }
    return radii[radii.length - 1][1];
  };
  const r0 = rAt(0);
  const r1 = rAt(1);
  const prof: Array<[number, number]> = [];
  const cap = 4;
  for (let i = 0; i <= cap; i++) {
    const a = (i / cap) * (Math.PI / 2);
    prof.push([Math.sin(a) * r1, -len - Math.cos(a) * r1 * 0.8]);
  }
  const mid = 9;
  for (let i = mid - 1; i >= 1; i--) {
    const t = i / mid;
    prof.push([rAt(t), -len * t]);
  }
  for (let i = cap; i >= 0; i--) {
    const a = (i / cap) * (Math.PI / 2);
    prof.push([Math.sin(a) * r0, Math.cos(a) * r0 * 0.8]);
  }
  const geo = lathe(prof, segs);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    const t = THREE.MathUtils.clamp(-tmp.y / len, 0, 1);
    const f = tmp.z > 0 ? o.front?.(t) ?? 0 : o.back?.(t) ?? 0;
    pos.setXYZ(i, tmp.x * (o.sx ?? 1), tmp.y, tmp.z * (1 + f));
  }
  geo.computeVertexNormals();
  return geo;
}

/** A bump centred at t = c with half-width w and height h (for limb() front/back). */
export const bump = (c: number, w: number, h: number) => (t: number) => {
  const d = Math.abs(t - c) / w;
  return d >= 1 ? 0 : h * (1 - d * d) * (1 - d * d);
};

/** Limb thickness scale: a gentler curve than b.limb so heavies don't balloon. */
export const limbScale = (b: Body) => 1.1 * (0.35 + 0.65 * b.limb);

/** How far the hips reach sideways (thigh tops included) — skirts must clear this. */
export function hipSpan(b: Body): number {
  return Math.max(b.hipR, b.hipW + 0.12 * limbScale(b));
}

export function addBody(rig: Rig, b: Body, look: Look, o: BodyOpts = {}): void {
  const L = limbScale(b);
  const skin = look.skin;
  const skinShade = (geo: G) => shade(geo, (p) => 0.9 + 0.1 * THREE.MathUtils.clamp(p.y * 2 + 0.6, 0, 1));
  const shirtAt = (y: number) => (o.shirt ? o.shirt(tmp.set(0, y, 0)) : skin);

  // --- pelvis + belly (spine bone) ---
  // The pelvis is wide enough to seat the thighs, so legs grow out of hips
  // instead of poking from under a narrow vase.
  const tl = b.torsoLen;
  const hipR = hipSpan(b);
  const pelvis = lathe([
    [0.02, -0.19], [hipR * 0.72, -0.17], [hipR * 0.97, -0.09], [hipR, 0.0],
    [(hipR + b.waistR) / 2, 0.12], [b.waistR, tl * 0.3], [b.waistR * 1.02, tl * 0.44],
  ], 16, 1, b.depth);
  paint(pelvis, o.shirt ? o.shirt : skin);
  rig.add('spine', pelvis);

  // --- chest (chest bone) ---
  const neckR = 0.095 * (b.limb * 0.3 + 0.7);
  const chestProfile: Array<[number, number]> = [
    [b.waistR * 1.02, -0.03], [b.chestR * 0.97, 0.1], [b.chestR, tl * 0.32],
    [b.chestR * 0.9, tl * 0.47], [b.chestR * 0.55, tl * 0.56], [neckR * 1.2, tl * 0.6], [neckR, tl * 0.62],
  ];
  const chest = lathe(chestProfile, 14, 1, b.depth);
  paint(chest, (p) => {
    if (o.shirt) return o.shirt(p);
    const c = o.chestPaint?.(p);
    return c ?? skin;
  });
  rig.add('chest', chest, { soft: 0.07 });
  if (b.female && !o.shirt) {
    // modesty wrap for bare-chested women: a band in cloth colour
    const band = lathe([[b.chestR * 1.03, 0.06], [b.chestR * 1.05, 0.12], [b.chestR * 1.03, 0.2]], 14, 1, b.depth * 1.04);
    paint(band, look.cloth);
    rig.add('chest', band);
  }
  // pectoral/back volume so the torso isn't a perfect vase
  if (!b.female) {
    const pec = blob(b.chestR * 0.9, 0.09, 0.06, 10, 6);
    place(pec, 0, tl * 0.3, b.chestR * b.depth * 0.78);
    paint(pec, o.shirt ? o.shirt(tmp.set(0, tl * 0.3, 1)) : skin);
    rig.add('chest', pec);
  }
  // Shoulder yoke: a rounded bar across the top of the torso that carries
  // the chest out to the shoulder joints — square, readable shoulders.
  const yoke = blob(b.shoulderW * 0.98, 0.1 * L, b.chestR * b.depth * 0.86, 14, 8);
  place(yoke, 0, tl * 0.44, -0.012);
  paint(yoke, o.shirt ? o.shirt : skin);
  rig.add('chest', yoke);
  // Trapezius: slopes from the neck down onto the yoke.
  const trap = lathe([[b.shoulderW * 0.62, tl * 0.47], [neckR * 1.55, tl * 0.56], [neckR * 1.05, tl * 0.64]], 14, 1, b.depth * 0.95);
  paint(trap, o.shirt ? o.shirt : skin);
  rig.add('chest', trap);

  // --- neck & head ---
  const neck = lathe([[neckR * 1.3, -0.02], [neckR * 1.02, b.neckLen * 0.4], [neckR * 0.96, b.neckLen + 0.06], [neckR * 0.5, b.neckLen + 0.1]], 10);
  paint(neck, skin);
  shade(neck, (p) => 0.88 + 0.12 * THREE.MathUtils.clamp(p.y / (b.neckLen + 0.1), 0, 1)); // chin shadow on the throat
  rig.add('neck', neck, { soft: 0.05 });
  addHead(rig, b, look);

  // --- arms ---
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const upperLen = b.armLen * 0.52;
    const foreLen = b.armLen * 0.48;
    const sleeve = o.sleeve ?? null;
    const sleeveLen = o.sleeveLen ?? (sleeve ? 'short' : 'none');
    // deltoid: a full cap that rounds the shoulder into the yoke
    const delt = blob(0.118 * L, 0.125 * L, 0.112 * L, 12, 8);
    place(delt, sx * 0.012, -0.03, 0);
    paint(delt, sleeve !== null && sleeveLen !== 'none' ? sleeve : shirtAt(tl * 0.4));
    rig.add(`arm${side}`, delt, { soft: 0.06 });

    // upper arm: full at the shoulder, a biceps belly in front, narrow at the elbow
    const upper = limb(upperLen, [[0, 0.104 * L], [0.35, 0.098 * L], [0.75, 0.08 * L], [1, 0.07 * L]], 12, {
      front: bump(0.45, 0.4, 0.16), back: bump(0.3, 0.35, 0.08),
    });
    paint(upper, (p) => (sleeve !== null && (sleeveLen === 'long' || p.y > -upperLen * 0.55) ? sleeve : skin));
    skinShade(upper);
    rig.add(`arm${side}`, upper, { soft: 0.07 });
    if (sleeve !== null && sleeveLen === 'short') {
      const cuff = torus(0.094 * L, 0.018, 5, 16);
      place(cuff, 0, -upperLen * 0.55, 0, Math.PI / 2, 0, 0);
      paint(cuff, tint(sleeve, 0.8));
      rig.add(`arm${side}`, cuff);
    }

    // forearm: a meaty belly just below the elbow, tapering to a slim wrist
    const fore = limb(foreLen, [[0, 0.074 * L], [0.22, 0.086 * L], [0.65, 0.07 * L], [1, 0.056 * L]], 12, {
      back: bump(0.25, 0.3, 0.1), sx: 1.05,
    });
    paint(fore, sleeve !== null && sleeveLen === 'long' ? (p) => (p.y > -foreLen * 0.8 ? sleeve : skin) : skin);
    skinShade(fore);
    rig.add(`fore${side}`, fore, { soft: 0.07 });
    if (sleeve !== null && sleeveLen === 'long') {
      const cuff = torus(0.07 * L, 0.02, 5, 16);
      place(cuff, 0, -foreLen * 0.8, 0, Math.PI / 2, 0, 0);
      paint(cuff, tint(sleeve, 0.8));
      rig.add(`fore${side}`, cuff);
    }

    addHand(rig, `hand${side}`, b.handR * (0.88 + L * 0.12), skin, sx);
  }

  // --- legs ---
  const legC = o.legs ?? skin;
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const thighLen = b.legLen * 0.52;
    const shinLen = b.legLen * 0.48;
    // thigh: heavy at the hip with a quad swell in front, narrowing to the knee
    const thigh = limb(thighLen, [[0, 0.14 * L], [0.3, 0.132 * L], [0.8, 0.1 * L], [1, 0.09 * L]], 12, {
      front: bump(0.4, 0.45, 0.12), back: bump(0.15, 0.3, 0.1), sx: 0.96,
    });
    paint(thigh, legC);
    rig.add(`thigh${side}`, thigh, { soft: 0.08 });
    if (o.noLegs) continue;
    // shin: a round knee, a real calf at the back, a slim ankle
    const shin = limb(shinLen, [[0, 0.092 * L], [0.28, 0.1 * L], [0.65, 0.078 * L], [1, 0.062 * L]], 12, {
      back: bump(0.3, 0.32, 0.38), front: bump(0.02, 0.15, 0.08),
    });
    paint(shin, legC);
    rig.add(`shin${side}`, shin, { soft: 0.08 });
    // foot: heel, arch and a broad rounded toe box
    const footC = o.feet ?? skin;
    const fl = 0.17 * (0.55 + 0.45 * L);
    const fw = 0.085 * L;
    const foot = blob(fw, 0.06, fl * 0.62, 12, 8);
    place(foot, sx * 0.01, -b.footH + 0.055, fl * 0.32);
    const toe = blob(fw * 1.06, 0.05, fl * 0.34, 10, 6);
    place(toe, sx * 0.012, -b.footH + 0.045, fl * 0.72);
    const heel = blob(fw * 0.82, 0.06, fl * 0.3, 8, 6);
    place(heel, 0, -b.footH + 0.06, -fl * 0.08);
    for (const g of [foot, toe, heel]) {
      paint(g, (p) => (p.y < -b.footH + 0.022 && o.feet ? tint(footC, 0.7) : footC)); // a darker sole edge
      rig.add(`foot${side}`, g);
    }
    if (o.feet) {
      // ankle wrap: two turns of binding
      for (let k = 0; k < 2; k++) {
        const wrap = torus(0.064 * L, 0.018, 5, 14);
        place(wrap, 0, -shinLen + 0.03 + k * 0.05, 0, Math.PI / 2 + (k ? 0.18 : -0.12), 0, 0);
        paint(wrap, tint(footC, k ? 1.12 : 0.9));
        rig.add(`shin${side}`, wrap);
      }
    }
  }
}

/** A mitten hand: palm, a curled finger block with knuckles, and a thumb. */
export function addHand(rig: Rig, bone: BoneName, r: number, skin: number, sx: number): void {
  const palm = blob(r * 0.86, r * 0.95, r * 0.55, 10, 7);
  place(palm, 0, -r * 0.75, 0.005);
  const fingers = blob(r * 0.82, r * 0.7, r * 0.5, 10, 7);
  place(fingers, 0, -r * 1.45, r * 0.12, 0.35, 0, 0);
  const knuckles = capsule(r * 0.22, r * 0.22, r * 1.25, 6);
  place(knuckles, sx * r * 0.62, -r * 1.25, r * 0.28, 0, 0, -Math.PI / 2 * sx);
  const thumb = limb(r * 0.85, [[0, r * 0.32], [1, r * 0.24]], 7);
  place(thumb, sx * r * 0.62, -r * 0.45, r * 0.25, 0.45, 0, sx * 0.55);
  for (const g of [palm, fingers, knuckles, thumb]) paint(g, skin);
  shade(fingers, () => 0.95);
  rig.add(bone, palm, { soft: 0.03 });
  rig.add(bone, fingers);
  rig.add(bone, knuckles);
  rig.add(bone, thumb);
}

/** Head centre in head-bone space. */
export function headCentre(b: Body): THREE.Vector3 {
  return new THREE.Vector3(0, b.headR * 0.88, 0.015);
}

export interface FaceOpts {
  /** Paint over the face (war paint / soot): returns a colour or null. */
  paint?: (p: THREE.Vector3) => number | null;
  /** Skip eyes/brows (masked faces). */
  masked?: boolean;
  /** Frown/brow angle: positive = fierce. */
  brow?: number;
  eyeScale?: number;
}

export function addHead(rig: Rig, b: Body, look: Look, f: FaceOpts = {}): void {
  const r = b.headR;
  const c = headCentre(b);
  // Skull: slightly egg-shaped, wider at the cheeks, a gentle jaw.
  const skull = blob(r * 0.96, r * 1.04, r * 0.98, 16, 12);
  // jaw: pull the lower front forward/narrow the chin
  const pos = skull.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    if (tmp.y < 0) {
      const k = -tmp.y / r;
      tmp.x *= 1 - k * 0.18;
      if (tmp.z > 0) tmp.z *= 1 + k * 0.08;
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
  }
  skull.computeVertexNormals();
  const blush = mix(look.skin, 0xd2645a, 0.22);
  paint(skull, (p) => {
    const fp = f.paint?.(p);
    if (fp !== null && fp !== undefined) return fp;
    // rosy cheeks
    if (p.z > r * 0.55 && Math.abs(p.x) > r * 0.35 && p.y < -r * 0.05 && p.y > -r * 0.5) return blush;
    return look.skin;
  });
  place(skull, c.x, c.y, c.z);
  rig.add('head', skull, { soft: 0.04 });

  // Ears
  for (const sx of [1, -1]) {
    const ear = blob(r * 0.13, r * 0.22, r * 0.1, 7, 5);
    place(ear, c.x + sx * r * 0.93, c.y - r * 0.05, c.z - r * 0.05, 0, sx * 0.3, 0);
    paint(ear, tint(look.skin, 0.93));
    rig.add('head', ear);
  }
  // Nose
  const nose = blob(r * 0.13, r * 0.16, r * 0.15, 7, 5);
  place(nose, c.x, c.y - r * 0.12, c.z + r * 0.93);
  paint(nose, tint(look.skin, 0.96));
  rig.add('head', nose);

  if (f.masked) return;
  // Eyes: dark ovals with a bright catchlight — the "alive" switch.
  const es = f.eyeScale ?? 1;
  for (const sx of [1, -1]) {
    const ex = c.x + sx * r * 0.37;
    const ey = c.y + r * 0.06;
    const ez = c.z + Math.sqrt(Math.max(0, r * r * 0.96 - (sx * r * 0.37) ** 2 - (r * 0.06) ** 2)) - 0.005;
    // Big, dark eyes: at the default camera a face is ~15px, so the eyes
    // and brows have to carry it on their own.
    const eye = blob(r * 0.145 * es, r * 0.205 * es, r * 0.08, 9, 7);
    place(eye, ex, ey, ez, 0, sx * 0.35, 0);
    paint(eye, look.eye);
    rig.add('head', eye);
    const glint = blob(r * 0.05 * es, r * 0.05 * es, r * 0.03, 5, 4);
    place(glint, ex + r * 0.045, ey + r * 0.07, ez + r * 0.055);
    paint(glint, 0xffffff);
    shine(glint, 0xffffff, 0.25);
    rig.add('head', glint);
    // Brow: a short tilted bar of hair colour. Tilt = attitude.
    const brow = capsule(r * 0.075, r * 0.055, r * 0.34, 5);
    const tilt = (f.brow ?? 0.1) * sx;
    place(brow, ex + sx * r * 0.16, ey + r * 0.3, ez + r * 0.0, 0, 0, Math.PI / 2 * sx + tilt);
    paint(brow, tint(look.hair, 0.8));
    rig.add('head', brow);
  }
  // Mouth: a small dark smile line.
  const mouth = capsule(r * 0.05, r * 0.05, r * 0.28, 5);
  place(mouth, c.x + r * 0.14, c.y - r * 0.4, c.z + r * 0.84, 0, 0, Math.PI / 2);
  paint(mouth, mix(look.skin, 0x3a1a14, 0.7));
  rig.add('head', mouth);
}

// ---------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------

export function addHair(rig: Rig, b: Body, look: Look, rnd: Rng): void {
  const r = b.headR;
  const c = headCentre(b);
  const hair = look.hair;
  const hairFn = (p: THREE.Vector3) => (Math.sin(p.x * 60 + p.y * 30) > 0.6 ? tint(hair, 1.18) : hair);
  const capOn = look.hairStyle !== 'bald';
  if (capOn) {
    const cap = dome(r * 1.07, look.hairStyle === 'crop' ? 1.5 : 1.85, 16, 8);
    place(cap, c.x, c.y + r * 0.02, c.z - r * 0.04, -0.55, 0, 0);
    paint(cap, hairFn);
    rig.add('head', cap);
    // fringe: a few lumps over the forehead so it isn't a helmet
    if (look.hairStyle !== 'crop') {
      for (let i = -2; i <= 2; i++) {
        const lump = blob(r * 0.24, r * 0.16, r * 0.14, 7, 5);
        place(lump, c.x + i * r * 0.2, c.y + r * 0.6 - Math.abs(i) * r * 0.06, c.z + r * 0.62 - Math.abs(i) * r * 0.08, 0.4, 0, i * 0.2);
        paint(lump, hair);
        rig.add('head', lump);
      }
    }
  }
  switch (look.hairStyle) {
    case 'bun': {
      const bun = blob(r * 0.38, r * 0.34, r * 0.38, 9, 7, 0.01, rnd.int(99), 9);
      place(bun, c.x, c.y + r * 0.95, c.z - r * 0.45);
      paint(bun, hairFn);
      rig.add('head', bun);
      break;
    }
    case 'long': {
      const back = capsule(r * 0.88, r * 0.62, r * 1.5, 12, 1, 0.55);
      place(back, 0, 0, 0);
      paint(back, hairFn);
      rig.add('tail', back, { weights: (p) => [['head', THREE.MathUtils.clamp(1 + p.y / (r * 0.8), 0, 1)], ['tail', THREE.MathUtils.clamp(-p.y / (r * 0.8), 0, 1)]] });
      break;
    }
    case 'tail': {
      const tie = torus(r * 0.16, r * 0.06, 5, 10);
      place(tie, 0, 0, 0, Math.PI / 2);
      paint(tie, look.trim);
      rig.add('tail', tie);
      const t = capsule(r * 0.22, r * 0.1, r * 1.6, 8);
      paint(t, hairFn);
      rig.add('tail', t, { soft: 0.05 });
      break;
    }
    case 'braids': {
      for (const sx of [1, -1]) {
        const br = capsule(r * 0.16, r * 0.1, r * 1.7, 7);
        warp(br, sx);
        place(br, c.x + sx * r * 0.85, c.y - r * 0.15, c.z - r * 0.2);
        paint(br, (p) => (Math.sin(p.y * 70) > 0.3 ? tint(hair, 1.2) : hair));
        rig.add('head', br);
        const bead = blob(r * 0.12, r * 0.12, r * 0.12, 6, 5);
        place(bead, c.x + sx * r * 0.85, c.y - r * 1.8, c.z - r * 0.2);
        paint(bead, look.trim);
        rig.add('head', bead);
      }
      break;
    }
    case 'mohawk': {
      for (let i = 0; i < 6; i++) {
        const a = -0.4 + i * 0.28;
        const spike = cone(r * 0.16, r * 0.55, 6);
        place(spike, c.x, c.y + Math.cos(a) * r * 1.05, c.z + Math.sin(a) * r * 1.05, a, 0, 0);
        paint(spike, hairFn);
        rig.add('head', spike);
      }
      break;
    }
    case 'wild': {
      const mop = blob(r * 1.3, r * 1.08, r * 1.25, 14, 10, r * 0.22, rnd.int(999), 7);
      place(mop, c.x, c.y + r * 0.25, c.z - r * 0.22);
      // cut the face hole: push front-lower vertices back behind the face
      const pos = mop.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        tmp.fromBufferAttribute(pos, i);
        if (tmp.z - c.z > r * 0.2 && tmp.y < c.y + r * 0.45) {
          pos.setZ(i, c.z + r * 0.2 - (tmp.z - c.z) * 0.15);
        }
      }
      mop.computeVertexNormals();
      paint(mop, hairFn);
      rig.add('head', mop);
      break;
    }
    default:
      break;
  }
  if (look.beard) {
    const beard = blob(r * 0.62, r * 0.55, r * 0.42, 10, 7, r * 0.06, rnd.int(999), 12);
    place(beard, c.x, c.y - r * 0.6, c.z + r * 0.58);
    paint(beard, hairFn);
    rig.add('head', beard);
    const tash = capsule(r * 0.09, r * 0.06, r * 0.5, 5);
    place(tash, c.x + r * 0.25, c.y - r * 0.27, c.z + r * 0.92, 0, 0, Math.PI / 2 + 0.25);
    paint(tash, hair);
    rig.add('head', tash);
  }
}

function warp(geo: G, sx: number): void {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) + sx * y * y * 0.15);
    pos.setZ(i, pos.getZ(i) - y * 0.08);
  }
  geo.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Clothing
// ---------------------------------------------------------------------------

/** Waist-to-knee skirt / kilt / tunic tail hanging from the hips. */
export function addSkirt(rig: Rig, b: Body, color: (p: THREE.Vector3) => number, len: number, flare = 0.08, top = 0.16, slit = false): void {
  const r0 = hipSpan(b) + 0.03;
  const prof: Array<[number, number]> = [
    [b.waistR + 0.02, top], [r0, 0.03], [r0 + flare * 0.4, -len * 0.35], [r0 + flare * 0.8, -len * 0.75], [r0 + flare, -len],
  ];
  const sk = lathe(prof, 18, 1, b.depth * 1.08);
  if (slit) {
    // ragged/split hem: notch the bottom ring
    const pos = sk.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      if (tmp.y < -len * 0.9) {
        const a = Math.atan2(tmp.x, tmp.z);
        pos.setY(i, tmp.y + (Math.sin(a * 7) > 0 ? len * 0.12 : 0));
      }
    }
    sk.computeVertexNormals();
  }
  paint(sk, color);
  rig.add('hips', sk, { weights: skirtWeights(len) });
}

/** A floor-length robe: skirt that reaches the ankles and follows the legs strongly. */
export function addRobe(rig: Rig, b: Body, color: (p: THREE.Vector3) => number, flare = 0.2): void {
  const len = b.legLen + b.footH - 0.04;
  const r0 = hipSpan(b) + 0.035;
  const prof: Array<[number, number]> = [
    [b.waistR + 0.025, 0.2], [r0, 0.02], [r0 + flare * 0.25, -len * 0.3], [r0 + flare * 0.6, -len * 0.7], [r0 + flare, -len + 0.02], [r0 + flare * 0.9, -len],
  ];
  const sk = lathe(prof, 20, 1, b.depth * 1.12);
  paint(sk, color);
  rig.add('hips', sk, { weights: skirtWeights(len, 0.7) });
}

/** Belt with an optional pouch. */
export function addBelt(rig: Rig, b: Body, color: number, pouch?: number): void {
  const belt = torus(b.waistR * 1.06 + 0.012, 0.028, 6, 22);
  place(belt, 0, 0.1, 0, Math.PI / 2, 0, 0, 1, 1, 1);
  belt.scale(1, 1, b.depth * 1.04);
  paint(belt, color);
  rig.add('spine', belt);
  const buckle = rbox(0.07, 0.06, 0.03, 0.01);
  place(buckle, 0, 0.1, b.waistR * b.depth * 1.06 + 0.02);
  paint(buckle, tint(color, 1.4));
  rig.add('spine', buckle);
  if (pouch !== undefined) {
    const p = blob(0.06, 0.07, 0.04, 7, 6);
    place(p, b.waistR * 0.85, 0.02, b.waistR * b.depth * 0.6, 0, 0.6, 0);
    paint(p, pouch);
    rig.add('spine', p);
  }
}

/** Diagonal sash across the chest (team colour, reads from anywhere). */
export function addSash(rig: Rig, b: Body, color: number, width = 0.05, leftShoulder = true): void {
  const sash = torus(1, width, 6, 28);
  // A tilted ellipse wrapping from one shoulder to the opposite hip.
  sash.scale(b.chestR * 1.12, b.torsoLen * 0.5, b.chestR * b.depth * 1.2 + 0.0);
  const s = leftShoulder ? 1 : -1;
  place(sash, 0, b.torsoLen * 0.12, 0, Math.PI / 2, 0, 0);
  // the torus lies in XY after scale; rotate into a diagonal around Z
  sash.rotateX(0);
  sash.rotateZ(0);
  const pos = sash.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    pos.setY(i, tmp.y + tmp.x * 0.85 * s);
  }
  sash.computeVertexNormals();
  paint(sash, color);
  rig.add('chest', sash);
}

export interface CloakOpts {
  /** Collar colour: a raised collar behind the neck. */
  collar?: number;
  /** Number of vertical folds round the back (drape). */
  folds?: number;
  /** Hem outline. */
  hem?: 'straight' | 'scallop' | 'points' | 'ragged';
  /** Colour of a band along the hem. */
  hemTrim?: number;
  /** How far round the body the cloth wraps (1 = to the shoulder line). */
  wrap?: number;
  /** Extra outward drape at the hem (world units). */
  drape?: number;
  /** Shorter overlapping tiers on top of the main cloak (layered hems): lengths as fractions of len. */
  tiers?: number[];
  /** Colour fn for the tiers (defaults to the outer colour). */
  tierColor?: (p: THREE.Vector3) => number;
  /** A shoulder mantle (capelet) over the cloak's top: its colour fn. */
  mantle?: (p: THREE.Vector3) => number;
  /** Mantle length. */
  mantleLen?: number;
  seed?: number;
  /** Segments round the cloak (more = crisper painted motifs). */
  segs?: number;
}

/** One cloth shell hanging from the cloak bone: the back of an ellipse that flares and folds toward the hem. */
function cloakShell(b: Body, len: number, width: number, o: CloakOpts, inset = 0): G {
  const wrap = o.wrap ?? 1.05;
  const A = (Math.PI / 2) * wrap;
  const rows = Math.max(8, Math.round(len / ((o.segs ?? 26) > 30 ? 0.045 : 0.06)));
  const prof: Array<[number, number]> = [];
  for (let i = rows; i >= 0; i--) prof.push([1, -len * (i / rows)]);
  setLatheStep(10); // our own rows; don't refine
  const geo = lathe(prof, o.segs ?? 26, 1, 1, Math.PI - A, 2 * A);
  setLatheStep(0.045);
  const pos = geo.attributes.position;
  const zc = b.chestR * b.depth * 0.75; // ellipse centre sits inside the body
  const folds = o.folds ?? 7;
  const drape = o.drape ?? 0.16;
  const seed = o.seed ?? 3;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i);
    const t = THREE.MathUtils.clamp(-tmp.y / len, 0, 1);
    const a = Math.atan2(tmp.x, -tmp.z); // 0 = straight back
    const rx = b.shoulderW * 0.92 + (width - 1) * 0.2 + 0.2 * Math.sqrt(t) * width + 0.06 * t - inset;
    const rz = zc + 0.045 + drape * t * t + 0.1 * Math.sqrt(t) - inset;
    // vertical folds: deeper toward the hem, strongest across the back
    const fold = Math.sin(a * folds + seed) * (0.02 + 0.075 * t) * (0.6 + 0.4 * Math.cos(a));
    const k = 1 + fold / Math.max(0.1, rx);
    let y = tmp.y;
    if (t > 0.98) {
      const n = folds * 2;
      if (o.hem === 'scallop') y += len * 0.035 * Math.abs(Math.sin(a * n * 0.5));
      else if (o.hem === 'points') y += len * 0.06 * Math.abs(((a * n) / Math.PI) % 2 - 1);
      else if (o.hem === 'ragged') y += len * 0.06 * Math.max(0, Math.sin(a * 11 + seed) * Math.sin(a * 5.3 + seed * 2));
    }
    // the back of the hem swings a touch lower than the sides (it drapes)
    y -= 0.03 * t * Math.cos(a);
    pos.setXYZ(i, Math.sin(a) * rx * k, y, zc - Math.cos(a) * rz * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Weights for cloth that hangs from the shoulders down the back (cloaks): chest → cloak1 → cloak2 → cloak3. */
export function cloakWeights(_len: number) {
  return (p: THREE.Vector3): Array<[BoneName, number]> => {
    const d = Math.max(0, -p.y);
    if (d < 0.12) {
      const k = d / 0.12;
      return [['chest', 1 - k], ['cloak1', k]];
    }
    const s = Math.min(2, (d - 0.06) / CLOAK_SEG);
    const chain: BoneName[] = ['cloak1', 'cloak2', 'cloak3'];
    const i = Math.min(1, Math.floor(s));
    const f = Math.min(1, s - i);
    return [[chain[i], 1 - f], [chain[i + 1], f]];
  };
}

/**
 * A cloak with volume: an outer shell that wraps round the shoulders and
 * flares into vertical folds, a contrasting lining, optional layered tiers
 * with shaped hems, a hem band, a shoulder mantle and a raised collar. It
 * hangs on the cloak1→cloak2→cloak3 chain, so the animator can make it
 * trail, billow and ripple.
 */
export function addCloak(
  rig: Rig, b: Body, outer: (p: THREE.Vector3) => number, inner: number, len: number, width = 1, collar?: number, o: CloakOpts = {},
): void {
  const opts: CloakOpts = { ...o, collar: o.collar ?? collar };
  const hemTrim = opts.hemTrim;
  const withHem = (fn: (p: THREE.Vector3) => number, l: number) => (p: THREE.Vector3) =>
    hemTrim !== undefined && -p.y > l * 0.93 ? hemTrim : fn(p);
  const w = cloakWeights(len);

  const shell = cloakShell(b, len, width, opts);
  paint(shell, withHem(outer, len));
  shade(shell, (p) => 0.84 + 0.16 * THREE.MathUtils.clamp(1 + p.y / len, 0, 1)); // darker toward the hem
  rig.add('cloak1', shell, { weights: w });
  const lining = flip(cloakShell(b, len - 0.01, width, opts, 0.014));
  paint(lining, inner);
  rig.add('cloak1', lining, { weights: w });

  // layered tiers, each a little wider so it sits over the one below
  (opts.tiers ?? []).forEach((f, i) => {
    const tlen = len * f;
    const to: CloakOpts = { ...opts, folds: (opts.folds ?? 7) + i, drape: (opts.drape ?? 0.16) * f + 0.02 * (i + 1), seed: (opts.seed ?? 3) + i * 2 };
    const out = -0.02 * (i + 1);
    const tier = cloakShell(b, tlen, width, to, out);
    paint(tier, withHem(opts.tierColor ?? outer, tlen));
    shade(tier, (p) => 0.9 + 0.1 * THREE.MathUtils.clamp(1 + p.y / tlen, 0, 1));
    rig.add('cloak1', tier, { weights: w });
    const under = flip(cloakShell(b, tlen - 0.01, width, to, out + 0.012));
    paint(under, tint(inner, 0.85));
    rig.add('cloak1', under, { weights: w });
  });

  const tl = b.torsoLen;
  if (opts.mantle) {
    // capelet over the shoulders: a short, round shell open at the front
    const ml = opts.mantleLen ?? 0.3;
    const prof: Array<[number, number]> = [];
    const steps = 6;
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      prof.push([b.chestR * 0.62 + (b.shoulderW + 0.1 - b.chestR * 0.62) * Math.sqrt(t) + 0.06 * t, tl * 0.64 - ml * t]);
    }
    const arc = Math.PI * 1.62;
    const sz = b.depth * 1.12 + 0.12;
    const m = lathe(prof, 26, 1, sz, Math.PI - arc / 2, arc);
    paint(m, opts.mantle);
    rig.add('chest', m);
    const mi = flip(lathe(prof.map(([r, y]) => [r - 0.012, y] as [number, number]), 26, 1, sz, Math.PI - arc / 2, arc));
    paint(mi, tint(inner, 0.8));
    rig.add('chest', mi);
  }
  if (opts.collar !== undefined) {
    // a raised collar standing behind the neck, flaring outward
    const arc = Math.PI * 1.15;
    const prof: Array<[number, number]> = [[b.chestR * 0.6, tl * 0.58], [b.chestR * 0.7, tl * 0.72], [b.chestR * 0.95, tl * 0.86]];
    const c = lathe(prof, 18, 1, b.depth * 1.05, Math.PI - arc / 2, arc);
    paint(c, opts.collar);
    rig.add('chest', c);
    const ci = flip(lathe(prof.map(([r, y]) => [r - 0.015, y] as [number, number]), 18, 1, b.depth * 1.05, Math.PI - arc / 2, arc));
    paint(ci, tint(opts.collar, 0.75));
    rig.add('chest', ci);
  }
}

/** Reverse triangle winding (inner surfaces). */
export function flip(geo: G): G {
  const idx = geo.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  const n = geo.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return geo;
}

/** A fur mantle: lumpy collar of fur over the shoulders. */
export function addFurMantle(rig: Rig, b: Body, color: number, size = 1, seed = 3): void {
  // A collar of overlapping shaggy tufts round the neck and over the shoulders.
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rx = b.chestR * 0.8 * size + 0.02;
    const rz = b.chestR * b.depth * 0.95 + 0.02;
    const shoulder = Math.abs(Math.sin(a)); // 1 at the sides
    const tuft = blob(0.11 * size, 0.085 * size, 0.1 * size, 9, 6, 0.025 * size, seed + i, 11);
    place(tuft, Math.sin(a) * (rx + shoulder * 0.05 * size), b.torsoLen * (0.52 - shoulder * 0.05), Math.cos(a) * rz, 0, a, 0);
    const tc = i % 3 === 0 ? tint(color, 1.15) : i % 3 === 1 ? color : tint(color, 0.88);
    paint(tuft, (p) => (Math.sin(p.x * 70 + p.y * 53 + p.z * 41) > 0.3 ? tint(tc, 1.12) : tc));
    rig.add('chest', tuft);
  }
  for (const sx of [1, -1]) {
    const pad = blob(0.15 * size, 0.11 * size, 0.15 * size, 10, 7, 0.03 * size, seed + sx, 9);
    place(pad, sx * (b.shoulderW - 0.02), b.torsoLen * 0.46, 0);
    paint(pad, (p) => (Math.sin(p.x * 50 + p.y * 37) > 0.1 ? tint(color, 0.88) : color));
    rig.add('chest', pad);
  }
  void displaceRough;
}

function displaceRough(geo: G, amt: number, seed: number) {
  const pos = geo.attributes.position;
  geo.computeVertexNormals();
  const n = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const k = (Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453) % 1;
    const d = (Math.abs(k) - 0.5) * 2 * amt;
    pos.setXYZ(i, pos.getX(i) + n.getX(i) * d, pos.getY(i) + n.getY(i) * d, pos.getZ(i) + n.getZ(i) * d);
  }
  geo.computeVertexNormals();
}

/** Necklace of beads/bones/teeth around the neck. */
export function addNecklace(rig: Rig, b: Body, color: number, count = 9, big = 0.03, pendant?: number): void {
  for (let i = 0; i < count; i++) {
    const a = -1.1 + (2.2 * i) / (count - 1);
    const bead = i % 2 ? blob(big * 0.7) : capsule(big * 0.6, big * 0.4, big * 1.6, 5);
    const rr = b.chestR * 0.6;
    place(bead, Math.sin(a) * rr, b.torsoLen * 0.5 - Math.cos(a) * 0.05 - 0.02, Math.cos(a) * rr * b.depth * 1.25 + 0.03);
    paint(bead, color);
    rig.add('chest', bead);
  }
  if (pendant !== undefined) {
    const p = blob(big * 1.6, big * 1.9, big * 0.8);
    place(p, 0, b.torsoLen * 0.38, b.chestR * b.depth * 1.02 + 0.02);
    paint(p, pendant);
    rig.add('chest', p);
  }
}

/** Arm/leg band. */
export function addBand(rig: Rig, bone: BoneName, r: number, y: number, color: number, w = 0.03): void {
  const band = torus(r, w * 0.5, 5, 14);
  place(band, 0, y, 0, Math.PI / 2, 0, 0);
  paint(band, color);
  rig.add(bone, band);
}

/** Feathers fanning from a point (headdresses). */
export function feather(len: number, w: number, color: number, tip: number): G {
  const f = blob(w, len / 2, w * 0.25, 7, 6);
  f.translate(0, len / 2, 0);
  paint(f, (p) => (p.y > len * 0.72 ? tip : p.y > len * 0.62 ? 0xf2ead8 : color));
  // spine
  return f;
}

export { blob, capsule, cone, cyl, dome, hsl, lathe, mix, paint, place, rbox, shade, shine, tint, torus, tube };
