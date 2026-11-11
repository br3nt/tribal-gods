/**
 * assets/models/materials.ts — THE material factory for every model.
 *
 * Every character, building, tree and prop material is created here and
 * nowhere else. That is a rule with a purpose: shader-level features that
 * must apply to *all* world objects (the planet's curvature bend, a shadow
 * tweak, fog, a debug tint) get added in exactly one place — push a patch
 * onto `materialPatches` and every model material compiles with it.
 *
 * Our models are vertex-coloured: one MeshStandardMaterial per *kind* of
 * surface (cloth-ish, glossy, foliage...) and the colour lives in the
 * geometry's `color` attribute. That keeps a whole villager to a single
 * draw call. Two extra per-vertex channels are spliced into the standard
 * shader here:
 *
 *   glow  (vec3)  — emissive radiance per vertex. Embers, staff crystals,
 *                   lit windows: paint them with `glow` and they shine in
 *                   any light, pulsing gently with uTime.
 *   sway  (float) — wind weight per vertex (0 at the trunk, 1 at the leaf
 *                   tips). Only materials made with `wind: true` read it;
 *                   the bend is done in the vertex shader so a forest of
 *                   instanced trees moves for free.
 *
 * Shared uniforms (uTime, uWind) are one object referenced by all
 * materials, ticked once per frame by `tickModelMaterials`.
 */

import * as THREE from 'three';

/** Uniforms shared by every model material (referenced, never copied). */
export const modelUniforms = {
  uTime: { value: 0 },
  /** xz = wind direction × strength. */
  uWind: { value: new THREE.Vector2(0.8, 0.35) },
};

/**
 * Hooks applied to every model material's shader at compile time, in
 * order, after our own glow/wind patches. Signature mirrors onBeforeCompile.
 *
 * (The planet's curvature bend is NOT registered here: the renderers apply
 * it per object with world/curvature.ts curveObject(), which also gives
 * each mesh the bent shadow caster. The gallery draws the same materials
 * unbent.)
 */
export const materialPatches: Array<(shader: THREE.WebGLProgramParametersWithUniforms, material: THREE.Material) => void> = [];

/** Every material the factory ever made, so a late patch can force recompiles. */
export const allModelMaterials: THREE.Material[] = [];

export interface ModelMaterialOptions {
  /** Base colour (multiplies vertex colours). Default white. */
  color?: number;
  roughness?: number;
  metalness?: number;
  /** Use the geometry's `color` attribute. Default true. */
  vertexColors?: boolean;
  /** Read the `glow` attribute into emissive. Default true. */
  glow?: boolean;
  /** Bend vertices by the `sway` attribute in the wind. */
  wind?: boolean;
  /** Pulse the glow over time (rad/s); 0 = steady. */
  glowPulse?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  flatShading?: boolean;
  emissive?: number;
  emissiveIntensity?: number;
  depthWrite?: boolean;
}

const GLOW_VERT_DECL = /* glsl */ `
attribute vec3 glow;
varying vec3 vGlow;
`;
const WIND_VERT_DECL = /* glsl */ `
attribute float sway;
uniform float uTime;
uniform vec2 uWind;
`;

/** Make a model material. All model materials come from here. */
export function modelMaterial(opts: ModelMaterialOptions = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    roughness: opts.roughness ?? 0.82,
    metalness: opts.metalness ?? 0,
    vertexColors: opts.vertexColors ?? true,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    depthWrite: opts.depthWrite ?? true,
  });
  const glow = opts.glow ?? true;
  const wind = opts.wind ?? false;
  const pulse = opts.glowPulse ?? 2.2;

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = modelUniforms.uTime;
    shader.uniforms.uWind = modelUniforms.uWind;
    if (glow) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GLOW_VERT_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n vGlow = glow;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vGlow;\nuniform float uTime;`)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           totalEmissiveRadiance += vGlow * (0.82 + 0.18 * sin(uTime * ${pulse.toFixed(2)} + vGlow.r * 7.0));`,
        );
    }
    if (wind) {
      // Bend in object space, phase-shifted by where the instance stands so
      // a forest ripples instead of nodding in lockstep. Height-weighted by
      // `sway` (painted into the geometry: 0 at the roots, 1 at the crown).
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WIND_VERT_DECL}`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec3 anchor = vec3(0.0);
             #ifdef USE_INSTANCING
               anchor = instanceMatrix[3].xyz;
             #endif
             float ph = anchor.x * 0.37 + anchor.z * 0.29;
             float gust = 0.6 + 0.4 * sin(uTime * 0.7 + ph * 0.3);
             float s = sway * sway;
             transformed.x += (sin(uTime * 1.7 + ph) * 0.6 + 0.6) * uWind.x * s * gust * 0.35;
             transformed.z += (sin(uTime * 1.3 + ph * 1.3) * 0.6 + 0.6) * uWind.y * s * gust * 0.35;
             transformed.y -= s * 0.04 * gust;
           }`,
        );
    }
    for (const patch of materialPatches) patch(shader, m);
  };
  m.customProgramCacheKey = () => `tg-model|g${glow ? 1 : 0}|w${wind ? 1 : 0}|p${pulse}|n${materialPatches.length}`;
  allModelMaterials.push(m);
  return m;
}

/** Additive, unlit glow (auras, flames, light shafts). Not shadowed. */
export function glowMaterial(color: number, opacity = 0.6): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  allModelMaterials.push(m);
  return m;
}

/** Flat decal (selection rings, scorch marks): unlit, transparent, no depth write. */
export function decalMaterial(color: number, opacity = 0.85): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  allModelMaterials.push(m);
  return m;
}

/** Dispose a per-instance factory material and forget it (shared ones must never go through here). */
export function disposeModelMaterial(m: THREE.Material): void {
  const i = allModelMaterials.indexOf(m);
  if (i >= 0) allModelMaterials.splice(i, 1);
  m.dispose();
}

/**
 * A private, fadeable copy of a factory material. Material.clone() drops
 * the instance-level onBeforeCompile (glow, wind, registered patches), so
 * copy the hooks across explicitly.
 */
export function fadeCopy(m: THREE.Material): THREE.Material {
  const c = m.clone();
  c.onBeforeCompile = m.onBeforeCompile;
  c.customProgramCacheKey = m.customProgramCacheKey;
  c.transparent = true;
  allModelMaterials.push(c);
  return c;
}

/** How a status variant differs from its base surface. */
export interface TintSpec {
  /** Multiplies the vertex colours. */
  color: number;
  emissive: number;
  emissiveIntensity?: number;
  /** Added to the base roughness / metalness (clamped 0..1). */
  roughnessShift?: number;
  metalnessShift?: number;
  /** 0..1: pull the vertex colours toward their grey (before `color` multiplies). */
  desaturate?: number;
  /** Fresnel rim light (linear radiance at grazing angles), for a sheen. */
  rim?: number;
  /** Paint over the vertex colours (before `color` multiplies): toward `paint` by `paintAmount` 0..1. */
  paint?: number;
  paintAmount?: number;
}

const glslVec3 = (hex: number) => {
  const c = new THREE.Color(hex); // linear
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

const tinted = new Map<string, THREE.Material>();
/**
 * A SHARED tinted variant of a shared factory material (Stone Ward,
 * Warsong): one instance per (base, key), so a hundred warded villagers
 * still draw from two materials. Keeps the base's shader hooks. Never
 * dispose it.
 */
export function tintedMaterial(base: THREE.Material, key: string, spec: TintSpec): THREE.Material {
  const id = `${base.uuid}|${key}`;
  let m = tinted.get(id);
  if (m) return m;
  const c = base.clone() as THREE.MeshStandardMaterial;
  const desat = spec.desaturate ?? 0;
  const rim = spec.rim ?? 0;
  const paintK = spec.paint !== undefined ? spec.paintAmount ?? 1 : 0;
  c.onBeforeCompile = (shader, renderer) => {
    base.onBeforeCompile(shader, renderer);
    if (desat > 0) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), ${desat.toFixed(3)});`,
      );
    }
    if (paintK > 0) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         diffuseColor.rgb = mix(diffuseColor.rgb, ${glslVec3(spec.paint!)} * (0.8 + 0.4 * dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1))), ${paintK.toFixed(3)});`,
      );
    }
    if (rim > 0) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        `#include <lights_fragment_begin>
         totalEmissiveRadiance += ${glslVec3(rim)} * pow(1.0 - saturate(dot(geometryNormal, geometryViewDir)), 3.0);`,
      );
    }
  };
  const baseKey = base.customProgramCacheKey.bind(base);
  c.customProgramCacheKey = () => `${baseKey()}|tint-${key}|d${desat}|r${rim}|p${paintK}`;
  c.color.setHex(spec.color);
  c.emissive.setHex(spec.emissive);
  c.emissiveIntensity = spec.emissiveIntensity ?? 1;
  c.roughness = THREE.MathUtils.clamp(c.roughness + (spec.roughnessShift ?? 0), 0, 1);
  c.metalness = THREE.MathUtils.clamp(c.metalness + (spec.metalnessShift ?? 0), 0, 1);
  allModelMaterials.push(c);
  tinted.set(id, c);
  m = c;
  return m;
}

/** Re-run every model material's compile (after pushing a late patch). */
export function recompileModelMaterials(): void {
  for (const m of allModelMaterials) m.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// The shared palette of surfaces. One instance each — reused by every model.
// ---------------------------------------------------------------------------

let shared: ReturnType<typeof makeShared> | null = null;
function makeShared() {
  return {
    /** Skin, cloth, wood, thatch, stone: most of the world. */
    matte: modelMaterial({ roughness: 0.86 }),
    /** Polished bits: gold, glazed tile, metal. */
    glossy: modelMaterial({ roughness: 0.38, metalness: 0.45 }),
    /** Trees and bushes: vertex-coloured, wind-bent. Double-sided leaves. */
    foliage: modelMaterial({ roughness: 0.9, wind: true, side: THREE.DoubleSide }),
    /** Trunks and rocks that don't sway but share instancing. */
    bark: modelMaterial({ roughness: 0.95 }),
  };
}
/** Shared materials, created on first use. */
export function sharedMaterials() {
  if (!shared) shared = makeShared();
  return shared;
}

/** Advance shared shader time. Call once per frame from any renderer. */
let lastTickFrame = -1;
export function tickModelMaterials(dt: number, frame?: number): void {
  if (frame !== undefined) {
    if (frame === lastTickFrame) return;
    lastTickFrame = frame;
  }
  modelUniforms.uTime.value += dt;
}
