/**
 * assets/models/geometry.ts — the sculpting toolkit.
 *
 * Everything we model is assembled from a few smooth primitives, then
 * painted and merged:
 *
 *   lathe     — spin a 2D profile round the Y axis: torsos, robes, pots,
 *               roundhouse walls, tree trunks. The profile IS the
 *               silhouette, so it's the most expressive tool we have.
 *   capsule   — a tapered, rounded limb hanging DOWN from its joint at
 *               the origin (so rotating it swings it like a real joint).
 *   blob      — a sphere, optionally squashed and noise-displaced: heads,
 *               hands, fur, canopies, boulders.
 *   rbox      — a bevelled box: planks, shields, stone blocks.
 *
 * Then: `paint` fills the `color` attribute (flat colour or a function of
 * position — gradients, stripes, patterns), `shine` fills the `glow`
 * attribute (see materials.ts), `place` moves/rotates/scales, and `merge`
 * welds a list of parts into one BufferGeometry = one draw call.
 *
 * Every geometry leaving this file is INDEXED and carries exactly
 * position, normal, color, glow (and sway when asked) — so any two of them
 * can be merged without attribute mismatches.
 */

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { hash3 } from './rng';

export type G = THREE.BufferGeometry;
export type ColorFn = (p: THREE.Vector3, n: THREE.Vector3) => number | THREE.Color;

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Normalise attributes: drop uv, add color/glow defaults, ensure indexed. */
function clean(geo: G): G {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('uv1');
  geo.deleteAttribute('uv2');
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const n = geo.attributes.position.count;
  if (!geo.attributes.color) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  if (!geo.attributes.glow) geo.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Max profile segment length before lathe() subdivides it. */
let LATHE_STEP = 0.045;
export function setLatheStep(s: number): void {
  LATHE_STEP = s;
}

/** Spin a profile [radius, y][] around Y. sx/sz squash the cross-section into an ellipse. */
export function lathe(profile: Array<[number, number]>, segs = 12, sx = 1, sz = 1, phi = 0, arc = Math.PI * 2): G {
  // Profiles must climb in y for outward-facing triangles; accept either order.
  const ordered = profile.length > 1 && profile[0][1] > profile[profile.length - 1][1] ? [...profile].reverse() : profile;
  // Refine long segments so vertex colours (hems, sleeves, stripes) get crisp edges.
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const [r, y] = ordered[i];
    if (i > 0) {
      const [r0, y0] = ordered[i - 1];
      const n = Math.min(12, Math.floor(Math.hypot(r - r0, y - y0) / LATHE_STEP));
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        pts.push(new THREE.Vector2(Math.max(0.0001, r0 + (r - r0) * t), y0 + (y - y0) * t));
      }
    }
    pts.push(new THREE.Vector2(Math.max(0.0001, r), y));
  }
  let geo: G = new THREE.LatheGeometry(pts, segs, phi, arc);
  if (sx !== 1 || sz !== 1) geo.scale(sx, 1, sz);
  geo = weld(geo);
  return clean(geo);
}

/**
 * A tapered capsule hanging from the origin down to y = -len: radius rTop
 * at the joint, rBot at the far end, both ends rounded.
 */
export function capsule(rTop: number, rBot: number, len: number, segs = 8, sx = 1, sz = 1): G {
  const prof: Array<[number, number]> = [];
  const cap = 4;
  // bottom hemisphere (from the tip up)
  for (let i = 0; i <= cap; i++) {
    const a = (i / cap) * (Math.PI / 2);
    prof.push([Math.sin(a) * rBot, -len - Math.cos(a) * rBot * 0.9 + rBot * 0.0]);
  }
  // top hemisphere
  for (let i = cap; i >= 0; i--) {
    const a = (i / cap) * (Math.PI / 2);
    prof.push([Math.sin(a) * rTop, Math.cos(a) * rTop * 0.9]);
  }
  return lathe(prof, segs, sx, sz);
}

/** A sphere/ellipsoid; `bumps` displaces it with value noise (fur, rock, foliage). */
export function blob(rx: number, ry = rx, rz = rx, w = 12, h = 9, bumps = 0, seed = 1, bumpFreq = 2.5): G {
  const geo = new THREE.SphereGeometry(1, w, h);
  geo.scale(rx, ry, rz);
  if (bumps > 0) displace(geo, bumps, seed, bumpFreq);
  return clean(weld(geo));
}

/** Partial sphere (domes, caps, hoods). thetaLen in radians from the top pole. */
export function dome(r: number, thetaLen = Math.PI / 2, w = 12, h = 6, sx = 1, sy = 1, sz = 1): G {
  const geo = new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, 0, thetaLen);
  geo.scale(sx, sy, sz);
  return clean(geo);
}

/** Bevelled box centred on the origin. */
export function rbox(w: number, h: number, d: number, r = 0.04, segs = 2): G {
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const geo = new RoundedBoxGeometry(w, h, d, segs, Math.max(0.001, rr));
  return clean(geo);
}

/** Plain box (cheap, for things that should be crisp). */
export function box(w: number, h: number, d: number): G {
  return clean(new THREE.BoxGeometry(w, h, d));
}

/** Cylinder/cone along Y centred on origin. */
export function cyl(rTop: number, rBot: number, h: number, segs = 8, open = false): G {
  return clean(new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, open));
}

export function cone(r: number, h: number, segs = 8): G {
  return clean(new THREE.ConeGeometry(r, h, segs));
}

export function torus(r: number, tube: number, radial = 6, tubular = 16, arc = Math.PI * 2): G {
  return clean(new THREE.TorusGeometry(r, tube, radial, tubular, arc));
}

/** A tube along a list of points (ropes, horns, antlers, roots). */
export function tube(points: THREE.Vector3[], radius: number, segs = 12, radial = 5, taper = 1): G {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, segs, radius, radial, false);
  if (taper !== 1) {
    // scale radius along the tube toward the end
    const pos = geo.attributes.position;
    const rings = segs + 1;
    for (let i = 0; i < rings; i++) {
      const t = i / segs;
      const c = curve.getPointAt(t);
      const k = 1 + (taper - 1) * t;
      for (let j = 0; j <= radial; j++) {
        const vi = i * (radial + 1) + j;
        _p.fromBufferAttribute(pos, vi).sub(c).multiplyScalar(k).add(c);
        pos.setXYZ(vi, _p.x, _p.y, _p.z);
      }
    }
    geo.computeVertexNormals();
  }
  return clean(geo);
}

/** A flat-ish quad strip (cloth panels, banners) hanging from y=0 down to -h. */
export function panel(w: number, h: number, wSegs = 3, hSegs = 4, curve = 0, thick = 0.03): G {
  // A thin box with enough segments to bend smoothly when skinned.
  const geo = new THREE.BoxGeometry(w, h, thick, wSegs, hSegs, 1);
  geo.translate(0, -h / 2, 0);
  if (curve !== 0) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, pos.getZ(i) - (x * x) * curve);
    }
    geo.computeVertexNormals();
  }
  return clean(geo);
}

/** A cheap 2-quad cross (grass tufts, ferns). */
export function cross(w: number, h: number): G {
  const a = new THREE.PlaneGeometry(w, h);
  a.translate(0, h / 2, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  return merge([clean(a), clean(b)]);
}

// ---------------------------------------------------------------------------
// Operators (all mutate and return the geometry for chaining)
// ---------------------------------------------------------------------------

/** Fill the vertex colour: a hex, a THREE.Color, or a function of position/normal. */
export function paint(geo: G, c: number | THREE.Color | ColorFn): G {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const col = geo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (typeof c === 'function') {
      _p.fromBufferAttribute(pos, i);
      _n.fromBufferAttribute(nor, i);
      const r = c(_p, _n);
      if (typeof r === 'number') _c.setHex(r);
      else _c.copy(r);
    } else if (typeof c === 'number') _c.setHex(c);
    else _c.copy(c);
    col.setXYZ(i, _c.r, _c.g, _c.b);
  }
  col.needsUpdate = true;
  return geo;
}

/** Multiply the existing vertex colour by a function of position (AO, gradients). */
export function shade(geo: G, f: (p: THREE.Vector3) => number): G {
  const pos = geo.attributes.position;
  const col = geo.attributes.color as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    const k = f(_p);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  return geo;
}

/** Make it glow: emissive radiance colour × intensity (HDR, > 1 is fine). */
export function shine(geo: G, color: number, intensity = 1.5, f?: (p: THREE.Vector3) => number): G {
  _c.setHex(color);
  const pos = geo.attributes.position;
  const g = geo.attributes.glow as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let k = intensity;
    if (f) {
      _p.fromBufferAttribute(pos, i);
      k *= f(_p);
    }
    g.setXYZ(i, _c.r * k, _c.g * k, _c.b * k);
  }
  return geo;
}

/** Wind weight per vertex (0 = rigid). */
export function setSway(geo: G, f: (p: THREE.Vector3) => number): G {
  const pos = geo.attributes.position;
  const s = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    s[i] = f(_p);
  }
  geo.setAttribute('sway', new THREE.BufferAttribute(s, 1));
  return geo;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Translate, rotate (Euler XYZ, radians), scale — in that conceptual order: scale, rotate, then move. */
export function place(geo: G, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): G {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(_t.set(x, y, z), _q, _s.set(sx, sy, sz));
  geo.applyMatrix4(_m);
  return geo;
}

/** Bend a geometry: vertices offset along x/z by f(y). */
export function warp(geo: G, f: (p: THREE.Vector3) => [number, number, number]): G {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    const [dx, dy, dz] = f(_p);
    pos.setXYZ(i, _p.x + dx, _p.y + dy, _p.z + dz);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Push vertices along their normals by value noise (fur, rock, bark, foliage clumps). */
export function displace(geo: G, amount: number, seed = 1, freq = 2.5): G {
  const pos = geo.attributes.position;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    _n.fromBufferAttribute(nor, i);
    const k = (smoothNoise(_p.x * freq, _p.y * freq, _p.z * freq, seed) - 0.5) * 2 * amount;
    pos.setXYZ(i, _p.x + _n.x * k, _p.y + _n.y * k, _p.z + _n.z * k);
  }
  return geo;
}

/** Weld duplicate seam vertices (lathe/sphere seams) so normals are smooth across them. */
export function weld(geo: G): G {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  const w = mergeVertices(geo, 1e-5);
  w.computeVertexNormals();
  return w;
}

/** Trilinear value noise in [0,1], deterministic. */
export function smoothNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const h = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), u), l(h(0, 1, 0), h(1, 1, 0), u), v),
    l(l(h(0, 0, 1), h(1, 0, 1), u), l(h(0, 1, 1), h(1, 1, 1), u), v),
    w,
  );
}

/** Weld a list of parts into one geometry. Parts are consumed. */
export function merge(parts: G[]): G {
  const list = parts.filter(Boolean);
  if (list.length === 0) return clean(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)));
  // Unify optional attributes so mergeGeometries doesn't refuse.
  const hasSway = list.some((g) => g.attributes.sway);
  const hasSkin = list.some((g) => g.attributes.skinIndex);
  for (const g of list) {
    clean(g);
    if (hasSway && !g.attributes.sway) g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
    if (hasSkin && !g.attributes.skinIndex) {
      const n = g.attributes.position.count;
      g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(n * 4), 4));
      const w = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) w[i * 4] = 1;
      g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    }
    // Index types must match: promote everything to 32-bit.
    if (!(g.index!.array instanceof Uint32Array)) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.index!.array), 1));
  }
  const out = mergeGeometries(list, false);
  if (!out) throw new Error('merge failed: attribute mismatch');
  for (const g of list) g.dispose();
  return out;
}

/** Colour helpers. */
export function mix(a: number, b: number, t: number): number {
  return _c.setHex(a).lerp(new THREE.Color(b), t).getHex();
}
export function tint(hex: number, k: number): number {
  return _c.setHex(hex).multiplyScalar(k).getHex();
}
/** Shift hue/saturation/lightness of a hex. */
export function hsl(hex: number, dh: number, ds: number, dl: number): number {
  const o = { h: 0, s: 0, l: 0 };
  _c.setHex(hex).getHSL(o);
  return _c.setHSL((o.h + dh + 1) % 1, THREE.MathUtils.clamp(o.s + ds, 0, 1), THREE.MathUtils.clamp(o.l + dl, 0, 1)).getHex();
}
