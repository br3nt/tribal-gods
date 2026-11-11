/**
 * render/unit-renderer.ts — sim units → animated people on the planet.
 *
 * One FigureModel (a single skinned mesh, see assets/models/people) and one
 * FigureAnimator per unit, created and destroyed as units come and go.
 * Every frame each figure runs the same pipeline:
 *
 * 1. INTERPOLATE — the sim ticks at 15 Hz, the screen at 60+. Lerp
 *    prev→current position by `alpha`, wrap-aware so a unit crossing the
 *    world seam doesn't streak across the planet.
 *
 * 2. ANCHOR — place the figure at the wrapped image of its position nearest
 *    the camera target (the seamless-wrap trick the terrain also uses).
 *
 * 3. CULL — beyond VIEW_RADIUS the planet's curvature has already dropped
 *    them below the horizon; outside the camera frustum nobody can see
 *    them. Either way: no animation, no draw.
 *
 * 4. CURVE — terrain bends down with distance in its vertex shader; figures
 *    are small, so we drop the whole figure by curvatureDrop() on the CPU —
 *    the FULL drop, limb included, so far figures sit on the planet's edge
 *    (sub-pixel error at this size, and no per-vertex shader patch needed).
 *
 * 5. ANIMATE — pick a clip from the unit's state/task (chooseClip), feed
 *    the animator the MEASURED ground speed (foot sync) and turn rate (lean
 *    into turns). Animation LOD: far figures update every 2nd/3rd frame
 *    with the accumulated dt.
 *
 * Deaths: the sim deletes dead units immediately, so the renderer keeps a
 * GHOST of the figure to play the fall (or the drowning, or — for a
 * leader — an ascension in light) before letting it go. An ordinary body
 * falls, lies still a moment, then fades out while a small wisp in its
 * tribe's colour rises from it.
 *
 * Picking: `visualPosition(unitId)` returns where a unit is DRAWN this
 * frame — tower lookouts on their platform, swimmers bobbing low in the
 * water, everyone wrapped and curved like the picture. Selection code
 * (src/ui) should prefer it over the sim's (x, z) + ground height; it is
 * not wired into the UI yet.
 *
 * Status (unit-visual-state.ts decides; this file draws):
 *   u.lifted      — caught in a cyclone: the figure is snatched up, spins,
 *                   tumbles, and its fling (the sim teleports it) is glided
 *                   into a flight; dropped, it falls back with gravity.
 *   u.pacified    — a hostile chant holds it: slack pose, no strikes.
 *   u.wardTime    — Stone Ward: a shared stone-sheen material variant.
 *   u.warsongTime — Warsong: a shared red-gold variant; movers run.
 *   u.garrison    — tower lookouts on the platform, shrine worshippers
 *                   kneeling round the altar.
 *   Chanters with task 'chant' chant; idle villagers cheer near a recruit
 *   trained or an objective met (world.events, read before effects drains
 *   them), and on world.gameOver for the winning side.
 */

import * as THREE from 'three';
import { CIVS, TILE, WORLD_SIZE } from '../config';
import { curvatureDrop } from '../world/curvature';
import { wrapDelta } from '../core/util';
import { buildUnitModel, FigureModel } from '../assets/models/registry';
import { decalMaterial, disposeModelMaterial, fadeCopy, tickModelMaterials, tintedMaterial } from '../assets/models/materials';
import { garrisonSpot } from '../assets/models/buildings/index';
import { spellDef, TRIBE_COLORS, Tribe, UNITS } from '../sim/catalog';
import { AnimInput, FigureAnimator, runThreshold } from './figure-animator';
import { UNIT_STATUS } from './look';
import { ParticlePool } from './model-particles';
import { Building, Unit, World } from '../sim/world-state';
import { cheerersFor, ClipContext, pickClip, StatusTint, statusTint } from './unit-visual-state';

const WORLD_UNITS = WORLD_SIZE * TILE;
/** Beyond this (world units from the camera target) figures are over the horizon. */
const VIEW_RADIUS = 150;
/** Distances for animation LOD. */
const LOD1 = 70;
const LOD2 = 105;

/** How long a cheer lasts (seconds). */
const CHEER_SECONDS = 2.4;

interface Entry {
  fig: FigureModel;
  anim: FigureAnimator;
  ring: THREE.Mesh;
  kind: string;
  tribe: string;
  lastHp: number;
  /** Last rendered world position (for measured speed). */
  px: number;
  pz: number;
  speed: number;
  yaw: number;
  turn: number;
  lodTick: number;
  accDt: number;
  /** Tile position last frame (for ghost spawn). */
  tx: number;
  tz: number;
  inWater: boolean;
  /** Where the figure was drawn this frame (bent world space), for picking. */
  drawn: THREE.Vector3;
  drawnFrame: number;
  /** Animation input, refilled every frame. */
  inp: AnimInput;
  /** Cyclone: 0 on the ground … 1 fully aloft, its fall speed, and the glide offset (tiles) hiding the sim's fling teleport. */
  lift: number;
  liftV: number;
  ox: number;
  oz: number;
  /** Sim position last frame (to spot a fling). */
  simX: number;
  simZ: number;
  /** The figure's own materials, and which status variant it wears. */
  baseMats: THREE.Material[];
  tint: StatusTint;
}

/** Where a unit is drawn: world-space feet (bent, nearest image) and tile coords. */
export interface VisualPosition {
  /** World-space position of the feet as drawn (wrap + curvature applied). */
  world: THREE.Vector3;
  /** Tile coordinates of the drawn spot (a lookout's platform, not the tower base). */
  tileX: number;
  tileZ: number;
  /** Figure height in world units (feet → head top). */
  height: number;
}

interface Ghost {
  fig: FigureModel;
  anim: FigureAnimator;
  t: number;
  mode: 'die' | 'drown' | 'ascend';
  tx: number;
  tz: number;
  yaw: number;
  fade: THREE.Material[] | null;
  tribe: string;
  /** Fractional wisp emission carried between frames. */
  wispAcc: number;
}

/** Ordinary death timeline (seconds): fall, lie still, fade out with a wisp. */
const DIE_LIE = 2.1;
const DIE_FADE = 1.1;
const DIE_END = DIE_LIE + DIE_FADE + 1.3; // the wisp's last particles outlive the body
const _wisp = new THREE.Vector3();
const GHOST_DIE: AnimInput = { clip: 'die', speed: 0, turnRate: 0 };
const GHOST_DROWN: AnimInput = { clip: 'drown', speed: 0, turnRate: 0 };
const GHOST_CAST: AnimInput = { clip: 'cast', speed: 0, turnRate: 0 };

function civOf(world: World, tribe: Tribe) {
  const t = (world.tribes as Record<string, { civ?: string } | undefined>)[tribe];
  return CIVS[(t?.civ ?? 'forest') as keyof typeof CIVS] ?? CIVS.forest;
}

export class UnitRenderer {
  private readonly entries = new Map<number, Entry>();
  private readonly ghosts: Ghost[] = [];
  private readonly ringGeo: THREE.BufferGeometry;
  private readonly ringMats = new Map<string, THREE.Material>();
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private camera: THREE.Camera | null = null;
  private frame = 0;
  private readonly sphere = new THREE.Sphere();
  /** Reused every frame (no per-frame allocation). */
  private readonly live = new Set<number>();
  private readonly buildingsById = new Map<number, Building>();
  /** Unit id → render-clock time its cheer ends. */
  private readonly cheerUntil = new Map<number, number>();
  private clock = 0;
  private readonly clipCtx: ClipContext = { garrisonKind: null, inWater: false, speed: 0, runSpeed: 0, cheering: false, winner: null };
  /** Tribe-coloured wisps rising from the dead. */
  private readonly wisps: ParticlePool;

  constructor(private readonly scene: THREE.Scene) {
    // Selection ring: a soft-edged band on the ground, tinted by tribe.
    this.ringGeo = new THREE.RingGeometry(0.85, 1.15, 32, 1);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.wisps = new ParticlePool(scene, 400, true);
  }

  /** Give the renderer the camera so it can frustum-cull (optional; main.ts may not call it). */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  private ringMat(tribe: string): THREE.Material {
    let m = this.ringMats.get(tribe);
    if (!m) {
      const c = new THREE.Color(TRIBE_COLORS[tribe as Tribe] ?? 0xffe9a8).lerp(new THREE.Color(0xffffff), 0.45);
      m = decalMaterial(c.getHex(), 0.9);
      this.ringMats.set(tribe, m);
    }
    return m;
  }

  /** Called once per render frame. */
  sync(world: World, camTarget: THREE.Vector3, alpha: number, dt: number, selected: Set<number>): void {
    this.frame++;
    tickModelMaterials(dt);
    if (!this.camera) this.camera = findCamera(this.scene);
    if (this.camera) {
      this.camera.updateMatrixWorld();
      this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreen);
    }
    const live = this.live;
    live.clear();
    const buildingsById = this.buildingsById;
    buildingsById.clear();
    for (const b of world.buildings) buildingsById.set(b.id, b);
    this.clock += dt;
    // Good news nearby: idle villagers cheer. (Effects drains the events later this frame.)
    if (world.events.length) {
      for (const id of cheerersFor(world.events, world.units, world.buildings)) this.cheerUntil.set(id, this.clock + CHEER_SECONDS);
    }
    const winner = world.gameOver;

    for (const u of world.units) {
      live.add(u.id);
      let e = this.entries.get(u.id);

      // Converted units change costume: rebuild.
      if (e && (e.kind !== u.kind || e.tribe !== u.tribe)) {
        this.dispose(e);
        this.entries.delete(u.id);
        e = undefined;
      }

      // Garrisoned figures we still SHOW: tower lookouts and shrine worshippers.
      const gb = u.garrison >= 0 ? buildingsById.get(u.garrison) : undefined;
      let spot: { x: number; z: number; y: number; yaw: number } | null = null;
      if (u.hidden && gb && (gb.kind === 'tower' || gb.kind === 'shrine')) {
        const idx = Math.max(0, gb.garrison.indexOf(u.id));
        spot = garrisonSpot(gb.kind, idx);
      }
      if (u.hidden && !spot) {
        if (e) {
          e.fig.root.visible = false;
          e.ring.visible = false;
        }
        continue;
      }

      if (!e) {
        const fig = buildUnitModel(u.kind, u.tribe as Tribe, civOf(world, u.tribe as Tribe), u.id);
        const ring = new THREE.Mesh(this.ringGeo, this.ringMat(u.tribe));
        ring.renderOrder = 1;
        ring.visible = false;
        ring.scale.setScalar(fig.height * 0.36);
        this.scene.add(fig.root, ring);
        e = {
          fig, anim: new FigureAnimator(fig, u.id), ring, kind: u.kind, tribe: u.tribe, lastHp: u.hp,
          px: NaN, pz: NaN, speed: 0, yaw: u.heading, turn: 0, lodTick: u.id % 3, accDt: 0, tx: u.x, tz: u.z, inWater: false,
          drawn: new THREE.Vector3(), drawnFrame: -1, inp: { clip: 'idle', speed: 0, turnRate: 0 },
          lift: 0, liftV: 0, ox: 0, oz: 0, simX: u.x, simZ: u.z,
          baseMats: fig.meshes.map((m) => m.material as THREE.Material), tint: 'none',
        };
        this.entries.set(u.id, e);
      }

      // 1. INTERPOLATE (wrap-aware)
      let ix = u.prevX + wrapDelta(u.x - u.prevX, WORLD_SIZE) * alpha;
      let iz = u.prevZ + wrapDelta(u.z - u.prevZ, WORLD_SIZE) * alpha;
      let heading = u.heading;
      // Cyclone: snatched up while lifted, then a gravity drop. The sim
      // teleports a flung unit; glide that jump into a flight instead.
      const jx = wrapDelta(u.x - e.simX, WORLD_SIZE);
      const jz = wrapDelta(u.z - e.simZ, WORLD_SIZE);
      e.simX = u.x;
      e.simZ = u.z;
      if (spot) {
        e.lift = e.liftV = e.ox = e.oz = 0;
      } else {
        if ((u.lifted > 0 || e.lift > 0) && jx * jx + jz * jz > 0.25) {
          e.ox -= jx;
          e.oz -= jz;
        }
        const glide = Math.exp(-dt * UNIT_STATUS.flingGlide);
        e.ox *= glide;
        e.oz *= glide;
        if (u.lifted > 0) {
          e.lift += (1 - e.lift) * Math.min(1, dt * UNIT_STATUS.liftRise);
          e.liftV = 0;
        } else if (e.lift > 0) {
          e.liftV += dt * UNIT_STATUS.liftFall;
          e.lift = Math.max(0, e.lift - e.liftV * dt);
          if (e.lift === 0) e.liftV = 0;
        }
        ix += e.ox;
        iz += e.oz;
      }
      if (spot && gb) {
        ix = gb.x + spot.x / TILE;
        iz = gb.z + spot.z / TILE;
        heading = spot.yaw;
      }
      e.tx = ix;
      e.tz = iz;

      // 2. ANCHOR
      const relX = wrapDelta(ix * TILE - camTarget.x, WORLD_UNITS);
      const relZ = wrapDelta(iz * TILE - camTarget.z, WORLD_UNITS);
      const d2 = relX * relX + relZ * relZ;
      const wx = camTarget.x + relX;
      const wz = camTarget.z + relZ;
      const ground = world.map.sampleHeight(ix, iz);
      const inWater = ground < -0.25 && !spot && e.lift < 0.05;
      e.inWater = inWater;
      let y = spot ? world.map.heightAt(Math.round(gb!.x), Math.round(gb!.z)) + spot.y : Math.max(ground, inWater ? -0.9 - 0.1 * Math.sin(this.frame * 0.1 + u.id) : 0);
      // 4. CURVE
      y -= curvatureDrop(relX, relZ);
      const groundY = y;
      if (e.lift > 0) y += e.lift * (UNIT_STATUS.liftHeight + 0.35 * Math.sin(this.clock * 3.1 + u.id));

      // measured speed (world units/s) for foot sync
      if (dt > 0 && !Number.isNaN(e.px)) {
        const v = Math.hypot(wx - e.px, wz - e.pz) / dt;
        const vv = v > 25 ? e.speed : v; // ignore teleports (blasts, wrap re-anchors)
        e.speed += (vv - e.speed) * Math.min(1, dt * 10);
      }
      e.px = wx;
      e.pz = wz;
      e.drawn.set(wx, y, wz);
      e.drawnFrame = this.frame;

      // 3. CULL
      let visible = d2 < VIEW_RADIUS * VIEW_RADIUS;
      if (visible && this.camera) {
        this.sphere.center.set(wx, y + e.fig.height * 0.5, wz);
        this.sphere.radius = e.fig.height;
        visible = this.frustum.intersectsSphere(this.sphere);
      }
      e.fig.root.visible = visible;
      e.ring.visible = visible && selected.has(u.id);
      if (!visible) continue;

      e.fig.root.position.set(wx, y, wz);
      // face the heading, the short way round; remember the turn rate for
      // leaning. Aloft in a cyclone the figure spins instead.
      if (e.lift > 0.05) {
        e.yaw = (e.yaw + dt * UNIT_STATUS.liftSpin * e.lift) % (Math.PI * 2);
        e.turn = 0;
      } else {
        const dyaw = wrapDelta(heading - e.yaw, Math.PI * 2) * Math.min(1, dt * 9);
        e.yaw += dyaw;
        e.turn += ((dt > 0 ? dyaw / dt : 0) - e.turn) * Math.min(1, dt * 8);
      }
      e.fig.root.rotation.y = e.yaw;

      // Stone Ward / Warsong: swap to a shared tinted variant.
      const tint = statusTint(u);
      if (tint !== e.tint) {
        e.tint = tint;
        const base = e.baseMats;
        e.fig.meshes.forEach((m, i) => {
          m.material = tint === 'none' ? base[i] : tintedMaterial(base[i], tint, UNIT_STATUS[tint]);
        });
      }

      // hit flinch
      if (u.hp < e.lastHp - 0.01) e.anim.flinch();
      e.lastHp = u.hp;

      // 5. ANIMATE (with LOD)
      const inp = this.chooseClip(u, e, spot ? gb!.kind : null, winner);
      const lodEvery = d2 > LOD2 * LOD2 ? 3 : d2 > LOD1 * LOD1 ? 2 : 1;
      e.accDt += dt;
      e.lodTick++;
      if (e.lodTick % lodEvery === 0) {
        e.anim.update(e.accDt, inp);
        e.accDt = 0;
      }
      if (e.fig.style.tools) {
        const c = e.anim.currentClip;
        e.fig.setProp('log', c === 'carry');
        e.fig.setProp('axe', c === 'chop' || (c === 'attack' && u.kind === 'brave'));
        e.fig.setProp('hammer', c === 'build');
      }
      if (e.fig.aura) {
        const k = 0.9 + 0.1 * Math.sin(this.frame * 0.05 + u.id);
        e.fig.aura.scale.setScalar(k * (inp.clip === 'cast' ? 1.5 : 1));
      }

      if (e.ring.visible) {
        e.ring.position.set(wx, groundY + 0.08, wz);
        tiltToGround(e.ring, world, ix, iz);
      }
    }

    // Units that vanished: deaths become ghosts; resets just disappear. A
    // world reset/level load removes most units in one frame — no ghosts then.
    let vanished = 0;
    for (const id of this.entries.keys()) if (!live.has(id)) vanished++;
    const reset = vanished > 6 && vanished > live.size * 0.5;
    for (const [id, until] of this.cheerUntil) if (!live.has(id) || until < this.clock) this.cheerUntil.delete(id);
    for (const [id, e] of this.entries) {
      if (live.has(id)) continue;
      this.entries.delete(id);
      this.scene.remove(e.ring);
      if (e.fig.root.visible && !reset) {
        const mode: Ghost['mode'] = e.kind === 'shaman' ? 'ascend' : e.inWater ? 'drown' : 'die';
        let fade: THREE.Material[] | null = null;
        if (mode !== 'drown') {
          // a private transparent copy of the materials, so the fade is ours alone
          fade = e.fig.meshes.map((m) => {
            const mm = fadeCopy(m.material as THREE.Material);
            m.material = mm;
            return mm;
          });
        }
        this.ghosts.push({ fig: e.fig, anim: e.anim, t: 0, mode, tx: e.tx, tz: e.tz, yaw: e.yaw, fade, tribe: e.tribe, wispAcc: 0 });
      } else {
        this.disposeFig(e.fig);
      }
    }
    this.updateGhosts(world, camTarget, dt);
    this.wisps.update(dt, 0.1);
  }

  /**
   * Where a unit is DRAWN this frame, for picking: a tower lookout stands on
   * the platform (not at the tower's base), a swimmer bobs low in the water.
   * Null when the unit isn't drawn (hidden, culled, over the horizon).
   * `out` is reused if given.
   */
  visualPosition(unitId: number, out?: VisualPosition): VisualPosition | null {
    const e = this.entries.get(unitId);
    if (!e || !e.fig.root.visible || e.drawnFrame !== this.frame) return null;
    const v = out ?? { world: new THREE.Vector3(), tileX: 0, tileZ: 0, height: 0 };
    v.world.copy(e.drawn);
    v.tileX = e.tx;
    v.tileZ = e.tz;
    v.height = e.fig.height;
    return v;
  }

  /** Map sim state → clip (the decision lives in unit-visual-state.ts). */
  private chooseClip(u: Unit, e: Entry, garrisonKind: string | null, winner: World['gameOver']): AnimInput {
    const c = this.clipCtx;
    c.garrisonKind = garrisonKind;
    c.inWater = e.inWater;
    c.speed = e.speed;
    c.runSpeed = runThreshold(e.fig);
    c.cheering = (this.cheerUntil.get(u.id) ?? -1) >= this.clock;
    c.winner = winner;
    const pick = pickClip(u, c);
    const inp = e.inp;
    inp.clip = pick.clip;
    inp.speed = e.speed;
    inp.turnRate = e.turn;
    inp.phase = pick.phase;
    inp.period = pick.clip === 'cast' && u.castSpell ? spellDef(u.castSpell).castSeconds : undefined;
    return inp;
  }

  private updateGhosts(world: World, camTarget: THREE.Vector3, dt: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.t += dt;
      const relX = wrapDelta(g.tx * TILE - camTarget.x, WORLD_UNITS);
      const relZ = wrapDelta(g.tz * TILE - camTarget.z, WORLD_UNITS);
      let y = Math.max(0, world.map.sampleHeight(g.tx, g.tz)) - curvatureDrop(relX, relZ);
      let done = false;
      if (g.mode === 'die') {
        // fall, lie still a moment, then fade away while a wisp in the
        // tribe's colour rises from the body
        if (g.t < DIE_LIE + DIE_FADE) g.anim.update(dt, GHOST_DIE);
        const k = 1 - THREE.MathUtils.clamp((g.t - DIE_LIE) / DIE_FADE, 0, 1);
        for (const m of g.fade ?? []) m.opacity = k * k;
        if (g.t > DIE_LIE) for (const m of g.fig.meshes) m.castShadow = false;
        if (k <= 0) for (const m of g.fig.meshes) m.visible = false;
        if (g.t > DIE_LIE - 0.2 && g.t < DIE_LIE + DIE_FADE) {
          g.wispAcc += dt * 34;
          const col = TRIBE_COLORS[g.tribe as Tribe] ?? 0xffe9a8;
          const s = g.fig.scale;
          for (; g.wispAcc >= 1; g.wispAcc--) {
            // the body lies along local −Z (it falls backward): spread along it
            const along = -Math.random() * g.fig.height * 0.75;
            _wisp.set((Math.random() - 0.5) * 0.4, 0.25 + Math.random() * 0.2, along);
            this.wisps.emit(g.fig.root, _wisp, {
              vy: 0.9 + Math.random() * 0.8, life: 1.1 + Math.random() * 0.5, size: 0.45 * s + 0.2, grow: 0.8,
              color: Math.random() < 0.15 ? 0xffffff : col, alpha: 0.7, spread: 0.25,
            });
          }
        }
        done = g.t > DIE_END;
      } else if (g.mode === 'drown') {
        g.anim.update(dt, GHOST_DROWN);
        y = -0.9 - g.t * 1.1 - curvatureDrop(relX, relZ);
        done = g.t > 2.5;
      } else {
        // a leader rises in light and fades
        g.anim.update(dt, g.t < 1.2 ? GHOST_DIE : GHOST_CAST);
        y += Math.max(0, g.t - 1.0) ** 1.5 * 1.6;
        const k = 1 - THREE.MathUtils.clamp((g.t - 1.2) / 1.8, 0, 1);
        for (const m of g.fade ?? []) m.opacity = k;
        if (g.fig.aura) g.fig.aura.scale.setScalar(1 + g.t);
        done = g.t > 3.2;
      }
      g.fig.root.position.set(camTarget.x + relX, y, camTarget.z + relZ);
      g.fig.root.rotation.y = g.yaw;
      if (done) {
        for (const m of g.fade ?? []) disposeModelMaterial(m);
        this.disposeFig(g.fig);
        this.ghosts.splice(i, 1);
      }
    }
  }

  private dispose(e: Entry): void {
    this.scene.remove(e.ring);
    this.disposeFig(e.fig);
  }

  private disposeFig(fig: FigureModel): void {
    this.scene.remove(fig.root);
    fig.dispose();
  }

  /**
   * Where a unit currently sits on screen, in pixels — used by drag-box
   * selection. Mirrors the anchor + curve math from sync(), then projects
   * through the camera. Returns null if behind the camera.
   */
  screenPosition(
    u: Unit,
    world: World,
    camTarget: THREE.Vector3,
    camera: THREE.Camera,
  ): { x: number; y: number } | null {
    const h = UNITS[u.kind]?.height ?? 2.3;
    const v = _proj;
    const e = this.entries.get(u.id);
    if (e && e.drawnFrame === this.frame && e.fig.root.visible) {
      v.copy(e.drawn).setY(e.drawn.y + e.fig.height * 0.45); // as drawn (lookouts, swimmers)
    } else {
      const relX = wrapDelta(u.x * TILE - camTarget.x, WORLD_UNITS);
      const relZ = wrapDelta(u.z * TILE - camTarget.z, WORLD_UNITS);
      const y = Math.max(0, world.map.sampleHeight(u.x, u.z)) - curvatureDrop(relX, relZ);
      v.set(camTarget.x + relX, y + h * 0.45, camTarget.z + relZ); // chest height
    }
    v.project(camera);
    if (v.z > 1) return null;
    return { x: (v.x + 1) * 0.5 * innerWidth, y: (1 - v.y) * 0.5 * innerHeight };
  }
}

const _n = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
/** Lay a ground decal flat on the local slope. */
function tiltToGround(m: THREE.Object3D, world: World, x: number, z: number): void {
  const hx = world.map.sampleHeight(x + 0.5, z) - world.map.sampleHeight(x - 0.5, z);
  const hz = world.map.sampleHeight(x, z + 0.5) - world.map.sampleHeight(x, z - 0.5);
  _n.set(-hx / TILE, 1, -hz / TILE).normalize();
  m.quaternion.setFromUnitVectors(_up, _n);
}

/** Find the active camera if main.ts never handed us one (the scene's parent chain doesn't know it). */
function findCamera(scene: THREE.Scene): THREE.Camera | null {
  const w = window as unknown as { __tg?: { rig?: { camera?: THREE.Camera } } };
  return w.__tg?.rig?.camera ?? (scene.userData.camera as THREE.Camera | undefined) ?? null;
}
