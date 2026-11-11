/**
 * render/tree-renderer.ts — forests and ground cover, instanced.
 *
 * Trees are sim data (world.trees: position, alive, regrow, burning).
 * Each tree is one INSTANCE of its species-variant mesh (assets/models/
 * flora.ts), so the whole planet's flora is a dozen draw calls. Every frame
 * we re-anchor the visible instances near the camera (wrapped to the image
 * nearest the camera, at their TRUE unbent position — the GPU bends every
 * vertex like the ground, see curveObject), pack them into the front of
 * each InstancedMesh and set the draw count — distance culling for free.
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
 *
 * SCALE AROUND HOMES: people are ~2.3 units tall, so a full-grown tree
 * (5–7 units) or a boulder next to a hut would hide the village. Flora
 * near a tribe's home circle or a building is drawn smaller (trees) or
 * thinned out (bushes, rocks); the wild forests further out stay full
 * size. See `nearFactor`.
 */

import * as THREE from 'three';
import { TILE, WORLD_SIZE } from '../config';
import { curveObject } from '../world/curvature';
import { surfaceHeight } from '../world/surface';
import { hash2 } from '../core/noise';
import { wrapDelta } from '../core/util';
import {
  bushGeometry, rockGeometry, Species, SPECIES, stumpGeometry, treeGeometry, VARIANTS_PER_SPECIES,
} from '../assets/models/flora';
import { sharedMaterials } from '../assets/models/materials';
import { World } from '../sim/world-state';
import { ModelFx } from './model-particles';
import { isHighlighted } from './highlight';
import { HIGHLIGHT } from './look';

const WORLD_UNITS = WORLD_SIZE * TILE;
const VIEW_RADIUS = 150;
const COVER_RADIUS = 95;

interface TreeState {
  species: number; // index into meshes
  scale: number;
  yaw: number;
  wasAlive: boolean;
  /** 0 right beside a home/building … 1 out in the wild (see nearFactor). */
  near: number;
  /** Seconds since felled (topple), or since regrowth started. */
  fall: number;
  grow: number;
  tint: THREE.Color;
}

interface Cover {
  mesh: THREE.InstancedMesh;
  rock: boolean;
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
  /** world.treesVersion the states were last indexed against. */
  private treesVersion = -1;
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
  private nearKey = '';
  private readonly maxTrees = 2400;
  /** Reused every frame (no per-frame allocation). */
  private readonly counts: number[] = [];
  private readonly burningNow = new Set<number>();
  private readonly blocked = new Set<number>();
  /** Homes and buildings flora should give way to: tile x, z and clear radius. */
  private readonly clearings: Array<{ x: number; z: number; r: number }> = [];
  private lastCamX = NaN;
  private lastCamZ = NaN;
  private lastMapVersion = -1;
  private lastBuildings = -1;

  constructor(private readonly scene: THREE.Scene) {
    const mats = sharedMaterials();
    for (const sp of SPECIES) {
      for (let v = 0; v < VARIANTS_PER_SPECIES; v++) {
        const im = new THREE.InstancedMesh(treeGeometry(sp, v), mats.foliage, this.maxTrees);
        im.castShadow = im.receiveShadow = true;
        im.frustumCulled = false;
        im.count = 0;
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxTrees * 3).fill(1), 3);
        curveObject(im);
        scene.add(im);
        this.meshes.push(im);
      }
    }
    this.stumps = new THREE.InstancedMesh(stumpGeometry(), mats.bark, this.maxTrees);
    this.stumps.castShadow = this.stumps.receiveShadow = true;
    this.stumps.frustumCulled = false;
    this.stumps.count = 0;
    curveObject(this.stumps);
    scene.add(this.stumps);
    this.fx = new ModelFx(scene);
    const covers: Array<[THREE.BufferGeometry, THREE.Material, boolean]> = [
      [rockGeometry(0), mats.bark, true], [rockGeometry(1), mats.bark, true],
      [bushGeometry(0), mats.foliage, true], [bushGeometry(1), mats.foliage, true], [bushGeometry(2), mats.foliage, true],
    ];
    // (Grass and flowers are the LOOK stream's GPU ground cover — world/ground-cover.ts.)
    for (const [g, mat, shadow] of covers) {
      const rock = mat === mats.bark;
      const im = new THREE.InstancedMesh(g, mat, 1600);
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.count = 0;
      curveObject(im);
      scene.add(im);
      this.covers.push({ mesh: im, rock, tiles: [] });
    }
  }

  /** Build visuals for the current world's tree list. Call after every world reset. */
  rebuild(world: World): void {
    this.states = world.trees.map((t, i) => this.stateFor(world, t.x, t.z, t.alive, i));
    this.treesVersion = world.treesVersion;
    this.scatterCover(world);
  }

  private stateFor(world: World, x: number, z: number, alive: boolean, i: number): TreeState {
    const sp = SPECIES.indexOf(pickSpecies(world, x, z));
    const v = Math.floor(hash2(x, z, 3) * VARIANTS_PER_SPECIES) % VARIANTS_PER_SPECIES;
    const r = hash2(x, z, 99);
    const tint = new THREE.Color().setHSL(0.0, 0, 0.88 + hash2(x, z, 5) * 0.2);
    void i;
    return { species: sp * VARIANTS_PER_SPECIES + v, scale: 0.8 + r * 0.36, yaw: r * Math.PI * 2, wasAlive: alive, near: 1, fall: 99, grow: 99, tint };
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
          s: (k < 2 ? 0.5 : 0.55) + hash2(x, z, 47) * 0.45,
          yaw: hash2(x, z, 48) * 6.28,
        });
      }
    }
    this.coverKey = '';
    this.nearKey = '';
  }

  /** Re-anchor every tree relative to the camera. Called once per frame. */
  sync(world: World, camTarget: THREE.Vector3): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.states.length > world.trees.length || (world.treesVersion !== this.treesVersion && this.states.length === world.trees.length)) {
      // Trees were REMOVED (the editor's eraser): per-tree state is indexed by
      // position in world.trees, so every later tree shifted down one. Re-index
      // from scratch (state is a pure function of the tree's position) so no
      // tree changes species or size.
      this.states = world.trees.map((t, i) => this.stateFor(world, t.x, t.z, t.alive, i));
      this.nearKey = '';
    } else if (this.states.length !== world.trees.length) {
      // Bloom sprouts new trees: keep existing states, add the newcomers.
      for (let i = this.states.length; i < world.trees.length; i++) {
        const t = world.trees[i];
        const st = this.stateFor(world, t.x, t.z, t.alive, i);
        st.grow = 0;
        this.states.push(st);
      }
      this.states.length = world.trees.length;
      this.nearKey = '';
    }
    this.treesVersion = world.treesVersion;
    this.updateClearings(world);
    const counts = this.counts;
    counts.length = this.meshes.length;
    counts.fill(0);
    const burningNow = this.burningNow;
    burningNow.clear();
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
      const y = world.map.heightAt(t.x, t.z); // trees stand on whole tiles: exactly the drawn surface
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
      let scale = st.scale * (0.6 + 0.4 * st.near);
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
      const c = burning ? CHARRED : st.tint;
      im.setColorAt(n, isHighlighted('tree', i) ? _lit.copy(c).multiplyScalar(HIGHLIGHT.treeBoost) : c);
      if (burning) {
        let a = this.fireAnchors.get(i);
        if (!a) {
          a = new THREE.Object3D();
          a.userData.gpuCurved = true; // unbent anchor: its particles bend on the GPU
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

  /**
   * Recompute each tree's `near` factor when homes or buildings change.
   * A clearing is a tribe's home circle (radius 9 tiles) or a building
   * (its footprint + 4); flora scales up smoothly from inside it.
   */
  private updateClearings(world: World): void {
    const tribes = Object.values(world.tribes);
    let key = `${world.buildings.length}|${world.trees.length}`;
    for (const t of tribes) if (t) key += `|${t.home.x},${t.home.z}`;
    if (key === this.nearKey) return;
    this.nearKey = key;
    this.coverKey = ''; // cover thins around the new clearings too
    const cl = this.clearings;
    cl.length = 0;
    for (const t of tribes) if (t) cl.push({ x: t.home.x, z: t.home.z, r: 9 });
    for (const b of world.buildings) cl.push({ x: b.x, z: b.z, r: b.size / 2 + 4 });
    for (let i = 0; i < world.trees.length; i++) {
      const t = world.trees[i];
      this.states[i].near = nearFactor(cl, t.x, t.z);
    }
  }

  private syncCover(world: World, camTarget: THREE.Vector3): void {
    // Only when something moved: the camera, the land, or the buildings.
    const ver = world.map.version;
    if (
      Math.abs(camTarget.x - this.lastCamX) < 0.005 && Math.abs(camTarget.z - this.lastCamZ) < 0.005 &&
      ver === this.lastMapVersion && world.buildings.length === this.lastBuildings && this.coverKey === 'ok'
    ) return;
    this.lastCamX = camTarget.x;
    this.lastCamZ = camTarget.z;
    this.lastMapVersion = ver;
    this.lastBuildings = world.buildings.length;
    this.coverKey = 'ok';
    // tiles covered by buildings stay clear
    const blocked = this.blocked;
    blocked.clear();
    for (const b of world.buildings) {
      const half = Math.floor(b.size / 2) + 1;
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
        const h = surfaceHeight(world.map, t.x, t.z);
        if (h < 0.35) continue;
        // villages stay readable: no boulders by the huts, bushes thinned and small
        const near = nearFactor(this.clearings, t.x, t.z);
        if (c.rock ? near < 0.75 : near < 0.35 || (near < 0.8 && (t.yaw * 7) % 1 < 0.5)) continue;
        this.e.set(0, t.yaw, 0);
        this.q.setFromEuler(this.e);
        this.p.set(camTarget.x + relX, h - 0.05, camTarget.z + relZ);
        this.m.compose(this.p, this.q, this.s.setScalar(t.s * (0.7 + 0.3 * near)));
        c.mesh.setMatrixAt(n++, this.m);
        if (n >= 1600) break;
      }
      c.mesh.count = n;
      c.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const ZERO = new THREE.Vector3();

/** 0 inside a clearing (home circle / around a building), easing to 1 in the wild. Wrap-aware. */
function nearFactor(cl: Array<{ x: number; z: number; r: number }>, x: number, z: number): number {
  let f = 1;
  for (const c of cl) {
    const dx = wrapDelta(x - c.x, WORLD_SIZE);
    const dz = wrapDelta(z - c.z, WORLD_SIZE);
    const d = Math.sqrt(dx * dx + dz * dz);
    const k = THREE.MathUtils.smoothstep(d, c.r * 0.55, c.r * 1.35);
    if (k < f) f = k;
  }
  return f;
}
const CHARRED = new THREE.Color(0.35, 0.3, 0.28);
const _lit = new THREE.Color();
