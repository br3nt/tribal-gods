/**
 * world/water.ts — the sea.
 *
 * Still one sheet at sea level (y = 0) that follows the camera, but now a
 * proper stylised ocean, all in one patched MeshStandardMaterial (so the
 * sun, sky reflections and shadows light it like everything else):
 *
 *   DEPTH COLOUR — every pixel samples the heightmap texture (the same one
 *     the terrain displaces with, see terrain-glsl.ts) to learn how deep
 *     the water is right there: turquoise over the sandbars, blue in the
 *     channels, ink-blue in the deeps. Shallows are also more transparent,
 *     so the beach shelf shows through.
 *   WAVES — a few travelling sine swells move the vertices and tilt the
 *     normal; two scrolling noise layers add ripple sparkle on top.
 *   REFLECTION — low roughness + the sky environment map give fresnel sky
 *     reflections at grazing angles and a glittering sun path for free.
 *   FOAM — a soft, broken band hugging every shoreline, with foam lines
 *     that wash in toward the beach and fade.
 *   CURVATURE — the same bend as everything else, so the sea falls over
 *     the horizon with the land.
 */

import * as THREE from 'three';
import { TILE, VIEW_TILES } from '../config';
import { RIM_END, RIM_START, WATER } from '../render/look';
import { curveShader } from './curvature';
import { bumpGlsl, heightGlsl, noiseGlsl } from './terrain-glsl';
import { TerrainMesh } from './terrain-mesh';

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly uTime = { value: 0 };
  private readonly step: number;

  constructor(terrain: TerrainMesh, segmentsPerTile = 1) {
    const size = VIEW_TILES * TILE;
    const segs = VIEW_TILES * segmentsPerTile;
    this.step = size / segs;
    const geometry = new THREE.PlaneGeometry(size, size, segs, segs);
    geometry.rotateX(-Math.PI / 2);

    const uniforms = {
      uTime: this.uTime,
      uHeightTex: terrain.uniforms.uHeightTex,
      uHaze: terrain.uniforms.uHaze,
      uRim: { value: new THREE.Vector2(RIM_START, RIM_END) },
      uShallow: { value: new THREE.Color(WATER.shallow) },
      uMid: { value: new THREE.Color(WATER.mid) },
      uDeep: { value: new THREE.Color(WATER.deep) },
      uFoam: { value: new THREE.Color(WATER.foam) },
      uWater: { value: new THREE.Vector4(WATER.depthScale, WATER.alphaShallow, WATER.alphaDeep, WATER.waveHeight) },
    };

    const material = new THREE.MeshStandardMaterial({
      roughness: WATER.roughness,
      metalness: 0,
      transparent: true,
      depthWrite: false,
    });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          uniform float uTime;
          uniform vec4 uWater;
          varying vec3 vTgPos;
          // Travelling swells: (direction.xy, wavelength, speed). Height and
          // world-space slope come back together.
          vec3 tgSwell(vec2 p, float t) {
            vec4 W[4];
            W[0] = vec4( 0.8,  0.6, 23.0, 1.1);
            W[1] = vec4(-0.5,  0.85, 14.0, 0.9);
            W[2] = vec4( 0.95, -0.3,  9.0, 1.4);
            W[3] = vec4(-0.7, -0.7,  6.0, 1.7);
            float h = 0.0; vec2 g = vec2(0.0);
            for (int i = 0; i < 4; i++) {
              float k = 6.2831853 / W[i].z;
              float a = 1.0 / (1.0 + float(i) * 0.7);
              float ph = dot(W[i].xy, p) * k + t * W[i].w;
              h += a * sin(ph);
              g += a * k * cos(ph) * W[i].xy;
            }
            return vec3(h, g) * uWater.w;
          }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          vec3 tgW = (modelMatrix * vec4(position, 1.0)).xyz;
          vec3 tgS = tgSwell(tgW.xz, uTime);
          vec3 objectNormal = normalize(vec3(-tgS.y, 1.0, -tgS.z));`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          vec3 transformed = vec3(position.x, tgS.x, position.z);
          vTgPos = vec3(tgW.x, tgS.x, tgW.z);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          ${heightGlsl}
          ${noiseGlsl}
          ${bumpGlsl}
          uniform float uTime;
          uniform vec4 uWater;
          uniform vec3 uShallow, uMid, uDeep, uFoam, uHaze;
          uniform vec2 uRim;
          uniform vec3 uCamTarget;
          varying vec3 vTgPos;`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          vec2 wp = vTgPos.xz;
          float depth = max(0.0, -tgHeightAtWorld(wp));
          float n1 = tgNoise(wp * 0.25 + vec2(uTime * 0.12, uTime * 0.05), 64.0);
          float n2 = tgNoise(wp * 0.5 - vec2(uTime * 0.07, -uTime * 0.11), 128.0);
          float dk = 1.0 - exp(-depth / uWater.x);
          vec3 c = mix(uShallow, uMid, smoothstep(0.0, 0.55, dk));
          c = mix(c, uDeep, smoothstep(0.45, 1.0, dk));
          float alpha = mix(uWater.y, uWater.z, smoothstep(0.0, 0.7, dk));

          // Foam: a soft band at the waterline, plus lines washing in.
          float edge = 1.0 - smoothstep(0.0, 0.22 + 0.18 * n1, depth);
          float band = 1.0 - smoothstep(0.1, 1.1, depth);
          float wash = sin(depth * 9.0 - uTime * 1.6 + n1 * 5.0) * 0.5 + 0.5;
          float lines = smoothstep(0.78, 0.95, wash) * band * smoothstep(0.35, 0.65, n2);
          float foam = clamp(max(edge * (0.55 + 0.45 * n2), lines * 0.8), 0.0, 1.0);
          c = mix(c, uFoam, foam);
          alpha = mix(alpha, 0.97, foam);
          diffuseColor = vec4(c, alpha);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, foam);',
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #include <normal_fragment_maps>
          // Ripple sparkle: two noise layers scrolling against each other.
          float tgRipple = (n1 * 0.6 + n2 * 0.4) * 0.12 * (1.0 - foam);
          float tgFade = 1.0 - smoothstep(40.0, 160.0, length(vViewPosition));
          normal = tgPerturb(-vViewPosition, normal, tgRipple * tgFade, faceDirection);`,
        )
        .replace(
          '#include <fog_fragment>',
          /* glsl */ `
          #include <fog_fragment>
          float tgR = length(vTgPos.xz - uCamTarget.xz);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, smoothstep(uRim.x, uRim.y, tgR));`,
        );
      curveShader(shader);
    };
    material.customProgramCacheKey = () => 'tg-water';

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false; // the shader bends it
    this.mesh.receiveShadow = true;
    // Draw after the opaque terrain so the blend has the seabed beneath it.
    this.mesh.renderOrder = 1;
  }

  /** Follow the camera (in whole grid cells, so waves don't swim) and advance time. */
  update(camTargetWorld: THREE.Vector3, dt: number): void {
    const s = this.step;
    this.mesh.position.set(Math.round(camTargetWorld.x / s) * s, 0, Math.round(camTargetWorld.z / s) * s);
    this.uTime.value += dt;
  }
}
