/**
 * render/tree-renderer.ts — forests and ground cover, instanced.
 *
 * Trees are sim data (world.trees: position, alive, regrow, burning).
 * Each tree is one INSTANCE of its species-variant mesh (assets/models/
 * flora.ts), so the whole planet's flora is a dozen draw calls. Every frame
 * we re-anchor the visible instances near the camera (wrap + curvature,
 * like units), pack them into the front of each InstancedMesh and set the
 * draw count — distance culling for free.
 *
 * Life cycle per tree:
 *   alive            → standing, wind-swayed (in the shader)
 *   alive → felled   → topples over (~1.3 s) and sinks away; a stump stays
 *   stump → regrown  → grows back from a sapling with a little overshoot
 *   burning          → flames and smoke from the canopy, charred tint
 *
 * Cosmetic ground cover — rocks and bushes (grass is world/ground-cover.ts) — is
 * scattered deterministically by tile hash on dry land, kept clear of
 * buildings, and follows the terrain as gods reshape it. It has no
 * gameplay meaning at all.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { curvatureDrop } from '../world/curvature';
import { hash2 } from '../core/noise';
import { wrapDelta } from '../core/util';
import {
  bushGeometry, rockGeometry, Species, SPECIES, stumpGeometry, treeGeometry, VARIANTS_PER_SPECIES,
} from '../assets/models/flora';
import { sharedMaterials } from '../assets/models/materials';
import { World } from '../sim/world-state';
import { ModelFx } from './model-particles';

const WORLD_UNITS = WORLD_SIZE * TILE;
const VIEW_RADIUS = 150;
const COVER_RADIUS = 95;

interface TreeState {
  species: number; // index into meshes
  scale: number;
  yaw: number;
  wasAlive: boolean;
  /** Seconds since felled (topple), or since regrowth started. */
  fall: number;
  grow: number;
  tint: THREE.Color;
}

interface Cover {
  mesh: THREE.InstancedMesh;
  tiles: Array<{ x: number; z: number; s: number; yaw: number }>;
}

/** Palms on low coastal land, conifers up high and toward the poles, broadleaf between. */
function pickSpecies(world: World, x: number, z: number): Species {
  const h = world.map.heightAt(x, z);
  const lat = Math.abs(Math.sin((z / WORLD_SIZE) * Math.PI * 2)); // two "polar" bands on the torus
  const r = hash2(x, z, 7);
  if (h < 1.6 && r < 0.75) return 'palm';
  if (h > 7 || (lat > 0.75 && r < 0.8) || r < 0.15) return 'conifer';
  return 'broadleaf';
}

export class TreeRenderer {
  private meshes: THREE.InstancedMesh[] = [];
  private stumps: THREE.InstancedMesh;
  private states: TreeState[] = [];
  private covers: Cover[] = [];
  private readonly fx: ModelFx;
  private readonly fireAnchors = new Map<number, THREE.Object3D>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private last = performance.now();
  private coverKey = '';
  private readonly maxTrees = 2400;

  constructor(private readonly scene: THREE.Scene) {
    const mats = sharedMaterials();
    for (const sp of SPECIES) {
      for (let v = 0; v < VARIANTS_PER_SPECIES; v++) {
        const im = new THREE.InstancedMesh(treeGeometry(sp, v), mats.foliage, this.maxTrees);
        im.castShadow = im.receiveShadow = true;
        im.frustumCulled = false;
        im.count = 0;
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxTrees * 3).fill(1), 3);
        scene.add(im);
        this.meshes.push(im);
      }
    }
    this.stumps = new THREE.InstancedMesh(stumpGeometry(), mats.bark, this.maxTrees);
    this.stumps.castShadow = this.stumps.receiveShadow = true;
    this.stumps.frustumCulled = false;
    this.stumps.count = 0;
    scene.add(this.stumps);
    this.fx = new ModelFx(scene);
    const covers: Array<[THREE.BufferGeometry, THREE.Material, boolean]> = [
      [rockGeometry(0), mats.bark, true], [rockGeometry(1), mats.bark, true],
      [bushGeometry(0), mats.foliage, true], [bushGeometry(1), mats.foliage, true], [bushGeometry(2), mats.foliage, true],
    ];
    // (Grass and flowers are the LOOK stream's GPU ground cover — world/ground-cover.ts.)
    for (const [g, mat, shadow] of covers) {
      const im = new THREE.InstancedMesh(g, mat, 1600);
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      scene.add(im);
      this.covers.push({ mesh: im, tiles: [] });
    }
  }

  /** Build visuals for the current world's tree list. Call after every world reset. */
  rebuild(world: World): void {
    this.states = world.trees.map((t, i) => this.stateFor(world, t.x, t.z, t.alive, i));
    this.scatterCover(world);
  }

  private stateFor(world: World, x: number, z: number, alive: boolean, i: number): TreeState {
    const sp = SPECIES.indexOf(pickSpecies(world, x, z));
    const v = Math.floor(hash2(x, z, 3) * VARIANTS_PER_SPECIES) % VARIANTS_PER_SPECIES;
    const r = hash2(x, z, 99);
    const tint = new THREE.Color().setHSL(0.0, 0, 0.88 + hash2(x, z, 5) * 0.2);
    void i;
    return { species: sp * VARIANTS_PER_SPECIES + v, scale: 0.85 + r * 0.4, yaw: r * Math.PI * 2, wasAlive: alive, fall: 99, grow: 99, tint };
  }

  /** Deterministic ground cover on dry, gentle land. */
  private scatterCover(_world: World): void {
    for (const c of this.covers) c.tiles = [];
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const r = hash2(x, z, 41);
        let k = -1;
        if (r < 0.012) k = hash2(x, z, 42) < 0.5 ? 0 : 1;
        else if (r < 0.04) k = 2 + Math.floor(hash2(x, z, 43) * 3);
        if (k < 0) continue;
        this.covers[k].tiles.push({
          x: x + (hash2(x, z, 45) - 0.5) * 0.8,
          z: z + (hash2(x, z, 46) - 0.5) * 0.8,
          s: 0.7 + hash2(x, z, 47) * 0.7,
          yaw: hash2(x, z, 48) * 6.28,
        });
      }
    }
    this.coverKey = '';
  }

  /** Re-anchor every tree relative to the camera. Called once per frame. */
  sync(world: World, camTarget: THREE.Vector3): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.states.length !== world.trees.length) {
      // Bloom sprouts new trees: keep existing states, add the newcomers.
      for (let i = this.states.length; i < world.trees.length; i++) {
        const t = world.trees[i];
        const st = this.stateFor(world, t.x, t.z, t.alive, i);
        st.grow = 0;
        this.states.push(st);
      }
      this.states.length = world.trees.length;
    }
    const counts = new Array(this.meshes.length).fill(0);
    const burningNow = new Set<number>();
    let stumps = 0;
    for (let i = 0; i < world.trees.length; i++) {
      const t = world.trees[i] as typeof world.trees[number] & { burning?: number };
      const st = this.states[i];
      if (t.alive && !st.wasAlive) st.grow = 0;
      if (!t.alive && st.wasAlive) st.fall = 0;
      st.wasAlive = t.alive;
      st.fall += dt;
      st.grow += dt;
      const relX = wrapDelta(t.x * TILE - camTarget.x, WORLD_UNITS);
      const relZ = wrapDelta(t.z * TILE - camTarget.z, WORLD_UNITS);
      const d2 = relX * relX + relZ * relZ;
      if (d2 > VIEW_RADIUS * VIEW_RADIUS) continue;
      const y = world.map.heightAt(t.x, t.z) - curvatureDrop(relX, relZ);
      this.p.set(camTarget.x + relX, y, camTarget.z + relZ);
      const showTree = t.alive || st.fall < 2.2;
      if (!t.alive || st.grow < 4) {
        if (stumps < this.maxTrees && !(t.alive && st.grow > 1.5)) {
          this.e.set(0, st.yaw, 0);
          this.q.setFromEuler(this.e);
          this.m.compose(this.p, this.q, this.s.setScalar(st.scale));
          this.stumps.setMatrixAt(stumps++, this.m);
        }
      }
      if (!showTree) continue;
      let scale = st.scale;
      let tilt = 0;
      let sink = 0;
      if (!t.alive) {
        // topple: accelerate like a falling mast, then sink away
        const f = Math.min(1, st.fall / 1.3);
        tilt = f * f * (Math.PI / 2 - 0.08);
        sink = Math.max(0, st.fall - 1.4) * 1.5;
      } else if (st.grow < 3) {
        const g = st.grow / 3;
        scale *= 0.2 + 0.8 * (1 + 0.12 * Math.sin(g * Math.PI)) * g ** 0.7; // sapling → tree with a little overshoot
      }
      this.e.set(tilt, st.yaw, 0, 'YXZ');
      this.q.setFromEuler(this.e);
      this.p.y -= sink;
      this.m.compose(this.p, this.q, this.s.setScalar(scale));
      const im = this.meshes[st.species];
      if (counts[st.species] >= this.maxTrees) continue;
      const n = counts[st.species]++;
      im.setMatrixAt(n, this.m);
      const burning = (t.burning ?? 0) > 0;
      im.setColorAt(n, burning ? CHARRED : st.tint);
      if (burning) {
        let a = this.fireAnchors.get(i);
        if (!a) {
          a = new THREE.Object3D();
          a.userData.gpuCurved = true; // we already applied the full drop
          this.scene.add(a);
          this.fireAnchors.set(i, a);
        }
        a.position.copy(this.p).setY(this.p.y + 3.5 * scale);
        a.updateMatrixWorld();
        burningNow.add(i);
        this.fx.building(a, { smoke: [], flames: [], fire: [ZERO], emit: { smoke: false, fire: true, flames: false, hurt: 0 } }, dt * 0.35);
      }
    }
    this.meshes.forEach((im, k) => {
      im.count = counts[k];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
    for (const [i, a] of this.fireAnchors) {
      if (!burningNow.has(i)) {
        this.scene.remove(a);
        this.fireAnchors.delete(i);
      }
    }
    this.stumps.count = stumps;
    this.stumps.instanceMatrix.needsUpdate = true;
    this.syncCover(world, camTarget);
    this.fx.update(dt);
  }

  private syncCover(world: World, camTarget: THREE.Vector3): void {
    const key = `${camTarget.x.toFixed(2)},${camTarget.z.toFixed(2)},${(world.map as unknown as { version?: number }).version ?? 0},${world.buildings.length}`;
    if (key === this.coverKey) return;
    this.coverKey = key;
    // tiles covered by buildings stay clear
    const blocked = new Set<number>();
    for (const b of world.buildings) {
      const half = Math.floor(((b as unknown as { size?: number }).size ?? 3) / 2) + 1;
      for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
        blocked.add((((b.z + dz) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE) * WORLD_SIZE + (((b.x + dx) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE));
      }
    }
    for (const c of this.covers) {
      let n = 0;
      for (const t of c.tiles) {
        const relX = wrapDelta(t.x * TILE - camTarget.x, WORLD_UNITS);
        const relZ = wrapDelta(t.z * TILE - camTarget.z, WORLD_UNITS);
        const d2 = relX * relX + relZ * relZ;
        if (d2 > COVER_RADIUS * COVER_RADIUS) continue;
        if (blocked.has(Math.round(t.z) * WORLD_SIZE + Math.round(t.x))) continue;
        const h = world.map.sampleHeight(t.x, t.z);
        if (h < 0.35) continue;
        this.e.set(0, t.yaw, 0);
        this.q.setFromEuler(this.e);
        this.p.set(camTarget.x + relX, h - curvatureDrop(relX, relZ) - 0.05, camTarget.z + relZ);
        this.m.compose(this.p, this.q, this.s.setScalar(t.s));
        c.mesh.setMatrixAt(n++, this.m);
        if (n >= 1600) break;
      }
      c.mesh.count = n;
      c.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const ZERO = new THREE.Vector3();
const CHARRED = new THREE.Color(0.35, 0.3, 0.28);
