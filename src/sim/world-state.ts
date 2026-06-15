/**
 * sim/world-state.ts — THE game state, and the systems that advance it.
 *
 * Everything that "exists" in the game lives here as plain data: the
 * heightmap, every unit, tree and building, each tribe's wood and mana.
 * No Three.js, no DOM — the renderer reads this state every frame and
 * never writes back. The sim stays deterministic and testable.
 *
 * PHASE 5 — WAR. The big structural change: there are now TWO tribes, and
 * they are symmetrical. The red tribe runs the exact same code yours does —
 * same assignWork brain, same buildings, same breeding, same shaman rules —
 * just steered by sim/ai.ts instead of your mouse. Symmetry is the honest
 * way to build an RTS opponent: the AI gets no cheats, only decisions.
 *
 * Combat is deliberately readable: every unit kind has {dmg, range,
 * cooldown, sight} (config.ts). Soldiers auto-engage enemies inside their
 * sight; braves have sight 0 and flee instead; shamans fight with spells
 * only. Towers are stationary soldiers wearing architecture. Type counters
 * fall out of the numbers, not special cases: firewarriors out-range
 * warriors, warriors shred whatever they catch.
 *
 * Win/lose: a tribe is ALIVE while it has any follower or any building
 * (the shaman only reincarnates for a living tribe). When one tribe stops
 * being alive, the other gets the planet.
 */

import {
  BREED_SECONDS,
  BUILD_COSTS,
  CHOP_SECONDS,
  CivId,
  CIVS,
  COMBAT,
  Difficulty,
  DIFFICULTIES,
  FLEE_RADIUS,
  HUT_BUILD_SECONDS,
  HUT_CAPACITY,
  HUT_FLAT_TOLERANCE,
  MANA_BASE_RATE,
  MANA_CAP,
  MANA_PER_FOLLOWER,
  MANA_PER_RESIDENT,
  MAX_BUILDERS,
  MIN_BRAVES,
  OUTING_SECONDS,
  POP_BASE,
  POP_PER_HUT,
  START_WOOD,
  STARTING_SPELLS,
  TOWER,
  TRAIN_COSTS,
  TRAIN_SECONDS,
  TREE_REGROW_SECONDS,
  UNIT_SPEED,
  WOOD_TARGET,
  WORLD_SIZE,
  WORSHIP_SECONDS,
} from '../config';
import { hash2 } from '../core/noise';
import { wrapDelta } from '../core/util';
import { LevelData, packTerrain, unpackTerrain } from '../level/level-format';
import { Heightmap } from '../world/heightmap';
import { tickAi } from './ai';
import { findNearestWalkable, findPath, obstacles, tileIndex, walkable } from './pathfinding';
import { castSpell, spellMeta, tickJobs, SpellId, SpellJob } from './spells';

export type UnitKind = 'brave' | 'shaman' | 'wildman' | 'warrior' | 'firewarrior';
export type Tribe = 'player' | 'red' | 'wild';
/** Tribes with an economy and a stake in the war (wildmen are scenery with legs). */
export type TribeId = 'player' | 'red';
export type BuildingKind = 'hut' | 'warriorHut' | 'fireHut' | 'tower';

/** WHY a unit is en route / busy. 'none' = no agenda, open to suggestions. */
export type Task =
  | 'none'
  | 'chop'
  | 'deliverWood'
  | 'build'
  | 'goHome'
  | 'train'
  | 'attack'
  | 'attackBuilding'
  | 'worship';

/** Skirmish setup, chosen on the start screen. */
export interface GameSettings {
  playerCiv: CivId;
  difficulty: Difficulty;
}

/**
 * An ancient stone head holding one spell. The first tribe whose LEADER
 * worships here claims the spell forever — the original's vault-of-
 * knowledge race, and the engine of the mid-game: the far monuments hold
 * the apocalyptic spells, and both gods know it.
 */
export interface Monument {
  x: number;
  z: number;
  spell: SpellId;
  claimedBy: TribeId | null;
}

export interface GameEvent {
  type: string;
  x: number;
  z: number;
  /** Optional second point (projectile destination). */
  x2?: number;
  z2?: number;
  magnitude?: number;
}

const CAST_RANGE = 14;
const CAST_SECONDS = 0.9;
const SHAMAN_RESPAWN_SECONDS = 15;
/** How close a right-click must land to an enemy to mean "attack him". */
export const ATTACK_PICK_RADIUS = 2;

export interface Unit {
  id: number;
  kind: UnitKind;
  tribe: Tribe;
  x: number;
  z: number;
  prevX: number;
  prevZ: number;
  heading: number;
  state: 'idle' | 'moving' | 'working' | 'inside' | 'fighting';
  task: Task;
  path: Array<{ x: number; z: number }>;
  pathIndex: number;
  goal: { x: number; z: number } | null;
  idleTime: number;
  workTimer: number;
  targetTree: number;
  targetBuilding: number;
  /** Unit id being hunted when task is 'attack', else -1. */
  targetUnit: number;
  /** Index into world.monuments when task is 'worship', else -1. */
  targetMonument: number;
  /** Seconds until the next swing/shot. */
  attackCooldown: number;
  carrying: boolean;
  hidden: boolean;
  home: number;
  hp: number;
  castSpell: SpellId | null;
  castTarget: { x: number; z: number } | null;
}

export interface Tree {
  x: number;
  z: number;
  alive: boolean;
  regrow: number;
}

export interface Building {
  id: number;
  tribe: TribeId;
  kind: BuildingKind;
  x: number;
  z: number;
  progress: number;
  hp: number;
  residents: number;
  breedTimer: number;
  outingTimer: number;
  /** Towers reload; training huts pace their recruiting. */
  workTimer: number;
}

/** Everything one tribe owns that isn't a unit or a building. */
export interface TribeState {
  wood: number;
  mana: number;
  home: { x: number; z: number };
  /** Architecture + leader theme. Pure flavor; the sim is civ-blind. */
  civ: CivId;
  /** Spells this tribe has learned (starts small; grows at monuments). */
  unlocked: Set<SpellId>;
  shamanRespawn: number;
  /** Seconds since this tribe last took damage — the AI's alarm bell. */
  threatTimer: number;
  /** Present on AI-driven tribes only. See sim/ai.ts. */
  ai: { state: 'grow' | 'harass' | 'assault' | 'defend'; evalTimer: number } | null;
}

const wrapf = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
const hostile = (a: Tribe, b: Tribe) =>
  (a === 'player' && b === 'red') || (a === 'red' && b === 'player');

/** Fisher–Yates, in place. */
function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export class World {
  readonly map = new Heightmap();
  units: Unit[] = [];
  trees: Tree[] = [];
  buildings: Building[] = [];
  monuments: Monument[] = [];
  tribes!: Record<TribeId, TribeState>;
  settings: GameSettings = { playerCiv: 'forest', difficulty: 'normal' };
  jobs: SpellJob[] = [];
  readonly swamp = new Map<number, number>();
  events: GameEvent[] = [];
  gameOver: 'victory' | 'defeat' | null = null;

  private nextId = 1;

  // -------------------------------------------------------------------------
  // Levels: loading a designed world, capturing the current one
  // -------------------------------------------------------------------------

  /**
   * Build the world from a level document instead of noise. Same setup
   * path as reset() from the tribes onward — a level is just terrain and
   * placements that someone chose instead of rolled.
   */
  async loadLevel(level: LevelData, settings: GameSettings): Promise<void> {
    this.settings = settings;
    this.map.heights.set(await unpackTerrain(level.terrain));
    this.map.version++;
    this.units = [];
    this.buildings = [];
    this.jobs = [];
    this.swamp.clear();
    this.events = [];
    this.gameOver = null;
    obstacles.clear();

    this.trees = [];
    for (let i = 0; i < level.trees.length; i += 2) {
      this.trees.push({ x: level.trees[i], z: level.trees[i + 1], alive: true, regrow: 0 });
    }
    this.monuments = level.monuments.map((m) => ({ ...m, claimedBy: null }));

    const otherCivs = (Object.keys(CIVS) as CivId[]).filter((c) => c !== settings.playerCiv);
    const redCiv =
      level.redCiv && level.redCiv !== settings.playerCiv
        ? level.redCiv
        : otherCivs[Math.floor(Math.random() * otherCivs.length)];

    this.tribes = {
      player: this.newTribe({ ...level.homes.player }, settings.playerCiv, null),
      red: this.newTribe({ ...level.homes.red }, redCiv, { state: 'grow', evalTimer: 2 }),
    };

    const redBraves = DIFFICULTIES[settings.difficulty].redStartBraves;
    for (const tribe of ['player', 'red'] as TribeId[]) {
      const home = this.tribes[tribe].home;
      const braves = tribe === 'red' ? redBraves : 8;
      this.spawn('shaman', tribe, home.x, home.z);
      for (let i = 0; i < braves; i++) {
        const a = (i / braves) * Math.PI * 2;
        this.spawnNearWalkable('brave', tribe, home.x + Math.cos(a) * 2.5, home.z + Math.sin(a) * 2.5);
      }
    }
    for (let i = 0; i < level.wildmen.length; i += 2) {
      this.spawnNearWalkable('wildman', 'wild', level.wildmen[i], level.wildmen[i + 1]);
    }
  }

  /** Snapshot the current world as a level document (the editor's Save). */
  async captureLevel(meta: { name: string; author: string; desc: string }): Promise<LevelData> {
    const wild: number[] = [];
    for (const u of this.units) {
      if (u.kind === 'wildman') wild.push(Math.round(u.x), Math.round(u.z));
    }
    const trees: number[] = [];
    for (const t of this.trees) {
      if (t.alive) trees.push(t.x, t.z);
    }
    return {
      v: 1,
      ...meta,
      terrain: await packTerrain(this.map.heights),
      trees,
      monuments: this.monuments.map((m) => ({ x: m.x, z: m.z, spell: m.spell })),
      homes: {
        player: { ...this.tribes.player.home },
        red: { ...this.tribes.red.home },
      },
      wildmen: wild,
      redCiv: this.tribes.red.civ,
    };
  }

  /** Tear down and rebuild the whole world: terrain, trees, BOTH tribes. */
  reset(seed: number, settings?: GameSettings): void {
    if (settings) this.settings = settings;
    this.map.generate(seed);
    this.units = [];
    this.buildings = [];
    this.jobs = [];
    this.swamp.clear();
    this.events = [];
    this.gameOver = null;
    obstacles.clear();
    this.placeTrees(seed);

    const playerHome = this.findSettleSite(true, null);
    // The enemy settles as far away as a good site allows — a skirmish
    // needs a march between the villages, not a brawl in the nursery.
    const redHome = this.findSettleSite(true, playerHome);

    // The red god plays a different civilization than you, picked at random
    // — purely cosmetic, but fighting your own architecture feels wrong.
    const otherCivs = (Object.keys(CIVS) as CivId[]).filter((c) => c !== this.settings.playerCiv);
    const redCiv = otherCivs[Math.floor(Math.random() * otherCivs.length)];

    this.tribes = {
      player: this.newTribe(playerHome, this.settings.playerCiv, null),
      red: this.newTribe(redHome, redCiv, { state: 'grow', evalTimer: 2 }),
    };

    const redBraves = DIFFICULTIES[this.settings.difficulty].redStartBraves;
    for (const tribe of ['player', 'red'] as TribeId[]) {
      const home = this.tribes[tribe].home;
      const braves = tribe === 'red' ? redBraves : 8;
      this.spawn('shaman', tribe, home.x, home.z);
      for (let i = 0; i < braves; i++) {
        const a = (i / braves) * Math.PI * 2;
        this.spawnNearWalkable('brave', tribe, home.x + Math.cos(a) * 2.5, home.z + Math.sin(a) * 2.5);
      }
    }

    this.placeMonuments();

    for (let i = 0; i < 14; i++) {
      const spot = this.findSettleSite(false, null);
      this.spawnNearWalkable('wildman', 'wild', spot.x, spot.z);
    }
  }

  private newTribe(home: { x: number; z: number }, civ: CivId, ai: TribeState['ai']): TribeState {
    return {
      wood: START_WOOD,
      mana: 0,
      home,
      civ,
      unlocked: new Set<SpellId>(STARTING_SPELLS),
      shamanRespawn: 0,
      threatTimer: 0,
      ai,
    };
  }

  /**
   * Scatter the six lockable spells into monuments. Each tribe gets one
   * modest spell within sprinting distance (a tutorial-by-geography), and
   * the apocalyptic pair lands far from both homes — a prize you must
   * cross the planet, and probably the other god, to claim.
   */
  private placeMonuments(): void {
    this.monuments = [];
    const nearPool: SpellId[] = ['flatten', 'landbridge', 'swamp', 'lightning'];
    const farPool: SpellId[] = ['earthquake', 'volcano'];
    shuffle(nearPool);

    for (const tribe of ['player', 'red'] as TribeId[]) {
      const home = this.tribes[tribe].home;
      const spot = this.findMonumentSpot(home, 8, 16);
      if (spot) this.monuments.push({ ...spot, spell: nearPool.pop()!, claimedBy: null });
    }
    // Remaining near-tier spells + the big two go to neutral ground.
    for (const spell of [...nearPool, ...farPool]) {
      const spot = this.findMonumentSpot(null, 0, 0);
      if (spot) this.monuments.push({ ...spot, spell, claimedBy: null });
    }
  }

  /** A walkable, flattish tile — near `anchor` if given, else far from both homes. */
  private findMonumentSpot(
    anchor: { x: number; z: number } | null,
    minR: number,
    maxR: number,
  ): { x: number; z: number } | null {
    for (let attempt = 0; attempt < 200; attempt++) {
      let x: number;
      let z: number;
      if (anchor) {
        const a = Math.random() * Math.PI * 2;
        const r = minR + Math.random() * (maxR - minR);
        x = Math.round(anchor.x + Math.cos(a) * r);
        z = Math.round(anchor.z + Math.sin(a) * r);
      } else {
        x = Math.floor(Math.random() * WORLD_SIZE);
        z = Math.floor(Math.random() * WORLD_SIZE);
        const dP = Math.hypot(wrapDelta(x - this.tribes.player.home.x, WORLD_SIZE), wrapDelta(z - this.tribes.player.home.z, WORLD_SIZE));
        const dR = Math.hypot(wrapDelta(x - this.tribes.red.home.x, WORLD_SIZE), wrapDelta(z - this.tribes.red.home.z, WORLD_SIZE));
        if (dP < 22 || dR < 22) continue; // neutral ground only
      }
      if (!walkable(this.map, x, z)) continue;
      if (this.monuments.some((m) => Math.hypot(wrapDelta(m.x - x, WORLD_SIZE), wrapDelta(m.z - z, WORLD_SIZE)) < 10)) continue;
      return { x: this.map.wrap(x), z: this.map.wrap(z) };
    }
    return null;
  }

  /** Advance the whole simulation by one fixed tick. */
  tick(dt: number): void {
    for (const u of this.units) {
      u.prevX = u.x;
      u.prevZ = u.z;
      switch (u.state) {
        case 'idle': this.tickIdle(u, dt); break;
        case 'moving': this.tickMoving(u, dt); break;
        case 'working': this.tickWorking(u, dt); break;
        case 'fighting': this.tickFighting(u, dt); break;
        case 'inside': break;
      }
    }
    this.tickBuildings(dt);
    this.tickTrees(dt);
    tickJobs(this, dt);
    tickAi(this, dt);

    for (const [idx, left] of this.swamp) {
      if (left - dt <= 0) this.swamp.delete(idx);
      else this.swamp.set(idx, left - dt);
    }

    // Environmental hazards: the ground is where danger lives.
    for (const u of this.units) {
      if (u.hidden) continue;
      if (this.map.sampleHeight(u.x, u.z) < -0.25) {
        if (u.hp > 0 && Math.random() < dt * 2) this.events.push({ type: 'splash', x: u.x, z: u.z });
        this.hurtUnit(u, dt * 5);
      }
      if (this.swamp.has(tileIndex(Math.round(u.x), Math.round(u.z)))) {
        this.hurtUnit(u, dt * 9);
      }
    }

    // Deaths — swept once so nothing iterates a mutating list.
    const dead = this.units.filter((u) => u.hp <= 0);
    if (dead.length > 0) {
      for (const u of dead) {
        this.events.push({ type: 'death', x: u.x, z: u.z });
        if (u.hidden) {
          const b = this.getBuilding(u.home);
          if (b) b.residents--;
        }
        if (u.kind === 'shaman' && u.tribe !== 'wild') {
          this.tribes[u.tribe as TribeId].shamanRespawn = SHAMAN_RESPAWN_SECONDS;
        }
      }
      this.units = this.units.filter((u) => u.hp > 0);
    }

    // Per-tribe upkeep: mana worship, shaman reincarnation, threat decay.
    for (const id of ['player', 'red'] as TribeId[]) {
      const t = this.tribes[id];
      t.threatTimer = Math.max(0, t.threatTimer - dt);

      const pop = this.tribePopulation(id);
      const housed = this.buildings.reduce((s, b) => (b.tribe === id ? s + b.residents : s), 0);
      t.mana = Math.min(MANA_CAP, t.mana + (MANA_BASE_RATE + pop * MANA_PER_FOLLOWER + housed * MANA_PER_RESIDENT) * dt);

      // The shaman only comes back for a tribe that still exists.
      if (t.shamanRespawn > 0 && this.tribeAlive(id)) {
        t.shamanRespawn -= dt;
        if (t.shamanRespawn <= 0) {
          this.spawnNearWalkable('shaman', id, t.home.x, t.home.z);
          this.events.push({ type: 'convert', x: t.home.x, z: t.home.z });
        }
      }
    }

    // The war ends when a tribe stops existing.
    if (!this.gameOver) {
      if (!this.tribeAlive('red')) this.gameOver = 'victory';
      else if (!this.tribeAlive('player')) this.gameOver = 'defeat';
    }
  }

  tribeAlive(id: TribeId): boolean {
    return (
      this.units.some((u) => u.tribe === id) || this.buildings.some((b) => b.tribe === id)
    );
  }

  // -------------------------------------------------------------------------
  // Unit behaviors
  // -------------------------------------------------------------------------

  private tickIdle(u: Unit, dt: number): void {
    u.idleTime += dt;

    // Soldiers on standby scan for trouble...
    if (COMBAT[u.kind].sight > 0 && u.task === 'none' && this.acquireTarget(u)) return;
    // ...and with no war to fight, they eventually billet in a hut like
    // anyone else. This matters beyond flavor: breeding requires residents,
    // so a tribe whose braves all died can still recover as long as
    // SOMEONE moves back in. (Found the hard way: an all-soldier tribe
    // was deadlocked sterile forever.)
    if (COMBAT[u.kind].sight > 0 && u.task === 'none' && u.idleTime > 12 && this.tryMoveIn(u)) return;

    // Braves are civilians: enemy soldiers nearby → run for the totem.
    if (u.kind === 'brave' && u.tribe !== 'wild' && this.enemySoldierNear(u, FLEE_RADIUS)) {
      const home = this.tribes[u.tribe as TribeId].home;
      this.abandonTask(u);
      this.sendTo(u, home.x, home.z, 1200);
      return;
    }

    if (u.kind === 'brave' && u.tribe !== 'wild' && u.task === 'none' && u.idleTime > 1.2) {
      if (this.assignWork(u)) return;
    }

    const restless = u.kind === 'wildman' ? 3 + Math.random() * 4 : 6 + Math.random() * 6;
    if (u.idleTime > restless) {
      const range = u.kind === 'wildman' ? 9 : 4;
      this.sendTo(u, Math.round(u.x + (Math.random() * 2 - 1) * range), Math.round(u.z + (Math.random() * 2 - 1) * range), 600);
      u.idleTime = 0;
    }
  }

  /** The village brain (see Phase 3) — now works for ANY economic tribe. */
  private assignWork(u: Unit): boolean {
    const tribe = this.tribes[u.tribe as TribeId];

    if (u.carrying) {
      u.task = 'deliverWood';
      if (this.sendTo(u, tribe.home.x, tribe.home.z)) return true;
      u.carrying = false;
      u.task = 'none';
      return false;
    }

    for (const b of this.buildings) {
      if (b.progress >= 1 || b.tribe !== u.tribe) continue;
      if (this.countUnits((q) => q.task === 'build' && q.targetBuilding === b.id) >= MAX_BUILDERS) continue;
      u.task = 'build';
      u.targetBuilding = b.id;
      if (this.sendTo(u, b.x + Math.round(Math.random() * 4 - 2), b.z + 2)) return true;
      u.task = 'none';
      u.targetBuilding = -1;
    }

    if (tribe.wood < WOOD_TARGET) {
      const treeIdx = this.nearestChoppableTree(u);
      if (treeIdx >= 0) {
        u.task = 'chop';
        u.targetTree = treeIdx;
        if (this.sendTo(u, this.trees[treeIdx].x, this.trees[treeIdx].z)) return true;
        u.task = 'none';
        u.targetTree = -1;
      }
    }

    if (u.idleTime > (u.home >= 0 ? 9 : 3) && this.tryMoveIn(u)) return true;

    return false;
  }

  /** Head for a hut with a free bunk (own home first). Used by braves and
   *  off-duty soldiers alike — see the sterile-tribe note in tickIdle. */
  private tryMoveIn(u: Unit): boolean {
    const hut = u.home >= 0
      ? this.buildings.find((b) => b.id === u.home && b.residents < HUT_CAPACITY)
      : this.buildings.find((b) => b.tribe === u.tribe && b.kind === 'hut' && b.progress >= 1 && b.residents < HUT_CAPACITY);
    if (!hut) return false;
    u.task = 'goHome';
    u.targetBuilding = hut.id;
    if (this.sendTo(u, hut.x, hut.z + 1)) return true; // the door tile
    u.task = 'none';
    u.targetBuilding = -1;
    return false;
  }

  private tickMoving(u: Unit, dt: number): void {
    if (u.castSpell && this.castTargetInRange(u)) {
      this.beginCast(u);
      return;
    }
    // Hunters check range continuously — stop and swing the moment the
    // prey is reachable instead of marching to where it USED to be.
    if (u.task === 'attack') {
      const target = this.unitById(u.targetUnit);
      if (!target || target.hp <= 0 || target.hidden) {
        this.abandonTask(u);
        return;
      }
      if (this.distTo(u, target.x, target.z) <= COMBAT[u.kind].range) {
        u.state = 'fighting';
        return;
      }
    }

    const wp = u.path[u.pathIndex];
    if (!wp) {
      this.onArrive(u);
      return;
    }
    if (!walkable(this.map, wp.x, wp.z) && !(u.goal && wp.x === u.goal.x && wp.z === u.goal.z)) {
      if (!u.goal || !this.sendTo(u, u.goal.x, u.goal.z)) this.abandonTask(u);
      return;
    }

    const dx = wrapDelta(wp.x - u.x, WORLD_SIZE);
    const dz = wrapDelta(wp.z - u.z, WORLD_SIZE);
    const dist = Math.hypot(dx, dz);
    const step = UNIT_SPEED[u.kind] * dt;

    if (dist <= step) {
      u.x = wp.x;
      u.z = wp.z;
      u.pathIndex++;
      if (u.pathIndex >= u.path.length) this.onArrive(u);
    } else {
      u.x = wrapf(u.x + (dx / dist) * step);
      u.z = wrapf(u.z + (dz / dist) * step);
      u.heading = Math.atan2(dx, dz);
    }
  }

  private onArrive(u: Unit): void {
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
    u.idleTime = 0;

    if (u.castSpell) {
      this.beginCast(u);
      return;
    }

    switch (u.task) {
      case 'chop': {
        const tree = this.trees[u.targetTree];
        if (tree?.alive) {
          u.state = 'working';
          u.workTimer = CHOP_SECONDS;
          u.heading = Math.atan2(wrapDelta(tree.x - u.x, WORLD_SIZE), wrapDelta(tree.z - u.z, WORLD_SIZE));
        } else this.abandonTask(u);
        return;
      }
      case 'build': {
        const b = this.getBuilding(u.targetBuilding);
        if (b && b.progress < 1) u.state = 'working';
        else this.abandonTask(u);
        return;
      }
      case 'deliverWood': {
        if (u.tribe !== 'wild') this.tribes[u.tribe as TribeId].wood++;
        u.carrying = false;
        this.abandonTask(u);
        return;
      }
      case 'goHome': {
        const b = this.getBuilding(u.targetBuilding);
        if (b && b.progress >= 1 && b.residents < HUT_CAPACITY) {
          u.hidden = true;
          u.state = 'inside';
          u.home = b.id;
          u.task = 'none';
          b.residents++;
        } else this.abandonTask(u);
        return;
      }
      case 'train': {
        const b = this.getBuilding(u.targetBuilding);
        if (b && b.progress >= 1) {
          u.state = 'working';
          u.workTimer = TRAIN_SECONDS;
        } else this.abandonTask(u);
        return;
      }
      case 'attack': {
        const target = this.unitById(u.targetUnit);
        if (!target || target.hp <= 0 || target.hidden) this.abandonTask(u);
        else if (this.distTo(u, target.x, target.z) <= COMBAT[u.kind].range) u.state = 'fighting';
        // Target moved on — chase its new position (recursion-safe: one hop).
        else if (!this.sendTo(u, target.x, target.z)) this.abandonTask(u);
        return;
      }
      case 'attackBuilding': {
        const b = this.getBuilding(u.targetBuilding);
        if (b) u.state = 'fighting';
        else this.abandonTask(u);
        return;
      }
      case 'worship': {
        const m = this.monuments[u.targetMonument];
        if (m && !m.claimedBy && this.distTo(u, m.x, m.z) < 3) {
          u.state = 'working';
          u.workTimer = WORSHIP_SECONDS;
          u.heading = Math.atan2(wrapDelta(m.x - u.x, WORLD_SIZE), wrapDelta(m.z - u.z, WORLD_SIZE));
        } else this.abandonTask(u); // claimed while we walked, or we got lost
        return;
      }
      default:
        u.state = 'idle';
    }
  }

  private tickWorking(u: Unit, dt: number): void {
    if (u.castSpell) {
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        const spell = u.castSpell;
        const target = u.castTarget!;
        const tribe = u.tribe as TribeId;
        u.castSpell = null;
        u.castTarget = null;
        u.state = 'idle';
        if (this.tribes[tribe].mana >= spellMeta(spell).cost) {
          this.tribes[tribe].mana -= spellMeta(spell).cost;
          castSpell(this, spell, target.x, target.z, u.x, u.z, tribe);
        }
      }
      return;
    }

    if (u.task === 'chop') {
      const tree = this.trees[u.targetTree];
      if (!tree?.alive) {
        this.abandonTask(u);
        return;
      }
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        tree.alive = false;
        tree.regrow = TREE_REGROW_SECONDS * (0.7 + Math.random() * 0.6);
        u.carrying = true;
        u.targetTree = -1;
        u.task = 'deliverWood';
        const home = this.tribes[u.tribe as TribeId].home;
        if (!this.sendTo(u, home.x, home.z)) this.abandonTask(u);
      }
      return;
    }

    if (u.task === 'build') {
      const b = this.getBuilding(u.targetBuilding);
      if (!b || b.progress >= 1) {
        this.abandonTask(u);
        return;
      }
      b.progress = Math.min(1, b.progress + dt / HUT_BUILD_SECONDS);
      if (b.progress < 0.4) this.map.flatten(b.x, b.z, 2.5, dt * 0.5);
      return;
    }

    if (u.task === 'worship') {
      const m = this.monuments[u.targetMonument];
      if (!m || m.claimedBy) {
        this.abandonTask(u); // the other god got here first
        return;
      }
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        // The stone speaks. One spell, one tribe, forever.
        m.claimedBy = u.tribe as TribeId;
        this.tribes[u.tribe as TribeId].unlocked.add(m.spell);
        this.events.push({ type: 'unlock', x: m.x, z: m.z });
        this.abandonTask(u);
      }
      return;
    }

    if (u.task === 'train') {
      const b = this.getBuilding(u.targetBuilding);
      if (!b || b.progress < 1) {
        this.abandonTask(u);
        return;
      }
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        // Graduation: the brave walks out a soldier. The wood was promised
        // when training started; collect it now (or call it off if the
        // stockpile was raided meanwhile).
        const cost = TRAIN_COSTS[b.kind as 'warriorHut' | 'fireHut'] ?? 0;
        const tribe = this.tribes[u.tribe as TribeId];
        if (tribe.wood >= cost) {
          tribe.wood -= cost;
          u.kind = b.kind === 'warriorHut' ? 'warrior' : 'firewarrior';
          u.hp = COMBAT[u.kind].hp;
          this.events.push({ type: 'convert', x: u.x, z: u.z });
        }
        this.abandonTask(u);
      }
      return;
    }

    this.abandonTask(u);
  }

  /** Toe to toe (or bow range): face the target, count down, strike. */
  private tickFighting(u: Unit, dt: number): void {
    u.attackCooldown -= dt;
    const stats = COMBAT[u.kind];

    if (u.task === 'attack') {
      const target = this.unitById(u.targetUnit);
      if (!target || target.hp <= 0 || target.hidden) {
        this.abandonTask(u);
        return;
      }
      const d = this.distTo(u, target.x, target.z);
      if (d > stats.range + 0.4) {
        // It rabbited — back to the chase.
        u.state = 'moving';
        if (!this.sendTo(u, target.x, target.z)) this.abandonTask(u);
        return;
      }
      u.heading = Math.atan2(wrapDelta(target.x - u.x, WORLD_SIZE), wrapDelta(target.z - u.z, WORLD_SIZE));
      if (u.attackCooldown <= 0) {
        u.attackCooldown = stats.cooldown;
        this.strike(u, target.x, target.z, stats.range > 2);
        this.hurtUnit(target, stats.dmg);
      }
      return;
    }

    if (u.task === 'attackBuilding') {
      const b = this.getBuilding(u.targetBuilding);
      if (!b) {
        this.abandonTask(u);
        return;
      }
      const d = this.distTo(u, b.x, b.z);
      if (d > Math.max(stats.range, 2.2) + 0.4) {
        u.state = 'moving';
        if (!this.sendTo(u, b.x, b.z + 2)) this.abandonTask(u);
        return;
      }
      u.heading = Math.atan2(wrapDelta(b.x - u.x, WORLD_SIZE), wrapDelta(b.z - u.z, WORLD_SIZE));
      if (u.attackCooldown <= 0) {
        u.attackCooldown = stats.cooldown;
        this.strike(u, b.x, b.z, stats.range > 2);
        this.hurtBuilding(b, stats.dmg / 30); // buildings take ~8 warrior swings
      }
      return;
    }

    this.abandonTask(u);
  }

  /** Emit the violence events the renderer turns into flashes/projectiles. */
  private strike(u: Unit, tx: number, tz: number, ranged: boolean): void {
    if (ranged) this.events.push({ type: 'fireball', x: u.x, z: u.z, x2: tx, z2: tz });
    else this.events.push({ type: 'hit', x: tx, z: tz });
  }

  /** Look around: nearest hostile unit in sight, else hostile building. */
  private acquireTarget(u: Unit): boolean {
    const sight = COMBAT[u.kind].sight;
    let best: Unit | null = null;
    let bestD: number = sight;
    for (const q of this.units) {
      if (q.hidden || !hostile(u.tribe, q.tribe)) continue;
      const d = this.distTo(u, q.x, q.z);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    if (best) {
      u.task = 'attack';
      u.targetUnit = best.id;
      if (this.distTo(u, best.x, best.z) <= COMBAT[u.kind].range) u.state = 'fighting';
      else if (!this.sendTo(u, best.x, best.z)) this.abandonTask(u);
      return u.task === 'attack';
    }
    for (const b of this.buildings) {
      if (!hostile(u.tribe, b.tribe)) continue;
      if (this.distTo(u, b.x, b.z) < sight) {
        u.task = 'attackBuilding';
        u.targetBuilding = b.id;
        if (!this.sendTo(u, b.x, b.z + 2)) this.abandonTask(u);
        return u.task === 'attackBuilding';
      }
    }
    return false;
  }

  private enemySoldierNear(u: Unit, radius: number): boolean {
    return this.units.some(
      (q) =>
        !q.hidden &&
        hostile(u.tribe, q.tribe) &&
        COMBAT[q.kind].sight > 0 &&
        this.distTo(u, q.x, q.z) < radius,
    );
  }

  private abandonTask(u: Unit): void {
    u.task = 'none';
    u.targetTree = -1;
    u.targetBuilding = -1;
    u.targetUnit = -1;
    u.targetMonument = -1;
    u.castSpell = null;
    u.castTarget = null;
    u.state = 'idle';
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
  }

  // -------------------------------------------------------------------------
  // Spellcasting & damage
  // -------------------------------------------------------------------------

  /** Ask a tribe's shaman to cast. UI calls this for you; the AI for red. */
  orderCast(tribe: TribeId, spell: SpellId, tx: number, tz: number): void {
    const shaman = this.units.find((u) => u.kind === 'shaman' && u.tribe === tribe);
    if (
      !shaman ||
      !this.tribes[tribe].unlocked.has(spell) || // knowledge must be earned at the stones
      this.tribes[tribe].mana < spellMeta(spell).cost
    ) {
      if (tribe === 'player') this.events.push({ type: 'denied', x: tx, z: tz });
      return;
    }
    shaman.task = 'none';
    shaman.castSpell = spell;
    shaman.castTarget = { x: this.map.wrap(Math.round(tx)), z: this.map.wrap(Math.round(tz)) };
    if (this.castTargetInRange(shaman)) this.beginCast(shaman);
    else if (!this.sendTo(shaman, tx, tz)) {
      shaman.castSpell = null;
      shaman.castTarget = null;
      if (tribe === 'player') this.events.push({ type: 'denied', x: tx, z: tz });
    }
  }

  private castTargetInRange(u: Unit): boolean {
    if (!u.castTarget) return false;
    return this.distTo(u, u.castTarget.x, u.castTarget.z) <= CAST_RANGE;
  }

  private beginCast(u: Unit): void {
    u.state = 'working';
    u.workTimer = CAST_SECONDS;
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
    if (u.castTarget) {
      u.heading = Math.atan2(wrapDelta(u.castTarget.x - u.x, WORLD_SIZE), wrapDelta(u.castTarget.z - u.z, WORLD_SIZE));
    }
    this.events.push({ type: 'castFlash', x: u.x, z: u.z });
  }

  hurtUnit(u: Unit, amount: number): void {
    u.hp -= amount;
    if (u.tribe !== 'wild') this.tribes[u.tribe as TribeId].threatTimer = 8;
  }

  displaceUnit(u: Unit, dx: number, dz: number): void {
    u.x = wrapf(u.x + dx);
    u.z = wrapf(u.z + dz);
    u.prevX = u.x;
    u.prevZ = u.z;
    if (u.state !== 'inside') this.abandonTask(u);
  }

  hurtBuilding(b: Building, amount: number): void {
    b.hp -= amount;
    this.tribes[b.tribe].threatTimer = 8;
    if (b.hp <= 0) this.destroyBuilding(b);
  }

  private destroyBuilding(b: Building): void {
    this.events.push({ type: 'explosion', x: b.x, z: b.z });
    for (const u of this.units) {
      if (u.hidden && u.home === b.id) {
        u.hidden = false;
        u.state = 'idle';
        u.home = -1;
        const out = findNearestWalkable(this.map, b.x, b.z + 2);
        if (out) {
          u.x = u.prevX = out.x;
          u.z = u.prevZ = out.z;
        }
      }
      if (u.home === b.id) u.home = -1;
      if (u.targetBuilding === b.id) u.targetBuilding = -1;
    }
    this.clearFootprint(b);
    this.buildings = this.buildings.filter((q) => q.id !== b.id);
  }

  // -------------------------------------------------------------------------
  // Buildings & trees
  // -------------------------------------------------------------------------

  private tickBuildings(dt: number): void {
    const doneHuts: Record<TribeId, number> = { player: 0, red: 0 };
    for (const b of this.buildings) {
      if (b.kind === 'hut' && b.progress >= 1) doneHuts[b.tribe]++;
    }

    for (const b of this.buildings) {
      if (b.progress < 1) continue;

      if (b.kind === 'hut') {
        const cap = POP_BASE + POP_PER_HUT * doneHuts[b.tribe];
        if (b.residents > 0 && this.tribePopulation(b.tribe) < cap) {
          b.breedTimer -= dt;
          if (b.breedTimer <= 0) {
            b.breedTimer = BREED_SECONDS * (0.8 + Math.random() * 0.5);
            this.spawnNearWalkable('brave', b.tribe, b.x, b.z + 2);
          }
        }
        b.outingTimer -= dt;
        if (b.outingTimer <= 0) {
          b.outingTimer = OUTING_SECONDS * (0.6 + Math.random() * 0.8);
          if (b.residents > 0) {
            const resident = this.units.find((q) => q.hidden && q.home === b.id);
            if (resident) {
              resident.hidden = false;
              resident.state = 'idle';
              resident.idleTime = 0;
              const door = findNearestWalkable(this.map, b.x, b.z + 2);
              if (door) {
                resident.x = resident.prevX = door.x;
                resident.z = resident.prevZ = door.z;
              }
              b.residents--;
            }
          }
        }
        continue;
      }

      if (b.kind === 'warriorHut' || b.kind === 'fireHut') {
        // RECRUITING: the hut periodically drafts a nearby idle brave —
        // if the tribe can afford the gear and still has hands enough for
        // the economy. (The original made you carry braves there; auto-
        // drafting keeps our god's hands on the terrain, not the roster.)
        b.workTimer -= dt;
        if (b.workTimer > 0) continue;
        b.workTimer = 3;
        const tribe = this.tribes[b.tribe];
        const cost = TRAIN_COSTS[b.kind];
        if (tribe.wood < cost) continue;
        if (this.countUnits((q) => q.tribe === b.tribe && q.kind === 'brave') <= MIN_BRAVES) continue;
        const recruit = this.units.find(
          (q) =>
            q.tribe === b.tribe && q.kind === 'brave' && !q.hidden &&
            q.task === 'none' && q.state !== 'working' &&
            this.distTo(q, b.x, b.z) < 20,
        );
        if (recruit) {
          recruit.task = 'train';
          recruit.targetBuilding = b.id;
          if (!this.sendTo(recruit, b.x, b.z + 1)) this.abandonTask(recruit);
        }
        continue;
      }

      if (b.kind === 'tower') {
        // A stationary soldier wearing architecture.
        b.workTimer -= dt;
        if (b.workTimer > 0) continue;
        let best: Unit | null = null;
        let bestD = TOWER.range;
        for (const q of this.units) {
          if (q.hidden || !hostile(b.tribe, q.tribe)) continue;
          const d = Math.hypot(wrapDelta(q.x - b.x, WORLD_SIZE), wrapDelta(q.z - b.z, WORLD_SIZE));
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
        if (best) {
          b.workTimer = TOWER.cooldown;
          this.events.push({ type: 'fireball', x: b.x, z: b.z, x2: best.x, z2: best.z });
          this.hurtUnit(best, TOWER.dmg);
        }
      }
    }
  }

  private tickTrees(dt: number): void {
    for (const t of this.trees) {
      if (t.alive) continue;
      t.regrow -= dt;
      if (t.regrow <= 0 && walkable(this.map, t.x, t.z)) t.alive = true;
    }
  }

  canPlaceBuilding(tribe: TribeId, kind: BuildingKind, cx: number, cz: number): boolean {
    if (this.tribes[tribe].wood < BUILD_COSTS[kind]) return false;
    const r = kind === 'tower' ? 0 : 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (!walkable(this.map, cx + dx, cz + dz)) return false;
        const h = this.map.heightAt(cx + dx, cz + dz);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    if (hi - lo > HUT_FLAT_TOLERANCE) return false;
    for (const id of ['player', 'red'] as TribeId[]) {
      const home = this.tribes[id].home;
      if (Math.abs(wrapDelta(cx - home.x, WORLD_SIZE)) < 3 && Math.abs(wrapDelta(cz - home.z, WORLD_SIZE)) < 3) return false;
    }
    return true;
  }

  placeBuilding(tribe: TribeId, kind: BuildingKind, cx: number, cz: number): boolean {
    if (!this.canPlaceBuilding(tribe, kind, cx, cz)) return false;
    this.tribes[tribe].wood -= BUILD_COSTS[kind];
    const b: Building = {
      id: this.nextId++,
      tribe,
      kind,
      x: this.map.wrap(cx),
      z: this.map.wrap(cz),
      progress: 0,
      hp: 1,
      residents: 0,
      breedTimer: BREED_SECONDS,
      outingTimer: OUTING_SECONDS,
      workTimer: 0,
    };
    this.buildings.push(b);
    this.blockFootprint(b);
    return true;
  }

  private blockFootprint(b: Building): void {
    if (b.kind === 'tower') {
      obstacles.add(tileIndex(b.x, b.z));
      return;
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 1) continue; // the door
        obstacles.add(tileIndex(b.x + dx, b.z + dz));
      }
    }
  }

  private clearFootprint(b: Building): void {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        obstacles.delete(tileIndex(b.x + dx, b.z + dz));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Orders & helpers
  // -------------------------------------------------------------------------

  sendTo(u: Unit, tx: number, tz: number, maxExpansions = 4000): boolean {
    const path = findPath(this.map, u.x, u.z, tx, tz, maxExpansions);
    if (!path || path.length === 0) return false;
    u.path = path;
    u.pathIndex = 0;
    u.goal = { x: this.map.wrap(Math.round(tx)), z: this.map.wrap(Math.round(tz)) };
    u.state = 'moving';
    return true;
  }

  orderMove(ids: number[], tx: number, tz: number): void {
    let slot = 0;
    for (const id of ids) {
      const u = this.units.find((q) => q.id === id);
      if (!u || u.hidden) continue;
      this.abandonTask(u);
      let ox = 0;
      let oz = 0;
      if (slot > 0) {
        let ring = 1;
        let first = 1;
        while (slot >= first + 6 * ring) {
          first += 6 * ring;
          ring++;
        }
        const a = ((slot - first) / (6 * ring)) * Math.PI * 2;
        ox = Math.cos(a) * 1.6 * ring;
        oz = Math.sin(a) * 1.6 * ring;
      }
      this.sendTo(u, Math.round(tx + ox), Math.round(tz + oz));
      slot++;
    }
  }

  /**
   * Send a leader to commune at a monument. Only leaders can worship —
   * the stones do not speak to the laity (and it keeps the race personal:
   * gods send their champions, not their mobs).
   */
  orderWorship(ids: number[], monumentIdx: number): void {
    const m = this.monuments[monumentIdx];
    if (!m || m.claimedBy) return;
    for (const id of ids) {
      const u = this.units.find((q) => q.id === id);
      if (!u || u.hidden || u.kind !== 'shaman') continue;
      this.abandonTask(u);
      u.task = 'worship';
      u.targetMonument = monumentIdx;
      if (!this.sendTo(u, m.x, m.z + 1)) this.abandonTask(u);
      return; // one worshipper is all it takes
    }
  }

  /** Right-clicked an enemy: soldiers hunt it, civilians just walk over. */
  orderAttack(ids: number[], targetId: number): void {
    const target = this.unitById(targetId);
    if (!target) return;
    const movers: number[] = [];
    for (const id of ids) {
      const u = this.units.find((q) => q.id === id);
      if (!u || u.hidden) continue;
      if (COMBAT[u.kind].dmg > 0 && hostile(u.tribe, target.tribe)) {
        this.abandonTask(u);
        u.task = 'attack';
        u.targetUnit = targetId;
        if (this.distTo(u, target.x, target.z) <= COMBAT[u.kind].range) u.state = 'fighting';
        else if (!this.sendTo(u, target.x, target.z)) this.abandonTask(u);
      } else movers.push(id);
    }
    if (movers.length > 0) this.orderMove(movers, target.x, target.z);
  }

  tribePopulation(id: TribeId): number {
    return this.countUnits((u) => u.tribe === id);
  }

  housedPopulation(id: TribeId): number {
    return this.buildings.reduce((s, b) => (b.tribe === id ? s + b.residents : s), 0);
  }

  distTo(u: Unit, x: number, z: number): number {
    return Math.hypot(wrapDelta(x - u.x, WORLD_SIZE), wrapDelta(z - u.z, WORLD_SIZE));
  }

  unitById(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  countUnits(pred: (u: Unit) => boolean): number {
    let n = 0;
    for (const u of this.units) if (pred(u)) n++;
    return n;
  }

  getBuilding(id: number): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  private nearestChoppableTree(u: Unit): number {
    let best = -1;
    let bestDist = 28;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      if (!t.alive) continue;
      if (this.countUnits((q) => q.task === 'chop' && q.targetTree === i) > 0) continue;
      const d = this.distTo(u, t.x, t.z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Spawning & placement
  // -------------------------------------------------------------------------

  spawn(kind: UnitKind, tribe: Tribe, x: number, z: number): Unit {
    const u: Unit = {
      id: this.nextId++,
      kind,
      tribe,
      x: wrapf(x),
      z: wrapf(z),
      prevX: wrapf(x),
      prevZ: wrapf(z),
      heading: Math.random() * Math.PI * 2,
      state: 'idle',
      task: 'none',
      path: [],
      pathIndex: 0,
      goal: null,
      idleTime: Math.random() * 5,
      workTimer: 0,
      targetTree: -1,
      targetBuilding: -1,
      targetUnit: -1,
      targetMonument: -1,
      attackCooldown: 0,
      carrying: false,
      hidden: false,
      home: -1,
      hp: COMBAT[kind].hp,
      castSpell: null,
      castTarget: null,
    };
    this.units.push(u);
    return u;
  }

  spawnNearWalkable(kind: UnitKind, tribe: Tribe, x: number, z: number): void {
    const spot = findNearestWalkable(this.map, Math.round(x), Math.round(z));
    if (spot) this.spawn(kind, tribe, spot.x + Math.random() * 0.6 - 0.3, spot.z + Math.random() * 0.6 - 0.3);
  }

  /**
   * Find a pleasant spot to live — and, given `awayFrom`, one at least a
   * third of the planet from the other tribe (skirmishes need a march).
   */
  private findSettleSite(
    needTrees: boolean,
    awayFrom: { x: number; z: number } | null,
  ): { x: number; z: number } {
    let best = { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 };
    let bestScore = -1;
    for (let attempt = 0; attempt < 500; attempt++) {
      const x = Math.floor(Math.random() * WORLD_SIZE);
      const z = Math.floor(Math.random() * WORLD_SIZE);
      const h = this.map.heightAt(x, z);
      if (h < 1 || h > 7 || !walkable(this.map, x, z)) continue;
      let open = 0;
      for (let dz = -4; dz <= 4; dz += 2) {
        for (let dx = -4; dx <= 4; dx += 2) {
          if (walkable(this.map, x + dx, z + dz)) open++;
        }
      }
      if (open < 20) continue;
      if (needTrees) {
        const nearby = this.trees.filter(
          (t) => Math.hypot(wrapDelta(t.x - x, WORLD_SIZE), wrapDelta(t.z - z, WORLD_SIZE)) < 14,
        ).length;
        if (nearby < 3) continue;
      }
      if (!awayFrom) return { x, z };
      const sep = Math.hypot(wrapDelta(x - awayFrom.x, WORLD_SIZE), wrapDelta(z - awayFrom.z, WORLD_SIZE));
      if (sep > WORLD_SIZE / 3) return { x, z };
      if (sep > bestScore) {
        bestScore = sep;
        best = { x, z };
      }
    }
    return best;
  }

  private placeTrees(seed: number): void {
    this.trees = [];
    for (let z = 0; z < WORLD_SIZE; z++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const h = this.map.heightAt(x, z);
        if (h < 1.2 || h > 9) continue;
        if (!walkable(this.map, x, z)) continue;
        if (hash2(x, z, seed + 555) < 0.022) {
          this.trees.push({ x, z, alive: true, regrow: 0 });
        }
      }
    }
  }
}
