/**
 * render/ground-picker.ts — "where on the planet is the mouse pointing?"
 *
 * The obvious approach — raycast against the terrain mesh's triangles —
 * has a flaw we shipped and then fixed: the mesh's true vertices are FLAT,
 * but the player sees them bent down by the curvature shader. Near the
 * camera target the difference is ~zero; out toward the horizon the visual
 * surface sits far below the true one, so triangle-raycast picks land well
 * beyond your cursor. Phase 2's landbridge testing made this very obvious.
 *
 * So instead we intersect the ray against the surface the player actually
 * SEES, with the oldest trick in terrain rendering — RAY-MARCHING:
 *
 *   walk along the ray in small steps;
 *   at each step compare the ray's height against the curved terrain
 *   height under that point (heightmap sample minus the same CURVATURE·d²
 *   the vertex shader applies);
 *   the first step that dips below the surface brackets the hit —
 *   then a few rounds of bisection sharpen it to centimeters.
 *
 * No mesh, no triangles — we intersect the same MATH that defines the
 * visuals. As a bonus this also picks the seafloor through water, which is
 * exactly what sculpting wants.
 */

import * as THREE from 'three';
import { CURVATURE, TILE } from '../config';
import { Heightmap } from '../world/heightmap';

const MAX_DISTANCE = 450; // world units; past this the ray is pointing at sky
const STEP = 1.2; // coarse march step — small vs any terrain feature
const BISECTION_ROUNDS = 18; // each halves the bracket: 1.2 / 2^18 ≈ sub-millimeter

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** Curved (i.e. as-rendered) terrain height under world-space (x, z). */
function curvedHeight(map: Heightmap, x: number, z: number, camTarget: THREE.Vector3): number {
  const dx = x - camTarget.x;
  const dz = z - camTarget.z;
  return map.sampleHeight(x / TILE, z / TILE) - CURVATURE * (dx * dx + dz * dz);
}

/**
 * Pick the ground under screen pixel (px, py). Returns fractional TILE
 * coordinates (the sim's language), or null if the cursor is on sky.
 */
export function pickGroundTile(
  px: number,
  py: number,
  camera: THREE.Camera,
  map: Heightmap,
  camTarget: THREE.Vector3,
): { x: number; z: number } | null {
  ndc.set((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin;
  const d = ray.ray.direction;

  // Coarse march: find the first step that ends up under the surface.
  let tPrev = 0;
  let above = o.y - curvedHeight(map, o.x, o.z, camTarget) > 0;
  if (!above) return { x: o.x / TILE, z: o.z / TILE }; // camera underground — degenerate but safe

  for (let t = STEP; t < MAX_DISTANCE; t += STEP) {
    const x = o.x + d.x * t;
    const y = o.y + d.y * t;
    const z = o.z + d.z * t;
    if (y - curvedHeight(map, x, z, camTarget) <= 0) {
      // Crossed! The hit lies between tPrev and t — bisect the bracket.
      let lo = tPrev;
      let hi = t;
      for (let i = 0; i < BISECTION_ROUNDS; i++) {
        const mid = (lo + hi) / 2;
        const mx = o.x + d.x * mid;
        const my = o.y + d.y * mid;
        const mz = o.z + d.z * mid;
        if (my - curvedHeight(map, mx, mz, camTarget) > 0) lo = mid;
        else hi = mid;
      }
      const tHit = (lo + hi) / 2;
      return { x: (o.x + d.x * tHit) / TILE, z: (o.z + d.z * tHit) / TILE };
    }
    tPrev = t;
  }
  return null; // marched off into the sky
}
