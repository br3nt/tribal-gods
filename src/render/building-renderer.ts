/**
 * render/building-renderer.ts — sim buildings → models that rise, wear and burn.
 *
 * Same create/destroy-by-id pattern as units: each sim Building gets a
 * BuildingModel (assets/models/buildings), anchored at the wrapped image
 * nearest the camera at its TRUE (unbent) world position; every vertex is
 * then bent on the GPU exactly like the ground under it (curveObject), so
 * the line where a building meets the ground is the same from every camera
 * position. Every frame the
 * model is told its construction progress, health and fire state; it
 * decides what to draw (reveal line, scaffold, rubble) and which emitters
 * should run, and this renderer turns those into smoke and flame particles.
 *
 * MEETING THE GROUND. A building stands on the HIGHEST drawn ground under
 * its footprint (world/surface.ts — the terrain's own bicubic filter), on a
 * foundation terrace whose walls reach below the lowest; its plot (stakes,
 * dug earth) and rubble are draped over the real ground. Recomputed when the
 * heightmap changes (builders levelling the site, spells).
 *
 * Also here: each tribe's home circle (totem) at tribes[t].home and the
 * monuments (standing stones), lit while they still hold a spell.
 *
 * Sim fields read: b.tier (dwelling tier 0..2), b.maxHp, b.burning
 * (seconds left), monument.mode / .claimedBy / .sleep, world.activeTribes().
 */

import * as THREE from 'three';
import { CIVS, TILE, WORLD_SIZE } from '../config';
import { curveObject } from '../world/curvature';
import { footprintRange, surfaceHeight } from '../world/surface';
import { clearWear, setWear } from '../world/wear';
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
  /** map.version the ground fit was last computed for. */
  groundVer: number;
  base: number;
}

/**
 * Building id → the height its model stands at (top of its foundation).
 * The unit renderer reads it to stand tower lookouts and shrine
 * worshippers on the model rather than on the sim's centre-tile height.
 */
export const buildingBaseY = new Map<number, number>();

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
        curveObject(built.root);
        t = { ...built, civ: civ.id };
        this.scene.add(t.root);
        this.totems.set(id, t);
      }
      const home = world.tribes[id]!.home;
      t.root.visible = this.anchor(t.root.position, home.x, home.z, surfaceHeight(world.map, home.x, home.z), camTarget);
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
      curveObject(m.root);
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
      model.root.visible = this.anchor(model.root.position, sim.x, sim.z, surfaceHeight(world.map, sim.x, sim.z), camTarget);
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
        curveObject(model.root);
        this.scene.add(model.root);
        e = { model, kind: b.kind, tribe: b.tribe, tier, groundVer: -1, base: 0 };
        this.entries.set(b.id, e);
      }
      if (e.groundVer !== world.map.version) this.fitGround(e, b, world);
      buildingBaseY.set(b.id, e.base);
      // the plot and the yard are trodden earth: no meadow grass through them
      setWear(`b:${b.id}`, { x: b.x, z: b.z, r: b.size / 2 + 0.35, round: false, k: 1 });
      const visible = this.anchor(e.model.root.position, b.x, b.z, e.base, camTarget);
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
        buildingBaseY.delete(id);
        clearWear(`b:${id}`);
      }
    }
    this.fx.update(dt);
  }

  /** Stand the model on the drawn ground under its footprint (see header). */
  private fitGround(e: Entry, b: { x: number; z: number; size: number }, world: World): void {
    const map = world.map;
    const r = footprintRange(map, b.x, b.z, b.size / 2);
    // Cut and fill: the platform sits most of the way up the slope — the
    // uphill edge is cut a little into the bank, the downhill side is a
    // retaining wall reaching below the lowest ground. On level ground it
    // sits a hair proud of the turf.
    e.base = r.lo + 0.7 * (r.hi - r.lo) + 0.04;
    e.groundVer = map.version;
    e.model.setGround(e.base, r.lo, (lx, lz) => surfaceHeight(map, b.x + lx / TILE, b.z + lz / TILE));
  }

  private remove(e: Entry): void {
    this.scene.remove(e.model.root);
    this.fx.smoke.forget(e.model.root);
    this.fx.fire.forget(e.model.root);
    e.model.dispose();
  }

  /**
   * Wrapped-anchor placement at height y, UNBENT (the GPU bends every
   * vertex). Returns false when over the horizon.
   */
  private anchor(pos: THREE.Vector3, tileX: number, tileZ: number, y: number, camTarget: THREE.Vector3): boolean {
    const relX = wrapDelta(tileX * TILE - camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(tileZ * TILE - camTarget.z, WORLD_UNITS);
    const d2 = relX * relX + relZ * relZ;
    pos.set(camTarget.x + relX, y, camTarget.z + relZ);
    return d2 < VIEW_RADIUS * VIEW_RADIUS;
  }
}
