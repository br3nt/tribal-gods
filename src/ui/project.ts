/**
 * ui/project.ts — from the sim's tile coordinates to where things appear.
 *
 * Two jobs every in-world UI element shares:
 *
 *   worldPoint()  tile (x, z) + a height above ground → the world-space
 *                 point the PLAYER SEES: the image of that tile nearest the
 *                 camera (the planet wraps), dropped by the same curvature
 *                 the shaders apply (world/curvature.ts curvatureDrop, limb
 *                 included) so markers sit on the bent ground even at the
 *                 horizon.
 *   toScreen()    the same point projected to CSS pixels (for DOM overlays
 *                 like health bars), or null when behind the camera.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { curvatureDrop } from '../world/curvature';
import type { Heightmap } from '../world/heightmap';

const WORLD_UNITS = WORLD_SIZE * TILE;
const v = new THREE.Vector3();

export interface View {
  camera: THREE.Camera;
  target: THREE.Vector3;
  map: Heightmap;
}

/** Visible ground height (sea level for water) at fractional tile coords. */
export function groundY(map: Heightmap, x: number, z: number): number {
  return Math.max(0, map.sampleHeight(x, z));
}

/** World-space position of tile (x, z), `lift` units above the ground, as seen. */
export function worldPoint(view: View, x: number, z: number, lift = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const rx = wrapDelta(x * TILE - view.target.x, WORLD_UNITS);
  const rz = wrapDelta(z * TILE - view.target.z, WORLD_UNITS);
  out.set(view.target.x + rx, groundY(view.map, x, z) + lift - curvatureDrop(rx, rz), view.target.z + rz);
  return out;
}

/** CSS-pixel screen position of tile (x, z) at `lift`, or null if behind the camera / far off-screen. */
export function toScreen(view: View, x: number, z: number, lift = 0): { x: number; y: number } | null {
  worldPoint(view, x, z, lift, v);
  v.project(view.camera);
  if (v.z > 1 || v.z < -1) return null;
  const sx = (v.x + 1) * 0.5 * innerWidth;
  const sy = (1 - v.y) * 0.5 * innerHeight;
  if (sx < -200 || sx > innerWidth + 200 || sy < -200 || sy > innerHeight + 200) return null;
  return { x: sx, y: sy };
}

/** Camera target in wrapped tile coords (where "the screen" is on the map). */
export function viewCentreTile(target: THREE.Vector3): { x: number; z: number } {
  const w = (n: number) => (((n / TILE) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
  return { x: w(target.x), z: w(target.z) };
}

/** Move the camera to look at tile (x, z), via the image nearest to where it is now. */
export function lookAtTile(target: THREE.Vector3, x: number, z: number): void {
  target.x += wrapDelta(x * TILE - target.x, WORLD_UNITS);
  target.z += wrapDelta(z * TILE - target.z, WORLD_UNITS);
}

/** Wrapped distance between two tile positions. */
export function tileDist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(wrapDelta(ax - bx, WORLD_SIZE), wrapDelta(az - bz, WORLD_SIZE));
}
