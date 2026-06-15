/**
 * world/curvature.ts — the planet illusion, in one line of shader code.
 *
 * The world is flat (see heightmap.ts). What makes it look like a planet is
 * done at render time, on the GPU, to every single vertex:
 *
 *     pull the vertex DOWN by  CURVATURE × (distance from camera target)²
 *
 * Near the camera target the drop is ~0 (you don't notice the ground under
 * your feet curving). Far away it grows quadratically, so terrain visibly
 * falls over the horizon in every direction — which is exactly what standing
 * on a small sphere looks like. Combined with the wrapping heightmap (walk
 * far enough and you come back around), the brain happily concludes:
 * "planet". Bullfrog shipped this trick in 1998 and nobody questioned it.
 *
 * It's a quadratic drop, not a true sphere projection, because (a) it's
 * indistinguishable at game camera angles and (b) it's one multiply-add per
 * vertex.
 *
 * Implementation note: every material that draws "things in the world"
 * (terrain, water, later units and buildings) must apply the same bend, or
 * objects would float above the curved ground in the distance. So the GLSL
 * lives here once and gets spliced into each shader, and they all share the
 * SAME uniform objects below — update the camera target once per frame in
 * main.ts and every material sees it.
 */

import * as THREE from 'three';
import { CURVATURE } from '../config';

/** Shared uniforms — referenced (not copied) by every world-space material. */
export const curvatureUniforms = {
  /** Where the camera is looking, in world units. The "top of the planet". */
  uCamTarget: { value: new THREE.Vector3() },
  /** How hard the world bends. See config.ts for tuning notes. */
  uCurvature: { value: CURVATURE },
};

/** GLSL to paste into a vertex shader. Call applyCurvature on a world-space position. */
export const curvatureGlsl = /* glsl */ `
  uniform vec3 uCamTarget;
  uniform float uCurvature;

  // The entire planet illusion:
  vec3 applyCurvature(vec3 worldPos) {
    vec2 d = worldPos.xz - uCamTarget.xz;
    worldPos.y -= uCurvature * dot(d, d); // dot(d,d) = distance squared
    return worldPos;
  }
`;
