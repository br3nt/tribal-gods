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
 * "planet". Many classic 3D games used this cheap trick and few players ever noticed.
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
import { LIMB_K, LIMB_START } from '../render/look';

/** Shared uniforms — referenced (not copied) by every world-space material. */
export const curvatureUniforms = {
  /** Where the camera is looking, in world units. The "top of the planet". */
  uCamTarget: { value: new THREE.Vector3() },
  /** How hard the world bends. See config.ts for tuning notes. */
  uCurvature: { value: CURVATURE },
  /** THE LIMB: past this distance the ground falls away much faster (cubic),
   *  so zoomed far out the planet ends in a round horizon — and the square
   *  edge of the drawn window always sits below it, out of sight. */
  uLimb: { value: new THREE.Vector2(LIMB_START, LIMB_K) },
};

/** GLSL to paste into a vertex shader. Call applyCurvature on a world-space position. */
export const curvatureGlsl = /* glsl */ `
  uniform vec3 uCamTarget;
  uniform float uCurvature;
  uniform vec2 uLimb;

  // The entire planet illusion:
  vec3 applyCurvature(vec3 worldPos) {
    vec2 d = worldPos.xz - uCamTarget.xz;
    float d2 = dot(d, d); // distance squared
    float l = max(0.0, sqrt(d2) - uLimb.x);
    worldPos.y -= uCurvature * d2 + uLimb.y * l * l * l;
    return worldPos;
  }
`;

/**
 * The same drop on the CPU, for anything positioned in JS (units, trees,
 * picking). (dx, dz) = offset from the camera target in world units.
 * Within LIMB_START it is exactly CURVATURE·d².
 */
export function curvatureDrop(dx: number, dz: number): number {
  const d2 = dx * dx + dz * dz;
  const l = Math.max(0, Math.sqrt(d2) - LIMB_START);
  return CURVATURE * d2 + LIMB_K * l * l * l;
}

// ---------------------------------------------------------------------------
// Bending three.js's BUILT-IN materials (Standard / Lambert / Basic / Phong /
// Physical / Depth): the shadow-safe way.
//
// Built-in materials compute two world positions in their vertex shaders:
//   - `project_vertex`  → where the vertex lands on screen;
//   - `worldpos_vertex` → what shadow-map lookups, env reflections and
//                         fog-free lighting use.
// Both must be bent identically, AND the shadow pass (which draws the scene
// from the sun with a depth material) must bend too — otherwise a curved
// hill would cast its shadow where the FLAT hill would be, and shadows would
// visibly detach from the ground in the distance. So:
//
//   applyCurvatureTo(material)   patches a material in place (returns it);
//   curvedDepthMaterial()        the matching shadow-caster material;
//   curveObject(object)          does both for every mesh under an object.
//
// Do NOT use these on objects that are already curved on the CPU (the
// current unit/tree/building renderers drop each group by CURVATURE·d²
// themselves) — that would bend them twice. They're for meshes placed at
// their true, unbent world position, whose vertices then bend on the GPU.
// ---------------------------------------------------------------------------

/** Rewrite a vertex shader's source so every world position is bent. */
export function curveVertexShader(vertexShader: string): string {
  if (vertexShader.includes('applyCurvature(')) return vertexShader; // already patched
  return vertexShader
    .replace('#include <common>', `#include <common>\n${curvatureGlsl}`)
    .replace(
      '#include <project_vertex>',
      /* glsl */ `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_BATCHING
        mvPosition = batchingMatrix * mvPosition;
      #endif
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 tgBent = modelMatrix * mvPosition;
      tgBent.xyz = applyCurvature( tgBent.xyz );
      mvPosition = viewMatrix * tgBent;
      gl_Position = projectionMatrix * mvPosition;
      `,
    )
    .replace(
      '#include <worldpos_vertex>',
      /* glsl */ `
      #include <worldpos_vertex>
      #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
        worldPosition.xyz = applyCurvature( worldPosition.xyz );
      #endif
      `,
    );
}

/** Hook the shared uniforms + bent vertex shader into a compiling shader. */
export function curveShader(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string }): void {
  shader.uniforms.uCamTarget = curvatureUniforms.uCamTarget;
  shader.uniforms.uCurvature = curvatureUniforms.uCurvature;
  shader.uniforms.uLimb = curvatureUniforms.uLimb;
  shader.vertexShader = curveVertexShader(shader.vertexShader);
}

const CURVED = Symbol('tgCurved');

/**
 * Make any built-in three.js material bend with the planet. Chains with an
 * existing onBeforeCompile (runs it first). Idempotent. Returns the material.
 */
export function applyCurvatureTo<T extends THREE.Material>(material: T): T {
  const m = material as T & { [CURVED]?: boolean };
  if (m[CURVED]) return material;
  m[CURVED] = true;
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    curveShader(shader);
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|tg-curved`;
  material.needsUpdate = true;
  return material;
}

let sharedDepth: THREE.MeshDepthMaterial | null = null;

/**
 * Shadow-caster material that bends like the world. Assign it as
 * `mesh.customDepthMaterial` on any mesh whose own material went through
 * applyCurvatureTo (curveObject does this for you). One shared instance is
 * fine for opaque meshes; pass `fresh = true` if you need to configure one
 * (e.g. alphaTest + map for cut-out leaves).
 */
export function curvedDepthMaterial(fresh = false): THREE.MeshDepthMaterial {
  if (!fresh && sharedDepth) return sharedDepth;
  const m = applyCurvatureTo(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));
  if (!fresh) sharedDepth = m;
  return m;
}

/**
 * Curve every mesh under `root`: patch its material(s) and give it the
 * curved shadow-caster. Use for objects positioned at their UNBENT world
 * position (no CPU curvature drop).
 */
export function curveObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) applyCurvatureTo(mat);
    if (mesh.isMesh) mesh.customDepthMaterial = curvedDepthMaterial();
    o.frustumCulled = false; // the GPU moves vertices after culling — bounds lie
  });
}

/**
 * TRANSITIONAL: the unit/tree/building renderers still drop their groups by
 * CURVATURE·d² on the CPU, which doesn't know about the limb. Until they
 * switch to curvatureDrop(), main.ts calls this after they sync: it adds
 * the limb's extra drop to every top-level object that is CPU-curved (i.e.
 * not tagged `userData.gpuCurved`). Inside LIMB_START it does nothing.
 */
export function applyLimbToCpuCurved(scene: THREE.Scene, camTarget: THREE.Vector3): void {
  for (const o of scene.children) {
    if (o.userData.gpuCurved || (o as THREE.Light).isLight || !o.visible) continue;
    // Objects left at the origin carry world-space geometry (e.g. the brush
    // ring); their position says nothing about where they are.
    if (o.position.x === 0 && o.position.z === 0) continue;
    // Non-cumulative: if no renderer re-placed the object since last frame,
    // take back last frame's drop before applying this frame's.
    const prev = o.userData.tgLimb as { y: number; d: number } | undefined;
    if (prev && o.position.y === prev.y) o.position.y += prev.d;
    const dx = o.position.x - camTarget.x;
    const dz = o.position.z - camTarget.z;
    const d2 = dx * dx + dz * dz;
    const l = Math.max(0, Math.sqrt(d2) - LIMB_START);
    const d = LIMB_K * l * l * l;
    o.position.y -= d;
    o.userData.tgLimb = { y: o.position.y, d };
  }
}
