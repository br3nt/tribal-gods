/**
 * render/tree-renderer.ts — the forests.
 *
 * Trees are sim data (a list of tile positions in world-state) so they can
 * be chopped for wood in Phase 3. Rendering them follows the unit pipeline
 * minus the animation: anchor each tree at its wrapped image nearest the
 * camera, drop it by the curvature term. No interpolation — trees famously
 * don't walk.
 *
 * Honest performance note: ~200 trees as individual Groups is a few hundred
 * draw calls, which any GPU shrugs at. When forests grow 10× (or units do),
 * the fix is THREE.InstancedMesh — one draw call for all trunks, one for
 * all canopies, per-instance matrices. Deliberately not done yet: the rule
 * in this codebase is that optimizations must be earned by a profiler.
 */

import * as THREE from 'three';
import { CURVATURE, TILE, WORLD_SIZE } from '../config';
import { hash2 } from '../core/noise';
import { wrapDelta } from '../core/util';
import { buildTree } from '../assets/models/figures';
import { World } from '../sim/world-state';

const WORLD_UNITS = WORLD_SIZE * TILE;

export class TreeRenderer {
  private groups: Array<{ g: THREE.Group; x: number; z: number }> = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** Build visuals for the current world's tree list. Call after every world reset. */
  rebuild(world: World): void {
    for (const t of this.groups) {
      this.scene.remove(t.g);
      t.g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.groups = [];
    for (const tree of world.trees) {
      const g = buildTree(hash2(tree.x, tree.z, 99)); // stable per-tile size/spin
      this.scene.add(g);
      this.groups.push({ g, x: tree.x, z: tree.z });
    }
  }

  /** Re-anchor every tree relative to the camera. Called once per frame. */
  sync(world: World, camTarget: THREE.Vector3): void {
    if (this.groups.length !== world.trees.length) this.rebuild(world); // Bloom sprouts new trees
    for (let i = 0; i < this.groups.length; i++) {
      const t = this.groups[i];
      // groups[] parallels world.trees[] — chopped trees simply vanish
      // (a falling animation is on the juice-pass wishlist).
      t.g.visible = world.trees[i]?.alive ?? false;
      if (!t.g.visible) continue;
      const relX = wrapDelta(t.x * TILE - camTarget.x, WORLD_UNITS);
      const relZ = wrapDelta(t.z * TILE - camTarget.z, WORLD_UNITS);
      const y =
        world.map.heightAt(t.x, t.z) - CURVATURE * (relX * relX + relZ * relZ);
      t.g.position.set(camTarget.x + relX, y, camTarget.z + relZ);
    }
  }
}
