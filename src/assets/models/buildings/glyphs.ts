/**
 * assets/models/buildings/glyphs.ts — one carved rune per spell.
 *
 * Each standing stone carries the spell it holds as a big rune on its
 * faces. The runes are ORIGINAL marks, drawn here as strokes in a unit
 * square (x right, y up, −1..1) and turned into raised, rounded grooves by
 * `glyphGeometry`. Each one tries to say what the spell does at a glance:
 *
 *   blast       a burst: a ring with eight rays
 *   convert     Kindle: a spiral drawn inward to a spark (persuasion)
 *   flatten     Level: a weight pressing three rough lines flat
 *   bloom       a sprout: a stem, two leaves, an unfurling tip
 *   ward        Stone Ward: a pointed arch sheltering a dot
 *   lightning   a forked bolt
 *   warsong     three nested chevrons (a war-cry rolling outward)
 *   swamp       Mire: rippling water with rising bubbles
 *   landbridge  Causeway: an arch striding over a wave
 *   cyclone     a funnel spiral
 *   emberfall   a cloud arc raining three drops of fire
 *   sink        Undertow: a whirlpool with a downward barb
 *   earthquake  Quake: a horizon split by a jagged crack
 *   volcano     a mountain with a plume from its crater
 *
 * Unknown spells get a plain circle-and-dot so new content still shows.
 */

import * as THREE from 'three';
import { G, merge, paint } from '../geometry';

type P = [number, number];
/** A rune: polylines (open unless the last point repeats the first). */
type Rune = P[][];

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 14): P[] => {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
};
const circle = (cx: number, cy: number, r: number, n = 18): P[] => arc(cx, cy, r, 0, Math.PI * 2, n);
const spiral = (cx: number, cy: number, r0: number, r1: number, turns: number, a0 = 0, n = 40): P[] => {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + t * turns * Math.PI * 2;
    const r = r0 + (r1 - r0) * t;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
};
const wave = (y: number, x0: number, x1: number, amp: number, waves: number, n = 20): P[] => {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([x0 + (x1 - x0) * t, y + Math.sin(t * waves * Math.PI * 2) * amp]);
  }
  return out;
};

export const RUNES: Record<string, Rune> = {
  blast: [
    circle(0, 0, 0.3),
    ...Array.from({ length: 8 }, (_, i) => {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r0 = 0.48, r1 = i % 2 ? 0.8 : 0.95;
      return [[Math.cos(a) * r0, Math.sin(a) * r0], [Math.cos(a) * r1, Math.sin(a) * r1]] as P[];
    }),
  ],
  convert: [spiral(0, 0, 0.85, 0.12, 2.25, Math.PI / 2), circle(0, 0, 0.06, 8)],
  flatten: [
    [[-0.35, 0.95], [0.35, 0.95], [0.35, 0.55], [-0.35, 0.55], [-0.35, 0.95]],
    [[0, 0.5], [0, 0.22]],
    wave(0.05, -0.85, 0.85, 0.06, 3),
    wave(-0.3, -0.85, 0.85, 0.03, 2.5),
    [[-0.85, -0.65], [0.85, -0.65]],
  ],
  bloom: [
    [[0, -0.95], [0.02, -0.4], [-0.04, 0.1], [0.04, 0.5]],
    [...arc(0.3, 0.62, 0.26, Math.PI, Math.PI * 2.6, 14)],
    [[0.01, -0.35], [-0.35, -0.1], [-0.62, -0.18], [-0.4, -0.38], [0.01, -0.35]],
    [[0.0, 0.02], [0.35, 0.25], [0.62, 0.18], [0.42, -0.02], [0.0, 0.02]],
  ],
  ward: [
    [[-0.7, -0.9], [-0.7, 0.15], [-0.4, 0.65], [0, 0.95], [0.4, 0.65], [0.7, 0.15], [0.7, -0.9]],
    [[-0.95, -0.9], [0.95, -0.9]],
    circle(0, -0.15, 0.16, 10),
  ],
  lightning: [
    [[0.35, 0.95], [-0.2, 0.15], [0.2, 0.1], [-0.35, -0.95]],
    [[0.2, 0.1], [0.62, -0.35]],
    [[-0.05, -0.38], [-0.55, -0.45]],
  ],
  warsong: [
    [[-0.85, 0.55], [0, -0.05], [0.85, 0.55]],
    [[-0.6, 0.15], [0, -0.35], [0.6, 0.15]],
    [[-0.35, -0.25], [0, -0.65], [0.35, -0.25]],
    [[0, 0.95], [0, 0.35]],
  ],
  swamp: [
    wave(-0.45, -0.9, 0.9, 0.1, 2.5),
    wave(-0.8, -0.7, 0.7, 0.07, 2),
    circle(-0.3, 0.05, 0.14, 10),
    circle(0.25, 0.4, 0.2, 12),
    circle(-0.05, 0.78, 0.1, 8),
  ],
  landbridge: [
    [[-0.9, 0.3], [0.9, 0.3]],
    arc(0, 0.3, 0.6, Math.PI, Math.PI * 2, 14),
    [[-0.9, 0.3], [-0.9, -0.55]],
    [[0.9, 0.3], [0.9, -0.55]],
    wave(-0.75, -0.6, 0.6, 0.08, 2),
  ],
  cyclone: [
    [[-0.8, 0.85], [0.8, 0.85]],
    [[-0.6, 0.45], [0.6, 0.45]],
    [[-0.4, 0.05], [0.4, 0.05]],
    [[-0.22, -0.35], [0.22, -0.35]],
    [[0.05, -0.6], [-0.08, -0.8], [0.06, -0.95]],
  ],
  emberfall: [
    arc(0, 0.35, 0.75, Math.PI * 0.08, Math.PI * 0.92, 16),
    [[-0.45, 0.15], [-0.55, -0.25], [-0.45, -0.4], [-0.35, -0.25], [-0.45, 0.15]],
    [[0.05, 0.05], [-0.05, -0.45], [0.05, -0.6], [0.15, -0.45], [0.05, 0.05]],
    [[0.5, 0.15], [0.4, -0.2], [0.5, -0.35], [0.6, -0.2], [0.5, 0.15]],
  ],
  sink: [
    spiral(0, 0.1, 0.8, 0.1, 1.75, 0, 36),
    [[0, -0.1], [0, -0.95]],
    [[-0.22, -0.7], [0, -0.95], [0.22, -0.7]],
  ],
  earthquake: [
    [[-0.95, 0.05], [-0.35, 0.05]],
    [[0.35, -0.05], [0.95, -0.05]],
    [[0.1, 0.95], [-0.2, 0.5], [0.15, 0.2], [-0.25, -0.15], [0.12, -0.5], [-0.1, -0.95]],
  ],
  volcano: [
    [[-0.95, -0.85], [-0.25, 0.25], [0.25, 0.25], [0.95, -0.85], [-0.95, -0.85]],
    [[0, 0.35], [-0.12, 0.6], [0.1, 0.78], [-0.05, 0.98]],
    [[-0.15, -0.1], [0.05, -0.4], [-0.1, -0.7]],
  ],
};

const FALLBACK: Rune = [circle(0, 0, 0.7, 20), circle(0, 0, 0.12, 8)];

/**
 * The rune as raised, rounded strokes facing +Z, `size` world units from
 * centre to edge, `depth` proud of the surface. y is centred on 0.
 */
export function glyphGeometry(spell: string, size: number, width = 0.075, depth = 0.06): G {
  const rune = RUNES[spell] ?? FALLBACK;
  const parts: G[] = [];
  const w = width * size;
  for (const line of rune) {
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = line[i];
      const [bx, by] = line[i + 1];
      const x0 = ax * size, y0 = ay * size, x1 = bx * size, y1 = by * size;
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1e-4) continue;
      const seg = new THREE.CapsuleGeometry(w, len, 2, 6);
      // capsule runs along Y: lay it along the stroke, flatten in Z
      seg.scale(1, 1, depth / w);
      seg.rotateZ(Math.atan2(y1 - y0, x1 - x0) - Math.PI / 2);
      seg.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
      parts.push(seg);
    }
  }
  const g = merge(parts);
  paint(g, 0x2e2a26);
  return g;
}
