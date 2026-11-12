/**
 * render/effects.ts — the fireworks department.
 *
 * The sim announces what happened (world.events — plain {type, x, z}
 * facts) and what is still going on (world.auras — wards, warsongs,
 * cyclones, emberfalls, sinks, blooms; burning buildings and swamp tiles
 * are read straight off the world). This module decides what that LOOKS and SOUNDS like. The sim
 * never knows pixels exist, and every spell can be re-art-directed here
 * without touching gameplay.
 *
 * Building blocks:
 *
 *   PARTICLES — two big pools drawn as GPU point sprites (one additive for
 *     light: fire, sparks, magic motes; one alpha-blended for matter:
 *     smoke, dust, debris, petals, spray). Each particle is a few floats
 *     of state stepped on the CPU (velocity, gravity, drag, size and colour
 *     over life); the sprite's shape (soft glow / lumpy smoke / hard chunk
 *     / petal) is drawn procedurally in the fragment shader. Colours are
 *     HDR, so hot things exceed 1.0 and the bloom pass makes them glow.
 *   MESH FX — shockwave rings that DRAPE over the terrain (their vertex
 *     shader samples the heightmap texture), jagged lightning ribbons,
 *     columns of light, the ward's shimmering dome, the cyclone's funnel.
 *   GROUND — scorch marks are painted into the terrain itself
 *     (TerrainMesh.addScorch), so they hug every bump.
 *   LIGHT — flashes borrow a pooled point light (lighting.ts); the whole
 *     screen can flash warm or white (screenFlash: a clip-space quad drawn
 *     with the scene, so bloom and tone mapping treat it like light).
 *   BOMBS — lava bombs on ballistic arcs (volcano), trailing smoke, bursting
 *     (or steaming in the sea) where they land.
 *   SPECTACLE — spells that run for seconds (world.jobs: volcano, causeway,
 *     level, quake, undertow), the leader's cast gather, the raiders' boats:
 *     render/spectacle.ts (+ cast-gather.ts, fleet.ts). AMBIENT LIFE (birds,
 *     fish, butterflies): render/ambient-life.ts. Both are driven from sync().
 *
 * Particle COUNTS scale with the quality tier (`detail`, look.ts FX_DETAIL);
 * pools are fixed-size and drop emissions when full, so a busy moment
 * never allocates or stalls.
 *
 * Everything lives in UNBENT world space and is curved on the GPU with the
 * shared curvature uniforms, like the terrain.
 *
 * The event registry maps names to handlers; unknown names are ignored,
 * so the sim can add events before the renderer learns to draw them.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import type { Aura, AuraKind } from '../sim/spells';
import { World } from '../sim/world-state';
import { curvatureDrop, curvatureGlsl, curvatureUniforms } from '../world/curvature';
import { grassShock } from '../world/ground-cover';
import { FxChannel, SurfaceFx } from '../world/surface-fx';
import { heightGlsl } from '../world/terrain-glsl';
import { TerrainMesh } from '../world/terrain-mesh';
import { AmbientLife } from './ambient-life';
import { CameraRig } from './camera-rig';
import { Lighting } from './lighting';
import { FX_DETAIL, QUALITY, QualityTier, SPELL_LOOK, SPELL_LOOK_DEFAULT } from './look';
import { Spectacle } from './spectacle';

const WORLD_UNITS = WORLD_SIZE * TILE;

// Sprite shapes (integer part of the shape attribute; fraction = per-particle seed).
export const GLOW = 0;
export const SMOKE = 1;
export const CHUNK = 2;
export const PETAL = 3;

// ---------------------------------------------------------------------------
// Particle pools
// ---------------------------------------------------------------------------

export interface Emit {
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  life: number;
  size: number;
  sizeEnd?: number;
  /** Linear RGB (HDR allowed) at birth and death. */
  r: number; g: number; b: number;
  r2?: number; g2?: number; b2?: number;
  alpha?: number;
  gravity?: number;
  drag?: number;
  shape?: number;
  /** Fraction of life spent fading in. */
  fadeIn?: number;
  /** Swirl around a vertical axis at (ax, az): radians/s. */
  swirl?: number;
  ax?: number; az?: number;
}

const particleVert = /* glsl */ `
  ${curvatureGlsl}
  attribute vec4 aColor;
  attribute float aSize;
  attribute float aShape;
  uniform float uPxScale;
  varying vec4 vColor;
  varying float vShape;
  void main() {
    vColor = aColor;
    vShape = aShape;
    vec4 mv = viewMatrix * vec4(applyCurvature(position), 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uPxScale / max(-mv.z, 0.1), 1.0, 512.0);
  }
`;

const particleFrag = /* glsl */ `
  varying vec4 vColor;
  varying float vShape;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    float shape = floor(vShape);
    float seed = fract(vShape) * 40.0;
    float a;
    vec3 shade = vec3(1.0);
    if (shape < 0.5) {
      // Glow: hot core, soft halo.
      a = exp(-r2 * 3.2) * (1.0 - r2);
      a += exp(-r2 * 18.0) * 0.6;
    } else if (shape < 1.5) {
      // Smoke: a lumpy, soft-edged puff, lit from above.
      float lump = sin(p.x * 4.0 + seed) * sin(p.y * 3.5 + seed * 1.7) * 0.18
                 + sin(p.x * 9.0 - seed * 2.1) * sin(p.y * 8.0 + seed) * 0.07;
      a = smoothstep(1.0, 0.35, sqrt(r2) + lump);
      shade = vec3(1.0 - 0.35 * (p.y * 0.5 + 0.5));
    } else if (shape < 2.5) {
      // Chunk: a hard-edged pebble with a lit top.
      a = smoothstep(0.85, 0.7, sqrt(r2) + sin(atan(p.y, p.x) * 3.0 + seed) * 0.08);
      shade = vec3(1.15 - 0.6 * (p.y * 0.5 + 0.5));
    } else {
      // Petal / spray drop: an ellipse turned by the seed.
      float c = cos(seed), s = sin(seed);
      vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
      a = smoothstep(1.0, 0.75, length(q * vec2(1.0, 2.2)));
      shade = vec3(1.1 - 0.3 * (q.y * 0.5 + 0.5));
    }
    gl_FragColor = vec4(vColor.rgb * shade, vColor.a * a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class ParticlePool {
  readonly points: THREE.Points;
  private count = 0;
  // Simulation state (struct of arrays).
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly c0: Float32Array;
  private readonly c1: Float32Array;
  private readonly misc: Float32Array; // age, life, size, sizeEnd, alpha, gravity, drag, shape, fadeIn, swirl, ax, az
  private static readonly M = 12;
  // GPU buffers.
  private readonly gPos: THREE.BufferAttribute;
  private readonly gColor: THREE.BufferAttribute;
  private readonly gSize: THREE.BufferAttribute;
  private readonly gShape: THREE.BufferAttribute;
  readonly uniforms = { uPxScale: { value: 800 } };
  /**
   * How many may be alive at once (the quality tier's budget). The arrays
   * are sized for the largest tier, so a Settings change or the automatic
   * downgrade moves this without reallocating; particles already above a
   * lowered limit live out their short lives.
   */
  limit: number;

  constructor(
    readonly capacity: number,
    additive: boolean,
  ) {
    this.limit = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.c0 = new Float32Array(capacity * 4);
    this.c1 = new Float32Array(capacity * 3);
    this.misc = new Float32Array(capacity * ParticlePool.M);
    const geo = new THREE.BufferGeometry();
    this.gPos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.gColor = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.gSize = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.gShape = new THREE.BufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.gPos);
    geo.setAttribute('aColor', this.gColor);
    geo.setAttribute('aSize', this.gSize);
    geo.setAttribute('aShape', this.gShape);
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...curvatureUniforms, ...this.uniforms },
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  /** Live particles / capacity (0..1): recipes thin themselves out near the top. */
  get load(): number {
    return this.count / this.limit;
  }

  emit(e: Emit): void {
    if (this.count >= this.limit) return;
    const i = this.count++;
    const M = ParticlePool.M;
    this.pos[i * 3] = e.x; this.pos[i * 3 + 1] = e.y; this.pos[i * 3 + 2] = e.z;
    this.vel[i * 3] = e.vx ?? 0; this.vel[i * 3 + 1] = e.vy ?? 0; this.vel[i * 3 + 2] = e.vz ?? 0;
    this.c0[i * 4] = e.r; this.c0[i * 4 + 1] = e.g; this.c0[i * 4 + 2] = e.b; this.c0[i * 4 + 3] = e.alpha ?? 1;
    this.c1[i * 3] = e.r2 ?? e.r; this.c1[i * 3 + 1] = e.g2 ?? e.g; this.c1[i * 3 + 2] = e.b2 ?? e.b;
    const m = this.misc;
    m[i * M] = 0;
    m[i * M + 1] = e.life;
    m[i * M + 2] = e.size;
    m[i * M + 3] = e.sizeEnd ?? e.size;
    m[i * M + 4] = e.alpha ?? 1;
    m[i * M + 5] = e.gravity ?? 0;
    m[i * M + 6] = e.drag ?? 0;
    m[i * M + 7] = (e.shape ?? GLOW) + Math.random() * 0.98;
    m[i * M + 8] = e.fadeIn ?? 0.05;
    m[i * M + 9] = e.swirl ?? 0;
    m[i * M + 10] = e.ax ?? 0;
    m[i * M + 11] = e.az ?? 0;
  }

  update(dt: number): void {
    const M = ParticlePool.M;
    const { pos, vel, c0, c1, misc } = this;
    const gp = this.gPos.array as Float32Array;
    const gc = this.gColor.array as Float32Array;
    const gs = this.gSize.array as Float32Array;
    const gsh = this.gShape.array as Float32Array;
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      const age = misc[i * M] + dt;
      const life = misc[i * M + 1];
      if (age >= life) continue;
      // Compact live particles toward the front as we go.
      if (w !== i) {
        for (let k = 0; k < 3; k++) {
          pos[w * 3 + k] = pos[i * 3 + k];
          vel[w * 3 + k] = vel[i * 3 + k];
          c1[w * 3 + k] = c1[i * 3 + k];
        }
        for (let k = 0; k < 4; k++) c0[w * 4 + k] = c0[i * 4 + k];
        for (let k = 0; k < M; k++) misc[w * M + k] = misc[i * M + k];
      }
      misc[w * M] = age;
      const drag = Math.exp(-misc[w * M + 6] * dt);
      vel[w * 3] *= drag;
      vel[w * 3 + 1] = vel[w * 3 + 1] * drag - misc[w * M + 5] * dt;
      vel[w * 3 + 2] *= drag;
      const swirl = misc[w * M + 9];
      if (swirl !== 0) {
        // Rotate position about the vertical axis through (ax, az).
        const ax = misc[w * M + 10], az = misc[w * M + 11];
        const dx = pos[w * 3] - ax, dz = pos[w * 3 + 2] - az;
        const a = swirl * dt, ca = Math.cos(a), sa = Math.sin(a);
        pos[w * 3] = ax + dx * ca - dz * sa;
        pos[w * 3 + 2] = az + dx * sa + dz * ca;
      }
      pos[w * 3] += vel[w * 3] * dt;
      pos[w * 3 + 1] += vel[w * 3 + 1] * dt;
      pos[w * 3 + 2] += vel[w * 3 + 2] * dt;

      const t = age / life;
      const fadeIn = misc[w * M + 8];
      const fade = Math.min(1, t / Math.max(fadeIn, 1e-3)) * (1 - t) * (1 - t * 0.0);
      gp[w * 3] = pos[w * 3]; gp[w * 3 + 1] = pos[w * 3 + 1]; gp[w * 3 + 2] = pos[w * 3 + 2];
      gc[w * 4] = c0[w * 4] + (c1[w * 3] - c0[w * 4]) * t;
      gc[w * 4 + 1] = c0[w * 4 + 1] + (c1[w * 3 + 1] - c0[w * 4 + 1]) * t;
      gc[w * 4 + 2] = c0[w * 4 + 2] + (c1[w * 3 + 2] - c0[w * 4 + 2]) * t;
      gc[w * 4 + 3] = misc[w * M + 4] * fade;
      gs[w] = misc[w * M + 2] + (misc[w * M + 3] - misc[w * M + 2]) * t;
      gsh[w] = misc[w * M + 7];
      w++;
    }
    this.count = w;
    this.points.geometry.setDrawRange(0, w);
    this.gPos.needsUpdate = this.gColor.needsUpdate = this.gSize.needsUpdate = this.gShape.needsUpdate = true;
    // Upload only the live range.
    for (const a of [this.gPos, this.gColor, this.gSize, this.gShape]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, w * a.itemSize));
    }
  }
}

// ---------------------------------------------------------------------------
// Mesh FX materials (all bend with the planet; `drape` ones also follow the
// terrain height, sampled from the heightmap texture per vertex).
// ---------------------------------------------------------------------------

export function fxMaterial(
  heightTex: THREE.IUniform,
  fragBody: string,
  uniforms: Record<string, THREE.IUniform>,
  opts: { drape?: boolean; additive?: boolean; side?: THREE.Side; depthTest?: boolean } = {},
): THREE.ShaderMaterial {
  // Draped meshes also hand the fragment shader the raw terrain height
  // under them (vGround; < 0 = sea), so a decal can tell land from water.
  return new THREE.ShaderMaterial({
    uniforms: { ...curvatureUniforms, uHeightTex: heightTex, uLift: { value: 0.25 }, uTime: { value: 0 }, uAlpha: { value: 1 }, ...uniforms },
    vertexShader: /* glsl */ `
      ${curvatureGlsl}
      ${opts.drape ? heightGlsl : ''}
      uniform float uLift;
      varying vec2 vUv;
      varying vec3 vLocal;
      varying vec3 vN;
      varying vec3 vView;
      varying float vGround;
      void main() {
        vUv = uv;
        vLocal = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vGround = 1.0;
        ${opts.drape ? 'vGround = tgHeightAtWorld(w.xz);\n        w.y = max(vGround, 0.0) + uLift + position.y;' : ''}
        vN = normalize(mat3(modelMatrix) * normal);
        vec3 b = applyCurvature(w.xyz);
        vView = normalize(cameraPosition - b);
        gl_Position = projectionMatrix * viewMatrix * vec4(b, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAlpha;
      varying vec2 vUv;
      varying vec3 vLocal;
      varying vec3 vN;
      varying vec3 vView;
      varying float vGround;
      ${Object.keys(uniforms)
        .map((k) => {
          const v = uniforms[k].value;
          const t = v instanceof THREE.Color ? 'vec3' : v instanceof THREE.Vector2 ? 'vec2' : 'float';
          return `uniform ${t} ${k};`;
        })
        .join('\n')}
      void main() {
        ${fragBody}
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
    side: opts.side ?? THREE.FrontSide,
    blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------

export interface MeshFx {
  obj: THREE.Object3D;
  mats: THREE.ShaderMaterial[];
  age: number;
  ttl: number;
  /** Tile anchor (re-wrapped each frame so it stays near the camera). */
  tx: number;
  tz: number;
  lift: number;
  drive(f: MeshFx, dt: number): void;
}

/** A lava bomb: thrown out of a crater on a ballistic arc (tile coords + height; tiles/s, world units/s). */
interface Bomb {
  tx: number; tz: number; y: number;
  vx: number; vz: number; vy: number;
  size: number;
  age: number;
}

interface Projectile {
  fx: number; fz: number; tx: number; tz: number;
  fromY: number; toY: number;
  age: number; ttl: number;
  arc: number;
  kind: 'ember' | 'stone';
  /** Where the head was last frame (unbent world units). */
  lastX?: number;
  lastY?: number;
  lastZ?: number;
}

interface AuraVisual {
  kind: AuraKind;
  meshes: MeshFx[];
  emitAcc: number;
  seen: boolean;
}

type Handler = (fx: EffectsRenderer, x: number, z: number, mag: number, ev: { x2?: number; z2?: number; tribe?: string }) => void;

const lin = (hex: number) => new THREE.Color(hex);

export class EffectsRenderer {
  /** Additive light (fire, sparks, motes) and alpha-blended matter (smoke, dust, debris). */
  readonly glow: ParticlePool;
  readonly matter: ParticlePool;
  /** Particle emission scale for the quality tier (look.ts FX_DETAIL): recipes multiply counts by it. */
  detail: number;
  /** The quality tier's name (ambient life is off at `low`). Changed by applyQuality. */
  tier: QualityTier['name'];
  /** Spell set pieces driven by world.jobs (render/spectacle.ts). */
  private readonly spectacle: Spectacle;
  /** Birds, fish, butterflies (render/ambient-life.ts). */
  private readonly life: AmbientLife;
  private bombs: Bomb[] = [];
  /** Full-screen warm/white flash (a clip-space quad drawn with the scene). */
  private readonly screenQuad: THREE.Mesh;
  private readonly screenUniforms = { uColor: { value: new THREE.Color() }, uAmount: { value: 0 } };
  private screenFade = 0;
  /** Blast shock ring rolling through the grass (ground-cover.ts reads it). */
  private shockAge = -1;
  private shockTx = 0;
  private shockTz = 0;
  private shockRadius = 0;
  /** Spots still burning after a strike (lightning's small fire). */
  private burns: { tx: number; tz: number; t: number; ttl: number; acc: number }[] = [];
  private meshFx: MeshFx[] = [];
  private projectiles: Projectile[] = [];
  private readonly auraVisuals = new Map<Aura, AuraVisual>();
  private camTarget = new THREE.Vector3();
  private world: World | null = null;

  /** The rune colour of the standing stone at tile (x, z), or `fallback` (no stone there). */
  stoneColor(x: number, z: number, fallback: number): number {
    for (const m of this.world?.monuments ?? []) {
      if (Math.abs(wrapDelta(m.x - x, WORLD_SIZE)) < 1.5 && Math.abs(wrapDelta(m.z - z, WORLD_SIZE)) < 1.5) {
        return (SPELL_LOOK[m.spell] ?? SPELL_LOOK_DEFAULT).glow;
      }
    }
    return fallback;
  }
  private swampAcc = 0;
  private burnAcc = 0;
  private readonly tmpV = new THREE.Vector3();

  // Shared geometry for mesh FX.
  private readonly ringGeo = new THREE.RingGeometry(0.82, 1, 96, 1).rotateX(-Math.PI / 2);
  private readonly discGeo = new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2);
  private readonly domeGeo = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  private readonly columnGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0);
  private readonly funnelGeo: THREE.BufferGeometry;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rig: CameraRig,
    private readonly terrain?: TerrainMesh,
    private readonly lighting?: Lighting,
    quality?: QualityTier,
  ) {
    // Sized for the richest tier; applyQuality sets the live budget.
    const capacity = Math.max(...Object.values(QUALITY).map((q) => q.particles));
    this.glow = new ParticlePool(capacity, true);
    this.matter = new ParticlePool(capacity, false);
    this.glow.points.userData.gpuCurved = this.matter.points.userData.gpuCurved = true;
    scene.add(this.glow.points, this.matter.points);
    this.tier = 'high';
    this.detail = FX_DETAIL.high;

    // The screen flash: a quad already in clip space (no camera maths),
    // additive, drawn last with the scene so bloom and tone mapping see it.
    const sq = new THREE.ShaderMaterial({
      uniforms: this.screenUniforms,
      vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAmount; varying vec2 vP;
        void main() {
          float v = 1.0 - 0.35 * dot(vP, vP);
          gl_FragColor = vec4(uColor * uAmount * v, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.screenQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sq);
    this.screenQuad.frustumCulled = false;
    this.screenQuad.renderOrder = 100;
    this.screenQuad.visible = false;
    this.screenQuad.userData.gpuCurved = true; // never CPU-curved (applyLimbToCpuCurved)
    scene.add(this.screenQuad);
    this.spectacle = new Spectacle(this, scene, terrain);
    this.life = new AmbientLife(this, scene);
    this.applyQuality(quality ?? QUALITY.high);
    terrain?.onWorldChange.push(() => this.reset());

    // Funnel: a lathe that flares from a tight base to a wide top.
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      pts.push(new THREE.Vector2(0.18 + Math.pow(t, 1.8) * 1.0, t));
    }
    this.funnelGeo = new THREE.LatheGeometry(pts, 48);
  }

  /** Where the camera looks (world units), as of this frame's sync. */
  get camTargetNow(): THREE.Vector3 {
    return this.camTarget;
  }

  /** The world being drawn (set each sync). */
  get worldNow(): World | null {
    return this.world;
  }

  /** The terrain's surface paint (lava, basalt, wet, fissures), if any. */
  get surface(): SurfaceFx | null {
    return this.terrain?.fx ?? null;
  }

  /**
   * A new quality tier (Settings → Graphics, or post.ts dropping a tier when
   * frames run long): particle budgets, emission detail, and ambient life
   * (off at `low`) follow it at once.
   */
  applyQuality(q: QualityTier): void {
    this.tier = q.name;
    this.detail = FX_DETAIL[q.name];
    this.glow.limit = this.matter.limit = Math.min(q.particles, this.glow.capacity);
    this.life.enabled = q.name !== 'low';
  }

  /** Scale a particle count by the quality tier (at least `min`). */
  n(count: number, min = 1): number {
    return Math.max(min, Math.round(count * this.detail));
  }

  /**
   * A different world was loaded: drop everything that belongs to the old
   * one (running set pieces, vents, boats, bombs, fires, shocks, flashes).
   * Without this a volcano running at load time would end() into a vent
   * smoking over the new map.
   */
  reset(): void {
    this.spectacle.reset();
    this.bombs = [];
    this.burns = [];
    this.projectiles = [];
    this.shockAge = -1;
    grassShock.value.w = 0;
    this.screenUniforms.uAmount.value = 0;
    this.screenQuad.visible = false;
  }

  /** Light up the whole screen for a moment (additive; `amount` ~0.1 subtle … 1 blinding). */
  screenFlash(color: number, amount: number, fade = 0.5): void {
    const u = this.screenUniforms;
    if (amount < u.uAmount.value) return;
    u.uColor.value.setHex(color);
    u.uAmount.value = amount;
    this.screenFade = fade;
    this.screenQuad.visible = true;
  }

  private stepScreen(dt: number): void {
    const u = this.screenUniforms.uAmount;
    if (u.value <= 0) return;
    u.value = Math.max(0, u.value - (dt / Math.max(0.05, this.screenFade)) * Math.max(u.value, 0.15));
    this.screenQuad.visible = u.value > 0.002;
  }

  /** Roll a shock ring through the grass from tile (tx, tz) out to `radius` world units. */
  grassShock(tx: number, tz: number, radius: number): void {
    this.shockAge = 0;
    this.shockTx = tx;
    this.shockTz = tz;
    this.shockRadius = radius;
  }

  private stepShock(dt: number): void {
    const s = grassShock.value;
    if (this.shockAge < 0) return;
    this.shockAge += dt;
    const T = 1.1;
    const t = this.shockAge / T;
    if (t >= 1) {
      this.shockAge = -1;
      s.w = 0;
      return;
    }
    const p = this.at(this.shockTx, this.shockTz, 0);
    s.set(p.x, p.z, this.shockRadius * (1 - Math.pow(1 - Math.min(1, t * 1.6), 2)), (1 - t) * (1 - t));
  }

  /** Keep a small fire going at tile (tx, tz) for `ttl` seconds. */
  burn(tx: number, tz: number, ttl: number): void {
    this.burns.push({ tx, tz, t: 0, ttl, acc: 0 });
  }

  private stepBurns(dt: number): void {
    if (!this.burns.length) return;
    for (const b of this.burns) {
      b.t += dt;
      b.acc += dt;
      if (b.acc < 0.07) continue;
      b.acc = 0;
      const k = 1 - b.t / b.ttl;
      this.flames(b.tx, b.tz, 0.9, Math.max(1, Math.round(3 * k)));
      if (Math.random() < 0.35) this.smoke(b.tx, b.tz, 1, { lift: 1.2, dark: 0.08, rise: 2.4, size: 1.4, life: 2.6 });
    }
    this.burns = this.burns.filter((b) => b.t < b.ttl);
  }

  /** The terrain's heightmap texture uniform (for draped FX materials). */
  get heightUniform(): THREE.IUniform {
    return this.heightTex;
  }

  private get heightTex(): THREE.IUniform {
    return this.terrain?.uniforms.uHeightTex ?? { value: null };
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  /** Drain new events, run persistent auras, animate everything. */
  sync(world: World, camTarget: THREE.Vector3, dt: number): void {
    this.world = world;
    this.camTarget.copy(camTarget);

    for (const ev of world.events.splice(0)) {
      const h = HANDLERS[ev.type];
      if (!h) continue; // unknown events are ignored, never thrown
      try {
        h(this, ev.x, ev.z, ev.magnitude ?? 1, ev);
      } catch (err) {
        console.warn('[effects]', ev.type, err);
      }
    }

    this.syncAuras(world, dt);
    this.ambient(world, dt);
    this.spectacle.sync(world, dt);
    if (this.life.enabled) this.life.sync(world, this.camTarget, dt);
    this.stepProjectiles(dt);
    this.stepBombs(dt);
    this.stepBurns(dt);
    this.stepScreen(dt);
    this.stepShock(dt);

    for (const f of this.meshFx) {
      f.age += dt;
      this.anchor(f.obj.position, f.tx, f.tz, f.lift);
      for (const m of f.mats) m.uniforms.uTime.value += dt;
      f.drive(f, dt);
    }
    const dead = this.meshFx.filter((f) => f.age >= f.ttl);
    for (const f of dead) this.disposeFx(f);
    if (dead.length) this.meshFx = this.meshFx.filter((f) => f.age < f.ttl);

    // Point sprite scale: pixels per world unit at distance 1.
    const cam = this.rig.camera;
    const px = (innerHeight * Math.min(devicePixelRatio, 2)) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    this.glow.uniforms.uPxScale.value = px;
    this.matter.uniforms.uPxScale.value = px;
    this.glow.update(dt);
    this.matter.update(dt);
  }

  // -------------------------------------------------------------------------
  // Placement helpers
  // -------------------------------------------------------------------------

  /** Ground height (≥ sea level) at fractional tile coords. */
  ground(tx: number, tz: number): number {
    return Math.max(0, this.world?.map.sampleHeight(tx, tz) ?? 0);
  }

  /** Unbent world position of a tile point, wrapped to the image nearest the camera. */
  anchor(out: THREE.Vector3, tx: number, tz: number, lift: number): THREE.Vector3 {
    const relX = wrapDelta(tx * TILE - this.camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(tz * TILE - this.camTarget.z, WORLD_UNITS);
    return out.set(this.camTarget.x + relX, this.ground(tx, tz) + lift, this.camTarget.z + relZ);
  }

  /** Same, but returns world x,z (for particle emission). */
  at(tx: number, tz: number, lift = 0): THREE.Vector3 {
    return this.anchor(this.tmpV, tx, tz, lift);
  }

  /** Curved (as-rendered) position — for point lights, which aren't bent by a shader. */
  curved(tx: number, tz: number, lift: number): THREE.Vector3 {
    const p = this.at(tx, tz, lift).clone();
    const dx = p.x - this.camTarget.x;
    const dz = p.z - this.camTarget.z;
    p.y -= curvatureDrop(dx, dz);
    return p;
  }

  shake(s: number): void {
    this.rig.shake(s);
  }

  flash(tx: number, tz: number, color: number, peak: number, ttl: number, lift = 3, range = 40): void {
    this.lighting?.flash(this.curved(tx, tz, lift), color, peak, ttl, range);
  }

  scorch(tx: number, tz: number, radius: number, amount = 1): void {
    this.terrain?.addScorch(tx, tz, radius, amount);
  }

  // -------------------------------------------------------------------------
  // Particle recipes
  // -------------------------------------------------------------------------

  /** Radial burst of glowing sparks (with gravity). */
  sparks(tx: number, tz: number, n: number, speed: number, color: THREE.Color, lift = 0.8, size = 0.35): void {
    const p = this.at(tx, tz, lift);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 0.3 + Math.random();
      const s = speed * (0.4 + Math.random() * 0.8);
      this.glow.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * s, vy: up * s, vz: Math.sin(a) * s,
        life: 0.5 + Math.random() * 0.6, size, sizeEnd: size * 0.3,
        r: color.r * 4, g: color.g * 4, b: color.b * 4,
        r2: color.r * 1.5, g2: color.g * 0.6, b2: color.b * 0.3,
        gravity: 14, drag: 1.2, shape: GLOW, fadeIn: 0.01,
      });
    }
  }

  /**
   * Fireball: a brief hot glow core (additive) wrapped in rolling fire that
   * cools to soot (alpha-blended, so overlapping puffs keep their shape
   * instead of summing to a white blob).
   */
  fireCore(tx: number, tz: number, scale: number, lift = 1): void {
    const p = this.at(tx, tz, lift);
    const n = Math.round(6 * scale + 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (1 + Math.random() * 3) * scale;
      this.glow.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * s, vy: (1 + Math.random() * 2) * scale, vz: Math.sin(a) * s,
        life: 0.25 + Math.random() * 0.25, size: 2.2 * scale, sizeEnd: 3.4 * scale,
        r: 4, g: 2.3, b: 0.8, r2: 1.4, g2: 0.3, b2: 0.05,
        drag: 4, shape: GLOW, fadeIn: 0.02,
      });
    }
    const m = Math.round(12 * scale + 3);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (2 + Math.random() * 4) * scale;
      this.matter.emit({
        x: p.x, y: p.y + Math.random() * scale, z: p.z,
        vx: Math.cos(a) * s, vy: (1.5 + Math.random() * 3) * scale, vz: Math.sin(a) * s,
        life: 0.9 + Math.random() * 0.8, size: 1.6 * scale, sizeEnd: 4.2 * scale,
        r: 3.2, g: 1.4, b: 0.35, r2: 0.09, g2: 0.08, b2: 0.075,
        alpha: 0.95, drag: 3.2, shape: SMOKE, fadeIn: 0.02,
      });
    }
  }

  /** Rising smoke puffs. */
  smoke(tx: number, tz: number, n: number, opts: { lift?: number; spread?: number; rise?: number; size?: number; dark?: number; life?: number } = {}): void {
    const p = this.at(tx, tz, opts.lift ?? 1);
    const spread = opts.spread ?? 1;
    const dark = opts.dark ?? 0.25;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const v = dark * (0.8 + Math.random() * 0.4);
      this.matter.emit({
        x: p.x + Math.cos(a) * r, y: p.y + Math.random() * 0.5, z: p.z + Math.sin(a) * r,
        vx: Math.cos(a) * 0.6 + 0.4, vy: (opts.rise ?? 2.2) * (0.6 + Math.random() * 0.6), vz: Math.sin(a) * 0.6,
        life: (opts.life ?? 2.4) * (0.7 + Math.random() * 0.6), size: (opts.size ?? 1.6) * (0.7 + Math.random() * 0.5),
        sizeEnd: (opts.size ?? 1.6) * 3.2,
        r: v, g: v * 0.95, b: v * 0.9, r2: v * 1.6, g2: v * 1.6, b2: v * 1.6,
        alpha: 0.75, drag: 0.8, shape: SMOKE, fadeIn: 0.15,
      });
    }
  }

  /** Dust kicked up along the ground in a ring. */
  dust(tx: number, tz: number, n: number, radius: number, color = 0xb59e7c, speed = 3): void {
    const c = lin(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const ptx = tx + (Math.cos(a) * r) / TILE;
      const ptz = tz + (Math.sin(a) * r) / TILE;
      const p = this.at(ptx, ptz, 0.3);
      const s = speed * (0.5 + Math.random());
      this.matter.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * s, vy: 0.6 + Math.random() * 1.6, vz: Math.sin(a) * s,
        life: 1.2 + Math.random() * 1.2, size: 1.3, sizeEnd: 3.4,
        r: c.r, g: c.g, b: c.b, alpha: 0.55, drag: 2.2, shape: SMOKE, fadeIn: 0.1,
      });
    }
  }

  /** Solid bits thrown out with gravity. */
  debris(tx: number, tz: number, n: number, speed: number, color = 0x4a3c30, size = 0.28): void {
    const p = this.at(tx, tz, 0.6);
    const c = lin(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.8);
      const k = 0.7 + Math.random() * 0.5;
      this.matter.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * s * 0.6, vy: s * (0.8 + Math.random() * 0.7), vz: Math.sin(a) * s * 0.6,
        life: 0.9 + Math.random() * 0.7, size: size * (0.6 + Math.random() * 0.8),
        r: c.r * k, g: c.g * k, b: c.b * k, gravity: 22, drag: 0.2, shape: CHUNK, fadeIn: 0.01,
      });
    }
  }

  /** Magic motes drifting upward (optionally spiralling). */
  motes(tx: number, tz: number, n: number, color: THREE.Color, opts: { radius?: number; rise?: number; life?: number; swirl?: number; size?: number; lift?: number; hdr?: number } = {}): void {
    const centre = this.at(tx, tz, 0).clone();
    const radius = opts.radius ?? 1.5;
    const hdr = opts.hdr ?? 4;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const ptx = tx + (Math.cos(a) * r) / TILE;
      const ptz = tz + (Math.sin(a) * r) / TILE;
      const p = this.at(ptx, ptz, (opts.lift ?? 0.3) + Math.random() * 1.2);
      this.glow.emit({
        x: p.x, y: p.y, z: p.z,
        vx: 0, vy: (opts.rise ?? 2.5) * (0.6 + Math.random() * 0.8), vz: 0,
        life: (opts.life ?? 1.6) * (0.6 + Math.random() * 0.7), size: (opts.size ?? 0.45) * (0.7 + Math.random() * 0.6),
        sizeEnd: 0.05,
        r: color.r * hdr, g: color.g * hdr, b: color.b * hdr,
        drag: 0.6, shape: GLOW, fadeIn: 0.2,
        swirl: opts.swirl ?? 0, ax: centre.x, az: centre.z,
      });
    }
  }

  /** Spray of water droplets. */
  spray(tx: number, tz: number, n: number, speed: number): void {
    const p = this.at(tx, tz, 0.2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.matter.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * s * 0.5, vy: s * (1 + Math.random()), vz: Math.sin(a) * s * 0.5,
        life: 0.6 + Math.random() * 0.4, size: 0.3, sizeEnd: 0.15,
        r: 0.8, g: 0.95, b: 1.0, alpha: 0.9, gravity: 18, shape: PETAL, fadeIn: 0.01,
      });
    }
  }

  petals(tx: number, tz: number, n: number, radius: number): void {
    const cols = [0xf7a8c8, 0xffffff, 0xffd86b, 0xd9a1ff].map(lin);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const p = this.at(tx + (Math.cos(a) * r) / TILE, tz + (Math.sin(a) * r) / TILE, 0.5 + Math.random() * 1.5);
      const c = cols[i % cols.length];
      this.matter.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * 1.5 + 0.8, vy: 1.5 + Math.random() * 2, vz: Math.sin(a) * 1.5,
        life: 2 + Math.random() * 1.5, size: 0.35, r: c.r, g: c.g, b: c.b,
        gravity: 1.2, drag: 1.5, shape: PETAL, fadeIn: 0.05,
      });
    }
  }

  /** Flames licking up from a burning spot (call repeatedly). */
  flames(tx: number, tz: number, radius: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const p = this.at(tx + (Math.cos(a) * r) / TILE, tz + (Math.sin(a) * r) / TILE, 0.2 + Math.random() * 0.6);
      // Tongue: a small hot glow that rises and shrinks...
      this.glow.emit({
        x: p.x, y: p.y, z: p.z,
        vx: (Math.random() - 0.5) * 0.5, vy: 2.5 + Math.random() * 2, vz: (Math.random() - 0.5) * 0.5,
        life: 0.4 + Math.random() * 0.4, size: 0.9, sizeEnd: 0.2,
        r: 3.6, g: 1.6, b: 0.35, r2: 1.6, g2: 0.25, b2: 0.03,
        drag: 0.5, shape: GLOW, fadeIn: 0.15,
      });
      // ...wrapped in an opaque-ish flame body that darkens into smoke.
      if (i % 2 === 0) {
        this.matter.emit({
          x: p.x, y: p.y + 0.3, z: p.z,
          vx: (Math.random() - 0.5) * 0.4, vy: 2 + Math.random() * 1.5, vz: (Math.random() - 0.5) * 0.4,
          life: 0.7 + Math.random() * 0.4, size: 0.9, sizeEnd: 1.8,
          r: 2.6, g: 1.0, b: 0.2, r2: 0.12, g2: 0.1, b2: 0.09,
          alpha: 0.85, drag: 0.6, shape: SMOKE, fadeIn: 0.05,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mesh recipes
  // -------------------------------------------------------------------------

  addFx(obj: THREE.Object3D, mats: THREE.ShaderMaterial[], tx: number, tz: number, lift: number, ttl: number, drive: (f: MeshFx, dt: number) => void): MeshFx {
    obj.traverse((o) => (o.frustumCulled = false));
    obj.userData.gpuCurved = true;
    this.scene.add(obj);
    const f: MeshFx = { obj, mats, age: 0, ttl, tx, tz, lift, drive };
    this.anchor(obj.position, tx, tz, lift);
    this.meshFx.push(f);
    return f;
  }

  private disposeFx(f: MeshFx): void {
    this.scene.remove(f.obj);
    for (const m of f.mats) m.dispose();
    f.obj.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && !g.userData.keep && ![this.ringGeo, this.discGeo, this.domeGeo, this.columnGeo, this.funnelGeo].includes(g)) g.dispose();
    });
  }

  /** Expanding shockwave ring draped on the ground. */
  ring(tx: number, tz: number, color: number, radius: number, ttl = 0.7, hdr = 3, width = 0.18, inward = false): void {
    const c = lin(color).multiplyScalar(hdr);
    const mat = fxMaterial(
      this.heightTex,
      /* glsl */ `
        float r = length(vLocal.xz);
        float inner = 1.0 - uWidth;
        float band = smoothstep(inner, inner + uWidth * 0.5, r) * (1.0 - smoothstep(1.0 - uWidth * 0.25, 1.0, r));
        gl_FragColor = vec4(uColor * band * uAlpha, 1.0);
      `,
      { uColor: { value: c }, uWidth: { value: width } },
      { drape: true },
    );
    const mesh = new THREE.Mesh(this.discGeo, mat);
    mesh.renderOrder = 7;
    this.addFx(mesh, [mat], tx, tz, 0, ttl, (f) => {
      const t = f.age / f.ttl;
      // outward: bursts fast and slows; inward: a surge closing on the centre
      const s = inward ? radius * (1 - t * t * 0.85) : radius * (1 - Math.pow(1 - t, 2.4));
      f.obj.position.y = 0; // drape shader supplies height
      f.obj.scale.set(Math.max(0.01, s), 1, Math.max(0.01, s));
      mat.uniforms.uAlpha.value = inward ? Math.sin(t * Math.PI) : (1 - t) * (1 - t);
    });
  }

  /** Soft glowing disc on the ground (cast circles, area auras). */
  groundGlow(tx: number, tz: number, color: number, radius: number, ttl: number, hdr = 1.5): MeshFx {
    const c = lin(color).multiplyScalar(hdr);
    const mat = fxMaterial(
      this.heightTex,
      /* glsl */ `
        float r = length(vLocal.xz);
        float edge = smoothstep(0.75, 0.98, r) * (1.0 - smoothstep(0.98, 1.0, r));
        float fill = (1.0 - r) * 0.25;
        float runes = smoothstep(0.6, 1.0, sin(atan(vLocal.z, vLocal.x) * 12.0 + uTime * 1.5) * 0.5 + 0.5) * step(0.86, r) * step(r, 0.93);
        gl_FragColor = vec4(uColor * (edge + fill + runes * 0.8) * uAlpha, 1.0);
      `,
      { uColor: { value: c } },
      { drape: true },
    );
    const mesh = new THREE.Mesh(this.discGeo, mat);
    mesh.renderOrder = 7;
    mesh.scale.set(radius, 1, radius);
    return this.addFx(mesh, [mat], tx, tz, 0, ttl, (f) => {
      f.obj.position.y = 0;
      const t = f.age / f.ttl;
      mat.uniforms.uAlpha.value = Math.min(1, f.age * 4) * Math.min(1, (1 - t) * 4);
    });
  }

  /** A vertical shaft of light. */
  column(tx: number, tz: number, color: number, radius: number, height: number, ttl: number, hdr = 3): MeshFx {
    const c = lin(color).multiplyScalar(hdr);
    const mat = fxMaterial(
      this.heightTex,
      /* glsl */ `
        float y = vUv.y;
        float fres = pow(max(1.0 - abs(dot(normalize(vN), vView)), 0.0), 1.5);
        float streak = 0.75 + 0.25 * sin(vUv.x * 40.0 + uTime * 3.0) * sin(vUv.x * 13.0 - uTime * 2.0);
        float scroll = 0.8 + 0.2 * sin(y * 18.0 - uTime * 8.0);
        float a = (1.0 - y) * (1.0 - y) * streak * scroll * (0.1 + fres * 0.8);
        gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
      `,
      { uColor: { value: c } },
      { side: THREE.DoubleSide },
    );
    const mesh = new THREE.Mesh(this.columnGeo, mat);
    mesh.renderOrder = 8;
    mesh.scale.set(radius, height, radius);
    return this.addFx(mesh, [mat], tx, tz, 0, ttl, (f) => {
      const t = f.age / f.ttl;
      const grow = Math.min(1, f.age * 5);
      f.obj.scale.set(radius * (0.4 + 0.6 * grow), height * grow, radius * (0.4 + 0.6 * grow));
      mat.uniforms.uAlpha.value = Math.min(1, (1 - t) * 3);
    });
  }

  /** Translucent hex-shimmer dome. */
  dome(tx: number, tz: number, color: number, radius: number, ttl: number): MeshFx {
    const c = lin(color);
    const mat = fxMaterial(
      this.heightTex,
      /* glsl */ `
        // Hex lattice on the dome's surface (in local, unit-sphere coords).
        vec2 p = vec2(atan(vLocal.z, vLocal.x) * 4.0, vLocal.y * 7.0);
        vec2 r = vec2(1.0, 1.732);
        vec2 h = r * 0.5;
        vec2 a = mod(p, r) - h;
        vec2 b = mod(p - h, r) - h;
        vec2 g = dot(a, a) < dot(b, b) ? a : b;
        float hexd = max(abs(g.x), dot(abs(g), vec2(0.5, 0.866)));
        float line = smoothstep(0.43, 0.5, hexd);
        float fres = pow(max(1.0 - abs(dot(normalize(vN), vView)), 0.0), 2.2);
        float sweep = smoothstep(0.92, 1.0, sin(vLocal.y * 6.0 - uTime * 2.2) * 0.5 + 0.5);
        float base = 1.0 - smoothstep(0.0, 0.08, vLocal.y);
        float a2 = fres * 0.7 + line * (0.12 + 0.6 * sweep) + base * 0.6 + 0.03;
        gl_FragColor = vec4(uColor * a2 * uAlpha, 1.0);
      `,
      { uColor: { value: c } },
      { side: THREE.DoubleSide },
    );
    const mesh = new THREE.Mesh(this.domeGeo, mat);
    mesh.renderOrder = 8;
    return this.addFx(mesh, [mat], tx, tz, -0.2, ttl, (f) => {
      const t = f.age / f.ttl;
      const pop = Math.min(1, f.age * 3);
      const s = radius * (0.2 + 0.8 * (1 - Math.pow(1 - pop, 3)));
      f.obj.scale.set(s, s * 0.8, s);
      mat.uniforms.uAlpha.value = Math.min(1, (1 - t) * 5) * (0.85 + 0.15 * Math.sin(f.age * 5));
    });
  }

  /** The cyclone's twisting funnel. */
  funnel(tx: number, tz: number, radius: number, height: number, ttl: number): MeshFx {
    const mat = fxMaterial(
      this.heightTex,
      /* glsl */ `
        float ang = atan(vLocal.z, vLocal.x);
        float y = vUv.y;
        float twist = sin(ang * 3.0 + y * 9.0 - uTime * 7.0) * 0.5 + 0.5;
        float twist2 = sin(ang * 5.0 - y * 14.0 - uTime * 11.0) * 0.5 + 0.5;
        float bands = smoothstep(0.35, 0.9, twist * 0.7 + twist2 * 0.4);
        float fade = smoothstep(0.0, 0.12, y) * (1.0 - smoothstep(0.75, 1.0, y));
        vec3 col = mix(vec3(0.55, 0.5, 0.45), vec3(0.9, 0.92, 0.95), y);
        gl_FragColor = vec4(col, bands * fade * 0.55 * uAlpha);
      `,
      {},
      { side: THREE.DoubleSide, additive: false },
    );
    const mesh = new THREE.Mesh(this.funnelGeo, mat);
    mesh.renderOrder = 8;
    return this.addFx(mesh, [mat], tx, tz, -0.3, ttl, (f) => {
      const t = f.age / f.ttl;
      const g = Math.min(1, f.age * 1.5);
      f.obj.scale.set(radius * g, height * g, radius * g);
      f.obj.rotation.y += 0.05;
      mat.uniforms.uAlpha.value = Math.min(1, (1 - t) * 4);
    });
  }

  /**
   * Jagged lightning bolt from the sky to (tx, tz), with branches. Options:
   * `top` (height above the strike point), `lift` (strike point above the
   * ground — a flicker inside a cloud), `width`, `branches`, `from` (a
   * local offset for the bolt's upper end; an arc between two people).
   */
  bolt(tx: number, tz: number, color = 0xcfe6ff, ttl = 0.4, o: { top?: number; lift?: number; width?: number; branches?: number; hdr?: number; from?: THREE.Vector3; steady?: boolean } = {}): MeshFx {
    const top = o.top ?? 46;
    const from = o.from ?? new THREE.Vector3(0, top, 0);
    const len = from.length();
    // Local space: the mesh sits at the strike point.
    const pts = jagged(from, new THREE.Vector3(0, 0, 0), len > 20 ? 6 : 4, Math.min(9, len * 0.2));
    const geo = new THREE.BufferGeometry();
    const verts: number[] = [];
    const uvs: number[] = [];
    const vertical = !o.from || Math.abs(from.y) > Math.hypot(from.x, from.z);
    const axes = vertical ? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)] : [new THREE.Vector3(0, 1, 0), new THREE.Vector3(-from.z, 0, from.x).normalize()];
    const addStrip = (path: THREE.Vector3[], width: number) => {
      // Two crossed ribbons so the bolt reads from any angle.
      for (const axis of axes) {
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i], b = path[i + 1];
          const w0 = width * (1 - (i / path.length) * 0.4);
          const w1 = width * (1 - ((i + 1) / path.length) * 0.4);
          const a0 = a.clone().addScaledVector(axis, -w0), a1 = a.clone().addScaledVector(axis, w0);
          const b0 = b.clone().addScaledVector(axis, -w1), b1 = b.clone().addScaledVector(axis, w1);
          verts.push(...a0.toArray(), ...a1.toArray(), ...b1.toArray(), ...a0.toArray(), ...b1.toArray(), ...b0.toArray());
          uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
        }
      }
    };
    const width = o.width ?? 0.32;
    addStrip(pts, width);
    // Branches fork off the upper two thirds.
    const nb = o.branches ?? 3;
    for (let b = 0; b < nb; b++) {
      const i = 1 + Math.floor(Math.random() * (pts.length * 0.6));
      const p0 = pts[i];
      const s = len / 46;
      const dir = new THREE.Vector3((Math.random() - 0.5) * 16 * s, (-6 - Math.random() * 10) * s, (Math.random() - 0.5) * 16 * s);
      const branch = jagged(p0, p0.clone().add(dir), 4, 4 * s);
      addStrip(branch, width * 0.5);
      // twigs off the bigger branches
      if (Math.random() < 0.5) {
        const q = branch[Math.floor(branch.length * 0.5)];
        addStrip(jagged(q, q.clone().add(dir.clone().multiplyScalar(0.45).add(new THREE.Vector3((Math.random() - 0.5) * 6 * s, 0, (Math.random() - 0.5) * 6 * s))), 3, 2 * s), width * 0.3);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(verts.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    const c = lin(color).multiplyScalar(o.hdr ?? 9);
    const mat = fxMaterial(
      this.heightTex,
      /* glsl */ `
        float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
        core = pow(max(core, 0.0), 1.5);
        gl_FragColor = vec4(uColor * core * uAlpha, 1.0);
      `,
      { uColor: { value: c } },
      { side: THREE.DoubleSide },
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 9;
    const steady = o.steady ?? false;
    return this.addFx(mesh, [mat], tx, tz, o.lift ?? 0, ttl, (f) => {
      // Flicker: strike, dim, restrike, fade (an afterimage just fades).
      const t = f.age / f.ttl;
      const flick = steady ? (1 - t) * (1 - t) : t < 0.15 ? 1 : t < 0.3 ? 0.25 : t < 0.45 ? 1 : 1 - t;
      mat.uniforms.uAlpha.value = flick;
    });
  }

  // -------------------------------------------------------------------------
  // Projectiles (emberthrower shots, burning stones)
  // -------------------------------------------------------------------------

  launch(fx: number, fz: number, tx: number, tz: number, kind: 'ember' | 'stone'): void {
    if (kind === 'ember') {
      this.projectiles.push({ fx, fz, tx, tz, fromY: 1.6, toY: 1, age: 0, ttl: 0.32, arc: 1.6, kind });
    } else {
      // Burning stone: falls out of the sky at a slant.
      const a = Math.random() * Math.PI * 2;
      const off = 8 + Math.random() * 4;
      this.projectiles.push({
        fx: tx + Math.cos(a) * off, fz: tz + Math.sin(a) * off, tx, tz,
        fromY: 34, toY: 0.4, age: 0, ttl: 0.75, arc: 0, kind,
      });
    }
  }

  /**
   * Throw a lava bomb from tile (tx, tz) at height y (world units):
   * horizontal velocity (vx, vz) in tiles/s, vy in world units/s.
   */
  bomb(tx: number, tz: number, y: number, vx: number, vz: number, vy: number, size = 1): void {
    if (this.bombs.length > 60) return;
    this.bombs.push({ tx, tz, y, vx, vz, vy, size, age: 0 });
  }

  private stepBombs(dt: number): void {
    if (!this.bombs.length) return;
    const keep: Bomb[] = [];
    for (const b of this.bombs) {
      b.age += dt;
      b.tx += b.vx * dt;
      b.tz += b.vz * dt;
      b.vy -= 22 * dt;
      b.y += b.vy * dt;
      const p = this.at(b.tx, b.tz, 0);
      const ground = p.y;
      const x = p.x, z = p.z;
      // glowing head and a trail of sparks and smoke
      this.glow.emit({ x, y: b.y, z, life: 0.07, size: 1.5 * b.size, r: 9, g: 4, b: 1.1, shape: GLOW, fadeIn: 0.01 });
      this.glow.emit({
        x: x + (Math.random() - 0.5) * 0.3, y: b.y, z: z + (Math.random() - 0.5) * 0.3,
        vy: 0.4, life: 0.5 + Math.random() * 0.3, size: 0.8 * b.size, sizeEnd: 0.1,
        r: 6, g: 2.2, b: 0.4, r2: 1.2, g2: 0.15, b2: 0.02, shape: GLOW, fadeIn: 0.01,
      });
      if (Math.random() < 0.6 * this.detail + 0.2) {
        this.matter.emit({
          x, y: b.y + 0.3, z, vy: 0.6, life: 1.6, size: 0.8 * b.size, sizeEnd: 2.8 * b.size,
          r: 0.12, g: 0.1, b: 0.09, alpha: 0.55, shape: SMOKE, fadeIn: 0.1, drag: 1,
        });
      }
      if (b.y <= ground + 0.2 && b.vy < 0) {
        const sea = (this.world?.map.sampleHeight(b.tx, b.tz) ?? 1) < 0;
        if (sea) {
          this.steam(b.tx, b.tz, this.n(6, 2), 1.2);
          this.spray(b.tx, b.tz, this.n(10, 3), 5);
        } else {
          this.fireCore(b.tx, b.tz, 0.32 * b.size, 0.4);
          this.sparks(b.tx, b.tz, this.n(10, 3), 5, C.lava, 0.4, 0.3);
          this.debris(b.tx, b.tz, this.n(5, 2), 5, 0x2a1a12, 0.25);
          this.surface?.paint(FxChannel.Heat, b.tx, b.tz, 0.4 * b.size, 0.6);
          this.scorch(b.tx, b.tz, 0.8 * b.size, 0.5);
        }
        continue;
      }
      if (b.age < 6) keep.push(b);
    }
    this.bombs = keep;
  }

  /** Steam off water: pale, fast-rising puffs. */
  steam(tx: number, tz: number, n: number, spread = 1, rise = 3.5): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread * TILE;
      const p = this.at(tx, tz, 0.2);
      const v = 0.75 + Math.random() * 0.2;
      this.matter.emit({
        x: p.x + Math.cos(a) * r, y: p.y, z: p.z + Math.sin(a) * r,
        vx: Math.cos(a) * 0.4 + 0.5, vy: rise * (0.6 + Math.random() * 0.7), vz: Math.sin(a) * 0.4,
        life: 2 + Math.random() * 1.5, size: 1.1, sizeEnd: 4.2,
        r: v, g: v, b: v * 1.03, alpha: 0.42, drag: 0.7, shape: SMOKE, fadeIn: 0.12,
      });
    }
  }

  private stepProjectiles(dt: number): void {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      p.age += dt;
      const t = Math.min(1, p.age / p.ttl);
      const dx = wrapDelta(p.tx - p.fx, WORLD_SIZE);
      const dz = wrapDelta(p.tz - p.fz, WORLD_SIZE);
      const cx = p.fx + dx * t;
      const cz = p.fz + dz * t;
      const yBase = p.kind === 'stone' ? p.fromY + (p.toY - p.fromY) * t * t : p.fromY + (p.toY - p.fromY) * t;
      const pos = this.at(cx, cz, 0);
      const y = (p.kind === 'stone' ? this.ground(p.tx, p.tz) : pos.y) + yBase + Math.sin(t * Math.PI) * p.arc;
      // Head + trail. A falling stone covers metres per frame: string its
      // trail along the whole stretch it crossed so it reads as one streak.
      const hot = p.kind === 'stone' ? 1.6 : 0.9;
      const px = pos.x, pz = pos.z;
      this.glow.emit({ x: px, y, z: pz, life: 0.08, size: 1.1 * hot, r: 10, g: 5, b: 1.5, shape: GLOW, fadeIn: 0.01 });
      const steps = p.kind === 'stone' ? 6 : 1;
      const lx = p.lastX ?? px, ly = p.lastY ?? y, lz = p.lastZ ?? pz;
      for (let k = 0; k < steps; k++) {
        const f = steps > 1 ? k / steps : 0;
        this.glow.emit({
          x: px + (lx - px) * f + (Math.random() - 0.5) * 0.3, y: y + (ly - y) * f, z: pz + (lz - pz) * f + (Math.random() - 0.5) * 0.3,
          vy: 0.5, life: 0.3 + Math.random() * 0.25, size: 0.75 * hot, sizeEnd: 0.1,
          r: 7, g: 2.6, b: 0.5, r2: 1.5, g2: 0.2, b2: 0.02, shape: GLOW, fadeIn: 0.01,
        });
        if (p.kind === 'stone' && k % 2 === 0) {
          this.matter.emit({
            x: px + (lx - px) * f, y: y + (ly - y) * f + 0.4, z: pz + (lz - pz) * f, vy: 0.8, life: 1.4, size: 0.9, sizeEnd: 2.8,
            r: 0.15, g: 0.13, b: 0.12, alpha: 0.55, shape: SMOKE, fadeIn: 0.1, drag: 1,
          });
        }
      }
      p.lastX = px;
      p.lastY = y;
      p.lastZ = pz;
      if (t >= 1) {
        if (p.kind === 'ember') {
          this.fireCore(p.tx, p.tz, 0.25, 0.8);
          this.sparks(p.tx, p.tz, 8, 5, lin(0xffa040));
        } else {
          this.impact(p.tx, p.tz, 0.7);
        }
        continue;
      }
      keep.push(p);
    }
    this.projectiles = keep;
  }

  /** Boats come ashore (the `landing` event): see render/fleet.ts. */
  spectacleLanding(x: number, z: number, count: number, tribe?: string): void {
    this.spectacle.landing(x, z, count, tribe);
  }

  /** Big clods thrown high out of a crater, each trailing dust. */
  ejecta(tx: number, tz: number, n: number, speed: number): void {
    const p = this.at(tx, tz, 0.8);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.5 + Math.random() * 0.6);
      const k = 0.6 + Math.random() * 0.4;
      this.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * s * 0.55, vy: s * (0.9 + Math.random() * 0.6), vz: Math.sin(a) * s * 0.55,
        life: 1.4 + Math.random() * 0.6, size: 0.55 + Math.random() * 0.4, r: 0.3 * k, g: 0.23 * k, b: 0.16 * k,
        gravity: 20, drag: 0.15, shape: CHUNK, fadeIn: 0.01,
      });
      // the dust trail: a few puffs strung out behind on the same path, born later
      for (let j = 1; j <= 3; j++) {
        const dt = j * 0.09;
        this.matter.emit({
          x: p.x + Math.cos(a) * s * 0.55 * dt, y: p.y + s * dt, z: p.z + Math.sin(a) * s * 0.55 * dt,
          vx: Math.cos(a) * s * 0.2, vy: s * 0.3, vz: Math.sin(a) * s * 0.2,
          life: 1 + Math.random() * 0.6, size: 0.6, sizeEnd: 2.4, r: 0.45, g: 0.39, b: 0.31, alpha: 0.45, drag: 2, shape: SMOKE, fadeIn: 0.1,
        });
      }
    }
  }

  /** Gouts of mud (Mire). */
  mud(tx: number, tz: number, n: number, radius: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const p = this.at(tx + (Math.cos(a) * r) / TILE, tz + (Math.sin(a) * r) / TILE, 0.2);
      const k = 0.7 + Math.random() * 0.4;
      this.matter.emit({
        x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 2, vy: 3 + Math.random() * 4, vz: (Math.random() - 0.5) * 2,
        life: 0.8 + Math.random() * 0.4, size: 0.35 + Math.random() * 0.3, r: 0.2 * k, g: 0.22 * k, b: 0.1 * k,
        gravity: 18, shape: CHUNK, fadeIn: 0.01,
      });
    }
  }

  /** A dark cloud deck over (tx, tz) at `height`: swirling (`swirl` rad/s), its underside tinted `under`. */
  cloudCap(tx: number, tz: number, height: number, radius: number, n: number, swirl: number, under: [number, number, number]): void {
    const c = this.at(tx, tz, height);
    const cx = c.x, cy = c.y, cz = c.z;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const v = 0.06 + Math.random() * 0.05;
      this.matter.emit({
        x: cx + Math.cos(a) * r, y: cy + (Math.random() - 0.5) * 2, z: cz + Math.sin(a) * r,
        vx: 0, vy: 0.2, vz: 0, life: 3 + Math.random() * 1.5, size: 5, sizeEnd: 9,
        r: under[0], g: under[1], b: under[2], r2: v, g2: v, b2: v * 1.1, alpha: 0.7, drag: 0.5, shape: SMOKE, fadeIn: 0.25,
        swirl, ax: cx, az: cz,
      });
    }
  }

  /** What's left of a lightning cloud: a dark puff high over the strike that breaks up. */
  cloudBurst(tx: number, tz: number): void {
    const c = this.at(tx, tz, 17);
    const cx = c.x, cy = c.y, cz = c.z;
    for (let i = 0; i < this.n(18, 6); i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 6;
      const v = 0.08 + Math.random() * 0.05;
      this.matter.emit({
        x: cx + Math.cos(a) * r, y: cy + (Math.random() - 0.5) * 2, z: cz + Math.sin(a) * r,
        vx: Math.cos(a) * 2, vy: 0.3, vz: Math.sin(a) * 2, life: 2 + Math.random(), size: 6, sizeEnd: 10,
        r: v, g: v, b: v * 1.25, alpha: 0.75, drag: 0.6, shape: SMOKE, fadeIn: 0.02,
      });
    }
  }

  /** A full explosion, scaled. */
  impact(tx: number, tz: number, scale: number): void {
    this.fireCore(tx, tz, scale, 0.8);
    this.sparks(tx, tz, Math.round(30 * scale), 9 * scale, lin(0xffb050));
    this.debris(tx, tz, Math.round(18 * scale), 10 * scale);
    this.smoke(tx, tz, Math.round(12 * scale), { spread: 1.5 * scale, size: 2 * scale, rise: 2.5, dark: 0.12, life: 3 });
    this.ring(tx, tz, 0xffc070, 7 * scale, 0.6, 3);
    this.dust(tx, tz, Math.round(10 * scale), 2 * scale, 0x8a7a64, 5 * scale);
    this.scorch(tx, tz, 2.2 * scale, 1);
    this.flash(tx, tz, 0xffa050, 900 * scale, 0.5, 3, 45 * scale);
  }

  // -------------------------------------------------------------------------
  // Persistent: auras (world.auras), burning buildings, swamp bubbles
  // -------------------------------------------------------------------------

  private syncAuras(world: World, dt: number): void {
    for (const v of this.auraVisuals.values()) v.seen = false;
    for (const a of world.auras) {
      let v = this.auraVisuals.get(a);
      if (!v) {
        // A loaded save rebuilds the aura objects: re-adopt an unclaimed
        // visual of the same kind close by rather than restarting it.
        for (const [o, old] of this.auraVisuals) {
          if (old.seen || old.kind !== a.kind) continue;
          if (Math.hypot(wrapDelta(o.x - a.x, WORLD_SIZE), wrapDelta(o.z - a.z, WORLD_SIZE)) > 4) continue;
          this.auraVisuals.delete(o);
          this.auraVisuals.set(a, old);
          v = old;
          break;
        }
      }
      if (!v) {
        v = { kind: a.kind, meshes: [], emitAcc: 0, seen: true };
        this.auraVisuals.set(a, v);
        this.startAura(a, v);
      }
      v.seen = true;
      for (const m of v.meshes) {
        m.tx = a.x;
        m.tz = a.z;
        m.ttl = Infinity; // lives as long as the aura does
      }
      this.tickAura(a, v, dt);
    }
    for (const [a, v] of this.auraVisuals) {
      if (v.seen) continue;
      // Aura ended: let its meshes fade out quickly.
      for (const m of v.meshes) {
        m.ttl = m.age + 0.4;
      }
      this.auraVisuals.delete(a);
    }
  }

  private startAura(a: Aura, v: AuraVisual): void {
    const r = Math.max(1, a.radius) * TILE;
    switch (v.kind) {
      case 'ward':
        v.meshes.push(this.dome(a.x, a.z, 0x8fd8ff, r, Infinity));
        v.meshes.push(this.groundGlow(a.x, a.z, 0x6fc4ff, r, Infinity, 1.2));
        break;
      case 'warsong':
        v.meshes.push(this.groundGlow(a.x, a.z, 0xff7a3a, r, Infinity, 1.6));
        break;
      case 'cyclone':
        v.meshes.push(this.funnel(a.x, a.z, Math.max(5, r * 0.9), 22, Infinity));
        break;
      case 'emberfall':
        v.meshes.push(this.groundGlow(a.x, a.z, 0xff4a1a, r, Infinity, 1.8));
        break;
      case 'sink':
        v.meshes.push(this.groundGlow(a.x, a.z, 0x3aa0c0, r, Infinity, 1.0));
        break;
      case 'bloom':
        v.meshes.push(this.groundGlow(a.x, a.z, 0x8cff6a, r, Infinity, 1.2));
        break;
    }
  }

  private tickAura(a: Aura, v: AuraVisual, dt: number): void {
    const k = v.kind;
    const rT = Math.max(1, a.radius); // tiles
    v.emitAcc += dt;
    const every = (s: number) => {
      if (v.emitAcc < s) return false;
      v.emitAcc = 0;
      return true;
    };
    if (k === 'ward') {
      if (every(0.12)) this.motes(a.x, a.z, 2, lin(0x9fe0ff), { radius: rT * TILE * 0.9, rise: 1.5, life: 2, hdr: 3 });
    } else if (k === 'warsong') {
      if (every(0.08)) this.motes(a.x, a.z, 3, lin(Math.random() < 0.5 ? 0xff5a2a : 0xffc04a), { radius: rT * TILE, rise: 3, life: 1.4, hdr: 4 });
      const pulse = Math.sin(performance.now() / 260);
      if (pulse > 0.995) this.ring(a.x, a.z, 0xff8a3a, rT * TILE, 0.8, 2.5);
    } else if (k === 'cyclone') {
      if (Math.random() < dt * 8 * this.detail + dt * 2) this.cloudCap(a.x, a.z, 21, 9, 1, 1.6, [0.2, 0.2, 0.22]);
      if (every(0.03)) {
        const c = this.at(a.x, a.z, 0).clone();
        for (let i = 0; i < 3; i++) {
          const ang = Math.random() * Math.PI * 2;
          const rr = 1 + Math.random() * 4;
          this.matter.emit({
            x: c.x + Math.cos(ang) * rr, y: c.y + Math.random() * 2, z: c.z + Math.sin(ang) * rr,
            vy: 3 + Math.random() * 5, life: 1.6, size: 1.6, sizeEnd: 4,
            r: 0.45, g: 0.4, b: 0.33, alpha: 0.5, shape: SMOKE, fadeIn: 0.2,
            swirl: 4, ax: c.x, az: c.z,
          });
          if (Math.random() < 0.4) {
            this.matter.emit({
              x: c.x + Math.cos(ang) * rr, y: c.y + 1 + Math.random() * 8, z: c.z + Math.sin(ang) * rr,
              vy: 2 + Math.random() * 3, life: 1.4, size: 0.35, r: 0.25, g: 0.2, b: 0.12,
              shape: CHUNK, swirl: 5, ax: c.x, az: c.z, fadeIn: 0.05,
            });
          }
        }
      }
    } else if (k === 'emberfall') {
      if (every(0.1)) {
        this.motes(a.x, a.z, 2, lin(0xff6a2a), { radius: rT * TILE, rise: 1, life: 1.5, hdr: 3, lift: 6 });
        // a low, smouldering cloud the stones fall out of, lit red from below
        this.cloudCap(a.x, a.z, 24, rT * TILE * 0.8, this.n(3, 1), 0.5, [0.5, 0.12, 0.05]);
      }
    } else if (k === 'sink') {
      if (every(0.1)) {
        this.dust(a.x + (Math.random() - 0.5) * rT, a.z + (Math.random() - 0.5) * rT, 2, rT, 0x9a8a70, 1.2);
        this.spray(a.x + (Math.random() - 0.5) * rT, a.z + (Math.random() - 0.5) * rT, 3, 4);
      }
    } else if (k === 'bloom') {
      if (every(0.1)) {
        this.motes(a.x, a.z, 2, lin(0x9cff7a), { radius: rT * TILE, rise: 1.2, life: 2, hdr: 2.5 });
        if (Math.random() < 0.5) this.petals(a.x, a.z, 1, rT * TILE);
      }
    }
  }

  private ambient(world: World, dt: number): void {
    // Burning buildings (b.burning = seconds left on fire).
    this.burnAcc += dt;
    if (this.burnAcc > 0.06) {
      this.burnAcc = 0;
      for (const b of world.buildings) {
        if (b.burning <= 0) continue;
        const { x, z } = b;
        if (!this.near(x, z, 90)) continue;
        this.flames(x, z, 2.5, 3);
        if (Math.random() < 0.4) this.smoke(x, z, 1, { lift: 4, dark: 0.09, rise: 3, size: 2.2, life: 3.5 });
      }
    }
    // Swamp bubbles on a few random visible swamp tiles.
    this.swampAcc += dt;
    if (this.swampAcc > 0.1 && world.swamp.size) {
      this.swampAcc = 0;
      const keys = [...world.swamp.keys()];
      for (let i = 0; i < 4; i++) {
        const idx = keys[Math.floor(Math.random() * keys.length)];
        const tx = idx % WORLD_SIZE, tz = Math.floor(idx / WORLD_SIZE);
        if (!this.near(tx, tz, 80)) continue;
        const fx = tx + Math.random() - 0.5, fz = tz + Math.random() - 0.5;
        if (i < 3) this.swampBubble(fx, fz);
        else this.swampMist(fx, fz);
      }
    }
  }

  private swampBubble(tx: number, tz: number): void {
    const p = this.at(tx, tz, 0.1);
    this.matter.emit({ x: p.x, y: p.y, z: p.z, vy: 0.5, life: 1.4, size: 0.5, sizeEnd: 1.6, r: 0.25, g: 0.3, b: 0.16, alpha: 0.5, shape: SMOKE, fadeIn: 0.3 });
    // a bubble of marsh gas swells and pops with a faint green glint
    this.glow.emit({ x: p.x, y: p.y + 0.1, z: p.z, vy: 0.2, life: 0.9, size: 0.35, sizeEnd: 0.6, r: 0.5, g: 1.2, b: 0.3, alpha: 0.7, shape: GLOW, fadeIn: 0.8 });
  }

  /** Low, sickly mist hanging over the mire. */
  private swampMist(tx: number, tz: number): void {
    const p = this.at(tx, tz, 0.4);
    this.matter.emit({
      x: p.x, y: p.y, z: p.z, vx: 0.4, vy: 0.15, life: 4, size: 2.2, sizeEnd: 4.5,
      r: 0.42, g: 0.5, b: 0.28, alpha: 0.32, drag: 0.5, shape: SMOKE, fadeIn: 0.35,
    });
  }

  /** Is tile (x, z) within `dist` world units of the camera target? */
  private near(tx: number, tz: number, dist: number): boolean {
    const dx = wrapDelta(tx * TILE - this.camTarget.x, WORLD_UNITS);
    const dz = wrapDelta(tz * TILE - this.camTarget.z, WORLD_UNITS);
    return dx * dx + dz * dz < dist * dist;
  }
}

/** Midpoint-displaced jagged path from a to b (in local space). */
function jagged(a: THREE.Vector3, b: THREE.Vector3, depth: number, amp: number): THREE.Vector3[] {
  let pts = [a.clone(), b.clone()];
  let s = amp;
  for (let d = 0; d < depth; d++) {
    const next: THREE.Vector3[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const m = p.clone().lerp(q, 0.5);
      m.x += (Math.random() - 0.5) * s;
      m.z += (Math.random() - 0.5) * s;
      next.push(p, m);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
    s *= 0.55;
  }
  return pts;
}

// ---------------------------------------------------------------------------
// The registry: event name → what it looks/sounds like.
// ---------------------------------------------------------------------------

const C = {
  lava: lin(0xff7a20),
  gold: lin(0xffd36a),
  cyan: lin(0x88eaff),
  white: lin(0xfff4dc),
  green: lin(0x8cff6a),
  violet: lin(0xc49bff),
  red: lin(0xff5a3a),
};

const HANDLERS: Record<string, Handler> = {
  explosion(fx, x, z) {
    // Blast (and a building blown apart): fireball, ejecta trailing dust, a
    // shock ring that rolls out low and flattens the grass as it passes.
    fx.shake(0.8);
    fx.impact(x, z, 1.15);
    fx.ejecta(x, z, fx.n(14, 5), 11);
    fx.dust(x, z, fx.n(26, 8), 1.5, 0x8a7a64, 11);
    fx.ring(x, z, 0xfff0d0, 16, 0.9, 1.6, 0.06);
    fx.grassShock(x, z, 22);
    fx.screenFlash(0xffc890, 0.12, 0.25);
  },
  lightning(fx, x, z, mag, ev) {
    if (mag < 1 && ev.x2 !== undefined && ev.z2 !== undefined) {
      // an arc jumping from the strike to the next victim
      const from = new THREE.Vector3(
        wrapDelta(ev.x2 - x, WORLD_SIZE) * TILE, fx.ground(ev.x2, ev.z2) - fx.ground(x, z) + 0.6,
        wrapDelta(ev.z2 - z, WORLD_SIZE) * TILE,
      );
      fx.bolt(x, z, 0xd8ecff, 0.35, { from, lift: 1.1, width: 0.14, branches: 1, hdr: 8 });
      fx.sparks(x, z, 14, 6, lin(0xbfe0ff), 1.2, 0.3);
      fx.scorch(x, z, 0.8, 0.6);
      return;
    }
    // THE bolt: blinding, forked, with an afterimage burned into the eye,
    // scorched ground and a small fire left burning.
    fx.shake(0.6);
    fx.bolt(x, z, 0xe6f2ff, 0.5, { top: 19, width: 0.42, branches: 5, hdr: 11 });
    fx.bolt(x, z, 0xb08cff, 1.1, { top: 19, width: 0.8, branches: 0, hdr: 1.6, steady: true });
    fx.flash(x, z, 0xcfe0ff, 3000, 0.35, 8, 70);
    fx.screenFlash(0xeaf0ff, 0.55, 0.22);
    fx.sparks(x, z, fx.n(40, 12), 9, lin(0xbfe0ff));
    fx.fireCore(x, z, 0.45, 0.5);
    fx.ring(x, z, 0xbfe0ff, 7, 0.5, 4);
    fx.ring(x, z, 0xfff0d0, 3, 0.25, 6, 0.3);
    fx.debris(x, z, fx.n(10, 4), 7, 0x3a2e24, 0.28);
    fx.smoke(x, z, 6, { size: 1.6, dark: 0.12 });
    fx.scorch(x, z, 1.8, 1.1);
    fx.burn(x, z, 6);
    fx.cloudBurst(x, z);
  },
  convert(fx, x, z) {
    fx.ring(x, z, 0x88eaff, 5, 0.8, 3);
    fx.motes(x, z, 22, C.cyan, { radius: 1.5, rise: 3, swirl: 3, life: 1.6 });
  },
  unlock(fx, x, z) {
    // a teaching stone gives up its spell: a burst in the spell's own colour
    const col = fx.stoneColor(x, z, 0xffd36a);
    fx.ring(x, z, col, 9, 1.1, 4);
    fx.ring(x, z, 0xffe9a8, 5, 0.8, 3);
    fx.column(x, z, col, 1.6, 30, 2.2, 2.5);
    fx.motes(x, z, 50, lin(col), { radius: 2.5, rise: 5, swirl: 2, life: 2.2 });
    fx.motes(x, z, 20, C.gold, { radius: 1.5, rise: 7, swirl: 3, life: 1.6, lift: 3 });
    fx.flash(x, z, col, 900, 0.9, 4, 40);
  },
  communeStart(fx, x, z) {
    // the stone wakes to the leader's touch
    const col = fx.stoneColor(x, z, 0xffe9a8);
    fx.ring(x, z, col, 4.5, 0.9, 3, 0.12);
    fx.motes(x, z, 18, lin(col), { radius: 1.2, rise: 3, swirl: 2, life: 1.4, lift: 1 });
  },
  communeInterrupted(fx, x, z) {
    // the thread snaps: a white crack of light, sparks flung outward, a puff of grit
    fx.flash(x, z, 0xfff4e8, 700, 0.25, 3, 30);
    fx.sparks(x, z, 30, 9, lin(0xfff0dc), 3, 0.3);
    fx.sparks(x, z, 14, 6, lin(fx.stoneColor(x, z, 0xffd36a)), 2, 0.4);
    fx.ring(x, z, 0xfff0dc, 5, 0.35, 5, 0.1);
    fx.dust(x, z, 8, 1.6, 0xa8957a, 3);
    fx.shake(0.25);
  },
  castFlash(fx, x, z) {
    fx.ring(x, z, 0xcfe8ff, 3, 0.5, 3);
    fx.motes(x, z, 12, lin(0xcfe8ff), { radius: 0.8, rise: 4, life: 0.9 });
    fx.flash(x, z, 0xcfe8ff, 200, 0.3, 2, 15);
  },
  hit(fx, x, z) {
    fx.sparks(x, z, 7, 4, lin(0xfff0c0), 1.2, 0.25);
    fx.dust(x, z, 3, 0.6, 0xa8957a, 1.5);
  },
  splash(fx, x, z) {
    fx.spray(x, z, 14, 5);
    fx.ring(x, z, 0xcfefff, 2.2, 0.6, 1.5, 0.3);
  },
  death(fx, x, z) {
    fx.dust(x, z, 5, 0.6, 0xaaa090, 1.2);
    fx.motes(x, z, 10, lin(0xe8f0ff), { radius: 0.4, rise: 3.5, life: 1.6, size: 0.5, hdr: 2.5 });
  },
  plume(fx, x, z) {
    fx.smoke(x, z, 3, { lift: 2, spread: 1.2, size: 2.4, rise: 5, dark: 0.08, life: 4 });
    fx.sparks(x, z, 4, 6, lin(0xff7a2a), 2);
  },
  volcanoStart(fx, x, z) {
    // The mountain wakes: the ground bursts, the screen goes hot, the sky shakes.
    fx.shake(2.2);
    fx.screenFlash(0xff7a30, 0.45, 0.9);
    fx.impact(x, z, 1.6);
    fx.ring(x, z, 0xff6a2a, 22, 1.8, 3, 0.08);
    fx.ring(x, z, 0xffd0a0, 12, 0.8, 4, 0.12);
    fx.dust(x, z, fx.n(50, 14), 16, 0x8a7a64, 7);
    fx.ejecta(x, z, fx.n(16, 6), 13);
    fx.flash(x, z, 0xff6020, 1800, 1.2, 5, 55);
    fx.grassShock(x, z, 30);
  },
  quakeStart(fx, x, z) {
    fx.shake(1.2);
    fx.screenFlash(0xffb070, 0.12, 0.4);
    fx.dust(x, z, fx.n(50, 14), 10, 0xa08a6a, 4);
    fx.debris(x, z, 20, 7, 0x6a5a48);
    fx.ring(x, z, 0xc8b090, 24, 1.6, 1.4, 0.06);
    fx.grassShock(x, z, 30);
  },
  rumbleSmall(fx, x, z) {
    fx.dust(x, z, 6, 3, 0xa08a6a, 2);
  },
  shake(fx, _x, _z, mag) {
    fx.shake(mag);
  },
  swamp(fx, x, z) {
    // the ground goes soft: a sickly ring, mud gouts, a slow bubble-burst
    fx.dust(x, z, 24, 5, 0x56603a, 1.5);
    fx.ring(x, z, 0x9aba5a, 9, 1.2, 1.6, 0.12);
    fx.ring(x, z, 0x6a8a3a, 5, 1.6, 1.2, 0.2, true);
    fx.mud(x, z, fx.n(30, 10), 8);
    fx.motes(x, z, fx.n(24, 8), lin(0xb8e070), { radius: 7, rise: 1.2, life: 2, hdr: 2 });
  },
  denied(fx, x, z) {
    fx.ring(x, z, 0xff4a3a, 1.6, 0.4, 2);
  },
  fireball(fx, x, z, _m, ev) {
    if (ev.x2 !== undefined && ev.z2 !== undefined) fx.launch(x, z, ev.x2, ev.z2, 'ember');
    else fx.fireCore(x, z, 0.4);
  },

  // --- the opening (fb-opening) ---
  landing(fx, x, z, mag, ev) {
    fx.spectacleLanding(x, z, mag, ev.tribe);
  },
  rescued(fx, x, z) {
    // home at last: a warm burst round the one who made it
    fx.ring(x, z, 0xffd38a, 6, 1, 3);
    fx.ring(x, z, 0xfff0c8, 3, 0.6, 4, 0.25);
    fx.column(x, z, 0xffd38a, 1.1, 14, 1.2, 2);
    fx.motes(x, z, fx.n(36, 12), C.gold, { radius: 1.4, rise: 4.5, swirl: 3, life: 1.6 });
    fx.petals(x, z, fx.n(12, 4), 3);
    fx.flash(x, z, 0xffc070, 500, 0.8, 3, 30);
  },
  siteLevel(fx, x, z, mag) {
    // builders cut the plot flat: a puff of dust and clods round the footprint
    const r = Math.max(3, mag) * TILE * 0.55;
    fx.dust(x, z, fx.n(22, 8), r, 0xbfa883, 2.5);
    fx.debris(x, z, fx.n(10, 4), 5, 0x5a4532, 0.3);
    fx.ring(x, z, 0xd8c09a, r * 1.2, 0.7, 1.4, 0.1);
  },

  // --- v2 events ---
  wardCast(fx, x, z) {
    fx.ring(x, z, 0x8fd8ff, 12, 0.9, 3);
    fx.dome(x, z, 0x8fd8ff, 12, 1.2);
    fx.motes(x, z, 30, lin(0x9fe0ff), { radius: 8, rise: 3, life: 1.6 });
  },
  warsongCast(fx, x, z) {
    fx.ring(x, z, 0xff6a2a, 14, 0.9, 4);
    fx.ring(x, z, 0xffc04a, 9, 0.7, 3);
    fx.motes(x, z, 50, C.red, { radius: 10, rise: 5, life: 1.8 });
    fx.motes(x, z, 30, C.gold, { radius: 10, rise: 6, life: 1.8 });
    fx.flash(x, z, 0xff7a3a, 400, 0.6, 3, 40);
  },
  cycloneTouch(fx, x, z) {
    fx.dust(x, z, 18, 3, 0x9a8a70, 6);
    fx.debris(x, z, 10, 9, 0x5a4a32);
  },
  emberStrike(fx, x, z) {
    fx.launch(x, z, x, z, 'stone');
  },
  sinkRumble(fx, x, z) {
    fx.shake(0.4);
    fx.dust(x, z, 18, 5, 0x9a8a70, 3);
    fx.spray(x, z, 24, 6);
    fx.ring(x, z, 0xd8f4ff, 10, 1.2, 1.4, 0.1);
  },
  bloomCast(fx, x, z) {
    fx.ring(x, z, 0x8cff6a, 12, 1.0, 3);
    fx.motes(x, z, 40, C.green, { radius: 9, rise: 3, life: 2 });
    fx.petals(x, z, 50, 10);
    fx.flash(x, z, 0x9cff7a, 300, 0.6, 3, 35);
  },
  chantStart(fx, x, z) {
    fx.ring(x, z, 0xc49bff, 4, 0.8, 2.5);
    fx.motes(x, z, 16, C.violet, { radius: 1.5, rise: 2.5, swirl: 2, life: 1.8 });
  },
  defect(fx, x, z) {
    fx.ring(x, z, 0xffffff, 3, 0.6, 3);
    fx.motes(x, z, 18, C.white, { radius: 0.8, rise: 4, swirl: -4, life: 1.2 });
  },
  dwellingGrow(fx, x, z) {
    fx.dust(x, z, 18, 4, 0xc2ab88, 2.5);
    fx.motes(x, z, 18, C.gold, { radius: 4, rise: 2, life: 1.2, size: 0.3, hdr: 5 });
  },
  built(fx, x, z) {
    fx.dust(x, z, 26, 5, 0xc2ab88, 3);
    fx.ring(x, z, 0xffe0a0, 7, 0.8, 2);
    fx.motes(x, z, 26, C.gold, { radius: 4, rise: 3, life: 1.4, size: 0.3, hdr: 5 });
  },
  trained(fx, x, z) {
    fx.ring(x, z, 0xffe9a8, 2.4, 0.6, 2.5);
    fx.motes(x, z, 12, C.gold, { radius: 0.8, rise: 3, life: 1, size: 0.3 });
  },
  collapse(fx, x, z) {
    fx.shake(0.5);
    fx.dust(x, z, 40, 6, 0x8f7c62, 4);
    fx.debris(x, z, 16, 9, 0x4a3a28, 0.3);
    fx.smoke(x, z, 10, { spread: 3, size: 3, dark: 0.3, rise: 1.5, life: 3.5 });
  },
  fireStart(fx, x, z) {
    fx.fireCore(x, z, 0.5, 1.5);
    fx.flames(x, z, 2.5, 20);
    fx.smoke(x, z, 5, { lift: 2.5, dark: 0.1, rise: 3 });
    fx.scorch(x, z, 1.5, 0.6);
  },
  giftClaimed(fx, x, z) {
    const col = fx.stoneColor(x, z, 0xffd36a);
    fx.ring(x, z, col, 6, 0.9, 4);
    fx.column(x, z, col, 1.2, 18, 1.4, 2.5);
    fx.motes(x, z, 40, lin(col), { radius: 1.2, rise: 7, swirl: 3, life: 1.6 });
    fx.flash(x, z, col, 600, 0.7, 4, 30);
  },
  objectiveDone(fx, x, z) {
    fx.column(x, z, 0xffe9a8, 2, 40, 2.5, 2);
    fx.ring(x, z, 0xffe9a8, 10, 1.2, 3);
    fx.motes(x, z, 50, C.gold, { radius: 3, rise: 6, swirl: 2, life: 2.2 });
  },
  leaderDown(fx, x, z) {
    fx.column(x, z, 0xeaf2ff, 1.4, 50, 3, 1.8);
    fx.motes(x, z, 40, lin(0xeaf2ff), { radius: 1, rise: 9, life: 2.5, size: 0.4 });
    fx.dust(x, z, 10, 1.5, 0xb0a890, 2);
  },
  leaderReturn(fx, x, z) {
    fx.column(x, z, 0xfff0c0, 1.8, 50, 2.2, 2.2);
    fx.ring(x, z, 0xfff0c0, 6, 0.9, 4);
    fx.motes(x, z, 30, C.gold, { radius: 1.5, rise: 3, swirl: 3, life: 1.6 });
    fx.flash(x, z, 0xfff0c0, 400, 0.8, 3, 30);
  },
};

/** Names this renderer draws (handy for tests/tools). */
export const DRAWN_EVENTS = Object.keys(HANDLERS);
