/**
 * world/ground-cover.ts — grass you can see the wind in.
 *
 * A carpet of little grass clumps (and the odd flower) around the camera,
 * drawn as ONE instanced mesh. The carpet is a fixed grid of instances
 * that slides with the camera in whole-cell steps; each instance looks up
 * WHICH world cell it covers and everything about its clump comes from that
 * cell (grass-placement.ts), so a blade stays on its spot of ground however
 * the camera pans, turns or zooms. Clumps only come and go in a thin faded
 * band at the far edge. Everything else happens in the vertex shader:
 *
 *   - height and slope come from the heightmap texture (terrain-glsl.ts),
 *     so clumps sit exactly on the bicubic ground and ride live sculpting;
 *   - a density mask kills clumps where grass doesn't grow — beach, rock,
 *     snow, swamp, scorched ground, under water — and thins them toward the
 *     edge of the carpet so there's no visible boundary;
 *   - a per-cell hash jitters position, size, lean and colour (stable: the
 *     hash uses the WRAPPED world cell);
 *   - wind: a slow travelling gust plus flutter bends each blade by its
 *     height², so roots stay planted.
 *
 * Blade normals point straight up, the classic trick that makes grass shade
 * like the ground it grows from instead of like a forest of tiny planes.
 * The material is a patched MeshStandardMaterial so the carpet receives the
 * sun's shadows.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { GROUND_COVER, QualityTier, TERRAIN } from '../render/look';
import { curveShader } from './curvature';
import { GRASS_CELLS_PER_LAP, GRASS_JITTER, GRASS_SPACING } from './grass-placement';
import { heightGlsl, noiseGlsl } from './terrain-glsl';
import { WEAR_N, WEAR_RES } from './wear';
import { TerrainMesh } from './terrain-mesh';
import { FX_N, FX_RES } from './surface-fx';

/**
 * The one blast shock ring the grass knows about: (x, z) centre in world
 * units (the camera-near image), z = front radius, w = strength 0..1. The
 * effects renderer drives it; strength 0 = no shock.
 */
export const grassShock = { value: new THREE.Vector4(0, 0, 0, 0) };

/** One clump: a few tapered, bent blades fanned around the root. */
function clumpGeometry(blades: number, segs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const t: number[] = []; // 0 at root → 1 at tip
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const ang = (b / blades) * Math.PI + (b % 2) * 0.4;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const lean = 0.18 + 0.1 * (b % 3);
    const ox = Math.cos(ang * 2.3) * 0.12, oz = Math.sin(ang * 1.7) * 0.12;
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const k = s / segs;
      const w = 0.07 * (1 - k * 0.92);
      const bend = lean * k * k;
      // Blade lies in the plane spanned by (ca, sa) sideways and its lean direction.
      const cx = ox + -sa * bend, cz = oz + ca * bend;
      pos.push(cx - ca * w, k, cz - sa * w, cx + ca * w, k, cz + sa * w);
      t.push(k, k);
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

export class GroundCover {
  readonly mesh: THREE.Mesh;
  private readonly spacing: number;
  private readonly uTime = { value: 0 };
  /** Zoomed far out the clumps are sub-pixel speckle: shrink them away. */
  private readonly uFade = { value: 1 };
  /** The world cell (integer index) the grid is centred on this frame. */
  private readonly uOrigin = { value: new THREE.Vector2() };

  constructor(terrain: TerrainMesh, quality: QualityTier) {
    const radius = quality.name === 'high' ? GROUND_COVER.radiusHigh : GROUND_COVER.radiusMedium;
    this.spacing = GRASS_SPACING;
    const n = Math.ceil((radius * 2) / this.spacing) + 2;
    // Each instance is a whole-cell offset from the grid origin (integers,
    // exact in float32). The origin cell is a uniform set per frame.
    const offsets = new Float32Array(n * n * 2);
    let k = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        offsets[k++] = i - Math.floor(n / 2);
        offsets[k++] = j - Math.floor(n / 2);
      }
    }
    const clump = clumpGeometry(4, 3);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = clump.index;
    geo.setAttribute('position', clump.getAttribute('position'));
    geo.setAttribute('normal', clump.getAttribute('normal'));
    geo.setAttribute('aT', clump.getAttribute('aT'));
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
    geo.instanceCount = n * n;

    const uniforms = {
      uTime: this.uTime,
      uFade: this.uFade,
      uHeightTex: terrain.uniforms.uHeightTex,
      uTileTex: terrain.uniforms.uTileTex,
      uWearTex: terrain.uniforms.uWearTex,
      uFxTex: terrain.uniforms.uFxTex,
      uShock: grassShock,
      uRadius: { value: radius },
      uSpacing: { value: this.spacing },
      uOrigin: this.uOrigin,
      uHeightScale: { value: GROUND_COVER.height },
      uLush: { value: new THREE.Color(TERRAIN.grassLush) },
      uLush2: { value: new THREE.Color(TERRAIN.grassLush2) },
      uDry: { value: new THREE.Color(TERRAIN.grassDry) },
      uTip: { value: new THREE.Color(GROUND_COVER.tip) },
      uBands: terrain.uniforms.uBands,
      uSlopes: terrain.uniforms.uSlopes,
    };

    const material = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          ${heightGlsl}
          ${noiseGlsl}
          #define TG_WORLD_UNITS ${(WORLD_SIZE * TILE).toFixed(1)}
          #define TG_GRASS_LAP ${GRASS_CELLS_PER_LAP.toFixed(1)}
          #define TG_GRASS_JITTER ${GRASS_JITTER.toFixed(3)}
          uniform vec2 uOrigin;
          attribute vec2 aOffset;
          attribute float aT;
          uniform sampler2D uTileTex;
          uniform sampler2D uWearTex;
          uniform sampler2D uFxTex;
          uniform vec4 uShock;
          uniform float uTime, uRadius, uSpacing, uHeightScale, uFade;
          uniform vec3 uLush, uLush2, uDry, uTip;
          uniform vec4 uBands;
          uniform vec2 uSlopes;
          varying vec3 vGrass;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          // WORLD-ANCHORED: the clump is a pure function of its world cell
          // (an integer index); the camera only decides WHICH cells are drawn.
          // Mirrored on the CPU by grass-placement.ts (unit-tested there).
          vec2 cellIdx = uOrigin + aOffset;
          vec2 wcell = mod(cellIdx, TG_GRASS_LAP);
          float r1 = tgHash(wcell), r2 = tgHash(wcell + 17.3), r3 = tgHash(wcell + 41.9);
          vec2 root = cellIdx * uSpacing + (vec2(r1, r2) - 0.5) * uSpacing * TG_GRASS_JITTER;
          vec3 hg = tgHeightGrad(root / TG_TILE);
          float h = hg.x;
          float slope = 1.0 - normalize(vec3(-hg.y / TG_TILE, 1.0, -hg.z / TG_TILE)).y;
          vec4 td = texture2D(uTileTex, (root / TG_TILE + 0.5) / TG_N);

          // Where does grass grow? (Mirrors the terrain splat.)
          float m = smoothstep(uBands.y + 0.2, uBands.y + 0.9, h);            // above the beach
          m *= 1.0 - smoothstep(uSlopes.x - 0.04, uSlopes.x + 0.04, slope);   // not on banks/cliffs
          m *= 1.0 - smoothstep(uBands.z - 3.5, uBands.z - 1.5, h);           // not alpine/snow
          m *= 1.0 - smoothstep(0.2, 0.5, td.g);                              // not swamp
          m *= 1.0 - smoothstep(0.1, 0.4, td.a);                              // not scorched
          float wear = texture2D(uWearTex, (root / TG_TILE * ${WEAR_RES.toFixed(1)} + 0.5) / ${WEAR_N.toFixed(1)}).r;
          m *= 1.0 - smoothstep(0.15, 0.5, wear);                             // not trodden (plots, yards, home circles)
          vec4 sfx = texture2D(uFxTex, (root / TG_TILE * ${FX_RES.toFixed(1)} + 0.5) / ${FX_N.toFixed(1)});
          m *= 1.0 - smoothstep(0.08, 0.35, max(sfx.r, sfx.g));               // not on lava or basalt
          float patchy = tgNoise(root * 0.12, TG_WORLD_UNITS * 0.12);
          m *= smoothstep(0.3, 0.55, patchy + 0.15 + 0.2 * r2);               // tufty meadows and clearings
          // Only the FAR EDGE of the carpet fades (a thin, ragged band near
          // the radius): inside it every clump is full size wherever the
          // camera is, so nothing grows or shrinks under your eyes as you pan.
          float dist = length(root - uCamTarget.xz);
          m *= 1.0 - smoothstep(uRadius * 0.8, uRadius * 0.97, dist + (r1 - 0.5) * uRadius * 0.08);
          float size = m * uFade * uHeightScale * (0.6 + 0.8 * r3);

          // Colour: matches the ground's lush/dry, darker at the root, sunlit tips.
          float moist = clamp(td.b * 0.8 + 0.65 * (1.0 - smoothstep(0.0, 14.0, h)) + (tgFbm(root * (1.0 / 64.0), 4.0) - 0.5) * 0.9, 0.0, 1.0);
          vec3 base = mix(uDry, mix(uLush, uLush2, r2), smoothstep(0.3, 0.7, moist));
          vGrass = mix(base * 0.78, mix(base, uTip, 0.3) * 1.12, aT);
          // A few flowers: one bright blade tip in a sparse handful of clumps.
          if (r1 > 0.965 && aT > 0.7 && gl_VertexID < 8) {
            vGrass = r2 > 0.5 ? vec3(1.0, 0.85, 0.3) : (r3 > 0.5 ? vec3(0.95, 0.95, 1.0) : vec3(0.95, 0.5, 0.75));
          }

          // Wind: a travelling gust plus flutter, bending by height².
          float gust = sin(dot(root, vec2(0.08, 0.05)) - uTime * 1.3) * 0.5 + 0.5;
          float flutter = sin(uTime * 4.0 + r1 * 30.0) * 0.12;
          vec2 sway = vec2(0.8, 0.5) * (gust * 0.35 + flutter) * aT * aT;
          // A blast's shock ring flattens the grass as it rolls through (uShock:
          // centre xz in world units, front radius, strength 0..1).
          vec2 sd = root - uShock.xy;
          float sl = length(sd);
          float front = uShock.w * (1.0 - smoothstep(0.0, 5.0, abs(sl - uShock.z))) * step(sl, uShock.z + 5.0);
          float behind = uShock.w * 0.45 * step(sl, uShock.z) * (1.0 - smoothstep(0.0, 9.0, uShock.z - sl));
          sway += (sd / max(sl, 0.01)) * (front * 2.4 + behind) * aT;

          float ang = r3 * 6.2831;
          mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
          vec2 xz = rot * position.xz * (1.0 + 0.6 * r1) + sway;
          // size == 0 collapses the clump to a point: masked-out grass costs
          // a few vertex invocations and no pixels.
          vec3 transformed = vec3(root.x, h, root.y) + vec3(xz.x, position.y * (1.0 - 0.75 * clamp(front + behind, 0.0, 1.0)), xz.y) * size;
          // These are WORLD coordinates (the mesh itself stays at the origin).`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
        .replace('#include <map_fragment>', 'diffuseColor.rgb = vGrass;');
      curveShader(shader);
    };
    material.customProgramCacheKey = () => 'tg-grass';

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.userData.gpuCurved = true;
  }

  update(camTarget: THREE.Vector3, dt: number, viewDistance = 30): void {
    this.uFade.value = 1 - THREE.MathUtils.smoothstep(viewDistance, GROUND_COVER.fadeOut[0], GROUND_COVER.fadeOut[1]);
    this.mesh.visible = this.uFade.value > 0;
    const s = this.spacing;
    this.uOrigin.value.set(Math.round(camTarget.x / s), Math.round(camTarget.z / s));
    this.uTime.value += dt;
  }
}
