/**
 * render/building-renderer.ts — sim buildings → staged models on the planet.
 *
 * Follows the same pattern as units (create/destroy entries by id, anchor
 * at the wrapped image nearest the camera, drop by the curvature term) with
 * one addition: each frame we feed the building's construction progress to
 * its model, which shows the matching stage — stakes, rising walls, roof.
 *
 * The totem (village center marker) also lives here: it's not a Building
 * in the sim (it can't be built or destroyed), just a landmark rendered at
 * world.home.
 */

import * as THREE from 'three';
import { CIVS, CURVATURE, TILE, TRIBE_COLORS, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import {
  BuildingModel,
  buildFireHut,
  buildHut,
  buildMonument,
  buildTotem,
  buildTower,
  buildWarriorHut,
} from '../assets/models/buildings';
import { Building, TribeId, World } from '../sim/world-state';

const WORLD_UNITS = WORLD_SIZE * TILE;

function buildFor(b: Building, world: World): BuildingModel {
  const team = TRIBE_COLORS[b.tribe];
  const civ = CIVS[world.tribes[b.tribe].civ]; // architecture follows the builder's civ
  switch (b.kind) {
    case 'warriorHut': return buildWarriorHut(team, civ);
    case 'fireHut': return buildFireHut(team, civ);
    case 'tower': return buildTower(team);
    case 'hut': return buildHut(team, civ);
  }
}

export class BuildingRenderer {
  private readonly entries = new Map<number, BuildingModel>();
  private totems: Partial<Record<TribeId, THREE.Group>> = {};
  private monuments: Array<ReturnType<typeof buildMonument>> = [];

  constructor(private readonly scene: THREE.Scene) {}

  sync(world: World, camTarget: THREE.Vector3): void {
    // Each tribe's totem, built lazily, re-anchored every frame.
    for (const id of ['player', 'red'] as TribeId[]) {
      let totem = this.totems[id];
      if (!totem) {
        totem = buildTotem(TRIBE_COLORS[id]);
        this.scene.add(totem);
        this.totems[id] = totem;
      }
      const home = world.tribes[id].home;
      this.anchor(totem.position, home.x, home.z, world, camTarget);
    }

    // Monuments: one model per sim entry, eyes lit while unclaimed.
    while (this.monuments.length < world.monuments.length) {
      const m = buildMonument();
      this.scene.add(m.root);
      this.monuments.push(m);
    }
    for (let i = 0; i < world.monuments.length; i++) {
      const sim = world.monuments[i];
      const model = this.monuments[i];
      model.setClaimed(sim.claimedBy !== null);
      this.anchor(model.root.position, sim.x, sim.z, world, camTarget);
    }

    const live = new Set<number>();
    for (const b of world.buildings) {
      live.add(b.id);
      let model = this.entries.get(b.id);
      if (!model) {
        model = buildFor(b, world);
        this.scene.add(model.root);
        this.entries.set(b.id, model);
      }
      model.setProgress(b.progress);
      this.anchor(model.root.position, b.x, b.z, world, camTarget);
    }

    // Demolished/reset buildings lose their models.
    for (const [id, model] of this.entries) {
      if (!live.has(id)) {
        this.scene.remove(model.root);
        model.root.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        this.entries.delete(id);
      }
    }
  }

  /** Wrapped-anchor + curvature-drop placement, shared by totem and huts. */
  private anchor(
    pos: THREE.Vector3,
    tileX: number,
    tileZ: number,
    world: World,
    camTarget: THREE.Vector3,
  ): void {
    const relX = wrapDelta(tileX * TILE - camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(tileZ * TILE - camTarget.z, WORLD_UNITS);
    const y = world.map.heightAt(tileX, tileZ) - CURVATURE * (relX * relX + relZ * relZ);
    pos.set(camTarget.x + relX, y, camTarget.z + relZ);
  }
}
