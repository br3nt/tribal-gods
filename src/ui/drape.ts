/**
 * ui/drape.ts — flat shapes laid over the terrain: rings, discs, bands, tiles.
 *
 * Aiming reticles, range rings, line previews and building footprints are
 * all "paint on the ground". WebGL lines are always 1px (unreadable over
 * bright grass), so instead we build thin TRIANGLE ribbons, every vertex
 * sampled from the heightmap and dropped by the planet's curvature (via
 * ui/project.ts worldPoint), so the shape hugs hills and bends over the
 * horizon exactly like the ground beneath it.
 *
 * A Drape is one mesh with a preallocated vertex buffer: each frame you
 * begin(), add shapes, end() — no allocation, one draw call. Vertex colours
 * let one Drape mix green and red tiles. depthTest is off on purpose: the
 * marks are UI, and must read through a hill that hides the ground.
 *
 * The mesh sits at the origin with world-space vertices, which is also how
 * main.ts's limb pass (applyLimbToCpuCurved) knows to leave it alone.
 */

import * as THREE from 'three';
import { View, worldPoint } from './project';

const LIFT = 0.18;
const p = new THREE.Vector3();

export class Drape {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private n = 0;
  private readonly max: number;
  private readonly c = new THREE.Color();

  /**
   * `onGround`: depth-tested (with a polygon offset so it never fights the
   * terrain) — paint that lies UNDER what stands on it, people and stones
   * drawn over it, like the drag area. Default off: reticles read through hills.
   */
  constructor(scene: THREE.Scene, opacity: number, maxTriangles = 6000, renderOrder = 20, onGround = false) {
    this.max = maxTriangles * 3;
    this.pos = new Float32Array(this.max * 3);
    this.col = new Float32Array(this.max * 3);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      depthTest: onGround,
      depthWrite: false,
      polygonOffset: onGround,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  begin(color: number): void {
    this.n = 0;
    this.c.setHex(color);
  }

  color(hex: number): void {
    this.c.setHex(hex);
  }

  end(): void {
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, this.n);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  private vert(view: View, x: number, z: number): void {
    if (this.n >= this.max) return;
    worldPoint(view, x, z, LIFT, p);
    const i = this.n * 3;
    this.pos[i] = p.x;
    this.pos[i + 1] = p.y;
    this.pos[i + 2] = p.z;
    this.col[i] = this.c.r;
    this.col[i + 1] = this.c.g;
    this.col[i + 2] = this.c.b;
    this.n++;
  }

  /** Quad from 4 tile-space corners (in order around the edge). */
  quad(view: View, ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): void {
    this.vert(view, ax, az);
    this.vert(view, bx, bz);
    this.vert(view, cx, cz);
    this.vert(view, ax, az);
    this.vert(view, cx, cz);
    this.vert(view, dx, dz);
  }

  /** A ring band between radii r0 < r1 (tiles). `dash` > 0 leaves gaps. */
  ring(view: View, cx: number, cz: number, r0: number, r1: number, dash = 0): void {
    const seg = Math.max(24, Math.min(160, Math.round(r1 * 10)));
    for (let s = 0; s < seg; s++) {
      if (dash > 0 && Math.floor(s / dash) % 2 === 1) continue;
      const a0 = (s / seg) * Math.PI * 2;
      const a1 = ((s + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.quad(view, cx + c0 * r0, cz + s0 * r0, cx + c0 * r1, cz + s0 * r1, cx + c1 * r1, cz + s1 * r1, cx + c1 * r0, cz + s1 * r0);
    }
  }

  /** A filled disc, built as concentric bands so it drapes over bumps. */
  disc(view: View, cx: number, cz: number, r: number): void {
    const bands = Math.max(2, Math.ceil(r / 1.5));
    for (let b = 0; b < bands; b++) this.ring(view, cx, cz, (b / bands) * r, ((b + 1) / bands) * r);
  }

  /** A band of half-width `hw` from A to B (tiles), subdivided to drape. */
  band(view: View, ax: number, az: number, bx: number, bz: number, hw: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    const nx = (-dz / len) * hw;
    const nz = (dx / len) * hw;
    const steps = Math.max(1, Math.ceil(len / 0.75));
    const across = Math.max(1, Math.ceil((hw * 2) / 1.5));
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      for (let j = 0; j < across; j++) {
        const u0 = -1 + (2 * j) / across, u1 = -1 + (2 * (j + 1)) / across;
        const P = (t: number, u: number): [number, number] => [ax + dx * t + nx * u, az + dz * t + nz * u];
        const [a, b] = P(t0, u0), [c, d] = P(t1, u0), [e, f] = P(t1, u1), [g, k] = P(t0, u1);
        this.quad(view, a, b, c, d, e, f, g, k);
      }
    }
  }

  /** Outline of a band (two edges), for crisp line previews. */
  bandEdges(view: View, ax: number, az: number, bx: number, bz: number, hw: number, w: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    const nx = -dz / len, nz = dx / len;
    for (const side of [-1, 1]) {
      const o0 = side * hw, o1 = side * (hw - w);
      this.band(view, ax + nx * (o0 + o1) / 2, az + nz * (o0 + o1) / 2, bx + nx * (o0 + o1) / 2, bz + nz * (o0 + o1) / 2, w / 2);
    }
  }

  /** One tile's square (centred on integer tile coords), inset a little. */
  tile(view: View, x: number, z: number, inset = 0.08): void {
    const a = 0.5 - inset;
    this.quad(view, x - a, z - a, x + a, z - a, x + a, z + a, x - a, z + a);
  }
}
