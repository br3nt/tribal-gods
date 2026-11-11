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
 * Sim fields read DEFENSIVELY: b.tier (dwelling tier 0..2), b.maxHp,
 * b.burning (seconds left, or boolean), monument.claimedBy / .sleep,
 * world.activeTribes().
 */

import * as THREE from 'three';
import { CIVS, TILE, WORLD_SIZE } from '../config';
import { curvatureDrop } from '../world/curvature';
import { wrapDelta } from '../core/util';
import { buildBuildingModel, BuildingModel } from '../assets/models/registry';
import { buildMonument, buildTotem } from '../assets/models/buildings/index';
import { BUILDINGS, BuildingKind, Tribe } from '../sim/catalog';
import { Building, World } from '../sim/world-state';
import { ModelFx } from './model-particles';

const WORLD_UNITS = WORLD_SIZE * TILE;
const VIEW_RADIUS = 160;

interface Entry {
  model: BuildingModel;
  kind: string;
  tribe: string;
  tier: number;
}

type AnyB = Building & Record<string, unknown>;

function civOf(world: World, tribe: string) {
  const t = (world.tribes as Record<string, { civ?: string } | undefined>)[tribe];
  return CIVS[(t?.civ ?? 'forest') as keyof typeof CIVS] ?? CIVS.forest;
}

function activeTribes(world: World): string[] {
  const w = world as unknown as { activeTribes?: () => string[] };
  if (typeof w.activeTribes === 'function') return w.activeTribes();
  return Object.keys(world.tribes).filter((k) => (world.tribes as Record<string, unknown>)[k]);
}

export class BuildingRenderer {
  private readonly entries = new Map<number, Entry>();
  private readonly totems = new Map<string, { root: THREE.Group; flames: THREE.Vector3[]; civ: string }>();
  private monuments: Array<ReturnType<typeof buildMonument>> = [];
  private readonly fx: ModelFx;
  private last = performance.now();

  constructor(private readonly scene: THREE.Scene) {
    this.fx = new ModelFx(scene);
  }

  sync(world: World, camTarget: THREE.Vector3): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;

    // Home circles, built lazily per active tribe.
    const active = new Set(activeTribes(world));
    for (const id of active) {
      const civ = civOf(world, id);
      let t = this.totems.get(id);
      if (t && t.civ !== civ.id) {
        this.scene.remove(t.root);
        t = undefined;
      }
      if (!t) {
        const built = buildTotem(id as Tribe, civ);
        t = { ...built, civ: civ.id };
        t.root.userData.gpuCurved = true; // full drop applied here (curvatureDrop)
        this.scene.add(t.root);
        this.totems.set(id, t);
      }
      const home = (world.tribes as Record<string, { home: { x: number; z: number } } | undefined>)[id]!.home;
      t.root.visible = this.anchor(t.root.position, home.x, home.z, world, camTarget);
      t.root.updateMatrixWorld();
      this.fx.building(t.root, { smoke: [], fire: [], flames: t.flames, emit: { smoke: false, fire: false, flames: true, hurt: 0 } }, dt);
    }
    for (const [id, t] of this.totems) {
      if (!active.has(id)) {
        this.scene.remove(t.root);
        this.totems.delete(id);
      }
    }

    // Monuments.
    while (this.monuments.length < world.monuments.length) {
      const m = buildMonument();
      m.root.userData.gpuCurved = true;
      this.scene.add(m.root);
      this.monuments.push(m);
    }
    while (this.monuments.length > world.monuments.length) this.scene.remove(this.monuments.pop()!.root);
    for (let i = 0; i < world.monuments.length; i++) {
      const sim = world.monuments[i] as unknown as { x: number; z: number; claimedBy: unknown; sleep?: number; mode?: string };
      const model = this.monuments[i];
      const dark = (sim.mode !== 'gift' && sim.claimedBy !== null && sim.claimedBy !== undefined) || (sim.sleep ?? 0) > 0;
      model.setClaimed(dark);
      model.root.visible = this.anchor(model.root.position, sim.x, sim.z, world, camTarget);
    }

    // Buildings.
    const live = new Set<number>();
    for (const raw of world.buildings) {
      const b = raw as AnyB;
      live.add(b.id);
      const tier = typeof b.tier === 'number' ? (b.tier as number) : 0;
      let e = this.entries.get(b.id);
      if (e && (e.kind !== b.kind || e.tribe !== b.tribe || (b.kind === 'hut' && e.tier !== tier))) {
        this.remove(e);
        this.entries.delete(b.id);
        e = undefined;
      }
      if (!e) {
        const model = buildBuildingModel(b.kind, b.tribe as Tribe, civOf(world, b.tribe), tier);
        // turn every model so its door faces the sim's door (south, +Z): already the case
        model.root.userData.gpuCurved = true;
        this.scene.add(model.root);
        e = { model, kind: b.kind, tribe: b.tribe, tier };
        this.entries.set(b.id, e);
      }
      const visible = this.anchor(e.model.root.position, b.x, b.z, world, camTarget);
      e.model.root.visible = visible;
      const maxHp = typeof b.maxHp === 'number' ? (b.maxHp as number) : BUILDINGS[b.kind as BuildingKind]?.hp ?? 40;
      const burning = typeof b.burning === 'number' ? (b.burning as number) > 0 : !!b.burning;
      e.model.update({ progress: b.progress, hpFrac: maxHp > 0 ? b.hp / maxHp : 1, burning, dt });
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
