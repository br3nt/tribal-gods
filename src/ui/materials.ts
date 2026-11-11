/**
 * ui/materials.ts — the stuff the interface is made of, grown at startup.
 *
 * The HUD is meant to look made BY the tribe: oiled timber frames, hide
 * stretched to dry, a stone slab for the spell book, bark tags, bone pegs.
 * Those surfaces need texture, and this game ships no image files, so
 * each one is GROWN here, once, as a small tileable canvas:
 *
 *   wood   streaked grain: noise stretched 1:14 along the board, with
 *          growth-ring lines bent by a second noise field, and a few knots;
 *   hide   parchment: low-frequency blotches (thicker and thinner skin),
 *          fine fibres and freckles;
 *   stone  weathered rock: four octaves of noise, mineral speckle, and a
 *          faint lamination;
 *   bark   deep vertical fissures from noise squeezed the other way.
 *
 * TILEABLE VALUE NOISE: the lattice wraps (period = lattice cells across
 * the tile), so the texture repeats without a seam — the same trick the
 * planet itself uses to wrap. Each surface is then published as a CSS
 * custom property (`--tex-wood: url(data:…)`) that theme.css layers under
 * tint gradients, so one 256px texture serves every panel of that
 * material at any size.
 *
 * The player's tribe colour is published too (`--tribe`), for the woven
 * cloth and paint accents.
 *
 * Why canvases and not SVG feTurbulence backgrounds: an SVG filter in a
 * CSS background is re-rasterised per element size and zoom, which is slow
 * on big panels and looks different across browsers; a JPEG made once is
 * free to draw and identical everywhere. (~25 KB each.)
 */

import { TRIBE_COLORS } from '../sim/catalog';

/** Seeded PRNG (mulberry32) so the textures are the same every load. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Periodic value noise on a lattice of px × pz cells; (u, v) in [0, 1) wraps. */
function noise2(seed: number, px: number, pz: number): (u: number, v: number) => number {
  const r = rng(seed);
  const g = new Float32Array(px * pz).map(() => r());
  const s = (t: number) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = (((u % 1) + 1) % 1) * px;
    const z = (((v % 1) + 1) % 1) * pz;
    const x0 = Math.floor(x), z0 = Math.floor(z);
    const fx = s(x - x0), fz = s(z - z0);
    const x1 = (x0 + 1) % px, z1 = (z0 + 1) % pz;
    const a = g[z0 * px + x0], b = g[z0 * px + x1], c = g[z1 * px + x0], d = g[z1 * px + x1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
}

/** Fractal sum of periodic noise: octave k has 2^k × the base lattice. */
function fbm(seed: number, px: number, pz: number, octaves: number): (u: number, v: number) => number {
  const layers = Array.from({ length: octaves }, (_, k) => noise2(seed + k * 101, px << k, pz << k));
  return (u, v) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (const n of layers) {
      sum += n(u, v) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

function paint(size: number, fn: (u: number, v: number, x: number, y: number) => RGB): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, gg, b] = fn(x / size, y / size, x, y);
      const i = (y * size + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = gg;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

const jpeg = (c: HTMLCanvasElement) => c.toDataURL('image/jpeg', 0.84);

/** Dark oiled timber. `light` gives the paler, worn wood of frames and tablets. */
function wood(light: boolean): HTMLCanvasElement {
  const streak = fbm(11, 2, 28, 4);
  const warp = fbm(23, 3, 6, 3);
  const fine = fbm(37, 8, 96, 2);
  const knot = noise2(41, 3, 3);
  const dark: RGB = light ? [92, 58, 32] : [44, 27, 15];
  const mid: RGB = light ? [138, 92, 54] : [74, 46, 26];
  const pale: RGB = light ? [176, 126, 78] : [104, 68, 40];
  return paint(256, (u, v) => {
    const w = warp(u, v);
    const s = streak(u, v + w * 0.05);
    const ring = 0.5 + 0.5 * Math.sin((v * 22 + w * 3.2 + s * 1.5) * Math.PI * 2);
    const k = knot(u, v);
    let c = mix(dark, mid, clamp01(s * 1.4 - 0.2));
    c = mix(c, pale, clamp01(ring - 0.82) * 2.2);
    c = mix(c, dark, clamp01(0.28 - ring) * 1.6);
    c = mix(c, dark, clamp01(k - 0.86) * 4); // knots
    const f = fine(u, v) - 0.5;
    return [c[0] + f * 22, c[1] + f * 16, c[2] + f * 10];
  });
}

function hide(): HTMLCanvasElement {
  const blot = fbm(51, 3, 3, 4);
  const fibre = fbm(63, 64, 8, 2);
  const r = rng(77);
  const base: RGB = [233, 212, 168];
  const thin: RGB = [244, 228, 192];
  const thick: RGB = [205, 176, 126];
  return paint(256, (u, v) => {
    const b = blot(u, v);
    let c = mix(thin, base, clamp01(b * 1.6 - 0.3));
    c = mix(c, thick, clamp01(b - 0.58) * 2.4);
    const f = (fibre(u, v) - 0.5) * 14;
    const speck = r() < 0.006 ? -38 : r() < 0.02 ? -10 : 0;
    return [c[0] + f + speck, c[1] + f + speck, c[2] + f * 0.8 + speck];
  });
}

function stone(): HTMLCanvasElement {
  const n = fbm(91, 4, 4, 5);
  const lam = fbm(97, 2, 18, 2);
  const r = rng(103);
  const dark: RGB = [68, 64, 58];
  const mid: RGB = [108, 102, 92];
  const pale: RGB = [146, 139, 126];
  return paint(256, (u, v) => {
    const a = n(u, v);
    let c = mix(dark, mid, clamp01(a * 1.8 - 0.35));
    c = mix(c, pale, clamp01(a - 0.62) * 2.5);
    const l = (lam(u, v) - 0.5) * 12;
    const roll = r();
    const speck = roll < 0.01 ? 34 : roll < 0.03 ? -22 : 0;
    return [c[0] + l + speck, c[1] + l + speck, c[2] + l + speck * 0.9];
  });
}

function bark(): HTMLCanvasElement {
  const fiss = fbm(131, 20, 2, 4);
  const plate = fbm(137, 6, 3, 3);
  const deep: RGB = [30, 19, 11];
  const face: RGB = [78, 52, 32];
  const worn: RGB = [104, 74, 48];
  return paint(256, (u, v) => {
    const f = fiss(u, v);
    const p = plate(u, v);
    let c = mix(deep, face, clamp01((f - 0.36) * 4));
    c = mix(c, worn, clamp01(p - 0.6) * 1.8 * clamp01((f - 0.45) * 5));
    return c;
  });
}

// ---------------------------------------------------------------------------
// FRAMES — 9-slice images for CSS border-image.
//
// A panel's frame is its border, drawn by `border-image: var(--frame-wood)
// 48 / var(--frame) round`. The image is a square of timber whose outer
// SLICE pixels are the frame: grain, a bevel (light on the top and left,
// shadow on the bottom and right, a groove where the frame meets the
// face), cord lashed in an X over each corner joint, and one wooden peg in
// the middle of each edge (the edges repeat with `round`, so the pegs
// recur along long sides like a board nailed at intervals).

const FRAME = 320; // canvas px
const SLICE = 48; // frame thickness in canvas px (border-image-slice)


function bevel(g: CanvasRenderingContext2D, s: number, slice: number, light: number, dark: number): void {
  // Top and left catch the light, bottom and right fall into shadow.
  const band = (x: number, y: number, w: number, hh: number, x0: number, y0: number, x1: number, y1: number, a0: string, a1: string) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, a0);
    gr.addColorStop(1, a1);
    g.fillStyle = gr;
    g.fillRect(x, y, w, hh);
  };
  band(0, 0, s, slice, 0, 0, 0, slice, `rgba(255,232,196,${light})`, 'rgba(255,232,196,0)');
  band(0, 0, slice, s, 0, 0, slice, 0, `rgba(255,232,196,${light * 0.7})`, 'rgba(255,232,196,0)');
  band(0, s - slice, s, slice, 0, s, 0, s - slice, `rgba(0,0,0,${dark})`, 'rgba(0,0,0,0)');
  band(s - slice, 0, slice, s, s, 0, s - slice, 0, `rgba(0,0,0,${dark * 0.8})`, 'rgba(0,0,0,0)');
  // Outer outline and the groove at the inner edge.
  g.strokeStyle = 'rgba(16,9,4,0.95)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, s - 3, s - 3);
  g.strokeStyle = 'rgba(16,9,4,0.85)';
  g.lineWidth = 4;
  g.strokeRect(slice - 2, slice - 2, s - 2 * slice + 4, s - 2 * slice + 4);
  g.strokeStyle = 'rgba(255,226,180,0.22)';
  g.lineWidth = 2;
  g.strokeRect(slice - 6, slice - 6, s - 2 * slice + 12, s - 2 * slice + 12);
}

function peg(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  gr.addColorStop(0, '#e9d3a6');
  gr.addColorStop(0.55, '#a7774a');
  gr.addColorStop(1, '#3a2312');
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath();
  g.arc(x + 1.5, y + 2, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = gr;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(20,10,4,0.8)';
  g.lineWidth = 1.5;
  g.stroke();
}

/** Cord wound in an X over a corner joint. (cx, cy) = corner centre, `flip` mirrors the X. */
function lashing(g: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const cord = (x0: number, y0: number, x1: number, y1: number) => {
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(18,9,3,0.9)';
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.strokeStyle = '#c7a15f';
    g.lineWidth = 4.2;
    g.stroke();
    g.strokeStyle = 'rgba(255,240,200,0.55)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x0 - 0.8, y0 - 1.2);
    g.lineTo(x1 - 0.8, y1 - 1.2);
    g.stroke();
  };
  const h = size / 2;
  for (const o of [-6, 0, 6]) cord(cx - h + o, cy - h - o, cx + h + o, cy + h - o);
  for (const o of [-4, 4]) cord(cx + h + o, cy - h + o, cx - h + o, cy + h + o);
}

function frames(woodImg: HTMLCanvasElement, stoneImg: HTMLCanvasElement): { wood: string; stone: string } {
  const make = (img: HTMLCanvasElement, draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = c.height = FRAME;
    const g = c.getContext('2d')!;
    g.fillStyle = g.createPattern(img, 'repeat')!;
    g.fillRect(0, 0, FRAME, FRAME);
    draw(g);
    return c.toDataURL('image/png');
  };
  const wood = make(woodImg, (g) => {
    bevel(g, FRAME, SLICE, 0.4, 0.55);
    const m = FRAME / 2;
    for (const [x, y] of [[m, SLICE / 2], [m, FRAME - SLICE / 2], [SLICE / 2, m], [FRAME - SLICE / 2, m]]) peg(g, x, y, 8.5);
    for (const [x, y] of [[SLICE / 2, SLICE / 2], [FRAME - SLICE / 2, SLICE / 2], [SLICE / 2, FRAME - SLICE / 2], [FRAME - SLICE / 2, FRAME - SLICE / 2]]) lashing(g, x, y, SLICE * 0.8);
  });
  const stone = make(stoneImg, (g) => {
    bevel(g, FRAME, SLICE, 0.32, 0.6);
    // Chips knocked out of the edge: a few dark notches.
    const r = rng(211);
    g.fillStyle = 'rgba(20,16,12,0.55)';
    for (let i = 0; i < 26; i++) {
      const side = i % 4;
      const t = SLICE + r() * (FRAME - 2 * SLICE);
      const d = 2 + r() * 7;
      const w = 6 + r() * 12;
      g.beginPath();
      if (side === 0) { g.moveTo(t, 0); g.lineTo(t + w / 2, d); g.lineTo(t + w, 0); }
      else if (side === 1) { g.moveTo(t, FRAME); g.lineTo(t + w / 2, FRAME - d); g.lineTo(t + w, FRAME); }
      else if (side === 2) { g.moveTo(0, t); g.lineTo(d, t + w / 2); g.lineTo(0, t + w); }
      else { g.moveTo(FRAME, t); g.lineTo(FRAME - d, t + w / 2); g.lineTo(FRAME, t + w); }
      g.fill();
    }
  });
  return { wood, stone };
}

let installed = false;

/** Grow the textures and publish them (and the tribe colour) as CSS custom properties. Idempotent. */
export function installMaterials(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const root = document.documentElement.style;
  const woodLight = wood(true);
  const stoneTex = stone();
  root.setProperty('--tex-wood', `url(${jpeg(wood(false))})`);
  root.setProperty('--tex-wood-light', `url(${jpeg(woodLight)})`);
  root.setProperty('--tex-hide', `url(${jpeg(hide())})`);
  root.setProperty('--tex-stone', `url(${jpeg(stoneTex)})`);
  root.setProperty('--tex-bark', `url(${jpeg(bark())})`);
  const f = frames(woodLight, stoneTex);
  root.setProperty('--frame-wood', `url(${f.wood})`);
  root.setProperty('--frame-stone', `url(${f.stone})`);
  setTribeColour(TRIBE_COLORS.player);
}

/** The player's tribe colour, for cloth and paint accents. */
export function setTribeColour(c: number): void {
  const hex = `#${c.toString(16).padStart(6, '0')}`;
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const s = document.documentElement.style;
  s.setProperty('--tribe', hex);
  s.setProperty('--tribe-dark', `rgb(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)})`);
  s.setProperty('--tribe-light', `rgb(${Math.min(255, Math.round(r * 0.6 + 102))}, ${Math.min(255, Math.round(g * 0.6 + 102))}, ${Math.min(255, Math.round(b * 0.6 + 102))})`);
}
