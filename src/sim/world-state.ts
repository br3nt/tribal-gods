/**
 * sim/world-state.ts — THE game state, and the systems that advance it.
 *
 * Everything that "exists" in the game lives here as plain data: the
 * heightmap, every unit, tree and building, each tribe's wood and spell
 * book. No Three.js, no DOM — the renderer reads this state every frame and
 * never writes back. The sim is deterministic: all chance comes from the
 * World's seeded Rng (world.random()).
 *
 * v2: content is catalog-driven (sim/catalog.ts is the contract). Up to four
 * tribes share the planet; hostility comes from per-tribe allies; win/lose
 * comes from the scenario's objectives (sim/objectives.ts). Every tribe runs
 * the same rules — the AI (sim/ai.ts) only makes decisions.
 *
 * Systems that grew big enough live in their own modules and are driven
 * from tick(): spellbook.ts (the charge model), chant.ts (Chanters),
 * spells.ts (what spells do), objectives.ts, ai.ts. World stays the single
 * owner of state.
 */

import {
  BUILD_FLAT_TOLERANCE,
  CHOP_SECONDS,
  CivId,
  CIVS,
  Difficulty,
  DIFFICULTIES,
  FIRE,
  FLEE_RADIUS,
  LEADER_RESPAWN_SECONDS,
  LUMBERYARD,
  MAX_BUILDERS,
  OUTING_SECONDS,
  START_BRAVES,
  START_WOOD,
  BUFFS,
  TOWER_BONUS,
  TREE_REGROW_SECONDS,
  WALK_MIN_HEIGHT,
  WARDEN,
  WOOD_TARGET,
  WORLD_SIZE,
  WORSHIP_SECONDS,
} from '../config';
import { hash2 } from '../core/noise';
import { wrapDelta } from '../core/util';
import { AnyLevelData, LevelData, migrateLevel, packTerrain, PlacedBuilding, PlacedUnits, unpackTerrain } from '../level/level-format';
import { Heightmap } from '../world/heightmap';
import { tickAi } from './ai';
import {
  AiPersonality,
  BuildingKind,
  BUILDINGS,
  CHANT,
  BuildState,
  DWELLING_TIERS,
  ECONOMY,
  MonumentDef,
  ObjectiveState,
  ScenarioRules,
  SimQueries,
  spellDef,
  SpellId,
  SpellState,
  Tribe,
  TribeId,
  TribeSummary,
  UnitKind,
  UNITS,
} from './catalog';
import { breakChant, tickChant } from './chant';
import { initObjectives, ObjectiveMemory, tickObjectives } from './objectives';
import { findNearestWalkable, findPath, obstaclesOf, tileIndex, walkable } from './pathfinding';
import { isMajor, regionAt } from './regions';
import { Rng } from './rng';
import { ALL_BUILDINGS, skirmishRules, STARTER_SPELLS } from './rules';
import { EventMemory, initEventMemory, tickScenarioEvents } from './scenario-events';
import { hasCast, manaIncome, newSpellBook, pourMana, slotState, SpellBook, spendCast } from './spellbook';
import { Aura, castSpell, SpellJob, tickJobs } from './spells';

// Catalog types, re-exported so existing `from './world-state'` imports keep working.
export type { BuildingKind, SpellId, Tribe, TribeId, UnitKind } from './catalog';

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
  | 'worship'
  | 'garrison'
  | 'chant';

/** Skirmish setup, chosen on the start screen. */
export interface GameSettings {
  playerCiv: CivId;
  difficulty: Difficulty;
  /** Rival AI tribes in a random skirmish (1–3). Default 1. */
  enemies?: number;
}

/**
 * A standing stone holding one spell (see MonumentDef in catalog.ts).
 * `claimedBy` is "unavailable right now" (a taught stone, or a gift stone
 * that is sleeping) — the renderer dims it. `claimer` is the last tribe to
 * commune here, for objectives.
 */
export interface Monument {
  x: number;
  z: number;
  spell: SpellId;
  mode: 'teach' | 'gift';
  charges?: number;
  cooldown?: number;
  claimedBy: TribeId | null;
  claimer: TribeId | null;
  /** Gift stones: seconds until they wake. */
  sleep: number;
  /** Nobody may commune before this many seconds of scenario time. */
  opensAt?: number;
  /** The first tribe ever to commune here (for `monumentTaken`). */
  firstClaimer?: TribeId;
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
  /** Dwelling this unit lives in (-1 = none). */
  home: number;
  hp: number;
  maxHp: number;
  castSpell: SpellId | null;
  castTarget: { x: number; z: number } | null;
  /** Building this unit is inside as a garrison/worshipper/trainee (-1 = none). */
  garrison: number;
  /** Seconds left of Stone Ward (half damage). */
  wardTime: number;
  /** Seconds left of Warsong (faster move + attack). */
  warsongTime: number;
  /** Seconds left airborne (a cyclone picked this unit up) — for the renderer. */
  lifted: number;
  /** >0 while a hostile chant holds this unit (it cannot attack). */
  pacified: number;
  /** Chanter whose chant this unit is hearing (-1 none) and for how long. */
  chantBy: number;
  chantProgress: number;
}

export interface Tree {
  x: number;
  z: number;
  alive: boolean;
  regrow: number;
  /** Seconds left burning (0 = not on fire). */
  burning: number;
}

export interface Building {
  id: number;
  tribe: TribeId;
  kind: BuildingKind;
  x: number;
  z: number;
  /** Footprint is size×size tiles centred on (x, z). */
  size: 3 | 5;
  progress: number;
  hp: number;
  maxHp: number;
  residents: number;
  breedTimer: number;
  outingTimer: number;
  workTimer: number;
  /** Dwellings: tier 0..2, and seconds spent full toward the next tier. */
  tier: number;
  fullTime: number;
  /** Training buildings: queued trainees, the villager being trained, its timer. */
  queue: number;
  trainee: number;
  trainTime: number;
  rally: { x: number; z: number } | null;
  /** Units inside as garrison (towers) or worshippers (shrines). */
  garrison: number[];
  /** Seconds left burning (0 = not on fire). */
  burning: number;
  wardTime: number;
}

export interface AiState {
  state: 'grow' | 'harass' | 'assault' | 'defend';
  evalTimer: number;
  /** Rival this AI is currently at war with (nearest living hostile). */
  target: TribeId | null;
  /** The construction site it is waiting on, and when it last made progress. */
  site?: { id: number; progress: number; since: number };
  /** False while a `passive` personality is holding back (see AiPersonality). */
  awake: boolean;
  /** Seconds until its leader may cast again (difficulty's aiCastGap after each cast). */
  castCooldown: number;
  /** The gap it is bridging to reach its target (sim/crossing.ts), re-planned as land rises. */
  crossing?: { from: { x: number; z: number }; to: { x: number; z: number }; kind: 'water' | 'cliff'; width: number; at: number; wait?: number } | null;
}

/** Everything one tribe owns that isn't a unit or a building. */
export interface TribeState {
  id: TribeId;
  wood: number;
  home: { x: number; z: number };
  /** Architecture + leader theme. Pure flavor; the sim is civ-blind. */
  civ: CivId;
  /** Spells this tribe knows. (`unlocked` is the same Set, kept for older readers.) */
  known: Set<SpellId>;
  unlocked: Set<SpellId>;
  spells: SpellBook;
  /** Raw mana income per second (last tick) and what actually flowed into spells. */
  income: number;
  manaRate: number;
  /** Buildings the scenario lets this tribe raise. */
  allowed: Set<BuildingKind>;
  allies: TribeId[];
  /** Seconds until the leader returns (0 = alive or not coming back). */
  shamanRespawn: number;
  /** False when the scenario forbids reincarnation (fail: leaderDies). */
  reincarnates: boolean;
  leaderDeaths: number;
  /** Seconds since this tribe last took damage — the AI's alarm bell. */
  threatTimer: number;
  /** Building kinds this tribe has ever completed (for `buildingLost`). */
  everBuilt: Set<BuildingKind>;
  /** Present on AI-driven tribes only. See sim/ai.ts. */
  ai: AiState | null;
  /** How its AI behaves (empty = the standard rival). */
  personality: AiPersonality;
}

const wrapf = (v: number) => ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
const half = (b: { size: number }) => (b.size - 1) / 2;
const isFighterKind = (k: UnitKind) => UNITS[k].dmg > 0 && UNITS[k].sight > 0;
const MAX_EVENTS = 4000;

export interface HurtOptions {
  /** Damage from a spell: Wardens shrug off half. */
  spell?: boolean;
}

export class World implements SimQueries {
  readonly map = new Heightmap();
  units: Unit[] = [];
  trees: Tree[] = [];
  /** Bumped when trees are added/removed (not when they fall/regrow). */
  treesVersion = 0;
  buildings: Building[] = [];
  monuments: Monument[] = [];
  tribes: Partial<Record<TribeId, TribeState>> = {};
  settings: GameSettings = { playerCiv: 'forest', difficulty: 'normal' };
  rules: ScenarioRules = skirmishRules(1);
  jobs: SpellJob[] = [];
  /** Timed spell effects in the world, for the renderer. */
  auras: Aura[] = [];
  readonly swamp = new Map<number, number>();
  events: GameEvent[] = [];
  objectives: ObjectiveState[] = [];
  objectiveMemory: ObjectiveMemory[] = [];
  gameOver: 'victory' | 'defeat' | null = null;
  gameOverReason: string | null = null;
  /** Seconds of sim time since the scenario began. */
  elapsed = 0;
  /** Lines the scenario said to the player (scripted events), oldest first. */
  messages: Array<{ at: number; text: string }> = [];
  /** Lines ever said this scenario (messages keeps only the last 50; readers diff against this). */
  messageSeq = 0;
  /** Running memory for rules.events (scenario-events.ts). */
  eventMemory: EventMemory[] = [];
  readonly rng = new Rng(1);

  /** Next id for a unit or building. Public for sim/save.ts only. */
  nextId = 1;
  /** `${unitId}:${target}` → sim time until which that unit won't retry an unreachable target. */
  unreachable = new Map<string, number>();
  /** A* budget for jobs a unit picks for itself (orders get the full budget). */
  private static readonly AUTO_EXPANSIONS = 1500;

  /** Tiles occupied by building footprints (pathfinding reads the same set). */
  get obstacles(): Set<number> {
    return obstaclesOf(this.map);
  }

  /** Uniform [0,1) from the World's seeded generator. The sim's only dice. */
  random(): number {
    return this.rng.next();
  }

  // -------------------------------------------------------------------------
  // Tribes
  // -------------------------------------------------------------------------

  /** Tribes present in this scenario, in TRIBE_IDS order. */
  activeTribes(): TribeId[] {
    return (['player', 'red', 'gold', 'violet'] as TribeId[]).filter((t) => this.tribes[t]);
  }

  /** The tribe's state; throws if it isn't in this scenario. */
  tribe(id: TribeId): TribeState {
    const t = this.tribes[id];
    if (!t) throw new Error(`tribe ${id} is not in this world`);
    return t;
  }

  /** Two different economic tribes that are not allied. Wanderers are nobody's enemy. */
  hostile(a: Tribe, b: Tribe): boolean {
    if (a === b || a === 'wild' || b === 'wild') return false;
    const ta = this.tribes[a];
    const tb = this.tribes[b];
    if (ta?.allies.includes(b) || tb?.allies.includes(a)) return false;
    return true;
  }

  /** Same tribe or allied. */
  friendly(a: Tribe, b: Tribe): boolean {
    if (a === 'wild' || b === 'wild') return false;
    return a === b || !this.hostile(a, b);
  }

  leaderOf(id: TribeId): Unit | undefined {
    return this.units.find((u) => u.kind === 'shaman' && u.tribe === id);
  }

  /** Has this tribe's leader died at least once? */
  leaderLost(id: TribeId): boolean {
    return (this.tribes[id]?.leaderDeaths ?? 0) > 0;
  }

  /** Kinds this tribe once completed and now has none of. */
  lostBuildingKinds(id: TribeId): Set<BuildingKind> {
    const t = this.tribes[id];
    const out = new Set<BuildingKind>();
    if (!t) return out;
    for (const k of t.everBuilt) {
      if (!this.buildings.some((b) => b.tribe === id && b.kind === k && b.progress >= 1)) out.add(k);
    }
    return out;
  }

  /** A scenario line for the player (the UI shows world.messages). */
  say(text: string): void {
    this.messages.push({ at: this.elapsed, text });
    this.messageSeq++;
    if (this.messages.length > 50) this.messages.shift();
  }

  endGame(result: 'victory' | 'defeat', reason: string): void {
    if (this.gameOver) return;
    this.gameOver = result;
    this.gameOverReason = reason;
  }

  // -------------------------------------------------------------------------
  // Levels and skirmishes
  // -------------------------------------------------------------------------

  private clearState(seed: number): void {
    this.rng.seed(seed);
    this.units = [];
    this.buildings = [];
    this.jobs = [];
    this.auras = [];
    this.swamp.clear();
    this.events = [];
    this.gameOver = null;
    this.gameOverReason = null;
    this.elapsed = 0;
    this.messages = [];
    this.messageSeq = 0;
    this.eventMemory = [];
    this.tribes = {};
    this.nextId = 1;
    this.unreachable.clear();
    this.obstacles.clear();
  }

  /**
   * Build the world from a level document (any version — v1 is migrated).
   * Rules come from the argument, else the level's own `rules`, else the
   * classic destroy-all skirmish against `red`. Pre-placed buildings and
   * units (v2) stand where the level says.
   */
  async loadLevel(input: AnyLevelData, settings: GameSettings, rules?: ScenarioRules): Promise<void> {
    const level = migrateLevel(input);
    this.settings = settings;
    this.map.heights.set(await unpackTerrain(level.terrain));
    this.map.version++;
    let seed = 7;
    for (const ch of level.name ?? '') seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    this.clearState(seed);
    this.levelExtras = { rules: level.rules, units: level.units, buildings: level.buildings };

    this.trees = [];
    for (let i = 0; i < level.trees.length; i += 2) {
      this.trees.push({ x: level.trees[i], z: level.trees[i + 1], alive: true, regrow: 0, burning: 0 });
    }
    this.treesVersion++;
    this.monuments = level.monuments.map((m) => ({
      x: m.x, z: m.z, spell: m.spell, mode: m.mode ?? 'teach', charges: m.charges, cooldown: m.cooldown,
      claimedBy: null, claimer: null, sleep: 0, ...(m.opensAt !== undefined ? { opensAt: m.opensAt } : {}),
    }));

    const r = rules ?? level.rules ?? skirmishRules(1);
    const homes: Partial<Record<TribeId, { x: number; z: number }>> = {};
    for (const t of r.tribes) {
      const h = level.homes[t.id];
      if (h) homes[t.id] = { ...h };
    }
    for (const t of r.tribes) {
      if (!homes[t.id]) homes[t.id] = this.findSettleSite(true, Object.values(homes) as Array<{ x: number; z: number }>);
    }
    this.setupTribes(r, homes, level.civs, level.buildings);
    for (let i = 0; i < level.wildmen.length; i += 2) {
      this.spawnNearWalkable('wildman', 'wild', level.wildmen[i], level.wildmen[i + 1]);
    }
    for (const p of level.units ?? []) {
      if (p.tribe !== 'wild' && !this.tribes[p.tribe]) continue;
      for (let i = 0; i < (p.count ?? 1); i++) {
        const a = i * 2.4;
        const rr = i === 0 ? 0 : 0.8 + Math.sqrt(i) * 0.9;
        this.spawnNearWalkable(p.kind, p.tribe, p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr);
      }
    }
  }

  /** What the loaded level carried beyond the live world (captureLevel writes it back). */
  levelExtras: { rules?: ScenarioRules; units?: PlacedUnits[]; buildings?: PlacedBuilding[] } = {};

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
    const homes = { player: { ...(this.tribes.player?.home ?? { x: 0, z: 0 }) } } as LevelData['homes'];
    const civs: Partial<Record<TribeId, CivId>> = {};
    for (const id of this.activeTribes()) {
      homes[id] = { ...this.tribes[id]!.home };
      if (id !== 'player') civs[id] = this.tribes[id]!.civ;
    }
    const source = this.levelExtras.buildings ?? [];
    const buildings: PlacedBuilding[] = this.buildings.map((b) => {
      const out: PlacedBuilding = { tribe: b.tribe, kind: b.kind, x: b.x, z: b.z };
      if (b.progress < 1) out.complete = false;
      const was = source.find((s) => s.tribe === b.tribe && s.kind === b.kind && s.x === b.x && s.z === b.z);
      const inside: Partial<Record<UnitKind, number>> = {};
      for (const id of b.garrison) {
        const u = this.unitById(id);
        if (u) inside[u.kind] = (inside[u.kind] ?? 0) + 1;
      }
      const garrison = Object.keys(inside).length ? inside : was?.garrison;
      if (garrison) out.garrison = { ...garrison };
      return out;
    });
    const level: LevelData = {
      v: 2,
      ...meta,
      terrain: await packTerrain(this.map.heights),
      trees,
      monuments: this.monuments.map((m) => {
        const d: MonumentDef = { x: m.x, z: m.z, spell: m.spell, mode: m.mode };
        if (m.charges !== undefined) d.charges = m.charges;
        if (m.cooldown !== undefined) d.cooldown = m.cooldown;
        if (m.opensAt !== undefined) d.opensAt = m.opensAt;
        return d;
      }),
      homes,
      wildmen: wild,
      civs,
    };
    if (this.levelExtras.rules) level.rules = this.levelExtras.rules;
    if (buildings.length) level.buildings = buildings;
    if (this.levelExtras.units?.length) level.units = this.levelExtras.units.map((u) => ({ ...u }));
    return level;
  }

  /**
   * Tear down and rebuild the whole world: terrain, trees, every tribe.
   * Without rules this is a random skirmish against `settings.enemies`
   * (1–3) AI gods.
   */
  reset(seed: number, settings?: GameSettings, rules?: ScenarioRules): void {
    if (settings) this.settings = settings;
    this.map.generate(seed);
    this.clearState(seed);
    this.levelExtras = {};
    this.placeTrees(seed);

    const r = rules ?? skirmishRules(this.settings.enemies ?? 1);
    const homes: Partial<Record<TribeId, { x: number; z: number }>> = {};
    const placed: Array<{ x: number; z: number }> = [];
    for (const t of r.tribes) {
      // Rivals settle as far apart as good sites allow — a skirmish needs a march.
      const h = this.findSettleSite(true, placed);
      homes[t.id] = h;
      placed.push(h);
    }
    this.setupTribes(r, homes);
    this.placeMonuments();
    for (let i = 0; i < 14; i++) {
      const spot = this.findSettleSite(false, []);
      this.spawnNearWalkable('wildman', 'wild', spot.x, spot.z);
    }
  }

  private setupTribes(
    rules: ScenarioRules,
    homes: Partial<Record<TribeId, { x: number; z: number }>>,
    civs: Partial<Record<TribeId, CivId>> = {},
    placed: PlacedBuilding[] = [],
  ): void {
    this.rules = rules;
    const civIds = Object.keys(CIVS) as CivId[];
    const otherCivs = civIds.filter((c) => c !== this.settings.playerCiv);
    const leaderDies = (rules.fail ?? []).some((f) => f.type === 'leaderDies');

    for (const t of rules.tribes) {
      const wanted = civs[t.id];
      const civ =
        t.id === 'player' ? this.settings.playerCiv
        : wanted && CIVS[wanted] && wanted !== this.settings.playerCiv ? wanted
        : this.rng.pick(otherCivs.length ? otherCivs : civIds);
      const lo = t.loadout ?? {};
      const known = new Set<SpellId>(lo.spells ?? STARTER_SPELLS);
      const spells = newSpellBook();
      for (const [id, n] of Object.entries(lo.extraCharges ?? {}) as Array<[SpellId, number]>) spells[id].bonus += n;
      for (const [id, k] of Object.entries(lo.chargeCost ?? {}) as Array<[SpellId, number]>) spells[id].cost = Math.max(0.05, k);
      for (const [id, n] of Object.entries(lo.gifts ?? {}) as Array<[SpellId, number]>) spells[id].gifted += n;
      const personality = { ...(t.personality ?? {}) };
      this.tribes[t.id] = {
        id: t.id,
        wood: lo.startWood ?? START_WOOD,
        home: homes[t.id] ?? { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 },
        civ,
        known,
        unlocked: known,
        spells,
        income: 0,
        manaRate: 0,
        allowed: new Set(lo.buildings ?? ALL_BUILDINGS),
        allies: [...(t.allies ?? [])],
        shamanRespawn: 0,
        reincarnates: !(leaderDies && t.id === 'player'),
        leaderDeaths: 0,
        threatTimer: 0,
        everBuilt: new Set(),
        ai: t.ai ? { state: 'grow', evalTimer: 2, target: null, awake: !personality.passive, castCooldown: 0, crossing: null } : null,
        personality,
      };
    }

    // Buildings first, so the people below spawn clear of their walls: the
    // level's pre-placed ones where it says, then loadout extras near home.
    const garrisons: Array<[Building, Partial<Record<UnitKind, number>>]> = [];
    for (const p of placed) {
      if (!this.tribes[p.tribe]) continue;
      const b = this.spawnBuilding(p.tribe, p.kind, p.x, p.z, { complete: p.complete ?? true });
      if (p.garrison) garrisons.push([b, p.garrison]);
    }
    for (const t of rules.tribes) {
      for (const kind of t.loadout?.startBuildings ?? []) this.placeStartBuilding(t.id, kind);
    }

    for (const t of rules.tribes) {
      const tribe = this.tribes[t.id]!;
      const lo = t.loadout ?? {};
      const units: Partial<Record<UnitKind, number>> = {
        shaman: 1,
        brave: t.ai ? DIFFICULTIES[this.settings.difficulty].redStartBraves : START_BRAVES,
        ...(lo.startUnits ?? {}),
      };
      const home = tribe.home;
      if ((units.shaman ?? 0) > 0) this.spawnNearWalkable('shaman', t.id, home.x, home.z);
      let slot = 0;
      const total = Object.entries(units).reduce((s, [k, n]) => (k === 'shaman' ? s : s + (n ?? 0)), 0);
      for (const [kind, n] of Object.entries(units) as Array<[UnitKind, number]>) {
        if (kind === 'shaman') continue;
        for (let i = 0; i < n; i++) {
          const a = (slot++ / Math.max(1, total)) * Math.PI * 2;
          const ring = 2.5 + Math.floor(slot / 12) * 1.5;
          this.spawnNearWalkable(kind, t.id, home.x + Math.cos(a) * ring, home.z + Math.sin(a) * ring);
        }
      }
    }
    // Garrisons step straight in through the door.
    for (const [b, inside] of garrisons) {
      const door = this.doorOf(b);
      for (const [kind, n] of Object.entries(inside) as Array<[UnitKind, number]>) {
        for (let i = 0; i < n; i++) {
          const u = this.spawn(kind, b.tribe, door.x, door.z);
          this.orderGarrison([u.id], b.id);
        }
      }
    }

    const obj = initObjectives(rules);
    this.objectives = obj.states;
    this.objectiveMemory = obj.memory;
    this.eventMemory = initEventMemory(rules.events);
  }

  /**
   * Stand a complete building up near a tribe's home circle (scenario start,
   * boons). Rings outward for a free site; failing that, levels the first
   * candidate whose footprint (plus its lane) is clear of buildings, homes
   * and water and builds there. Returns null — no building — rather than
   * overlap anything.
   */
  placeStartBuilding(tribe: TribeId, kind: BuildingKind): Building | null {
    const t = this.tribes[tribe];
    if (!t) return null;
    const r0 = BUILDINGS[kind].size === 5 ? 7 : 5;
    for (let r = r0; r <= r0 + 12; r += 2) {
      const steps = Math.max(8, Math.round(r * 2));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2 + r * 0.7;
        const x = Math.round(t.home.x + Math.cos(a) * r);
        const z = Math.round(t.home.z + Math.sin(a) * r);
        if (this.siteFree(kind, x, z)) return this.spawnBuilding(tribe, kind, x, z);
      }
    }
    const half = (BUILDINGS[kind].size - 1) / 2;
    const clear = (x: number, z: number) => {
      for (let dz = -half - 1; dz <= half + 1; dz++) {
        for (let dx = -half - 1; dx <= half + 1; dx++) {
          if (this.obstacles.has(tileIndex(x + dx, z + dz)) || this.map.heightAt(x + dx, z + dz) < WALK_MIN_HEIGHT) return false;
        }
      }
      return !this.activeTribes().some((id) => {
        const h = this.tribes[id]!.home;
        return Math.abs(wrapDelta(x - h.x, WORLD_SIZE)) < half + 3 && Math.abs(wrapDelta(z - h.z, WORLD_SIZE)) < half + 3;
      });
    };
    for (let r = r0; r <= r0 + 12; r += 2) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = Math.round(t.home.x + Math.cos(a) * r);
        const z = Math.round(t.home.z + Math.sin(a) * r);
        if (!clear(x, z)) continue;
        this.map.flatten(x, z, half + 1.5, 1);
        this.map.version++;
        return this.spawnBuilding(tribe, kind, x, z);
      }
    }
    return null;
  }

  /**
   * Monuments for a random skirmish: each tribe gets one modest stone within
   * sprinting distance; the rest — including the planet-breakers — stand on
   * neutral ground. Two of the neutral stones are gift stones.
   */
  private placeMonuments(): void {
    this.monuments = [];
    const nearPool: SpellId[] = this.rng.shuffle(['flatten', 'landbridge', 'swamp', 'lightning', 'ward', 'bloom', 'warsong']);
    const giftPool: SpellId[] = this.rng.shuffle(['emberfall', 'sink', 'cyclone']);
    const homes = this.activeTribes().map((t) => this.tribes[t]!.home);
    const add = (spot: { x: number; z: number } | null, spell: SpellId, mode: 'teach' | 'gift' = 'teach') => {
      if (!spot) return;
      this.monuments.push({
        ...spot, spell, mode, claimedBy: null, claimer: null, sleep: 0,
        ...(mode === 'gift' ? { charges: 1, cooldown: 120 } : {}),
      });
    };
    for (const home of homes) add(this.findMonumentSpot(home, 8, 16, homes), nearPool.pop()!);
    for (const spell of [nearPool.pop()!, nearPool.pop()!, 'earthquake', 'volcano'] as SpellId[]) {
      add(this.findMonumentSpot(null, 0, 0, homes), spell);
    }
    add(this.findMonumentSpot(null, 0, 0, homes), giftPool[0], 'gift');
    add(this.findMonumentSpot(null, 0, 0, homes), giftPool[1], 'gift');
  }

  private findMonumentSpot(
    anchor: { x: number; z: number } | null,
    minR: number,
    maxR: number,
    homes: Array<{ x: number; z: number }>,
  ): { x: number; z: number } | null {
    for (let attempt = 0; attempt < 300; attempt++) {
      let x: number;
      let z: number;
      if (anchor) {
        const a = this.random() * Math.PI * 2;
        const r = minR + this.random() * (maxR - minR);
        x = Math.round(anchor.x + Math.cos(a) * r);
        z = Math.round(anchor.z + Math.sin(a) * r);
      } else {
        x = this.rng.int(WORLD_SIZE);
        z = this.rng.int(WORLD_SIZE);
        const nearHome = homes.some((h) => Math.hypot(wrapDelta(x - h.x, WORLD_SIZE), wrapDelta(z - h.z, WORLD_SIZE)) < 22);
        if (nearHome && attempt < 250) continue; // neutral ground only (relaxed if the planet is crowded)
      }
      if (!walkable(this.map, x, z)) continue;
      if (this.monuments.some((m) => Math.hypot(wrapDelta(m.x - x, WORLD_SIZE), wrapDelta(m.z - z, WORLD_SIZE)) < 10)) continue;
      return { x: this.map.wrap(x), z: this.map.wrap(z) };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /** Advance the whole simulation by one fixed tick. */
  tick(dt: number): void {
    this.elapsed += dt;
    tickChant(this, dt);

    for (const u of this.units) {
      u.prevX = u.x;
      u.prevZ = u.z;
      if (u.wardTime > 0) u.wardTime = Math.max(0, u.wardTime - dt);
      if (u.warsongTime > 0) u.warsongTime = Math.max(0, u.warsongTime - dt);
      if (u.lifted > 0) u.lifted = Math.max(0, u.lifted - dt);
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
    this.tickMonuments(dt);
    tickScenarioEvents(this);
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
        if (u.hp > 0 && this.random() < dt * 2) this.events.push({ type: 'splash', x: u.x, z: u.z });
        this.hurtUnit(u, dt * 5);
      }
      if (this.swamp.has(tileIndex(Math.round(u.x), Math.round(u.z)))) this.hurtUnit(u, dt * 9);
    }

    this.sweepDeaths();

    // Per-tribe upkeep: mana into spells, leader reincarnation, threat decay.
    const praying = this.prayingCounts();
    for (const id of this.activeTribes()) {
      const t = this.tribes[id]!;
      t.threatTimer = Math.max(0, t.threatTimer - dt);
      t.income = manaIncome(this.tribePopulation(id), this.housedPopulation(id), praying[id] ?? 0);
      t.manaRate = pourMana(t.spells, t.known, t.income, dt);

      if (t.shamanRespawn > 0 && this.tribeAlive(id)) {
        t.shamanRespawn -= dt;
        if (t.shamanRespawn <= 0) {
          t.shamanRespawn = 0;
          this.spawnNearWalkable('shaman', id, t.home.x, t.home.z);
          this.events.push({ type: 'leaderReturn', x: t.home.x, z: t.home.z });
          this.events.push({ type: 'convert', x: t.home.x, z: t.home.z });
        }
      }
    }

    // Buildings whose ground slid under the sea drown.
    for (const b of [...this.buildings]) {
      if (this.map.heightAt(b.x, b.z) < 0) this.hurtBuildingFrac(b, dt * 0.25);
    }
    if (Math.floor(this.elapsed / 10) !== Math.floor((this.elapsed - dt) / 10)) {
      for (const [k, until] of this.unreachable) if (until <= this.elapsed) this.unreachable.delete(k);
    }

    tickObjectives(this, dt);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private sweepDeaths(): void {
    const dead = this.units.filter((u) => u.hp <= 0);
    if (dead.length === 0) return;
    for (const u of dead) {
      this.events.push({ type: 'death', x: u.x, z: u.z });
      if (u.hidden && u.garrison < 0) {
        const b = this.getBuilding(u.home);
        if (b) b.residents--;
      }
      if (u.garrison >= 0) {
        const b = this.getBuilding(u.garrison);
        if (b) b.garrison = b.garrison.filter((id) => id !== u.id);
      }
      if (u.kind === 'shaman' && u.tribe !== 'wild') {
        const t = this.tribes[u.tribe];
        if (t) {
          t.leaderDeaths++;
          t.shamanRespawn = t.reincarnates ? LEADER_RESPAWN_SECONDS : 0;
          this.events.push({ type: 'leaderDown', x: u.x, z: u.z });
        }
      }
    }
    this.units = this.units.filter((u) => u.hp > 0);
  }

  tribeAlive(id: TribeId): boolean {
    return this.units.some((u) => u.tribe === id) || this.buildings.some((b) => b.tribe === id);
  }

  // -------------------------------------------------------------------------
  // Unit behaviours
  // -------------------------------------------------------------------------

  unitSpeed(u: Unit): number {
    return UNITS[u.kind].speed * (u.warsongTime > 0 ? BUFFS.warsongFactor : 1);
  }

  unitCooldown(u: Unit): number {
    return UNITS[u.kind].cooldown / (u.warsongTime > 0 ? BUFFS.warsongFactor : 1);
  }

  private tickIdle(u: Unit, dt: number): void {
    u.idleTime += dt;

    // A unit with a fight on its books (pacified a moment ago) picks it back up.
    if ((u.task === 'attack' || u.task === 'attackBuilding') && u.pacified <= 0) {
      u.state = 'fighting';
      return;
    }

    if (u.kind === 'chanter' && u.tribe !== 'wild') {
      if (u.task === 'none' && this.tryChant(u)) return;
    } else if (isFighterKind(u.kind) && u.task === 'none') {
      // Soldiers on standby scan for trouble...
      if (this.acquireTarget(u)) return;
      // ...and if the tribe has no villagers left, billet in a dwelling
      // (breeding needs residents; an all-soldier tribe must still recover).
      if (u.idleTime > 12 && !this.units.some((q) => q.tribe === u.tribe && q.kind === 'brave') && this.tryMoveIn(u)) return;
    }

    // Villagers are civilians: enemy soldiers nearby → run for the home circle.
    if (u.kind === 'brave' && u.tribe !== 'wild' && this.enemySoldierNear(u, FLEE_RADIUS)) {
      const home = this.tribes[u.tribe]!.home;
      this.abandonTask(u);
      this.sendTo(u, home.x, home.z, 1200);
      return;
    }

    if (u.kind === 'brave' && u.tribe !== 'wild' && u.task === 'none' && u.idleTime > 1.2) {
      if (this.assignWork(u)) return;
    }

    // Villagers and wanderers mill about; fighters, chanters and leaders hold
    // the ground they were put on.
    if ((u.kind === 'brave' || u.kind === 'wildman') && u.task === 'none') {
      const restless = u.kind === 'wildman' ? 3 + this.random() * 4 : 7 + this.random() * 6;
      if (u.idleTime > restless) {
        const range = u.kind === 'wildman' ? 9 : 4;
        this.sendTo(u, Math.round(u.x + (this.random() * 2 - 1) * range), Math.round(u.z + (this.random() * 2 - 1) * range), 600);
        u.idleTime = 0;
      }
    }
  }

  /** Chanters: start chanting if a hostile is in earshot, else close on one in sight. */
  private tryChant(u: Unit, approach = true): boolean {
    let best: Unit | null = null;
    let bestD: number = UNITS.chanter.sight;
    for (const q of this.units) {
      if (q.hidden || q.kind === 'chanter' || !this.hostile(u.tribe, q.tribe) || this.isUnreachable(u, `u${q.id}`)) continue;
      const d = this.distTo(u, q.x, q.z);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    if (!best) return false;
    if (bestD <= CHANT.pacifyRadius - 0.3) {
      this.abandonTask(u);
      u.task = 'chant';
      u.state = 'working';
      u.heading = Math.atan2(wrapDelta(best.x - u.x, WORLD_SIZE), wrapDelta(best.z - u.z, WORLD_SIZE));
      this.events.push({ type: 'chantStart', x: u.x, z: u.z, magnitude: CHANT.pacifyRadius });
      return true;
    }
    return approach && this.autoSendTo(u, best.x, best.z, `u${best.id}`);
  }

  /** The village brain — works for ANY economic tribe. */
  private assignWork(u: Unit): boolean {
    const tribe = this.tribes[u.tribe as TribeId]!;

    if (u.carrying) {
      u.task = 'deliverWood';
      const drop = this.dropOffFor(u);
      if (this.sendTo(u, drop.x, drop.z)) return true;
      u.carrying = false;
      u.task = 'none';
      return false;
    }

    // Every dwelling wants someone at home — no residents, no children.
    if (u.home < 0 && this.tribePopulation(u.tribe as TribeId) < this.popCap(u.tribe as TribeId)) {
      const empty = this.buildings.find(
        (b) => b.tribe === u.tribe && b.kind === 'hut' && b.progress >= 1 && b.residents === 0 &&
          !this.units.some((q) => q.task === 'goHome' && q.targetBuilding === b.id),
      );
      if (empty && !this.isUnreachable(u, `b${empty.id}`)) {
        u.task = 'goHome';
        u.targetBuilding = empty.id;
        const door = this.doorOf(empty);
        if (this.autoSendTo(u, door.x, door.z, `b${empty.id}`)) return true;
        u.task = 'none';
        u.targetBuilding = -1;
      }
    }

    for (const b of this.buildings) {
      if (b.progress >= 1 || b.tribe !== u.tribe || this.isUnreachable(u, `b${b.id}`)) continue;
      if (this.countUnits((q) => q.task === 'build' && q.targetBuilding === b.id) >= MAX_BUILDERS) continue;
      u.task = 'build';
      u.targetBuilding = b.id;
      const r = half(b);
      if (this.autoSendTo(u, b.x + Math.round(this.random() * 2 * r - r), b.z + r + 1, `b${b.id}`)) return true;
      u.task = 'none';
      u.targetBuilding = -1;
    }

    if (tribe.wood < WOOD_TARGET) {
      const treeIdx = this.nearestChoppableTree(u);
      if (treeIdx >= 0) {
        u.task = 'chop';
        u.targetTree = treeIdx;
        if (this.autoSendTo(u, this.trees[treeIdx].x, this.trees[treeIdx].z, `t${treeIdx}`)) return true;
        u.task = 'none';
        u.targetTree = -1;
      }
    }

    if (u.idleTime > (u.home >= 0 ? 5 : 3) && this.tryMoveIn(u)) return true;
    return false;
  }

  /** Nearest place to drop wood: the home circle or a finished lumberyard. */
  private dropOffFor(u: Unit): { x: number; z: number } {
    const tribe = this.tribes[u.tribe as TribeId]!;
    let best = tribe.home;
    let bestD = this.distTo(u, best.x, best.z);
    for (const b of this.buildings) {
      if (b.tribe !== u.tribe || b.kind !== 'lumberyard' || b.progress < 1) continue;
      const door = this.doorOf(b);
      const d = this.distTo(u, door.x, door.z);
      if (d < bestD) {
        bestD = d;
        best = door;
      }
    }
    return best;
  }

  private nearYard(tribe: Tribe, x: number, z: number): boolean {
    return this.buildings.some(
      (b) => b.tribe === tribe && b.kind === 'lumberyard' && b.progress >= 1 &&
        Math.hypot(wrapDelta(b.x - x, WORLD_SIZE), wrapDelta(b.z - z, WORLD_SIZE)) <= LUMBERYARD.radius,
    );
  }

  /** Seconds this villager needs to fell a tree where it stands. */
  chopSecondsFor(u: Unit): number {
    return CHOP_SECONDS / (this.nearYard(u.tribe, u.x, u.z) ? LUMBERYARD.chopBonus : 1);
  }

  dwellingCapacity(b: Building): number {
    return DWELLING_TIERS[b.tier].capacity;
  }

  popCap(id: TribeId): number {
    let beds = 0;
    for (const b of this.buildings) {
      if (b.tribe === id && b.kind === 'hut' && b.progress >= 1) beds += this.dwellingCapacity(b);
    }
    return Math.min(ECONOMY.popHardCap, Math.floor(ECONOMY.popBase + beds * ECONOMY.popPerBed));
  }

  /** Head for a dwelling with a free bed (own home first). */
  private tryMoveIn(u: Unit): boolean {
    // A dwelling whose door this unit recently failed to reach is skipped for
    // a while (see autoSendTo) — otherwise a cut-off hut costs a full A*
    // search every tick for every idle villager.
    const free = (b: Building) =>
      b.kind === 'hut' && b.progress >= 1 && b.residents < this.dwellingCapacity(b) && !this.isUnreachable(u, `h${b.id}`);
    const ownHome = u.home >= 0;
    const hut = ownHome
      ? this.buildings.find((b) => b.id === u.home && free(b))
      : this.buildings.find((b) => b.tribe === u.tribe && free(b));
    if (!hut) return false;
    u.task = 'goHome';
    u.targetBuilding = hut.id;
    const door = this.doorOf(hut);
    // Your own home gets the full search budget; any free hut, the cheap one.
    if (ownHome ? this.sendTo(u, door.x, door.z) : this.autoSendTo(u, door.x, door.z, `h${hut.id}`)) return true;
    if (ownHome) this.unreachable.set(`${u.id}:h${hut.id}`, this.elapsed + 20 + this.random() * 10);
    u.task = 'none';
    u.targetBuilding = -1;
    return false;
  }

  /** Put a unit straight into a dwelling (level setup, tests). */
  moveIn(u: Unit, b: Building): boolean {
    if (b.kind !== 'hut' || b.residents >= this.dwellingCapacity(b)) return false;
    this.abandonTask(u);
    u.hidden = true;
    u.state = 'inside';
    u.home = b.id;
    b.residents++;
    return true;
  }

  private tickMoving(u: Unit, dt: number): void {
    if (u.castSpell && this.castTargetInRange(u)) {
      this.beginCast(u);
      return;
    }
    if (u.task === 'attack') {
      const target = this.unitById(u.targetUnit);
      if (!target || target.hp <= 0 || target.hidden) {
        this.abandonTask(u);
        return;
      }
      if (this.distTo(u, target.x, target.z) <= UNITS[u.kind].range) {
        u.state = 'fighting';
        return;
      }
    } else if (u.task === 'attackBuilding') {
      const b = this.getBuilding(u.targetBuilding);
      if (!b) {
        this.abandonTask(u);
        return;
      }
      if (this.distTo(u, b.x, b.z) <= this.buildingReach(u, b)) {
        u.state = 'fighting';
        return;
      }
    } else if (u.kind === 'chanter' && u.task === 'none' && u.tribe !== 'wild' && this.tryChant(u, false)) {
      return;
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
    const d = Math.hypot(dx, dz);
    const step = this.unitSpeed(u) * dt;

    if (d <= step) {
      u.x = wp.x;
      u.z = wp.z;
      u.pathIndex++;
      if (u.pathIndex >= u.path.length) this.onArrive(u);
    } else {
      u.x = wrapf(u.x + (dx / d) * step);
      u.z = wrapf(u.z + (dz / d) * step);
      u.heading = Math.atan2(dx, dz);
    }
  }

  private onArrive(u: Unit): void {
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
    u.idleTime = 0;

    if (u.castSpell) {
      // Walked as close as the ground allows; cast if that's close enough.
      if (this.castTargetInRange(u)) this.beginCast(u);
      else {
        if (u.tribe === 'player' && u.castTarget) this.events.push({ type: 'denied', x: u.castTarget.x, z: u.castTarget.z });
        this.abandonTask(u);
      }
      return;
    }

    switch (u.task) {
      case 'chop': {
        const tree = this.trees[u.targetTree];
        if (tree?.alive) {
          u.state = 'working';
          u.workTimer = this.chopSecondsFor(u);
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
        const t = this.tribes[u.tribe as TribeId];
        if (t) t.wood++;
        u.carrying = false;
        this.abandonTask(u);
        return;
      }
      case 'goHome': {
        const b = this.getBuilding(u.targetBuilding);
        if (!b || !this.moveIn(u, b)) this.abandonTask(u);
        return;
      }
      case 'train': {
        const b = this.getBuilding(u.targetBuilding);
        const tribe = this.tribes[u.tribe as TribeId];
        const def = b && BUILDINGS[b.kind].trains ? UNITS[BUILDINGS[b.kind].trains!] : null;
        if (b && tribe && def && b.progress >= 1 && b.trainee === u.id && tribe.wood >= def.trainWood) {
          tribe.wood -= def.trainWood;
          this.enter(u, b);
          b.trainTime = def.trainSeconds;
        } else {
          if (b && b.trainee === u.id) b.trainee = -1;
          this.abandonTask(u);
        }
        return;
      }
      case 'garrison': {
        const b = this.getBuilding(u.targetBuilding);
        if (b && b.progress >= 1 && b.garrison.length < this.garrisonCap(b) && this.canGarrison(u, b)) {
          this.enter(u, b);
          b.garrison.push(u.id);
        } else this.abandonTask(u);
        return;
      }
      case 'attack': {
        const target = this.unitById(u.targetUnit);
        if (!target || target.hp <= 0 || target.hidden) this.abandonTask(u);
        else if (this.distTo(u, target.x, target.z) <= UNITS[u.kind].range) u.state = 'fighting';
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
        if (m && this.monumentAvailable(m) && this.distTo(u, m.x, m.z) < 3) {
          u.state = 'working';
          u.workTimer = WORSHIP_SECONDS;
          u.heading = Math.atan2(wrapDelta(m.x - u.x, WORLD_SIZE), wrapDelta(m.z - u.z, WORLD_SIZE));
        } else this.abandonTask(u);
        return;
      }
      default:
        u.task = u.task === 'chant' ? 'none' : u.task;
        u.state = 'idle';
    }
  }

  private tickWorking(u: Unit, dt: number): void {
    if (u.castSpell) {
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        const spell = u.castSpell;
        const target = u.castTarget!;
        const tribe = this.tribes[u.tribe as TribeId];
        u.castSpell = null;
        u.castTarget = null;
        u.state = 'idle';
        if (tribe && spendCast(tribe.spells, tribe.known, spell)) {
          castSpell(this, spell, target.x, target.z, u.x, u.z, tribe.id);
        } else if (u.tribe === 'player') {
          this.events.push({ type: 'denied', x: target.x, z: target.z });
        }
      }
      return;
    }

    if (u.task === 'chant') return; // the chant system (chant.ts) does the work

    if (u.task === 'chop') {
      const tree = this.trees[u.targetTree];
      if (!tree?.alive) {
        this.abandonTask(u);
        return;
      }
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        tree.alive = false;
        tree.burning = 0;
        const replant = this.nearYard(u.tribe, tree.x, tree.z) ? LUMBERYARD.regrowFactor : 1;
        tree.regrow = TREE_REGROW_SECONDS * (0.7 + this.random() * 0.6) * replant;
        u.carrying = true;
        u.targetTree = -1;
        u.task = 'deliverWood';
        const drop = this.dropOffFor(u);
        if (!this.sendTo(u, drop.x, drop.z)) {
          // Standing on the drop-off already: deliver on the spot.
          if (this.distTo(u, drop.x, drop.z) < 1.5) this.onArrive(u);
          else this.abandonTask(u);
        }
      }
      return;
    }

    if (u.task === 'build') {
      const b = this.getBuilding(u.targetBuilding);
      if (!b || b.progress >= 1) {
        this.abandonTask(u);
        return;
      }
      const def = BUILDINGS[b.kind];
      const step = Math.min(1 - b.progress, dt / def.buildSeconds);
      b.progress += step;
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.9 * step);
      if (b.progress < 0.4) this.map.flatten(b.x, b.z, half(b) + 1.5, dt * 0.5);
      if (b.progress >= 1 - 1e-9) this.completeBuilding(b);
      return;
    }

    if (u.task === 'worship') {
      const m = this.monuments[u.targetMonument];
      if (!m || !this.monumentAvailable(m)) {
        this.abandonTask(u);
        return;
      }
      u.workTimer -= dt;
      if (u.workTimer <= 0) {
        this.commune(m, u.tribe as TribeId);
        this.abandonTask(u);
      }
      return;
    }

    this.abandonTask(u);
  }

  private buildingReach(u: Unit, b: Building): number {
    return Math.max(UNITS[u.kind].range, half(b) + 1.3) + 0.4;
  }

  /** Toe to toe (or pitch range): face the target, count down, strike. */
  private tickFighting(u: Unit, dt: number): void {
    u.attackCooldown -= dt;
    const stats = UNITS[u.kind];

    if (u.task === 'attack') {
      const target = this.unitById(u.targetUnit);
      if (!target || target.hp <= 0 || target.hidden || !this.hostile(u.tribe, target.tribe)) {
        this.abandonTask(u);
        return;
      }
      const d = this.distTo(u, target.x, target.z);
      if (d > stats.range + 0.4) {
        u.state = 'moving';
        if (!this.sendTo(u, target.x, target.z)) this.abandonTask(u);
        return;
      }
      u.heading = Math.atan2(wrapDelta(target.x - u.x, WORLD_SIZE), wrapDelta(target.z - u.z, WORLD_SIZE));
      if (u.pacified > 0) return; // the chant holds the arm
      if (u.attackCooldown <= 0) {
        u.attackCooldown = this.unitCooldown(u);
        this.strike(u, target.x, target.z, stats.range > 2);
        this.hurtUnit(target, stats.dmg);
      }
      return;
    }

    if (u.task === 'attackBuilding') {
      const b = this.getBuilding(u.targetBuilding);
      if (!b || !this.hostile(u.tribe, b.tribe)) {
        this.abandonTask(u);
        return;
      }
      if (this.distTo(u, b.x, b.z) > this.buildingReach(u, b)) {
        u.state = 'moving';
        const r = half(b);
        if (!this.sendTo(u, b.x, b.z + r + 1)) this.abandonTask(u);
        return;
      }
      u.heading = Math.atan2(wrapDelta(b.x - u.x, WORLD_SIZE), wrapDelta(b.z - u.z, WORLD_SIZE));
      if (u.pacified > 0) return;
      if (u.attackCooldown <= 0) {
        u.attackCooldown = this.unitCooldown(u);
        this.strike(u, b.x, b.z, stats.range > 2);
        const bonus = u.kind === 'warden' ? WARDEN.buildingBonus : 1;
        if (u.kind === 'firewarrior' && this.random() < FIRE.emberIgniteChance) this.ignite(b);
        this.hurtBuilding(b, stats.dmg * bonus);
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
    if (u.pacified > 0) return false;
    const sight = UNITS[u.kind].sight;
    let best: Unit | null = null;
    let bestD: number = sight;
    for (const q of this.units) {
      if (q.hidden || !this.hostile(u.tribe, q.tribe) || this.isUnreachable(u, `u${q.id}`)) continue;
      const d = this.distTo(u, q.x, q.z);
      if (d < bestD) {
        bestD = d;
        best = q;
      }
    }
    if (best) {
      u.task = 'attack';
      u.targetUnit = best.id;
      if (this.distTo(u, best.x, best.z) <= UNITS[u.kind].range) u.state = 'fighting';
      else if (!this.autoSendTo(u, best.x, best.z, `u${best.id}`)) this.abandonTask(u);
      return u.task === 'attack';
    }
    for (const b of this.buildings) {
      if (!this.hostile(u.tribe, b.tribe) || this.isUnreachable(u, `b${b.id}`)) continue;
      if (this.distTo(u, b.x, b.z) < sight + half(b)) {
        u.task = 'attackBuilding';
        u.targetBuilding = b.id;
        if (this.distTo(u, b.x, b.z) <= this.buildingReach(u, b)) u.state = 'fighting';
        else if (!this.autoSendTo(u, b.x, b.z + half(b) + 1, `b${b.id}`)) this.abandonTask(u);
        return u.task === 'attackBuilding';
      }
    }
    return false;
  }

  private enemySoldierNear(u: Unit, radius: number): boolean {
    return this.units.some(
      (q) => !q.hidden && this.hostile(u.tribe, q.tribe) && isFighterKind(q.kind) && this.distTo(u, q.x, q.z) < radius,
    );
  }

  abandonTask(u: Unit): void {
    u.task = 'none';
    u.targetTree = -1;
    u.targetBuilding = -1;
    u.targetUnit = -1;
    u.targetMonument = -1;
    u.castSpell = null;
    u.castTarget = null;
    if (u.state !== 'inside') u.state = 'idle';
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
  }

  /** A listener gives in to a chant and joins the chanter's tribe. */
  defect(u: Unit, chanter: Unit): void {
    if (u.home >= 0 && u.hidden && u.garrison < 0) {
      const b = this.getBuilding(u.home);
      if (b) b.residents--;
    }
    u.tribe = chanter.tribe;
    u.home = -1;
    u.chantBy = -1;
    u.chantProgress = 0;
    u.pacified = 0;
    u.carrying = false;
    this.abandonTask(u);
    this.events.push({ type: 'defect', x: u.x, z: u.z, x2: chanter.x, z2: chanter.z });
  }

  // -------------------------------------------------------------------------
  // Spellcasting & damage
  // -------------------------------------------------------------------------

  /**
   * Why `tribe` can't cast `spell` at (tx, tz) right now, or null if it can.
   * Checks: a leader exists, a gifted cast or charge is ready, the target is
   * land for spells that aren't `anywhere`, and the target is in range or
   * the leader can walk into range.
   */
  castCheck(tribe: TribeId, spell: SpellId, tx: number, tz: number): string | null {
    const t = this.tribes[tribe];
    const leader = this.leaderOf(tribe);
    if (!t || !leader || leader.hidden) return 'Your leader is not here';
    if (!hasCast(t.spells, t.known, spell)) return t.known.has(spell) ? 'No charges ready' : 'Spell not known';
    const def = spellDef(spell);
    const x = this.map.wrap(Math.round(tx));
    const z = this.map.wrap(Math.round(tz));
    if (!def.anywhere && this.map.heightAt(x, z) < WALK_MIN_HEIGHT) return 'Must target land';
    if (this.distTo(leader, x, z) <= def.range) return null;
    const path = findPath(this.map, leader.x, leader.z, x, z);
    const end = path && path.length > 0 ? path[path.length - 1] : null;
    if (!end || Math.hypot(wrapDelta(end.x - x, WORLD_SIZE), wrapDelta(end.z - z, WORLD_SIZE)) > def.range) {
      return 'Out of range';
    }
    return null;
  }

  /**
   * Ask a tribe's leader to cast. Returns null when the order is accepted
   * (the leader casts now or walks into range first), else the reason it
   * was refused (a 'denied' event fires for the human player).
   */
  orderCast(tribe: TribeId, spell: SpellId, tx: number, tz: number): string | null {
    const why = this.castCheck(tribe, spell, tx, tz);
    if (why) {
      if (tribe === 'player') this.events.push({ type: 'denied', x: tx, z: tz });
      return why;
    }
    const leader = this.leaderOf(tribe)!;
    this.abandonTask(leader);
    leader.castSpell = spell;
    leader.castTarget = { x: this.map.wrap(Math.round(tx)), z: this.map.wrap(Math.round(tz)) };
    if (this.castTargetInRange(leader)) this.beginCast(leader);
    else if (!this.sendTo(leader, tx, tz)) {
      leader.castSpell = null;
      leader.castTarget = null;
      if (tribe === 'player') this.events.push({ type: 'denied', x: tx, z: tz });
      return 'Out of range';
    }
    return null;
  }

  private castTargetInRange(u: Unit): boolean {
    if (!u.castTarget || !u.castSpell) return false;
    return this.distTo(u, u.castTarget.x, u.castTarget.z) <= spellDef(u.castSpell).range;
  }

  private beginCast(u: Unit): void {
    u.state = 'working';
    u.workTimer = u.castSpell ? spellDef(u.castSpell).castSeconds : 0.9;
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
    if (u.castTarget) {
      u.heading = Math.atan2(wrapDelta(u.castTarget.x - u.x, WORLD_SIZE), wrapDelta(u.castTarget.z - u.z, WORLD_SIZE));
    }
    this.events.push({ type: 'castFlash', x: u.x, z: u.z });
  }

  /**
   * All unit damage goes through here: Wardens halve spell damage, armor
   * takes its share, Stone Ward halves what's left.
   */
  hurtUnit(u: Unit, amount: number, opts: HurtOptions = {}): void {
    let a = amount;
    if (opts.spell && u.kind === 'warden') a *= 1 - WARDEN.spellResist;
    a *= 1 - UNITS[u.kind].armor;
    if (u.wardTime > 0) a *= BUFFS.wardFactor;
    u.hp -= a;
    if (u.tribe !== 'wild') {
      const t = this.tribes[u.tribe];
      if (t) t.threatTimer = 8;
    }
    if (u.kind === 'chanter' && a > 0) breakChant(this, u);
  }

  displaceUnit(u: Unit, dx: number, dz: number): void {
    u.x = wrapf(u.x + dx);
    u.z = wrapf(u.z + dz);
    u.prevX = u.x;
    u.prevZ = u.z;
    if (u.state !== 'inside') this.abandonTask(u);
  }

  hurtBuilding(b: Building, amount: number): void {
    if (!this.buildings.includes(b)) return;
    b.hp -= b.wardTime > 0 ? amount * BUFFS.wardFactor : amount;
    const t = this.tribes[b.tribe];
    if (t) t.threatTimer = 8;
    if (b.hp <= 0) this.destroyBuilding(b);
  }

  /** Damage as a fraction of the building's max hp (spells scale with size). */
  hurtBuildingFrac(b: Building, frac: number): void {
    this.hurtBuilding(b, frac * b.maxHp);
  }

  /** Set a building alight (no-op if already burning). */
  ignite(b: Building): void {
    if (!this.buildings.includes(b) || b.burning > 0) return;
    b.burning = FIRE.buildingSeconds;
    this.events.push({ type: 'fireStart', x: b.x, z: b.z, magnitude: b.size });
  }

  /** Light living trees within r of (x, z), each with probability `chance`. */
  igniteTreesNear(x: number, z: number, r: number, chance = 1): void {
    for (const t of this.trees) {
      if (!t.alive || t.burning > 0) continue;
      if (Math.hypot(wrapDelta(t.x - x, WORLD_SIZE), wrapDelta(t.z - z, WORLD_SIZE)) > r) continue;
      if (chance < 1 && this.random() >= chance) continue;
      t.burning = FIRE.treeSeconds;
      this.events.push({ type: 'fireStart', x: t.x, z: t.z, magnitude: 1 });
    }
  }

  private destroyBuilding(b: Building, demolished = false): void {
    if (!demolished) this.events.push({ type: 'explosion', x: b.x, z: b.z });
    this.events.push({ type: 'collapse', x: b.x, z: b.z, magnitude: b.size });
    for (const u of this.units) {
      // Only people physically inside THIS building come out (a resident praying
      // at a shrine stays there; it just loses its home).
      if (u.hidden && (u.garrison === b.id || (u.garrison < 0 && u.home === b.id))) this.exitBuilding(u, b);
      if (u.home === b.id) u.home = -1;
      if (u.targetBuilding === b.id) this.abandonTask(u);
    }
    this.clearFootprint(b);
    this.buildings = this.buildings.filter((q) => q.id !== b.id);
  }

  // -------------------------------------------------------------------------
  // Buildings & trees
  // -------------------------------------------------------------------------

  /** The open tile on the south edge of a footprint where people go in and out. */
  doorOf(b: Building): { x: number; z: number } {
    return { x: b.x, z: this.map.wrap(b.z + half(b)) };
  }

  private enter(u: Unit, b: Building): void {
    u.path = [];
    u.pathIndex = 0;
    u.goal = null;
    u.task = 'none';
    u.hidden = true;
    u.state = 'inside';
    u.garrison = b.id;
  }

  private exitBuilding(u: Unit, b: Building): void {
    const door = this.doorOf(b);
    const out = findNearestWalkable(this.map, door.x, door.z + 1) ?? door;
    u.hidden = false;
    u.state = 'idle';
    u.task = 'none';
    u.idleTime = 0;
    u.garrison = -1;
    u.x = u.prevX = out.x;
    u.z = u.prevZ = out.z;
  }

  private completeBuilding(b: Building): void {
    b.progress = 1;
    b.hp = Math.min(b.maxHp, b.hp + 1e-6 * b.maxHp);
    if (b.maxHp - b.hp < 1e-3) b.hp = b.maxHp;
    this.tribes[b.tribe]?.everBuilt.add(b.kind);
    this.events.push({ type: 'built', x: b.x, z: b.z, magnitude: b.size });
  }

  private garrisonCap(b: Building): number {
    return b.kind === 'tower' ? ECONOMY.towerGarrison : b.kind === 'shrine' ? ECONOMY.shrineWorshippers : 0;
  }

  private canGarrison(u: Unit, b: Building): boolean {
    if (u.tribe !== b.tribe) return false;
    if (b.kind === 'tower') return isFighterKind(u.kind);
    if (b.kind === 'shrine') return u.kind === 'brave';
    return false;
  }

  /** Villagers praying at finished shrines, per tribe. */
  private prayingCounts(): Partial<Record<TribeId, number>> {
    const out: Partial<Record<TribeId, number>> = {};
    for (const b of this.buildings) {
      if (b.kind === 'shrine' && b.progress >= 1) out[b.tribe] = (out[b.tribe] ?? 0) + b.garrison.length;
    }
    return out;
  }

  private tickBuildings(dt: number): void {
    for (const b of [...this.buildings]) {
      if (b.wardTime > 0) b.wardTime = Math.max(0, b.wardTime - dt);
      if (b.burning > 0) this.tickFire(b, dt);
      if (b.progress < 1 || !this.buildings.includes(b)) continue;

      if (b.kind === 'hut') this.tickDwelling(b, dt);
      else if (BUILDINGS[b.kind].trains) this.tickTraining(b, dt);
      else if (b.kind === 'tower') this.tickTower(b, dt);
    }
  }

  private tickFire(b: Building, dt: number): void {
    b.burning = Math.max(0, b.burning - dt);
    if (this.random() < FIRE.spreadChancePerSecond * dt) {
      const near = this.trees.filter(
        (t) => t.alive && t.burning <= 0 &&
          Math.hypot(wrapDelta(t.x - b.x, WORLD_SIZE), wrapDelta(t.z - b.z, WORLD_SIZE)) <= FIRE.spreadRadius + half(b),
      );
      if (near.length > 0) {
        const t = this.rng.pick(near);
        t.burning = FIRE.treeSeconds;
        this.events.push({ type: 'fireStart', x: t.x, z: t.z, magnitude: 1 });
      }
    }
    this.hurtBuilding(b, b.maxHp * FIRE.buildingDps * dt);
  }

  private tickDwelling(b: Building, dt: number): void {
    const tier = DWELLING_TIERS[b.tier];
    const full = b.residents >= tier.capacity;
    const tribe = this.tribes[b.tribe]!;

    // A full dwelling grows (paused, not reset, while someone steps out).
    if (full && b.tier < DWELLING_TIERS.length - 1) {
      const next = DWELLING_TIERS[b.tier + 1];
      b.fullTime += dt;
      if (b.fullTime >= next.growSeconds && tribe.wood >= next.growWood) {
        tribe.wood -= next.growWood;
        b.tier++;
        b.fullTime = 0;
        this.events.push({ type: 'dwellingGrow', x: b.x, z: b.z, magnitude: b.tier });
      }
    }

    if (b.residents > 0 && this.tribePopulation(b.tribe) < this.popCap(b.tribe)) {
      b.breedTimer -= dt;
      if (b.breedTimer <= 0) {
        b.breedTimer = DWELLING_TIERS[b.tier].breedSeconds * (0.8 + this.random() * 0.5);
        const door = this.doorOf(b);
        this.spawnNearWalkable('brave', b.tribe, door.x, door.z + 1);
      }
    }

    // Residents step out for a stroll — except from a full house that's growing.
    const nextTier = DWELLING_TIERS[b.tier + 1];
    // Residents stay in to grow the house — unless it's ready and waiting on wood
    // (then they go out and fetch it).
    const growing = full && !!nextTier && (b.fullTime < nextTier.growSeconds || tribe.wood >= nextTier.growWood);
    b.outingTimer -= dt;
    if (b.outingTimer <= 0) {
      b.outingTimer = OUTING_SECONDS * (0.6 + this.random() * 0.8);
      // Someone stays home to raise children — unless the tribe is at its cap.
      const atCap = this.tribePopulation(b.tribe) >= this.popCap(b.tribe);
      if (b.residents > (atCap ? 0 : 1) && !growing) {
        const resident = this.units.find((q) => q.hidden && q.home === b.id && q.garrison < 0);
        if (resident) {
          this.exitBuilding(resident, b);
          b.residents--;
        }
      }
    }
  }

  private tickTraining(b: Building, dt: number): void {
    const kind = BUILDINGS[b.kind].trains!;
    const def = UNITS[kind];
    const tribe = this.tribes[b.tribe]!;

    if (b.trainee >= 0) {
      const u = this.unitById(b.trainee);
      const inside = u && u.garrison === b.id;
      if (!u || u.tribe !== b.tribe || (!inside && !(u.task === 'train' && u.targetBuilding === b.id))) {
        b.trainee = -1;
        return;
      }
      if (!inside) return; // still walking over
      b.trainTime -= dt;
      if (b.trainTime > 0) return;
      // Graduation: the villager walks out a soldier.
      b.trainee = -1;
      b.queue = Math.max(0, b.queue - 1);
      this.exitBuilding(u, b);
      if (u.home >= 0) {
        // Leaves the family home; soldiers billet wherever there's a bed.
        u.home = -1;
      }
      u.kind = kind;
      u.hp = u.maxHp = def.hp;
      this.events.push({ type: 'trained', x: u.x, z: u.z, magnitude: b.id });
      if (b.rally) this.sendTo(u, b.rally.x, b.rally.z);
      return;
    }

    if (b.queue <= 0 || tribe.wood < def.trainWood) return;
    b.workTimer -= dt;
    if (b.workTimer > 0) return;
    b.workTimer = 0.5;
    let recruit: Unit | null = null;
    let bestD = Infinity;
    for (const q of this.units) {
      if (q.tribe !== b.tribe || q.kind !== 'brave' || q.hidden || q.task !== 'none' || q.carrying) continue;
      if (q.state !== 'idle' && q.state !== 'moving') continue;
      const d = this.distTo(q, b.x, b.z);
      if (d < bestD) {
        bestD = d;
        recruit = q;
      }
    }
    if (!recruit) return;
    this.abandonTask(recruit);
    recruit.task = 'train';
    recruit.targetBuilding = b.id;
    b.trainee = recruit.id;
    const door = this.doorOf(b);
    if (this.distTo(recruit, door.x, door.z) < 0.6) this.onArrive(recruit);
    else if (!this.sendTo(recruit, door.x, door.z)) {
      this.abandonTask(recruit);
      b.trainee = -1;
    }
  }

  /** A tower only fights with people in it; they reach farther and hit harder. */
  private tickTower(b: Building, dt: number): void {
    for (const id of b.garrison) {
      const u = this.unitById(id);
      if (!u) continue;
      u.attackCooldown -= dt;
      if (u.attackCooldown > 0) continue;
      const stats = UNITS[u.kind];
      const reach = Math.max(stats.range, TOWER_BONUS.minRange) + TOWER_BONUS.range;
      let best: Unit | null = null;
      let bestD = reach;
      for (const q of this.units) {
        if (q.hidden || !this.hostile(b.tribe, q.tribe)) continue;
        const d = Math.hypot(wrapDelta(q.x - b.x, WORLD_SIZE), wrapDelta(q.z - b.z, WORLD_SIZE));
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      if (best) {
        u.attackCooldown = this.unitCooldown(u);
        this.events.push({ type: 'fireball', x: b.x, z: b.z, x2: best.x, z2: best.z });
        this.hurtUnit(best, stats.dmg * TOWER_BONUS.dmg);
      }
    }
  }

  private tickTrees(dt: number): void {
    for (const t of this.trees) {
      if (t.burning > 0) {
        t.burning -= dt;
        if (this.random() < 0.15 * dt) this.igniteTreesNear(t.x, t.z, 1.6, 0.5);
        if (t.burning <= 0) {
          t.burning = 0;
          t.alive = false;
          t.regrow = TREE_REGROW_SECONDS * (0.7 + this.random() * 0.6);
        }
        continue;
      }
      if (t.alive) {
        if (this.map.heightAt(t.x, t.z) < WALK_MIN_HEIGHT) {
          t.alive = false; // drowned (or blasted into a crater lake)
          t.regrow = TREE_REGROW_SECONDS;
        }
        continue;
      }
      t.regrow -= dt;
      if (t.regrow <= 0 && walkable(this.map, t.x, t.z)) t.alive = true;
    }
  }

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /** Allowed + prerequisites + wood, independent of location. */
  buildState(tribe: TribeId, kind: BuildingKind): BuildState {
    const t = this.tribes[tribe];
    const def = BUILDINGS[kind];
    if (!t) return { allowed: false, unlocked: false, affordable: false, reason: 'No such tribe' };
    const allowed = t.allowed.has(kind);
    const missing = def.requires.filter(
      (r) => !this.buildings.some((b) => b.tribe === tribe && b.kind === r && b.progress >= 1),
    );
    const unlocked = missing.length === 0;
    const affordable = t.wood >= def.wood;
    let reason: string | null = null;
    if (!allowed) reason = 'Not available in this scenario';
    else if (!unlocked) reason = `Needs a ${missing.map((m) => BUILDINGS[m].name).join(' and a ')}`;
    else if (!affordable) reason = `Needs ${def.wood - t.wood} more wood`;
    return { allowed, unlocked, affordable, reason };
  }

  /** Can a building of `kind` stand centred on (cx, cz)? Ground + space only. */
  siteFree(kind: BuildingKind, cx: number, cz: number): boolean {
    const r = (BUILDINGS[kind].size - 1) / 2;
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
    if (hi - lo > BUILD_FLAT_TOLERANCE * (r > 1 ? 1.5 : 1)) return false;
    // A one-tile lane around every building keeps doors and paths open.
    for (let dz = -r - 1; dz <= r + 1; dz++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        if (this.obstacles.has(tileIndex(cx + dx, cz + dz))) return false;
      }
    }
    for (const id of this.activeTribes()) {
      const home = this.tribes[id]!.home;
      if (Math.abs(wrapDelta(cx - home.x, WORLD_SIZE)) < r + 3 && Math.abs(wrapDelta(cz - home.z, WORLD_SIZE)) < r + 3) return false;
    }
    return true;
  }

  canPlaceBuilding(tribe: TribeId, kind: BuildingKind, cx: number, cz: number): boolean {
    const s = this.buildState(tribe, kind);
    return s.allowed && s.unlocked && s.affordable && this.siteFree(kind, cx, cz);
  }

  placeBuilding(tribe: TribeId, kind: BuildingKind, cx: number, cz: number): boolean {
    if (!this.canPlaceBuilding(tribe, kind, cx, cz)) return false;
    this.tribes[tribe]!.wood -= BUILDINGS[kind].wood;
    this.spawnBuilding(tribe, kind, cx, cz, { complete: false });
    return true;
  }

  /**
   * Put a building straight into the world — no cost, no prerequisite or
   * site checks. For scenario setup and tests. Complete by default.
   */
  spawnBuilding(tribe: TribeId, kind: BuildingKind, cx: number, cz: number, opts: { complete?: boolean } = {}): Building {
    const def = BUILDINGS[kind];
    const complete = opts.complete ?? true;
    const b: Building = {
      id: this.nextId++,
      tribe,
      kind,
      x: this.map.wrap(cx),
      z: this.map.wrap(cz),
      size: def.size,
      progress: complete ? 1 : 0,
      hp: complete ? def.hp : def.hp * 0.1,
      maxHp: def.hp,
      residents: 0,
      breedTimer: DWELLING_TIERS[0].breedSeconds,
      outingTimer: OUTING_SECONDS,
      workTimer: 0,
      tier: 0,
      fullTime: 0,
      queue: 0,
      trainee: -1,
      trainTime: 0,
      rally: null,
      garrison: [],
      burning: 0,
      wardTime: 0,
    };
    this.buildings.push(b);
    this.blockFootprint(b);
    for (const t of this.trees) {
      if (Math.abs(wrapDelta(t.x - b.x, WORLD_SIZE)) <= half(b) && Math.abs(wrapDelta(t.z - b.z, WORLD_SIZE)) <= half(b)) {
        t.alive = false;
        t.regrow = TREE_REGROW_SECONDS;
      }
    }
    if (complete) this.tribes[tribe]?.everBuilt.add(kind);
    return b;
  }

  private blockFootprint(b: Building): void {
    const r = half(b);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx === 0 && dz === r) continue; // the door
        this.obstacles.add(tileIndex(b.x + dx, b.z + dz));
      }
    }
  }

  private clearFootprint(b: Building): void {
    const r = half(b);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) this.obstacles.delete(tileIndex(b.x + dx, b.z + dz));
    }
  }

  // -------------------------------------------------------------------------
  // SimQueries — what the UI may ask (see catalog.ts)
  // -------------------------------------------------------------------------

  spellState(tribe: TribeId, id: SpellId): SpellState {
    const t = this.tribes[tribe];
    if (!t) {
      const def = spellDef(id);
      return { known: false, charges: 0, max: def.maxCharges, progress: 0, charging: false, gifted: 0, eta: Infinity, chargeMana: def.chargeMana, bonusCharges: 0 };
    }
    return slotState(t.spells, t.known, id, t.income);
  }

  setSpellCharging(tribe: TribeId, id: SpellId, on: boolean): void {
    const t = this.tribes[tribe];
    if (t) t.spells[id].charging = on;
  }

  tribeSummary(tribe: TribeId): TribeSummary {
    const t = this.tribes[tribe];
    const counts = Object.fromEntries(Object.keys(UNITS).map((k) => [k, 0])) as Record<UnitKind, number>;
    let idle = 0;
    for (const u of this.units) {
      if (u.tribe !== tribe) continue;
      counts[u.kind]++;
      if (u.kind === 'brave' && !u.hidden && u.task === 'none' && u.state === 'idle') idle++;
    }
    const leader = this.leaderOf(tribe);
    return {
      wood: t?.wood ?? 0,
      manaRate: t?.manaRate ?? 0,
      population: this.tribePopulation(tribe),
      popCap: this.popCap(tribe),
      housed: this.housedPopulation(tribe),
      idleVillagers: idle,
      counts,
      praying: this.prayingCounts()[tribe] ?? 0,
      leaderAlive: !!leader,
      leaderRespawn: leader ? 0 : Math.max(0, t?.shamanRespawn ?? 0),
    };
  }

  queueTraining(buildingId: number, count: number): number {
    const b = this.getBuilding(buildingId);
    if (!b || !BUILDINGS[b.kind].trains) return 0;
    b.queue = Math.max(0, Math.min(ECONOMY.trainQueueMax, b.queue + count));
    return b.queue;
  }

  setRally(buildingId: number, x: number, z: number): void {
    const b = this.getBuilding(buildingId);
    if (b) b.rally = { x: this.map.wrap(Math.round(x)), z: this.map.wrap(Math.round(z)) };
  }

  orderGarrison(unitIds: number[], buildingId: number): void {
    const b = this.getBuilding(buildingId);
    if (!b || b.progress < 1) return;
    const cap = this.garrisonCap(b);
    let reserved = b.garrison.length + this.countUnits((q) => q.task === 'garrison' && q.targetBuilding === b.id);
    const door = this.doorOf(b);
    for (const id of unitIds) {
      if (reserved >= cap) break;
      const u = this.unitById(id);
      if (!u || u.hidden || !this.canGarrison(u, b)) continue;
      if (u.task === 'garrison' && u.targetBuilding === b.id) continue;
      this.abandonTask(u);
      u.task = 'garrison';
      u.targetBuilding = b.id;
      reserved++;
      if (this.distTo(u, door.x, door.z) < 0.6) this.onArrive(u);
      else if (!this.sendTo(u, door.x, door.z)) {
        this.abandonTask(u);
        reserved--;
      }
    }
  }

  ejectGarrison(buildingId: number): void {
    const b = this.getBuilding(buildingId);
    if (!b) return;
    for (const id of b.garrison) {
      const u = this.unitById(id);
      if (u) this.exitBuilding(u, b);
    }
    b.garrison = [];
  }

  demolish(buildingId: number): void {
    const b = this.getBuilding(buildingId);
    if (!b) return;
    const t = this.tribes[b.tribe];
    if (t) t.wood += Math.floor(BUILDINGS[b.kind].wood / 2);
    this.destroyBuilding(b, true);
  }

  // -------------------------------------------------------------------------
  // Monuments
  // -------------------------------------------------------------------------

  monumentAvailable(m: Monument): boolean {
    if (m.opensAt !== undefined && this.elapsed < m.opensAt) return false;
    return m.mode === 'teach' ? m.claimedBy === null : m.sleep <= 0;
  }

  private commune(m: Monument, tribe: TribeId): void {
    const t = this.tribes[tribe];
    if (!t) return;
    m.claimer = tribe;
    m.claimedBy = tribe;
    m.firstClaimer ??= tribe;
    if (m.mode === 'teach') {
      t.known.add(m.spell);
      this.events.push({ type: 'unlock', x: m.x, z: m.z });
    } else {
      t.spells[m.spell].gifted += m.charges ?? 2;
      m.sleep = m.cooldown ?? 90;
      this.events.push({ type: 'giftClaimed', x: m.x, z: m.z, magnitude: m.charges ?? 2 });
    }
  }

  private tickMonuments(dt: number): void {
    for (const m of this.monuments) {
      if (m.mode !== 'gift' || m.sleep <= 0) continue;
      m.sleep -= dt;
      if (m.sleep <= 0) {
        m.sleep = 0;
        m.claimedBy = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Orders & helpers
  // -------------------------------------------------------------------------

  private isUnreachable(u: Unit, target: string): boolean {
    const until = this.unreachable.get(`${u.id}:${target}`);
    return until !== undefined && until > this.elapsed;
  }

  /**
   * sendTo for a job the unit chose itself: a smaller search budget, and on
   * failure the target is remembered as unreachable for a while so the unit
   * picks something else instead of re-running the same failed search every tick.
   */
  private autoSendTo(u: Unit, tx: number, tz: number, target: string): boolean {
    if (this.sendTo(u, tx, tz, World.AUTO_EXPANSIONS)) return true;
    this.unreachable.set(`${u.id}:${target}`, this.elapsed + 20 + this.random() * 10);
    return false;
  }

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

  /** Send a leader to commune at a monument. Only leaders can worship. */
  orderWorship(ids: number[], monumentIdx: number): void {
    const m = this.monuments[monumentIdx];
    if (!m || !this.monumentAvailable(m)) return;
    for (const id of ids) {
      const u = this.units.find((q) => q.id === id);
      if (!u || u.hidden || u.kind !== 'shaman') continue;
      this.abandonTask(u);
      u.task = 'worship';
      u.targetMonument = monumentIdx;
      if (this.distTo(u, m.x, m.z + 1) < 0.6) this.onArrive(u);
      else if (!this.sendTo(u, m.x, m.z + 1)) this.abandonTask(u);
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
      if (UNITS[u.kind].dmg > 0 && this.hostile(u.tribe, target.tribe)) {
        this.abandonTask(u);
        u.task = 'attack';
        u.targetUnit = targetId;
        if (this.distTo(u, target.x, target.z) <= UNITS[u.kind].range) u.state = 'fighting';
        else if (!this.sendTo(u, target.x, target.z)) this.abandonTask(u);
      } else movers.push(id);
    }
    if (movers.length > 0) this.orderMove(movers, target.x, target.z);
  }

  /** Send fighters at an enemy building. */
  orderAttackBuilding(ids: number[], buildingId: number): void {
    const b = this.getBuilding(buildingId);
    if (!b) return;
    for (const id of ids) {
      const u = this.unitById(id);
      if (!u || u.hidden || UNITS[u.kind].dmg <= 0 || !this.hostile(u.tribe, b.tribe)) continue;
      this.abandonTask(u);
      u.task = 'attackBuilding';
      u.targetBuilding = b.id;
      if (this.distTo(u, b.x, b.z) <= this.buildingReach(u, b)) u.state = 'fighting';
      else if (!this.sendTo(u, b.x, b.z + half(b) + 1)) this.abandonTask(u);
    }
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
    const claimed = new Set<number>();
    for (const q of this.units) if (q.task === 'chop') claimed.add(q.targetTree);
    let best = -1;
    let bestDist = 28;
    for (let i = 0; i < this.trees.length; i++) {
      const t = this.trees[i];
      if (!t.alive || t.burning > 0 || claimed.has(i) || this.isUnreachable(u, `t${i}`)) continue;
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
    const hp = UNITS[kind].hp;
    const u: Unit = {
      id: this.nextId++,
      kind,
      tribe,
      x: wrapf(x),
      z: wrapf(z),
      prevX: wrapf(x),
      prevZ: wrapf(z),
      heading: this.random() * Math.PI * 2,
      state: 'idle',
      task: 'none',
      path: [],
      pathIndex: 0,
      goal: null,
      idleTime: this.random() * 5,
      workTimer: 0,
      targetTree: -1,
      targetBuilding: -1,
      targetUnit: -1,
      targetMonument: -1,
      attackCooldown: 0,
      carrying: false,
      hidden: false,
      home: -1,
      hp,
      maxHp: hp,
      castSpell: null,
      castTarget: null,
      garrison: -1,
      wardTime: 0,
      warsongTime: 0,
      lifted: 0,
      pacified: 0,
      chantBy: -1,
      chantProgress: 0,
    };
    this.units.push(u);
    return u;
  }

  spawnNearWalkable(kind: UnitKind, tribe: Tribe, x: number, z: number): Unit | null {
    // Never onto a stranded scrap (a cliff-ringed ridge-top): the nearest
    // ground that belongs to a real stretch of land, else any ground at all.
    const major = (tx: number, tz: number) => isMajor(this.map, regionAt(this.map, tx, tz));
    const spot =
      findNearestWalkable(this.map, Math.round(x), Math.round(z), 16, major) ??
      findNearestWalkable(this.map, Math.round(x), Math.round(z));
    if (!spot) return null;
    return this.spawn(kind, tribe, spot.x + this.random() * 0.6 - 0.3, spot.z + this.random() * 0.6 - 0.3);
  }

  /**
   * Find a pleasant spot to live — as far from `awayFrom` homes as good
   * ground allows (a skirmish needs a march between villages).
   */
  private findSettleSite(needTrees: boolean, awayFrom: Array<{ x: number; z: number }>): { x: number; z: number } {
    let best = { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 };
    let bestScore = -1;
    const want = awayFrom.length <= 1 ? WORLD_SIZE / 3 : WORLD_SIZE / 4;
    for (let attempt = 0; attempt < 600; attempt++) {
      const x = this.rng.int(WORLD_SIZE);
      const z = this.rng.int(WORLD_SIZE);
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
      if (awayFrom.length === 0) return { x, z };
      const sep = Math.min(
        ...awayFrom.map((a) => Math.hypot(wrapDelta(x - a.x, WORLD_SIZE), wrapDelta(z - a.z, WORLD_SIZE))),
      );
      if (sep > want) return { x, z };
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
        if (hash2(x, z, seed + 555) < 0.022) this.trees.push({ x, z, alive: true, regrow: 0, burning: 0 });
      }
    }
    this.treesVersion++;
  }
}

