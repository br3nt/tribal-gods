/**
 * render/building-renderer.ts — sim buildings → models that rise, wear and burn.
 *
 * Same create/destroy-by-id pattern as units: each sim Building gets a
 * BuildingModel (assets/models/buildings), anchored at the wrapped image
 * nearest the camera and dropped by the curvature term. Every frame the
 * model is told its construction progress, health and fire state; it
 * decides what to draw (reveal line, scaffold, rubble) and which emitters
 * should run, and this renderer turns those into smoke and flame particles.
 *
 * Also here: each tribe's home circle (totem) at tribes[t].home and the
 * monuments (standing stones), lit while they still hold a spell.
 *
 * Sim fields read: b.tier (dwelling tier 0..2), b.maxHp, b.burning
 * (seconds left), monument.mode / .claimedBy / .sleep, world.activeTribes().
 */

import * as THREE from 'three';
import { CIVS, TILE, WORLD_SIZE } from '../config';
import { curvatureDrop } from '../world/curvature';
import { wrapDelta } from '../core/util';
import { buildBuildingModel, BuildingModel } from '../assets/models/registry';
import { buildMonument, buildTotem } from '../assets/models/buildings/index';
import { TribeId } from '../sim/catalog';
import { World } from '../sim/world-state';
import { ModelFx } from './model-particles';

const WORLD_UNITS = WORLD_SIZE * TILE;
const VIEW_RADIUS = 160;

interface Entry {
  model: BuildingModel;
  kind: string;
  tribe: string;
  tier: number;
}

function civOf(world: World, tribe: TribeId) {
  return CIVS[world.tribes[tribe]?.civ ?? 'forest'];
}

export class BuildingRenderer {
  private readonly entries = new Map<number, Entry>();
  private readonly totems = new Map<TribeId, { root: THREE.Group; flames: THREE.Vector3[]; civ: string; dispose(): void }>();
  private monuments: Array<ReturnType<typeof buildMonument>> = [];
  private readonly fx: ModelFx;
  private last = performance.now();
  /** Reused every frame (no per-frame allocation). */
  private readonly active = new Set<TribeId>();
  private readonly live = new Set<number>();

  constructor(private readonly scene: THREE.Scene) {
    this.fx = new ModelFx(scene);
  }

  sync(world: World, camTarget: THREE.Vector3): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    // Home circles, built lazily per active tribe.
    const active = this.active;
    active.clear();
    for (const id of world.activeTribes()) active.add(id);
    for (const id of active) {
      const civ = civOf(world, id);
      let t = this.totems.get(id);
      if (t && t.civ !== civ.id) {
        this.scene.remove(t.root);
        t.dispose();
        t = undefined;
      }
      if (!t) {
        const built = buildTotem(id, civ);
        t = { ...built, civ: civ.id };
        this.scene.add(t.root);
        this.totems.set(id, t);
      }
      const home = world.tribes[id]!.home;
      t.root.visible = this.anchor(t.root.position, home.x, home.z, world, camTarget);
      t.root.updateMatrixWorld();
      this.fx.building(t.root, { smoke: [], fire: [], flames: t.flames, emit: { smoke: false, fire: false, flames: true, hurt: 0 } }, dt);
    }
    for (const [id, t] of this.totems) {
      if (!active.has(id)) {
        this.scene.remove(t.root);
        t.dispose();
        this.totems.delete(id);
      }
    }

    // Monuments.
    while (this.monuments.length < world.monuments.length) {
      const m = buildMonument();
      this.scene.add(m.root);
      this.monuments.push(m);
    }
    while (this.monuments.length > world.monuments.length) {
      const m = this.monuments.pop()!;
      this.scene.remove(m.root);
      m.dispose();
    }
    for (let i = 0; i < world.monuments.length; i++) {
      const sim = world.monuments[i];
      const model = this.monuments[i];
      const dark = (sim.mode !== 'gift' && sim.claimedBy !== null) || sim.sleep > 0;
      model.setClaimed(dark);
      model.root.visible = this.anchor(model.root.position, sim.x, sim.z, world, camTarget);
    }

    // Buildings.
    const live = this.live;
    live.clear();
    for (const b of world.buildings) {
      live.add(b.id);
      const tier = b.tier;
      let e = this.entries.get(b.id);
      if (e && (e.kind !== b.kind || e.tribe !== b.tribe || (b.kind === 'hut' && e.tier !== tier))) {
        this.remove(e);
        this.entries.delete(b.id);
        e = undefined;
      }
      if (!e) {
        const model = buildBuildingModel(b.kind, b.tribe, civOf(world, b.tribe), tier);
        // turn every model so its door faces the sim's door (south, +Z): already the case
        this.scene.add(model.root);
        e = { model, kind: b.kind, tribe: b.tribe, tier };
        this.entries.set(b.id, e);
      }
      const visible = this.anchor(e.model.root.position, b.x, b.z, world, camTarget);
      e.model.root.visible = visible;
      e.model.update({ progress: b.progress, hpFrac: b.maxHp > 0 ? b.hp / b.maxHp : 1, burning: b.burning > 0, dt });
      if (visible) {
        e.model.root.updateMatrixWorld();
        this.fx.building(e.model.root, e.model, dt);
      }
    }
    for (const [id, e] of this.entries) {
      if (!live.has(id)) {
        this.remove(e);
        this.entries.delete(id);
      }
    }
    this.fx.update(dt);
  }

  private remove(e: Entry): void {
    this.scene.remove(e.model.root);
    this.fx.smoke.forget(e.model.root);
    this.fx.fire.forget(e.model.root);
    e.model.dispose();
  }

  /** Wrapped-anchor + curvature-drop placement. Returns false when over the horizon. */
  private anchor(pos: THREE.Vector3, tileX: number, tileZ: number, world: World, camTarget: THREE.Vector3): boolean {
    const relX = wrapDelta(tileX * TILE - camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(tileZ * TILE - camTarget.z, WORLD_UNITS);
    const d2 = relX * relX + relZ * relZ;
    const y = world.map.heightAt(Math.round(tileX), Math.round(tileZ)) - curvatureDrop(relX, relZ);
    pos.set(camTarget.x + relX, y, camTarget.z + relZ);
    return d2 < VIEW_RADIUS * VIEW_RADIUS;
  }
}
