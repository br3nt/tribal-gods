/**
 * world/terrain-mesh.ts — turning the heightmap into pixels.
 *
 * Two jobs:
 *
 * 1. THE SCROLLING WINDOW. We never build geometry for "the whole planet" —
 *    we keep ONE reusable mesh of VIEW_TILES × VIEW_TILES quads and refill
 *    its vertices from the wrapped heightmap, centered on whatever tile the
 *    camera is looking at. Pan east far enough and tiles from the west edge
 *    of the array scroll seamlessly into view — the wrap is invisible
 *    because `heightAt()` wraps for us. (The original did the same; it also
 *    kept its software renderer from drawing a whole world every frame.)
 *
 * 2. THE LOOK. Vertices carry colors picked from height + slope (beach near
 *    sea level, grass on flats, rock on steeps, snow on peaks) with a
 *    per-tile dither so it reads as hand-painted rather than vector-smooth.
 *    A small custom shader does one-directional-light Lambert lighting and
 *    applies the curvature bend. That's the entire material system.
 *
 * Buffer strategy: positions/normals/colors are allocated once and refilled
 * in place (DynamicDrawUsage), triangle indices never change. A full refill
 * touches ~17k vertices — comfortably under a millisecond, so we don't
 * bother with partial updates until profiling says otherwise.
 */

import * as THREE from 'three';
import {
  COLOR_DEEP_SEAFLOOR,
  COLOR_GRASS_A,
  COLOR_GRASS_B,
  COLOR_ROCK,
  COLOR_SAND,
  COLOR_SNOW,
  COLOR_WET_SAND,
  TILE,
  VIEW_TILES,
} from '../config';
import { smoothstep } from '../core/util';
import { curvatureGlsl, curvatureUniforms } from './curvature';
import { Heightmap } from './heightmap';

// Pre-parsed palette (Color instances so we can lerp channels cheaply).
const DEEP = new THREE.Color(COLOR_DEEP_SEAFLOOR);
const WET_SAND = new THREE.Color(COLOR_WET_SAND);
const SAND = new THREE.Color(COLOR_SAND);
const GRASS_A = new THREE.Color(COLOR_GRASS_A);
const GRASS_B = new THREE.Color(COLOR_GRASS_B);
const ROCK = new THREE.Color(COLOR_ROCK);
const SNOW = new THREE.Color(COLOR_SNOW);

const VERTS = VIEW_TILES + 1; // vertices per side (fence posts vs fence panels)

export class TerrainMesh {
  readonly mesh: THREE.Mesh;

  private readonly positions: THREE.BufferAttribute;
  private readonly normals: THREE.BufferAttribute;
  private readonly colors: THREE.BufferAttribute;

  /** Window center, in whole tiles. */
  private offsetX = 0;
  private offsetZ = 0;
  /** Heightmap version we last uploaded — refill only when it changes. */
  private uploadedVersion = -1;

  // Scratch objects reused every refill — allocating ~17k of these per
  // frame while sculpting would hammer the garbage collector.
  private readonly scratchNormal = { x: 0, y: 0, z: 0 };
  private readonly scratchColor = new THREE.Color();

  constructor(private readonly map: Heightmap) {
    const geometry = new THREE.BufferGeometry();

    this.positions = new THREE.BufferAttribute(new Float32Array(VERTS * VERTS * 3), 3);
    this.normals = new THREE.BufferAttribute(new Float32Array(VERTS * VERTS * 3), 3);
    this.colors = new THREE.BufferAttribute(new Float32Array(VERTS * VERTS * 3), 3);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.normals.setUsage(THREE.DynamicDrawUsage);
    this.colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('normal', this.normals);
    geometry.setAttribute('color', this.colors);

    // Triangle indices: two triangles per grid cell. Built once — scrolling
    // and sculpting only ever move vertices, never re-stitch them.
    const indices = new Uint32Array(VIEW_TILES * VIEW_TILES * 6);
    let k = 0;
    for (let j = 0; j < VIEW_TILES; j++) {
      for (let i = 0; i < VIEW_TILES; i++) {
        const a = j * VERTS + i;
        const b = a + 1;
        const c = a + VERTS;
        const d = c + 1;
        indices[k++] = a; indices[k++] = c; indices[k++] = b;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...curvatureUniforms, // shared objects — main.ts updates them once for all materials
        uLightDir: { value: new THREE.Vector3(0.55, 0.75, 0.35).normalize() },
        uLightColor: { value: new THREE.Color(1.0, 0.96, 0.88) }, // warm sun
        uAmbient: { value: new THREE.Color(0.42, 0.46, 0.52) }, // cool sky fill
      },
      vertexColors: true, // makes three declare the `color` attribute for us
      vertexShader: /* glsl */ `
        ${curvatureGlsl}
        varying vec3 vColor;
        varying vec3 vNormal;
        void main() {
          vColor = color;
          vNormal = normal; // terrain mesh never rotates, so no normal matrix needed
          vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(applyCurvature(worldPos), 1.0);
        }
      `,
      // Lambert diffuse: brightness = how squarely the surface faces the sun.
      // We light in display color space directly (no linear-space pipeline,
      // no tone mapping) — technically naive, authentically 1998, and it
      // keeps the palette in config.ts WYSIWYG.
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying vec3 vNormal;
        uniform vec3 uLightDir;
        uniform vec3 uLightColor;
        uniform vec3 uAmbient;
        void main() {
          float diffuse = max(dot(normalize(vNormal), uLightDir), 0.0);
          gl_FragColor = vec4(vColor * (uAmbient + uLightColor * diffuse), 1.0);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    // The shader moves vertices downward after culling math is done, so
    // tell three to never frustum-cull the terrain by its (uncurved) bounds.
    this.mesh.frustumCulled = false;

    this.refill();
  }

  /**
   * Called once per frame: recenter the window on the camera target and
   * refill vertex data if anything (position or terrain) changed.
   */
  sync(camTargetWorld: THREE.Vector3): void {
    const ox = Math.round(camTargetWorld.x / TILE);
    const oz = Math.round(camTargetWorld.z / TILE);
    if (ox !== this.offsetX || oz !== this.offsetZ || this.map.version !== this.uploadedVersion) {
      this.offsetX = ox;
      this.offsetZ = oz;
      this.refill();
    }
  }

  /** Rewrite every vertex's position, normal and color from the heightmap. */
  private refill(): void {
    const half = VIEW_TILES / 2;
    const pos = this.positions.array as Float32Array;
    const nrm = this.normals.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const n = this.scratchNormal;

    let k = 0;
    for (let j = 0; j < VERTS; j++) {
      const wz = this.offsetZ + j - half; // world tile coords (unwrapped —
      for (let i = 0; i < VERTS; i++) {
        const wx = this.offsetX + i - half; // heightAt() wraps internally)
        const h = this.map.heightAt(wx, wz);

        pos[k] = wx * TILE;
        pos[k + 1] = h;
        pos[k + 2] = wz * TILE;

        this.map.normalAt(wx, wz, n);
        nrm[k] = n.x;
        nrm[k + 1] = n.y;
        nrm[k + 2] = n.z;

        this.pickColor(h, n.y, this.map.jitterAt(wx, wz), this.scratchColor);
        col[k] = this.scratchColor.r;
        col[k + 1] = this.scratchColor.g;
        col[k + 2] = this.scratchColor.b;

        k += 3;
      }
    }

    this.positions.needsUpdate = true;
    this.normals.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.uploadedVersion = this.map.version;
  }

  /**
   * The "texture" of the world, as a function: height + slope + a stable
   * per-tile jitter → color. Bands blend with smoothstep so coastlines and
   * snowlines feather instead of striping.
   */
  private pickColor(h: number, slopeY: number, jitter: number, out: THREE.Color): void {
    if (h < 0) {
      // Seafloor, seen through the translucent water: wet sand shading into
      // murky green as it deepens.
      out.copy(WET_SAND).lerp(DEEP, smoothstep(0, -6, h));
    } else {
      // Two grass tones dithered per tile — the cheapest possible "painted
      // texture". From a distance it reads as brushwork.
      out.copy(GRASS_A).lerp(GRASS_B, jitter);
      // Beach near sea level...
      out.lerp(SAND, smoothstep(1.8, 0.4, h));
      // ...rock where the ground tips past ~40° (slopeY is the normal's
      // up-ness: 1 = flat, lower = steeper)...
      out.lerp(ROCK, smoothstep(0.88, 0.72, slopeY));
      // ...snow on the peaks.
      out.lerp(SNOW, smoothstep(12, 15.5, h));
    }
    // ±6% brightness jitter breaks up flat-shaded banding everywhere.
    const v = 0.94 + 0.12 * jitter;
    out.multiplyScalar(v);
  }

  /** Convert a point in world units to fractional tile coordinates. */
  static worldToTile(p: THREE.Vector3): { x: number; z: number } {
    return { x: p.x / TILE, z: p.z / TILE };
  }
}
