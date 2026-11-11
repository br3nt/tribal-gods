/**
 * ui/picking.ts — "what is drawn under this pixel?", in screen space.
 *
 * The ground picker (render/ground-picker.ts) finds the tile a ray hits,
 * which for a click on a tall roof or a villager's head is the ground
 * BEHIND it. So people and buildings are also picked by projecting a few
 * probe points of their silhouette (feet, head; footprint corners, roof) to
 * pixels and testing the cursor against the box they span.
 *
 * The probes deliberately use probeScreen(), not ui/project.ts toScreen():
 * toScreen() drops points far off screen (right for DOM overlays), but a
 * silhouette probe that is off screen is still part of a thing that is ON
 * screen. Up close, a Watchtower's roof is above the top of the viewport
 * while its door is right under the cursor; rejecting the roof probe made
 * the whole tower unclickable. Only a point behind the camera has no
 * meaningful projection, so that is the only rejection here.
 *
 * When silhouettes overlap, whatever is nearest the camera wins — the
 * same rule the depth buffer uses to decide what you see.
 */

import * as THREE from 'three';
import { BUILDINGS, UNITS } from '../sim/catalog';
import type { Building, Unit } from '../sim/world-state';
import { View, worldPoint } from './project';

export interface Viewport {
  width: number;
  height: number;
}

export interface Probe {
  x: number;
  y: number;
  /** Distance in front of the camera (camera-space depth, world units). */
  depth: number;
}

const v = new THREE.Vector3();

/** The browser viewport (CSS pixels). */
export const screenViewport = (): Viewport => ({ width: innerWidth, height: innerHeight });

/**
 * Tile (x, z) at `lift` projected to CSS pixels, however far off screen;
 * null only when the point is behind (or practically at) the camera.
 */
export function probeScreen(view: View, x: number, z: number, lift: number, vp: Viewport): Probe | null {
  worldPoint(view, x, z, lift, v);
  v.applyMatrix4(view.camera.matrixWorldInverse);
  const depth = -v.z; // three.js cameras look down -Z
  if (depth < 0.05) return null;
  v.applyMatrix4(view.camera.projectionMatrix);
  return { x: (v.x + 1) * 0.5 * vp.width, y: (1 - v.y) * 0.5 * vp.height, depth };
}

/** Screen box a unit's body covers, or null if it is behind the camera. */
function unitBox(view: View, u: Unit, vp: Viewport) {
  const foot = probeScreen(view, u.x, u.z, 0, vp);
  const head = probeScreen(view, u.x, u.z, UNITS[u.kind].height, vp);
  if (!foot || !head) return null;
  const bodyPx = Math.max(10, foot.y - head.y);
  const halfW = Math.max(9, bodyPx * 0.32);
  return { foot, head, halfW, depth: (foot.depth + head.depth) / 2 };
}

/** Screen box a building covers (footprint wide, roof tall), or null. */
function buildingBox(view: View, b: Building, vp: Viewport) {
  const half = b.size / 2;
  const base = probeScreen(view, b.x, b.z, 0, vp);
  const top = probeScreen(view, b.x, b.z, BUILDINGS[b.kind].height, vp);
  if (!base || !top) return null;
  let minX = Math.min(base.x, top.x);
  let maxX = Math.max(base.x, top.x);
  let maxY = base.y;
  let nearDepth = base.depth;
  for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
    const c = probeScreen(view, b.x + dx, b.z + dz, 0, vp);
    if (!c) continue; // a corner behind the camera: the rest still bound it
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
    nearDepth = Math.min(nearDepth, c.depth);
  }
  return { minX: minX - 4, maxX: maxX + 4, minY: Math.min(top.y, base.y) - 4, maxY: maxY + 4, depth: base.depth, nearDepth };
}

/** The nearest-to-camera person whose body is under (px, py). */
export function unitAtScreen(view: View, units: Iterable<Unit>, px: number, py: number, pred: (u: Unit) => boolean, vp = screenViewport()): Unit | null {
  let best: Unit | null = null;
  let bestScore = Infinity;
  for (const u of units) {
    if (u.hidden || !pred(u)) continue;
    const box = unitBox(view, u, vp);
    if (!box) continue;
    const { foot, head, halfW } = box;
    if (px < foot.x - halfW || px > foot.x + halfW || py < head.y - 4 || py > foot.y + 6) continue;
    // Mostly "nearest the cursor's centre line", tie-broken toward the camera.
    const score = Math.hypot(px - foot.x, py - (foot.y + head.y) / 2) + box.depth * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/** The nearest-to-camera building whose silhouette contains (px, py). */
export function buildingAtScreen(view: View, buildings: Iterable<Building>, px: number, py: number, vp = screenViewport()): Building | null {
  let best: Building | null = null;
  let bestDepth = Infinity;
  for (const b of buildings) {
    const box = buildingBox(view, b, vp);
    if (!box) continue;
    if (px < box.minX || px > box.maxX || py < box.minY || py > box.maxY) continue;
    if (box.depth < bestDepth) {
      bestDepth = box.depth;
      best = b;
    }
  }
  return best;
}

/**
 * Is this person drawn BEHIND this building from the camera's point of
 * view? A unit further from the camera than the building's centre, whose
 * body overlaps its silhouette, is hidden by the walls.
 */
export function hiddenBehind(view: View, u: Unit, b: Building, vp = screenViewport()): boolean {
  const ub = unitBox(view, u, vp);
  const bb = buildingBox(view, b, vp);
  if (!ub || !bb) return false;
  return ub.foot.depth > bb.depth;
}

/** What is drawn under the cursor: the person or the building, whichever is in front. */
export function pickAtScreen(
  view: View,
  units: Iterable<Unit>,
  buildings: Iterable<Building>,
  px: number,
  py: number,
  pred: (u: Unit) => boolean,
  vp = screenViewport(),
): { unit: Unit | null; building: Building | null } {
  const building = buildingAtScreen(view, buildings, px, py, vp);
  const unit = unitAtScreen(view, units, px, py, (u) => pred(u) && !(building && hiddenBehind(view, u, building, vp)), vp);
  return { unit, building: unit ? null : building };
}
