/**
 * world/terrain-mesh.ts — turning the heightmap into a painted landscape.
 *
 * Three jobs:
 *
 * 1. THE SLIDING GRID. We keep ONE fixed grid of vertices covering a
 *    VIEW_TILES × VIEW_TILES window, and slide it under the camera in steps
 *    of exactly one grid cell (so each vertex always lands on the same
 *    world points — no swimming). The vertex shader looks its height up in
 *    the heightmap TEXTURE (see terrain-glsl.ts), wrapping around the
 *    planet for free. Panning costs nothing; sculpting re-uploads 64 KB.
 *
 * 2. THE SURFACE. A patched MeshStandardMaterial — so the ground is lit by
 *    the same sun, sky light and shadows as everything else — whose albedo
 *    is painted per pixel by a procedural splat:
 *
 *        height  → seabed, wet sand, beach, grass, snow caps
 *        slope   → earth on banks, layered rock on cliffs
 *        moisture→ lush vs. dry grass (wet near water, macro noise)
 *        forest  → darker mossy floor under trees
 *        swamp   → mud with standing water (world.swamp)
 *        scorch  → burnt ground left by fire spells (fades over time)
 *
 *    Fine bump detail perturbs the normal so close-up ground has grain
 *    instead of being a smooth blob. No texture files: it's all noise.
 *
 * 3. THE TILE DATA TEXTURE. Per-tile facts the shader can't derive from
 *    height alone (forest density, swamp, moisture, scorch) live in a small
 *    RGBA texture rebuilt on the CPU only when they change.
 */

import * as THREE from 'three';
import { TILE, VIEW_TILES, WORLD_SIZE } from '../config';
import { curveShader } from './curvature';
import { Heightmap } from './heightmap';
import { bumpGlsl, heightGlsl, noiseGlsl } from './terrain-glsl';
import { QualityTier, RIM_END, RIM_START, TERRAIN } from '../render/look';

const N = WORLD_SIZE;

/** What the terrain needs to know about the world beyond heights. Loosely typed on purpose. */
export interface TerrainWorldView {
  trees?: ReadonlyArray<{ x: number; z: number; alive: boolean }>;
  swamp?: ReadonlyMap<number, number>;
}

const col = (hex: number) => ({ value: new THREE.Color(hex) });

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  /** The heightmap as a float texture (shares map.heights' memory). */
  readonly heightTexture: THREE.DataTexture;
  /** Per-tile R forest, G swamp, B water proximity, A scorch. */
  readonly tileTexture: THREE.DataTexture;
  /** Shared uniforms other world shaders (water) can reference. */
  readonly uniforms: Record<string, THREE.IUniform>;

  private readonly step: number;
  private uploadedVersion = -1;
  private moistureVersion = -1;
  private moistureCooldown = 0;
  private forestKey = '';
  private swampKey = '';

  private readonly tileData = new Uint8Array(N * N * 4);
  private readonly moisture = new Float32Array(N * N);
  private readonly forest = new Float32Array(N * N);
  private readonly scorch = new Float32Array(N * N);
  private scorchLive = false;
  private scorchTimer = 0;

  constructor(
    private readonly map: Heightmap,
    quality: QualityTier,
  ) {
    const sub = quality.terrainSubdiv;
    this.step = TILE / sub;
    const cells = VIEW_TILES * sub;
    const verts = cells + 1;
    const half = (cells * this.step) / 2;

    // Flat grid in local coords; the vertex shader supplies the height.
    const positions = new Float32Array(verts * verts * 3);
    let k = 0;
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        positions[k++] = -half + i * this.step;
        positions[k++] = 0;
        positions[k++] = -half + j * this.step;
      }
    }
    const indices = new Uint32Array(cells * cells * 6);
    k = 0;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = j * verts + i;
        const b = a + 1;
        const c = a + verts;
        const d = c + 1;
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.heightTexture = new THREE.DataTexture(map.heights, N, N, THREE.RedFormat, THREE.FloatType);
    this.heightTexture.minFilter = this.heightTexture.magFilter = THREE.NearestFilter;
    this.heightTexture.needsUpdate = true;

    this.tileTexture = new THREE.DataTexture(this.tileData, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tileTexture.wrapS = this.tileTexture.wrapT = THREE.RepeatWrapping;
    this.tileTexture.minFilter = this.tileTexture.magFilter = THREE.LinearFilter;
    this.tileTexture.needsUpdate = true;

    this.uniforms = {
      uHeightTex: { value: this.heightTexture },
      uTileTex: { value: this.tileTexture },
      uHaze: { value: new THREE.Color(0xb4d4ea) },
      uRim: { value: new THREE.Vector2(RIM_START, RIM_END) },
      uSeabed: col(TERRAIN.seabed),
      uSeabedDeep: col(TERRAIN.seabedDeep),
      uWetSand: col(TERRAIN.wetSand),
      uSand: col(TERRAIN.sand),
      uGrassLush: col(TERRAIN.grassLush),
      uGrassLush2: col(TERRAIN.grassLush2),
      uGrassDry: col(TERRAIN.grassDry),
      uGrassDry2: col(TERRAIN.grassDry2),
      uForestFloor: col(TERRAIN.forestFloor),
      uEarth: col(TERRAIN.earth),
      uRock: col(TERRAIN.rock),
      uRockDark: col(TERRAIN.rockDark),
      uRockWarm: col(TERRAIN.rockWarm),
      uSnow: col(TERRAIN.snow),
      uSwampMud: col(TERRAIN.swampMud),
      uSwampWater: col(TERRAIN.swampWater),
      uScorch: col(TERRAIN.scorch),
      uBands: { value: new THREE.Vector4(TERRAIN.wetBand, TERRAIN.beachTop, TERRAIN.snowLine, 0) },
      uSlopes: { value: new THREE.Vector2(TERRAIN.earthSlope, TERRAIN.rockSlope) },
      uTime: { value: 0 },
    };

    const detail = quality.terrainDetail;
    const material = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = patchVertex(shader.vertexShader, true);
      shader.fragmentShader = patchFragment(shader.fragmentShader, detail);
      curveShader(shader);
    };
    material.customProgramCacheKey = () => `tg-terrain-${detail}`;
    // Hills shadow the valleys: the heightfield must cast with its FRONT
    // faces (the default would draw back faces into the shadow map, and a
    // heightfield seen from the sun has none).
    material.shadowSide = THREE.FrontSide;

    // The shadow caster has to displace AND bend exactly like the visible
    // surface, or hill shadows would be cast by an invisible flat plane.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = patchVertex(shader.vertexShader, false);
      curveShader(shader);
    };
    depth.customProgramCacheKey = () => 'tg-terrain-depth';

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.customDepthMaterial = depth;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    // The shader moves every vertex; the CPU-side bounds mean nothing.
    this.mesh.frustumCulled = false;

    this.rebuildMoisture();
    this.writeTileTexture();
  }

  /**
   * Once per frame: slide the grid under the camera, re-upload heights when
   * a spell changed them, and refresh per-tile data when the world changed.
   */
  sync(camTargetWorld: THREE.Vector3, world?: TerrainWorldView, dt = 0): void {
    const s = this.step;
    this.mesh.position.set(Math.round(camTargetWorld.x / s) * s, 0, Math.round(camTargetWorld.z / s) * s);
    this.uniforms.uTime.value += dt;

    let dirty = false;
    if (this.map.version !== this.uploadedVersion) {
      this.heightTexture.needsUpdate = true;
      this.uploadedVersion = this.map.version;
    }
    // Moisture is a blur over the whole map: throttle it while sculpting.
    this.moistureCooldown -= dt;
    if (this.map.version !== this.moistureVersion && this.moistureCooldown <= 0) {
      this.rebuildMoisture();
      this.moistureCooldown = 0.3;
      dirty = true;
    }
    if (world?.trees) dirty = this.rebuildForest(world.trees) || dirty;
    if (world?.swamp) dirty = this.checkSwamp(world.swamp) || dirty;

    if (this.scorchLive) {
      this.scorchTimer -= dt;
      if (this.scorchTimer <= 0) {
        // Scorch fades over ~a minute and a half; update the texture at 4 Hz.
        const decay = 0.25 / 90;
        let any = false;
        for (let i = 0; i < this.scorch.length; i++) {
          if (this.scorch[i] > 0) {
            this.scorch[i] = Math.max(0, this.scorch[i] - decay);
            any = true;
          }
        }
        this.scorchLive = any;
        this.scorchTimer = 0.25;
        dirty = true;
      }
    }
    if (dirty) this.writeTileTexture();
  }

  /** Burn the ground around fractional tile (x, z). Effects call this. */
  addScorch(x: number, z: number, radius: number, amount = 1): void {
    const r = Math.ceil(radius);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.round(x) + dx;
        const tz = Math.round(z) + dz;
        const d = Math.hypot(tx - x, tz - z) / Math.max(0.5, radius);
        if (d >= 1) continue;
        const i = this.map.wrap(tz) * N + this.map.wrap(tx);
        this.scorch[i] = Math.min(1, this.scorch[i] + amount * (1 - d * d));
      }
    }
    this.scorchLive = true;
    this.scorchTimer = 0;
  }

  /** Set the haze colour the far rim melts into (sky.ts owns the palette). */
  setHaze(c: THREE.Color): void {
    (this.uniforms.uHaze.value as THREE.Color).copy(c);
  }

  // -------------------------------------------------------------------------

  /** Moisture: how close to water each tile is, blurred into soft gradients. */
  private rebuildMoisture(): void {
    const m = this.moisture;
    const h = this.map.heights;
    for (let i = 0; i < m.length; i++) m[i] = h[i] < 0.6 ? 1 : 0;
    // Three wrapped box blurs ≈ a gaussian several tiles wide.
    const tmp = new Float32Array(m.length);
    for (let pass = 0; pass < 3; pass++) {
      boxBlur(m, tmp, 3);
    }
    for (let i = 0; i < m.length; i++) m[i] = Math.min(1, m[i] * 2);
    this.moistureVersion = this.map.version;
  }

  private rebuildForest(trees: ReadonlyArray<{ x: number; z: number; alive: boolean }>): boolean {
    let alive = 0;
    let sum = 0;
    for (const t of trees) {
      if (t.alive) {
        alive++;
        sum += t.x * 7 + t.z * 131;
      }
    }
    const key = `${trees.length}:${alive}:${sum}`;
    if (key === this.forestKey) return false;
    this.forestKey = key;
    const f = this.forest;
    f.fill(0);
    for (const t of trees) {
      if (!t.alive) continue;
      const cx = Math.round(t.x);
      const cz = Math.round(t.z);
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.hypot(dx, dz);
          if (d > 2.5) continue;
          const i = this.map.wrap(cz + dz) * N + this.map.wrap(cx + dx);
          f[i] = Math.min(1, f[i] + 0.45 * (1 - d / 2.5));
        }
      }
    }
    return true;
  }

  private checkSwamp(swamp: ReadonlyMap<number, number>): boolean {
    let sum = 0;
    for (const k of swamp.keys()) sum += k;
    const key = `${swamp.size}:${sum}`;
    if (key === this.swampKey) return false;
    this.swampKey = key;
    this.swampSet = swamp;
    return true;
  }
  private swampSet: ReadonlyMap<number, number> | null = null;

  private writeTileTexture(): void {
    const d = this.tileData;
    for (let i = 0; i < N * N; i++) {
      const o = i * 4;
      d[o] = this.forest[i] * 255;
      d[o + 1] = this.swampSet?.has(i) ? 255 : 0;
      d[o + 2] = this.moisture[i] * 255;
      d[o + 3] = this.scorch[i] * 255;
    }
    this.tileTexture.needsUpdate = true;
  }

  /** Convert a point in world units to fractional tile coordinates. */
  static worldToTile(p: THREE.Vector3): { x: number; z: number } {
    return { x: p.x / TILE, z: p.z / TILE };
  }
}

/** Wrapped separable box blur of radius r, in place (tmp is scratch). */
function boxBlur(a: Float32Array, tmp: Float32Array, r: number): void {
  const w = 2 * r + 1;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[z * N + ((x + k + N) % N)];
      tmp[z * N + x] = s / w;
    }
  }
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[((z + k + N) % N) * N + x];
      a[z * N + x] = s / w;
    }
  }
}

// ---------------------------------------------------------------------------
// Shader patches
// ---------------------------------------------------------------------------

function patchVertex(src: string, withVaryings: boolean): string {
  const decl = /* glsl */ `
    ${heightGlsl}
    ${withVaryings ? 'varying vec3 vTgPos;\nvarying vec3 vTgN;' : ''}
  `;
  // Height + gradient once at the top of main(), used for both the normal
  // and the position (the depth material compiles its normal chunk out).
  const mainHead = /* glsl */ `
    vec3 tgW = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 tgHG = tgHeightGrad(tgW.xz / TG_TILE);
    vec3 tgObjN = normalize(vec3(-tgHG.y / TG_TILE, 1.0, -tgHG.z / TG_TILE));
  `;
  const normalChunk = /* glsl */ `
    vec3 objectNormal = tgObjN;
    #ifdef USE_TANGENT
      vec3 objectTangent = vec3(1.0, 0.0, 0.0);
    #endif
  `;
  const beginChunk = /* glsl */ `
    vec3 transformed = vec3(position.x, tgHG.x, position.z);
    ${withVaryings ? 'vTgPos = vec3(tgW.x, tgHG.x, tgW.z);\nvTgN = tgObjN;' : ''}
  `;
  return src
    .replace('#include <common>', `#include <common>\n${decl}`)
    .replace('void main() {', `void main() {\n${mainHead}`)
    .replace('#include <beginnormal_vertex>', normalChunk)
    .replace('#include <begin_vertex>', beginChunk);
}

function patchFragment(src: string, detail: boolean): string {
  const decl = /* glsl */ `
    #define TG_DETAIL ${detail ? 1 : 0}
    #define TG_N ${N.toFixed(1)}
    #define TG_TILE ${TILE.toFixed(1)}
    uniform sampler2D uTileTex;
    uniform vec3 uCamTarget;
    uniform vec3 uHaze;
    uniform vec2 uRim;
    uniform vec3 uSeabed, uSeabedDeep, uWetSand, uSand, uGrassLush, uGrassLush2, uGrassDry, uGrassDry2;
    uniform vec3 uForestFloor, uEarth, uRock, uRockDark, uRockWarm, uSnow, uSwampMud, uSwampWater, uScorch;
    uniform vec4 uBands;
    uniform vec2 uSlopes;
    uniform float uTime;
    varying vec3 vTgPos;
    varying vec3 vTgN;
    ${noiseGlsl}
    ${bumpGlsl}
  `;

  // Albedo, roughness and bump height, all computed together.
  const albedo = /* glsl */ `
    vec2 wp = vTgPos.xz;
    float h = vTgPos.y;
    vec3 Nw = normalize(vTgN);
    float slope = 1.0 - Nw.y;
    vec4 td = texture2D(uTileTex, (wp / TG_TILE + 0.5) / TG_N);
    // Far away, fine grain turns to blotches: calm it with distance.
    float tgFar = smoothstep(35.0, 140.0, length(vViewPosition));
    float grain = 1.0 - 0.65 * tgFar;

    float nMacro = tgFbm(wp * (1.0 / 64.0), 4.0);
    float nMid = tgNoise(wp * (1.0 / 8.0), 32.0);
    float nFine = tgNoise(wp * 0.5, 128.0);
    #if TG_DETAIL
      float nMicro = tgNoise(wp * 2.0, 512.0);
      float nMicro2 = tgNoise(wp * 5.0 + 17.0, 1280.0);
    #else
      float nMicro = 0.5;
      float nMicro2 = 0.5;
    #endif

    // --- Grass: lush where it's wet, straw-gold where it's dry ---
    // Moisture: near water, or low ground (which holds water), plus macro variation.
    float moist = clamp(td.b * 0.8 + 0.65 * (1.0 - smoothstep(0.0, 14.0, h)) + (nMacro - 0.5) * 0.9, 0.0, 1.0);
    vec3 lush = mix(uGrassLush, uGrassLush2, smoothstep(0.25, 0.75, nMid));
    vec3 dry = mix(uGrassDry, uGrassDry2, smoothstep(0.3, 0.7, nFine));
    vec3 c = mix(dry, lush, smoothstep(0.3, 0.7, moist));
    // Brush-stroke grain: clumps and blades.
    c *= 1.0 + grain * (0.2 * (nFine - 0.5) + 0.12 * (nMicro - 0.5) + 0.1 * (nMicro2 - 0.5));
    float rough = 0.92;
    float bump = nFine * 0.10 + nMicro * 0.05 + nMicro2 * 0.03;

    // --- Forest floor: darker, mossier, a touch of leaf litter ---
    float forestK = smoothstep(0.12, 0.7, td.r + (nFine - 0.5) * 0.25);
    vec3 floorC = uForestFloor * (0.8 + 0.35 * nFine) + vec3(0.05, 0.03, 0.0) * step(0.72, nMicro);
    c = mix(c, floorC, forestK * 0.85);

    // --- Earth on banks, rock on cliffs (with sedimentary layers) ---
    float sl = slope + (nMid - 0.5) * 0.08;
    float earthK = smoothstep(uSlopes.x, uSlopes.x + 0.06, sl);
    c = mix(c, uEarth * (0.82 + 0.3 * nFine), earthK);
    float strata = sin(h * 2.4 + nMid * 2.5 + nMacro * 4.0) * 0.5 + 0.5;
    vec3 rock = mix(uRockDark, uRock, smoothstep(0.2, 0.8, strata));
    rock = mix(rock, uRockWarm, smoothstep(0.4, 0.8, nMacro) * 0.7);
    rock *= 0.8 + 0.35 * nFine + 0.1 * (nMicro - 0.5);
    // High ground turns alpine: thinner turf, rock breaking through sooner.
    float alpK = smoothstep(7.5, 11.5, h + (nMid - 0.5) * 3.0);
    c = mix(c, mix(uRock * 1.05, uGrassDry * 0.75, smoothstep(0.35, 0.65, nFine)), alpK * 0.55);
    float rockK = smoothstep(uSlopes.y - 0.13 * alpK, uSlopes.y - 0.13 * alpK + 0.08, sl);
    c = mix(c, rock, rockK);
    rough = mix(rough, 0.78, rockK);
    bump = mix(bump, strata * 0.25 + nFine * 0.18 + nMicro * 0.08, max(rockK, earthK * 0.5));

    // --- Beach and the wet band at the waterline ---
    float beachTop = uBands.y + (nMid - 0.5) * 0.9;
    float beachK = (1.0 - smoothstep(beachTop - 0.35, beachTop + 0.15, h)) * (1.0 - rockK * 0.7)
                 * smoothstep(0.08, 0.3, td.b); // beaches need a sea: inland lowlands stay green
    vec3 sand = uSand * (0.93 + 0.12 * nFine + 0.06 * (nMicro2 - 0.5));
    c = mix(c, sand, beachK);
    float ripples = sin(dot(wp, vec2(0.8, 0.6)) * 3.2 + nMid * 6.0) * 0.5 + 0.5;
    bump = mix(bump, ripples * 0.025 + nMicro * 0.02, beachK);
    rough = mix(rough, 0.88, beachK);
    float wetK = 1.0 - smoothstep(uBands.x * 0.4, uBands.x + nFine * 0.25, h);
    c = mix(c, uWetSand, wetK);
    rough = mix(rough, 0.35, wetK);

    // --- Under the sea: wet sand into weedy seabed ---
    if (h < 0.0) {
      vec3 sea = mix(uWetSand, uSeabed, smoothstep(-0.1, -2.5, h + (nMid - 0.5)));
      sea = mix(sea, uSeabedDeep, smoothstep(-2.5, -7.0, h));
      c = sea * (0.9 + 0.2 * nFine);
      rough = 0.6;
    }

    // --- Snow caps: on high, flattish ground ---
    float snowK = smoothstep(uBands.z - 1.2, uBands.z + 0.4, h + (nMid - 0.5) * 3.0)
                * (1.0 - smoothstep(0.22, 0.4, slope + (nFine - 0.5) * 0.15));
    // Wind-scoured: patchy near the snow line, solid only near the summit.
    snowK *= smoothstep(0.35, 0.55, nFine * 0.45 + nMid * 0.35 + (h - uBands.z) * 0.12);
    c = mix(c, uSnow * (0.95 + 0.05 * nFine), snowK);
    rough = mix(rough, 0.5, snowK);
    bump = mix(bump, nFine * 0.06, snowK);

    // --- Swamp: dark mud with standing water ---
    float swampK = smoothstep(0.25, 0.65, td.g + (nFine - 0.5) * 0.35);
    float puddle = smoothstep(0.5, 0.58, nMid * 0.7 + nFine * 0.3);
    c = mix(c, mix(uSwampMud * (0.8 + 0.4 * nMicro), uSwampWater, puddle), swampK);
    rough = mix(rough, mix(0.75, 0.08, puddle), swampK);
    bump = mix(bump, (1.0 - puddle) * nMicro * 0.06, swampK);

    // --- Scorch ---
    float scorchK = smoothstep(0.05, 0.55, td.a * (0.6 + 0.8 * nFine));
    c = mix(c, uScorch * (0.7 + 0.6 * nMicro), scorchK * 0.92);
    rough = mix(rough, 0.95, scorchK);

    diffuseColor.rgb = c;
  `;

  return src
    .replace('#include <common>', `#include <common>\n${decl}`)
    .replace('#include <map_fragment>', albedo)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = rough;')
    .replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #include <normal_fragment_maps>
      #if TG_DETAIL
        // Fade the grain with distance: at the horizon it would only shimmer.
        float tgFade = 1.0 - smoothstep(30.0, 120.0, length(vViewPosition));
        normal = tgPerturb(-vViewPosition, normal, bump * tgFade, faceDirection);
      #endif
      `,
    )
    .replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `
      #include <emissivemap_fragment>
      // Fresh scorch still glows: embers flicker in the cracks.
      float ember = smoothstep(0.75, 1.0, td.a) * smoothstep(0.55, 0.8, nMicro);
      totalEmissiveRadiance += vec3(3.0, 0.9, 0.2) * ember * (0.7 + 0.3 * sin(uTime * 7.0 + nMid * 30.0));
      `,
    )
    .replace(
      '#include <fog_fragment>',
      /* glsl */ `
      #include <fog_fragment>
      // The planet's limb: the far rim of the drawn window melts into haze.
      float tgR = length(vTgPos.xz - uCamTarget.xz);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, smoothstep(uRim.x, uRim.y, tgR));
      `,
    );
}

