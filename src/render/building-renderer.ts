/**
 * render/building-renderer.ts — sim buildings → models that rise, wear and burn.
 *
 * Same create/destroy-by-id pattern as units: each sim Building gets a
 * BuildingModel (assets/models/buildings), anchored at the wrapped image
 * nearest the camera at its TRUE (unbent) world position; every vertex is
 * then bent on the GPU exactly like the ground under it (curveObject), so
 * the line where a building meets the ground is the same from every camera
 * position. Every frame the model is told its construction progress,
 * health and fire state; it decides what to draw (reveal line, scaffold,
 * rubble) and which emitters should run, and this renderer turns those
 * into smoke and flame particles.
 *
 * MEETING THE GROUND. A building stands on a levelled foundation terrace
 * (cut and fill: most of the way up the drawn ground under its footprint —
 * world/surface.ts, the terrain's own bicubic filter) whose walls reach
 * below the lowest ground there; its plot (stakes, dug earth) and rubble
 * are draped over the real ground. Refitted when the heightmap changes
 * (builders levelling the site, spells). Plots and yards wear the turf
 * (world/wear.ts): no meadow grass through them.
 *
 * LANDMARKS. Each tribe's home circle (a ring of standing stones round its
 * focus, at tribes[t].home) and the monuments — standing stones that each
 * carry their spell's rune, motes of its element drifting round them,
 * teaching stones crowned with light and lending stones holding one
 * charged pebble per cast. While a leader communes the ritual is drawn
 * here: the rune fills, runes rise from the ground, a thread of light joins
 * leader and stone (tinted the communing tribe's colour, so a rival's
 * ritual is easy to spot). The snap of an interrupted ritual and the burst
 * of a completed one are one-shot effects (effects.ts).
 *
 * A war band that has no buildings and never had one (raiders on a beach)
 * gets no home circle: unit-visual-state.ts hasHomeCircle() decides.
 *
 * QUAKES. Buildings standing on a running quake's fault shudder (the model
 * jitters on its foundation) before the sim brings them down.
 *
 * HIGHLIGHT. render/highlight.ts says what's under the cursor; buildings
 * and monuments wear the shared highlight material variant while it's them.
 *
 * Sim fields read: b.tier (dwelling tier 0..2), b.maxHp, b.burning
 * (seconds left), monument.spell / .mode / .claimedBy / .sleep / .charges,
 * and — defensively, if the sim provides them — monument.communeProgress
 * (0..1) and monument.communer (unit id or tribe id); without those a
 * leader with task 'worship' at the stone is taken as the communer.
 */

import * as THREE from 'three';
import { CIVS, TILE, WORLD_SIZE } from '../config';
import { curveObject } from '../world/curvature';
import { footprintRange, surfaceHeight } from '../world/surface';
import { clearWear, setWear } from '../world/wear';
import { wrapDelta } from '../core/util';
import { buildBuildingModel, BuildingModel } from '../assets/models/registry';
import {
  applyHighlight, buildMonumentStone, buildStoneCircle, HomeCircle, MonumentModel,
} from '../assets/models/buildings/index';
import { TRIBE_COLORS, TribeId, UNITS } from '../sim/catalog';
import { Monument, Unit, World } from '../sim/world-state';
import { isHighlighted } from './highlight';
import { SPELL_LOOK, SPELL_LOOK_DEFAULT } from './look';
import { ModelFx } from './model-particles';
import { hasHomeCircle } from './unit-visual-state';
import { spellDef } from '../sim/catalog';

const WORLD_UNITS = WORLD_SIZE * TILE;
const VIEW_RADIUS = 160;
/** Stones farther than this (world units) don't shed motes. */
const MOTE_RADIUS = 90;

interface Entry {
  model: BuildingModel;
  kind: string;
  tribe: string;
  tier: number;
  /** map.version the ground fit was last computed for. */
  groundVer: number;
  base: number;
  lit: boolean;
}

interface Home {
  circle: HomeCircle;
  civ: string;
  groundVer: number;
  groundKey: string;
}

interface Stone {
  model: MonumentModel;
  spell: string;
  groundVer: number;
  lit: boolean;
  /** Fallback progress tracking (no sim communeProgress): the longest worship timer seen. */
  timerMax: number;
}

/**
 * Building id → the height its model stands at (top of its foundation).
 * The unit renderer reads it to stand tower lookouts and shrine
 * worshippers on the model rather than on the sim's centre-tile height.
 */
export const buildingBaseY = new Map<number, number>();

/** Unit ids communing at a stone this frame (the unit renderer poses them in prayer). */
export const communers = new Set<number>();

function civOf(world: World, tribe: TribeId) {
  return CIVS[world.tribes[tribe]?.civ ?? 'forest'];
}

type CommuneFields = { communeProgress?: number; communer?: number | string | null };

const _leader = new THREE.Vector3();
const _mote = new THREE.Vector3();

export class BuildingRenderer {
  private readonly entries = new Map<number, Entry>();
  private readonly homes = new Map<TribeId, Home>();
  private stones: Stone[] = [];
  private readonly fx: ModelFx;
  private last = performance.now();
  private clock = 0;
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
    this.clock += dt;
    this.syncHomes(world, camTarget, dt);
    this.syncStones(world, camTarget, dt);

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
        e = { model, kind: b.kind, tribe: b.tribe, tier, groundVer: -1, base: 0, lit: false };
        this.entries.set(b.id, e);
      }
      if (e.groundVer !== world.map.version) this.fitGround(e, b, world);
      buildingBaseY.set(b.id, e.base);
      // the plot and the yard are trodden earth: no meadow grass through them
      setWear(`b:${b.id}`, { x: b.x, z: b.z, r: b.size / 2 + 0.35, round: false, k: 1 });
      const visible = this.anchor(e.model.root.position, b.x, b.z, e.base, camTarget);
      e.model.root.visible = visible;
      const quake = visible ? this.quakeShake(world, b) : 0;
      if (quake > 0) {
        e.model.root.position.x += (Math.random() - 0.5) * quake;
        e.model.root.position.z += (Math.random() - 0.5) * quake;
        e.model.root.position.y += (Math.random() - 0.5) * quake * 0.4;
        e.model.root.rotation.z = (Math.random() - 0.5) * quake * 0.05;
      } else if (e.model.root.rotation.z !== 0) e.model.root.rotation.z = 0;
      e.model.update({ progress: b.progress, hpFrac: b.maxHp > 0 ? b.hp / b.maxHp : 1, burning: b.burning > 0, dt });
      const hl = isHighlighted('building', b.id);
      if (hl !== e.lit) {
        e.lit = hl;
        applyHighlight(e.model.root, hl);
      }
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


  // -------------------------------------------------------------------------
  // Home circles
  // -------------------------------------------------------------------------

  private syncHomes(world: World, camTarget: THREE.Vector3, dt: number): void {
    const active = this.active;
    active.clear();
    for (const id of world.activeTribes()) {
      const t = world.tribes[id]!;
      let built = 0;
      for (const b of world.buildings) if (b.tribe === id) built++;
      if (hasHomeCircle(t, built)) active.add(id);
    }
    for (const id of active) {
      const civ = civOf(world, id);
      let h = this.homes.get(id);
      if (h && h.civ !== civ.id) {
        this.removeHome(h);
        h = undefined;
      }
      if (!h) {
        const circle = buildStoneCircle(id, civ);
        curveObject(circle.root);
        this.scene.add(circle.root);
        h = { circle, civ: civ.id, groundVer: -1, groundKey: '' };
        this.homes.set(id, h);
      }
      const home = world.tribes[id]!.home;
      const map = world.map;
      const cy = surfaceHeight(map, home.x, home.z);
      if (h.groundVer !== map.version) {
        h.groundVer = map.version;
        // Rebuild only when the ground under the ring actually moved.
        let key = '';
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          key += (surfaceHeight(map, home.x + Math.sin(a) * 2.15, home.z + Math.cos(a) * 2.15) - cy).toFixed(2) + ',';
        }
        key += `${home.x},${home.z}`;
        if (key !== h.groundKey) {
          h.groundKey = key;
          h.circle.setGround((lx, lz) => surfaceHeight(map, home.x + lx / TILE, home.z + lz / TILE) - cy);
        }
      }
      setWear(`h:${id}`, { x: home.x, z: home.z, r: 2.75, round: true, k: 1 });
      h.circle.root.visible = this.anchor(h.circle.root.position, home.x, home.z, cy, camTarget);
      h.circle.update(this.clock);
      h.circle.root.updateMatrixWorld();
      this.fx.building(h.circle.root, { smoke: [], fire: [], flames: h.circle.flames, emit: { smoke: false, fire: false, flames: true, hurt: 0 } }, dt);
    }
    for (const [id, h] of this.homes) {
      if (!active.has(id)) {
        this.removeHome(h);
        this.homes.delete(id);
        clearWear(`h:${id}`);
      }
    }
  }

  private removeHome(h: Home): void {
    this.scene.remove(h.circle.root);
    this.fx.fire.forget(h.circle.root);
    this.fx.smoke.forget(h.circle.root);
    h.circle.dispose();
  }

  // -------------------------------------------------------------------------
  // Standing stones and the communing ritual
  // -------------------------------------------------------------------------

  private syncStones(world: World, camTarget: THREE.Vector3, dt: number): void {
    communers.clear();
    const map = world.map;
    while (this.stones.length > world.monuments.length) this.removeStone(this.stones.pop()!);
    for (let i = 0; i < world.monuments.length; i++) {
      const sim = world.monuments[i];
      let st = this.stones[i];
      if (st && st.spell !== sim.spell) {
        this.removeStone(st);
        st = undefined as unknown as Stone;
      }
      if (!st) {
        const model = buildMonumentStone(sim.spell);
        curveObject(model.root);
        this.scene.add(model.root);
        st = { model, spell: sim.spell, groundVer: -1, lit: false, timerMax: 0 };
        this.stones[i] = st;
      }
      const cy = surfaceHeight(map, sim.x, sim.z);
      if (st.groundVer !== map.version) {
        st.groundVer = map.version;
        st.model.setGround((lx, lz) => surfaceHeight(map, sim.x + lx / TILE, sim.z + lz / TILE) - cy);
      }
      setWear(`m:${i}`, { x: sim.x, z: sim.z, r: [2.0, 2.2, 2.7][st.model.tier - 1], round: true, k: 0.8 });
      const root = st.model.root;
      const visible = this.anchor(root.position, sim.x, sim.z, cy, camTarget);
      root.visible = visible;

      const dark = (sim.mode !== 'gift' && sim.claimedBy !== null) || sim.sleep > 0;
      // the ritual, read defensively
      const leader = dark ? null : this.communerOf(world, sim, i, st);
      let ritual: number | null = null;
      let color = 0xffffff;
      let leaderLocal: THREE.Vector3 | null = null;
      if (leader) {
        communers.add(leader.unit.id);
        ritual = leader.progress;
        color = TRIBE_COLORS[leader.unit.tribe] ?? 0xffffff;
        const rx = wrapDelta(leader.unit.x * TILE - root.position.x, WORLD_UNITS);
        const rz = wrapDelta(leader.unit.z * TILE - root.position.z, WORLD_UNITS);
        const h = (UNITS[leader.unit.kind]?.height ?? 2.6) * 0.62;
        leaderLocal = _leader.set(rx, surfaceHeight(map, leader.unit.x, leader.unit.z) + h - cy, rz);
      }
      st.model.update({
        dark, mode: sim.mode, charges: sim.mode === 'gift' ? sim.charges ?? 2 : 0,
        ritual, ritualColor: color, leader: leaderLocal, t: this.clock + i * 1.7,
      });
      const hl = isHighlighted('monument', i);
      if (hl !== st.lit) {
        st.lit = hl;
        applyHighlight(root, hl);
      }
      if (visible && !dark) {
        root.updateMatrixWorld();
        const dx = root.position.x - camTarget.x;
        const dz = root.position.z - camTarget.z;
        if (dx * dx + dz * dz < MOTE_RADIUS * MOTE_RADIUS) this.motes(st, sim, ritual, dt);
      }
    }
  }

  /** The leader communing at stone `i`, and how far along (0..1), or null. */
  private communerOf(world: World, sim: Monument, i: number, st: Stone): { unit: Unit; progress: number } | null {
    const m = sim as Monument & CommuneFields;
    if (typeof m.communeProgress === 'number' && m.communer !== undefined && m.communer !== null) {
      let unit: Unit | undefined;
      if (typeof m.communer === 'number') unit = world.units.find((u) => u.id === m.communer);
      else unit = world.units.find((u) => u.tribe === m.communer && u.kind === 'shaman');
      if (unit && m.communeProgress >= 0 && m.communeProgress < 1) return { unit, progress: m.communeProgress };
      return null;
    }
    // Fallback (older sim): a leader worshipping here, progress from its timer.
    for (const u of world.units) {
      if (u.task !== 'worship' || u.targetMonument !== i || u.kind !== 'shaman') continue;
      const dx = wrapDelta(u.x - sim.x, WORLD_SIZE);
      const dz = wrapDelta(u.z - sim.z, WORLD_SIZE);
      if (dx * dx + dz * dz > 25) continue;
      st.timerMax = Math.max(st.timerMax, u.workTimer);
      const progress = st.timerMax > 0 ? 1 - Math.max(0, u.workTimer) / st.timerMax : 0;
      return { unit: u, progress };
    }
    st.timerMax = 0;
    return null;
  }

  /** Motes of the stone's element; more and brighter while a ritual runs. */
  private motes(st: Stone, sim: Monument, ritual: number | null, dt: number): void {
    const look = SPELL_LOOK[sim.spell] ?? SPELL_LOOK_DEFAULT;
    const mo = look.mote;
    const tierK = 0.7 + st.model.tier * 0.3;
    const rate = mo.rate * tierK * (ritual !== null ? 2.5 + 3 * ritual : 1);
    const pool = mo.pool === 'fire' ? this.fx.fire : this.fx.smoke;
    const H = st.model.height;
    for (let n = this.fx.count(st.model.root, 50, rate, dt); n > 0; n--) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.6 + Math.random() * mo.spread;
      const y = mo.vy < 0 ? H * (0.75 + Math.random() * 0.4) : 0.3 + Math.random() * H * 0.7;
      _mote.set(Math.sin(a) * r, y, Math.cos(a) * r);
      const sw = mo.swirl ?? 0;
      pool.emit(st.model.root, _mote, {
        vx: Math.cos(a) * sw, vz: -Math.sin(a) * sw, vy: mo.vy * (0.7 + Math.random() * 0.6),
        life: mo.life * (0.7 + Math.random() * 0.6), size: mo.size, grow: mo.pool === 'smoke' ? 1.2 : -0.3,
        color: mo.color, alpha: mo.alpha, spread: 0.2,
      });
    }
  }

  private removeStone(st: Stone): void {
    this.scene.remove(st.model.root);
    this.fx.fire.forget(st.model.root);
    this.fx.smoke.forget(st.model.root);
    st.model.dispose();
  }

  /** How hard a running quake shakes building `b` (world units of jitter; 0 = not on a fault). */
  private quakeShake(world: World, b: { x: number; z: number; size: number }): number {
    let k = 0;
    for (const j of world.jobs) {
      if (j.spell !== 'earthquake') continue;
      const len = Math.round(spellDef('earthquake').radius * 1.45);
      const bx = wrapDelta(b.x - j.x, WORLD_SIZE);
      const bz = wrapDelta(b.z - j.z, WORLD_SIZE);
      const c = Math.cos(j.angle), s = Math.sin(j.angle);
      const along = Math.abs(bx * c + bz * s);
      const across = Math.abs(-bx * s + bz * c);
      if (along < len + 1 && across < 4 + b.size / 2) k = Math.max(k, 0.35 * (1 - across / (6 + b.size)));
    }
    return k;
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
