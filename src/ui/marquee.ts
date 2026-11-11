/**
 * ui/marquee.ts — box selection drawn ON THE LAND, not on the glass.
 *
 * A screen rectangle selects whatever happens to project inside it, which
 * on a curved, hilly planet seen at an angle is a strange trapezoid of
 * ground: wide and deep far away, narrow up close. Instead the drag is
 * read as a rectangle ON THE GROUND:
 *
 *   1. The press point S and the current point C are projected onto the
 *      visible surface (the same curved-ground ray march clicks use, but
 *      against the water's surface where it is wet, so a drag over a bay
 *      lands where you see it). A point over the sky is clamped to the
 *      nearest ground straight below it on screen (the horizon).
 *   2. The rectangle's sides follow the camera's own right/forward axes laid
 *      flat on the ground, so it looks square-on to you whichever way the
 *      view is turned:
 *
 *            S + b·f ─────────── C
 *               │                 │        r = camera right on the ground
 *               │    selected     │        f = camera forward on the ground
 *               │                 │        a = (C−S)·r,  b = (C−S)·f
 *               S ─────────── S + a·r
 *
 *   3. It is drawn as a tessellated, draped decal (ui/drape.ts): every
 *      vertex sampled from the heightmap and dropped by the planet's
 *      curvature, exactly like the spell reticles, so the outline hugs
 *      hills and bends over the horizon.
 *   4. A person is inside when their tile position, taken RELATIVE TO S the
 *      short way round the torus (wrapDelta), lies in the quad. That makes
 *      a drag across the map's seam behave like any other.
 *
 * The geometry is pure (no DOM, no three.js) and tested in
 * test/ui-marquee.test.ts; GroundMarquee draws it.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { curvatureDrop } from '../world/curvature';
import type { Heightmap } from '../world/heightmap';
import { Drape } from './drape';
import { View } from './project';

export interface Pt {
  x: number;
  z: number;
}

/** Four corners (tile coords, in order around the edge) of the ground rectangle from S to C. */
export function groundRect(s: Pt, c: Pt, right: Pt): [Pt, Pt, Pt, Pt] {
  const len = Math.hypot(right.x, right.z) || 1;
  const r = { x: right.x / len, z: right.z / len };
  const f = { x: -r.z, z: r.x };
  const dx = wrapDelta(c.x - s.x, WORLD_SIZE);
  const dz = wrapDelta(c.z - s.z, WORLD_SIZE);
  const a = dx * r.x + dz * r.z;
  const b = dx * f.x + dz * f.z;
  return [
    { x: s.x, z: s.z },
    { x: s.x + r.x * a, z: s.z + r.z * a },
    { x: s.x + dx, z: s.z + dz },
    { x: s.x + f.x * b, z: s.z + f.z * b },
  ];
}

/**
 * Is tile point p inside the convex quad q (any winding), measured on the
 * torus: p is brought next to q[0] the short way round before testing.
 */
export function inGroundQuad(p: Pt, q: readonly Pt[]): boolean {
  const ox = q[0].x;
  const oz = q[0].z;
  const px = wrapDelta(p.x - ox, WORLD_SIZE);
  const pz = wrapDelta(p.z - oz, WORLD_SIZE);
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const ax = a.x - ox, az = a.z - oz, bx = b.x - ox, bz = b.z - oz;
    const cross = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
    if (Math.abs(cross) < 1e-9) continue; // on an edge counts as inside
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  // A degenerate quad (a click, a line) holds nothing.
  return sign !== 0;
}

/** Area of the quad in tiles² (tiny = treat as a click). */
export function quadArea(q: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.z - n.x * p.z;
  }
  return Math.abs(a) / 2;
}

// ---------------------------------------------------------------------------
// Projecting the drag onto the land

const MAX_DISTANCE = 450;
const STEP = 1.2;
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** The surface a player SEES: land, or the sea's surface where it is wet. */
function seenHeight(map: Heightmap, x: number, z: number, target: THREE.Vector3): number {
  return Math.max(0, map.sampleHeight(x / TILE, z / TILE)) - curvatureDrop(x - target.x, z - target.z);
}

/** Visible surface under a pixel (ray march + bisection, as render/ground-picker.ts), or null for sky. */
export function pickSurface(px: number, py: number, camera: THREE.Camera, map: Heightmap, target: THREE.Vector3): Pt | null {
  ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  if (o.y - seenHeight(map, o.x, o.z, target) <= 0) return { x: o.x / TILE, z: o.z / TILE };
  let prev = 0;
  for (let t = STEP; t < MAX_DISTANCE; t += STEP) {
    if (o.y + d.y * t - seenHeight(map, o.x + d.x * t, o.z + d.z * t, target) <= 0) {
      let lo = prev, hi = t;
      for (let i = 0; i < 16; i++) {
        const m = (lo + hi) / 2;
        if (o.y + d.y * m - seenHeight(map, o.x + d.x * m, o.z + d.z * m, target) > 0) lo = m;
        else hi = m;
      }
      const th = (lo + hi) / 2;
      return { x: (o.x + d.x * th) / TILE, z: (o.z + d.z * th) / TILE };
    }
    prev = t;
  }
  return null;
}

/** The surface under a pixel, or — over the sky — the nearest ground straight below it on screen. */
export function pickSurfaceClamped(px: number, py: number, view: View): Pt | null {
  const hit = pickSurface(px, py, view.camera, view.map, view.target);
  if (hit) return hit;
  // Coarse walk down the screen to the horizon, then bisect onto it.
  let sky = py;
  for (let y = py + 12; y <= innerHeight + 12; y += 12) {
    const yy = Math.min(innerHeight - 1, y);
    if (pickSurface(px, yy, view.camera, view.map, view.target)) {
      let lo = sky, hi = yy;
      for (let i = 0; i < 6; i++) {
        const m = (lo + hi) / 2;
        if (pickSurface(px, m, view.camera, view.map, view.target)) hi = m;
        else lo = m;
      }
      return pickSurface(px, hi, view.camera, view.map, view.target);
    }
    sky = yy;
  }
  return null;
}

/** The camera's right axis laid flat on the ground (tile space). */
export function cameraRight(camera: THREE.Camera): Pt {
  const e = camera.matrixWorld.elements; // column 0 = local +X in world space
  const x = e[0], z = e[2];
  const len = Math.hypot(x, z);
  return len > 1e-6 ? { x: x / len, z: z / len } : { x: 1, z: 0 };
}

// ---------------------------------------------------------------------------

/** The decal: a soft fill and a bright rim, both draped over the ground. */
export class GroundMarquee {
  private readonly fill: Drape;
  private readonly rim: Drape;
  quad: [Pt, Pt, Pt, Pt] | null = null;

  constructor(scene: THREE.Scene) {
    this.fill = new Drape(scene, 0.2, 5000, 18);
    this.rim = new Drape(scene, 0.95, 3000, 19);
  }

  /** Redraw from the drag's ground start `s` (tile coords, picked once) to the pointer. */
  update(view: View, s: Pt | null, now: { x: number; y: number }, color: number): [Pt, Pt, Pt, Pt] | null {
    const c = pickSurfaceClamped(now.x, now.y, view);
    if (!s || !c) {
      this.hide();
      return (this.quad = null);
    }
    const q = groundRect(s, c, cameraRight(view.camera));
    this.quad = q;
    this.draw(view, q, color);
    return q;
  }

  private draw(view: View, q: [Pt, Pt, Pt, Pt], color: number): void {
    const [a, b, , d] = q;
    // Edge vectors from corner a: u along a→b, v along a→d.
    const ux = b.x - a.x, uz = b.z - a.z, vx = d.x - a.x, vz = d.z - a.z;
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    const nu = Math.max(1, Math.min(40, Math.ceil(lu / 1.25)));
    const nv = Math.max(1, Math.min(40, Math.ceil(lv / 1.25)));
    const P = (i: number, j: number): [number, number] => [a.x + (ux * i) / nu + (vx * j) / nv, a.z + (uz * i) / nu + (vz * j) / nv];
    this.fill.begin(color);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const [x0, z0] = P(i, j), [x1, z1] = P(i + 1, j), [x2, z2] = P(i + 1, j + 1), [x3, z3] = P(i, j + 1);
        this.fill.quad(view, x0, z0, x1, z1, x2, z2, x3, z3);
      }
    }
    this.fill.end();
    this.rim.begin(color);
    const w = 0.16;
    for (let k = 0; k < 4; k++) {
      const p = q[k], n = q[(k + 1) % 4];
      this.rim.band(view, p.x, p.z, n.x, n.z, w);
    }
    this.rim.end();
  }

  hide(): void {
    this.fill.hide();
    this.rim.hide();
    this.quad = null;
  }
}
