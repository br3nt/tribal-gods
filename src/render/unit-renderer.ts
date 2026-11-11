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
 *    are small, so we drop the whole figure by curvatureDrop() on the CPU
 *    (sub-pixel error at this size, and no per-vertex shader patch needed).
 *
 * 5. ANIMATE — pick a clip from the unit's state/task (chooseClip), feed
 *    the animator the MEASURED ground speed (foot sync) and turn rate (lean
 *    into turns). Animation LOD: far figures update every 2nd/3rd frame
 *    with the accumulated dt.
 *
 * Deaths: the sim deletes dead units immediately, so the renderer keeps a
 * GHOST of the figure to play the fall (or the drowning, or — for a
 * leader — an ascension in light) before letting it go.
 *
 * Sim fields read DEFENSIVELY (the v2 sim adds them; absent = default):
 *   u.maxHp, u.garrison (building id, −1 none), u.wardTime, u.warsongTime,
 *   u.pacified, u.chantBy, u.praying, u.cheer, u.chanting;
 *   b.kind 'tower' / 'shrine' for garrisoned figures shown on the platform
 *   or kneeling round the altar; world.gameOver for victory cheers.
 */

import * as THREE from 'three';
import { CIVS, TILE, WORLD_SIZE } from '../config';
import { curvatureDrop } from '../world/curvature';
import { wrapDelta } from '../core/util';
import { buildUnitModel, FigureModel } from '../assets/models/registry';
import { decalMaterial, disposeModelMaterial, fadeCopy, tickModelMaterials } from '../assets/models/materials';
import { garrisonSpot } from '../assets/models/buildings/index';
import { spellDef, TRIBE_COLORS, Tribe, UNITS, UnitKind } from '../sim/catalog';
import { AnimInput, ClipName, FigureAnimator, runThreshold } from './figure-animator';
import { Unit, World } from '../sim/world-state';

const WORLD_UNITS = WORLD_SIZE * TILE;
/** Beyond this (world units from the camera target) figures are over the horizon. */
const VIEW_RADIUS = 150;
/** Distances for animation LOD. */
const LOD1 = 70;
const LOD2 = 105;

type AnyUnit = Unit & Record<string, unknown>;
const num = (u: AnyUnit, k: string, d: number): number => (typeof u[k] === 'number' ? (u[k] as number) : d);

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
}

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

  constructor(private readonly scene: THREE.Scene) {
    // Selection ring: a soft-edged band on the ground, tinted by tribe.
    this.ringGeo = new THREE.RingGeometry(0.85, 1.15, 32, 1);
    this.ringGeo.rotateX(-Math.PI / 2);
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
    const live = new Set<number>();
    const buildingsById = new Map<number, { kind: string; x: number; z: number; garrison?: number[] }>();
    for (const b of world.buildings) buildingsById.set(b.id, b as never);
    const winner = (world as unknown as { gameOver?: string | null }).gameOver;

    for (const raw of world.units) {
      const u = raw as AnyUnit;
      live.add(u.id);
      let e = this.entries.get(u.id);

      // Converted units change costume: rebuild.
      if (e && (e.kind !== u.kind || e.tribe !== u.tribe)) {
        this.dispose(e);
        this.entries.delete(u.id);
        e = undefined;
      }

      // Garrisoned figures we still SHOW: tower lookouts and shrine worshippers.
      const gid = num(u, 'garrison', -1);
      const gb = gid >= 0 ? buildingsById.get(gid) : undefined;
      let spot: { x: number; z: number; y: number; yaw: number } | null = null;
      if (u.hidden && gb && (gb.kind === 'tower' || gb.kind === 'shrine')) {
        const idx = Math.max(0, (gb.garrison ?? []).indexOf(u.id));
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
        // We apply the full planet drop (curvatureDrop) ourselves: opt out of main.ts's limb pass.
        fig.root.userData.gpuCurved = true;
        ring.userData.gpuCurved = true;
        ring.scale.setScalar(fig.height * 0.36);
        this.scene.add(fig.root, ring);
        e = {
          fig, anim: new FigureAnimator(fig, u.id), ring, kind: u.kind, tribe: u.tribe, lastHp: u.hp,
          px: NaN, pz: NaN, speed: 0, yaw: u.heading, turn: 0, lodTick: u.id % 3, accDt: 0, tx: u.x, tz: u.z, inWater: false,
        };
        this.entries.set(u.id, e);
      }

      // 1. INTERPOLATE (wrap-aware)
      let ix = u.prevX + wrapDelta(u.x - u.prevX, WORLD_SIZE) * alpha;
      let iz = u.prevZ + wrapDelta(u.z - u.prevZ, WORLD_SIZE) * alpha;
      let heading = u.heading;
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
      const inWater = ground < -0.25 && !spot;
      e.inWater = inWater;
      let y = spot ? world.map.heightAt(Math.round(gb!.x), Math.round(gb!.z)) + spot.y : Math.max(ground, inWater ? -0.9 - 0.1 * Math.sin(this.frame * 0.1 + u.id) : 0);
      // 4. CURVE
      y -= curvatureDrop(relX, relZ);

      // measured speed (world units/s) for foot sync
      if (dt > 0 && !Number.isNaN(e.px)) {
        const v = Math.hypot(wx - e.px, wz - e.pz) / dt;
        const vv = v > 25 ? e.speed : v; // ignore teleports (blasts, wrap re-anchors)
        e.speed += (vv - e.speed) * Math.min(1, dt * 10);
      }
      e.px = wx;
      e.pz = wz;

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
      // face the heading, the short way round; remember the turn rate for leaning
      const dyaw = wrapDelta(heading - e.yaw, Math.PI * 2) * Math.min(1, dt * 9);
      e.yaw += dyaw;
      e.turn += ((dt > 0 ? dyaw / dt : 0) - e.turn) * Math.min(1, dt * 8);
      e.fig.root.rotation.y = e.yaw;

      // hit flinch
      if (u.hp < e.lastHp - 0.01) e.anim.flinch();
      e.lastHp = u.hp;

      // 5. ANIMATE (with LOD)
      const inp = this.chooseClip(u, e, spot ? (gb!.kind as string) : null, winner ?? null);
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
        e.ring.position.set(wx, y + 0.08, wz);
        tiltToGround(e.ring, world, ix, iz);
      }
    }

    // Units that vanished: deaths become ghosts; resets just disappear. A
    // world reset/level load removes most units in one frame — no ghosts then.
    let vanished = 0;
    for (const id of this.entries.keys()) if (!live.has(id)) vanished++;
    const reset = vanished > 6 && vanished > live.size * 0.5;
    for (const [id, e] of this.entries) {
      if (live.has(id)) continue;
      this.entries.delete(id);
      this.scene.remove(e.ring);
      if (e.fig.root.visible && !reset) {
        const mode: Ghost['mode'] = e.kind === 'shaman' ? 'ascend' : e.inWater ? 'drown' : 'die';
        let fade: THREE.Material[] | null = null;
        if (mode === 'ascend') {
          // a private transparent copy of the materials, so the fade is ours alone
          fade = e.fig.meshes.map((m) => {
            const mm = fadeCopy(m.material as THREE.Material);
            m.material = mm;
            return mm;
          });
        }
        this.ghosts.push({ fig: e.fig, anim: e.anim, t: 0, mode, tx: e.tx, tz: e.tz, yaw: e.yaw, fade });
      } else {
        this.disposeFig(e.fig);
      }
    }
    this.updateGhosts(world, camTarget, dt);
  }

  /** Map sim state → clip. */
  private chooseClip(u: AnyUnit, e: Entry, garrisonKind: string | null, winner: string | null): AnimInput {
    const speed = e.speed;
    const turnRate = e.turn;
    const kind = u.kind as string;
    const task = u.task as string;
    const def = UNITS[u.kind as UnitKind];
    let clip: ClipName = 'idle';
    let phase: number | undefined;
    let period: number | undefined;
    if (garrisonKind === 'shrine') clip = 'pray';
    else if (garrisonKind === 'tower') clip = 'idle';
    else if (e.inWater) clip = 'drown';
    else if (u.state === 'fighting' || task === 'attack' && u.state !== 'moving') {
      if (kind === 'chanter') clip = 'chant';
      else if (kind === 'firewarrior') clip = 'throw';
      else if (kind === 'shaman' || kind === 'wildman') clip = 'idle';
      else clip = 'attack';
      const cool = def?.cooldown ?? 1.2;
      if (cool > 0 && clip !== 'chant') {
        // phase 0 at the sim's strike moment → our clip's impact frame
        const impact = clip === 'throw' ? 0.6 : 0.5;
        phase = (1 - THREE.MathUtils.clamp(u.attackCooldown / cool, 0, 1) + impact) % 1;
      }
    } else if (u.state === 'working') {
      if (u.castSpell) {
        clip = 'cast';
        try {
          period = spellDef(u.castSpell as never)?.castSeconds;
        } catch {
          period = undefined;
        }
      } else if (task === 'chop') clip = 'chop';
      else if (task === 'worship') clip = 'pray';
      else if (task === 'chant' || kind === 'chanter') clip = 'chant';
      else clip = 'build';
    } else if (u.state === 'moving') {
      if (u.carrying) clip = 'carry';
      else clip = speed > runThreshold(e.fig) || num(u, 'warsongTime', 0) > 0 ? 'run' : 'walk';
    } else {
      if (u['praying']) clip = 'pray';
      else if (u['chanting'] || task === 'chant') clip = 'chant';
      else if (num(u, 'cheer', 0) > 0 || (winner && winnerMatches(winner, u.tribe))) clip = 'cheer';
    }
    // still moving visibly but sim says idle (end of path) → let the blend handle it
    if (clip === 'idle' && speed > 1.2 && !garrisonKind) clip = 'walk';
    return { clip, speed, turnRate, phase, period };
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
        g.anim.update(dt, { clip: 'die', speed: 0, turnRate: 0 });
        // lie still, then sink into the earth
        y -= Math.max(0, g.t - 2.2) * 0.6;
        done = g.t > 4;
      } else if (g.mode === 'drown') {
        g.anim.update(dt, { clip: 'drown', speed: 0, turnRate: 0 });
        y = -0.9 - g.t * 1.1 - curvatureDrop(relX, relZ);
        done = g.t > 2.5;
      } else {
        // a leader rises in light and fades
        g.anim.update(dt, { clip: g.t < 1.2 ? 'die' : 'cast', speed: 0, turnRate: 0 });
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
    const relX = wrapDelta(u.x * TILE - camTarget.x, WORLD_UNITS);
    const relZ = wrapDelta(u.z * TILE - camTarget.z, WORLD_UNITS);
    const y = Math.max(0, world.map.sampleHeight(u.x, u.z)) - curvatureDrop(relX, relZ);
    const h = UNITS[u.kind as UnitKind]?.height ?? 2.3;
    const v = new THREE.Vector3(camTarget.x + relX, y + h * 0.45, camTarget.z + relZ); // chest height
    v.project(camera);
    if (v.z > 1) return null;
    return { x: (v.x + 1) * 0.5 * innerWidth, y: (1 - v.y) * 0.5 * innerHeight };
  }
}

function winnerMatches(gameOver: string, tribe: string): boolean {
  // Old sim: 'victory' = the player won, 'defeat' = the player lost. Newer sims may name the tribe.
  if (gameOver === 'victory') return tribe === 'player';
  if (gameOver === 'defeat') return tribe !== 'player' && tribe !== 'wild';
  return gameOver === tribe;
}

const _n = new THREE.Vector3();
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
