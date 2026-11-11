/**
 * sim/catalog.ts — THE CONTRACT. Every unit, building, spell and tribe the
 * game knows about, as plain data, plus the query surface the UI reads.
 *
 * Three groups of code meet here and nowhere else:
 *   - the SIM (world-state.ts, spells.ts, ai.ts) implements the behaviour
 *     these rows describe, and implements `SimQueries` below;
 *   - the RENDERER (assets/models, render/) builds one model per `kind`
 *     and one effect per `EFFECT_EVENTS` entry;
 *   - the UI (ui/) draws panels straight from these rows and `SimQueries`
 *     — it never hard-codes a cost, a name, or a list of spells.
 *
 * Adding content = adding a row here, then teaching each group about it.
 * Numbers are starting points for balance; structure is what's binding.
 *
 * Tribal Gods is its own game: names, roster, spell book and scenarios are
 * ours. It shares a genre with the late-90s god games, not their content.
 */

// ---------------------------------------------------------------------------
// Tribes
// ---------------------------------------------------------------------------

/** Tribes with an economy. `player` is always the human. Up to four per world. */
export const TRIBE_IDS = ['player', 'red', 'gold', 'violet'] as const;
export type TribeId = (typeof TRIBE_IDS)[number];
/** `wild` = unaligned wanderers (recruitable). */
export type Tribe = TribeId | 'wild';

/** What a tribe is called when its scenario doesn't name it. */
export function tribeName(rules: ScenarioRules, id: TribeId): string {
  const named = rules.tribes.find((t) => t.id === id)?.name;
  if (named) return named;
  return id === 'player' ? 'your tribe' : `the ${id[0].toUpperCase()}${id.slice(1)} tribe`;
}

export const TRIBE_COLORS: Record<Tribe, number> = {
  player: 0x2f7fe6,
  red: 0xd9483b,
  gold: 0xe2a72e,
  violet: 0x9a5fd6,
  wild: 0x8a8273,
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type UnitKind = 'brave' | 'warrior' | 'firewarrior' | 'warden' | 'chanter' | 'shaman' | 'wildman';

export interface UnitDef {
  kind: UnitKind;
  /** Display name. (Ids are historical; names are what players see.) */
  name: string;
  blurb: string;
  hp: number;
  dmg: number;
  /** Attack reach in tiles (<=1.5 is melee). */
  range: number;
  cooldown: number;
  /** Auto-engage radius in tiles. 0 = never picks a fight. */
  sight: number;
  /** Tiles per second. */
  speed: number;
  /** Fraction of incoming damage ignored (0..1). */
  armor: number;
  /** Building that trains it (undefined = born or summoned, not trained). */
  trainedAt?: BuildingKind;
  trainWood: number;
  trainSeconds: number;
  /** Rendered height in world units (a tile is 2 wide). People are BIG now. */
  height: number;
}

export const UNITS: Record<UnitKind, UnitDef> = {
  brave: {
    kind: 'brave', name: 'Villager',
    blurb: 'Chops, hauls, builds, raises families, prays. The tribe itself.',
    hp: 12, dmg: 1.2, range: 1.1, cooldown: 1.4, sight: 0, speed: 1.8, armor: 0,
    trainWood: 0, trainSeconds: 0, height: 2.3,
  },
  warrior: {
    kind: 'warrior', name: 'Warrior',
    blurb: 'Spear and hide shield. Wins any fight it can reach.',
    hp: 30, dmg: 4, range: 1.3, cooldown: 1.1, sight: 9, speed: 1.9, armor: 0.1,
    trainedAt: 'warriorHut', trainWood: 2, trainSeconds: 5, height: 2.5,
  },
  firewarrior: {
    kind: 'firewarrior', name: 'Emberthrower',
    blurb: 'Hurls burning pitch from range. Sets buildings alight. Fragile.',
    hp: 15, dmg: 5, range: 6.5, cooldown: 1.7, sight: 10, speed: 1.7, armor: 0,
    trainedAt: 'fireHut', trainWood: 3, trainSeconds: 6, height: 2.4,
  },
  warden: {
    kind: 'warden', name: 'Warden',
    blurb: 'Tower shield and stone maul. Slow, nearly unkillable, wrecks buildings. Shrugs off half of any spell.',
    hp: 60, dmg: 3, range: 1.3, cooldown: 1.6, sight: 7, speed: 1.3, armor: 0.35,
    trainedAt: 'wardenHall', trainWood: 5, trainSeconds: 9, height: 2.8,
  },
  chanter: {
    kind: 'chanter', name: 'Chanter',
    blurb: 'Unarmed. Enemies who hear the chant stop fighting and, in time, change sides. Another chanter breaks the spell.',
    hp: 14, dmg: 0, range: 5, cooldown: 0, sight: 8, speed: 1.6, armor: 0,
    trainedAt: 'chantHall', trainWood: 4, trainSeconds: 8, height: 2.4,
  },
  shaman: {
    kind: 'shaman', name: 'Leader',
    blurb: 'Your one voice in the world. Casts every spell. Returns to the home circle after death — while the tribe lives.',
    hp: 45, dmg: 0, range: 0, cooldown: 0, sight: 0, speed: 2.2, armor: 0,
    trainWood: 0, trainSeconds: 0, height: 3.0,
  },
  wildman: {
    kind: 'wildman', name: 'Wanderer',
    blurb: 'Belongs to no tribe. Yet.',
    hp: 10, dmg: 0, range: 0, cooldown: 0, sight: 0, speed: 1.3, armor: 0,
    trainWood: 0, trainSeconds: 0, height: 2.2,
  },
};

/** Chanter tuning: seconds of uninterrupted chant before a listener defects. */
export const CHANT = { pacifyRadius: 5, convertSeconds: 9, maxListeners: 4 };

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildingKind =
  | 'hut' | 'warriorHut' | 'fireHut' | 'wardenHall' | 'chantHall' | 'tower' | 'shrine' | 'lumberyard';

export interface BuildingDef {
  kind: BuildingKind;
  name: string;
  blurb: string;
  wood: number;
  /** Builder-seconds to raise. */
  buildSeconds: number;
  hp: number;
  /** Footprint is size×size tiles (odd). Buildings are BIG now. */
  size: 3 | 5;
  /** Buildings that must already stand (complete) before this can be placed. */
  requires: BuildingKind[];
  trains?: UnitKind;
  /** Rendered height in world units, for camera/UI framing. */
  height: number;
}

export const BUILDINGS: Record<BuildingKind, BuildingDef> = {
  hut: {
    kind: 'hut', name: 'Dwelling',
    blurb: 'Homes breed villagers and feed your mana. A full dwelling grows — twice — into something larger.',
    wood: 5, buildSeconds: 30, hp: 40, size: 3, requires: [], height: 4.5,
  },
  lumberyard: {
    kind: 'lumberyard', name: 'Lumberyard',
    blurb: 'A second place to drop wood. Villagers working nearby fell trees a third faster and replant what they cut.',
    wood: 6, buildSeconds: 25, hp: 35, size: 3, requires: ['hut'], height: 3.5,
  },
  warriorHut: {
    kind: 'warriorHut', name: 'War Lodge',
    blurb: 'Turns villagers into Warriors.',
    wood: 8, buildSeconds: 35, hp: 55, size: 3, requires: ['hut'], trains: 'warrior', height: 5,
  },
  fireHut: {
    kind: 'fireHut', name: 'Ember Lodge',
    blurb: 'Turns villagers into Emberthrowers.',
    wood: 10, buildSeconds: 38, hp: 50, size: 3, requires: ['warriorHut'], trains: 'firewarrior', height: 5,
  },
  tower: {
    kind: 'tower', name: 'Watchtower',
    blurb: 'Garrison up to two fighters; they see farther and hit harder from the top.',
    wood: 6, buildSeconds: 22, hp: 60, size: 3, requires: ['hut'], height: 7,
  },
  shrine: {
    kind: 'shrine', name: 'Shrine',
    blurb: 'Villagers sent here pray instead of work. Each one speeds every spell that is charging.',
    wood: 12, buildSeconds: 45, hp: 60, size: 5, requires: ['hut'], height: 6,
  },
  wardenHall: {
    kind: 'wardenHall', name: 'Warden Hall',
    blurb: 'Turns villagers into Wardens.',
    wood: 14, buildSeconds: 50, hp: 80, size: 5, requires: ['warriorHut'], trains: 'warden', height: 6,
  },
  chantHall: {
    kind: 'chantHall', name: 'Chant Hall',
    blurb: 'Turns villagers into Chanters.',
    wood: 12, buildSeconds: 45, hp: 50, size: 3, requires: ['shrine'], trains: 'chanter', height: 5.5,
  },
};

/** Panel order for the build menu. */
export const BUILD_ORDER: BuildingKind[] = [
  'hut', 'lumberyard', 'tower', 'warriorHut', 'fireHut', 'shrine', 'chantHall', 'wardenHall',
];

/**
 * Dwellings have three tiers. A dwelling that has been FULL for
 * `growSeconds` grows a tier if the tribe can pay `growWood` (villagers haul
 * it). Tier is 0..2; capacity and breeding improve with each.
 */
export const DWELLING_TIERS = [
  { name: 'Small Dwelling', capacity: 3, breedSeconds: 24, growWood: 0, growSeconds: 0 },
  { name: 'Dwelling', capacity: 4, breedSeconds: 20, growWood: 4, growSeconds: 40 },
  { name: 'Great Dwelling', capacity: 6, breedSeconds: 16, growWood: 7, growSeconds: 70 },
] as const;

export const ECONOMY = {
  popBase: 6,
  /** Population cap contributed by a dwelling = its capacity × this. */
  popPerBed: 1.4,
  popHardCap: 160,
  towerGarrison: 2,
  shrineWorshippers: 6,
  /** Each praying villager adds this fraction to spell charge speed. */
  shrinePrayerBonus: 0.12,
  /** Training buildings hold a queue this long. */
  trainQueueMax: 8,
};

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

export type SpellId =
  | 'blast' | 'convert' | 'lightning' | 'swamp' | 'landbridge' | 'flatten' | 'earthquake' | 'volcano'
  | 'ward' | 'warsong' | 'cyclone' | 'emberfall' | 'sink' | 'bloom';

export type SpellTier = 1 | 2 | 3;
/** How the UI should aim it. `line` = from the leader toward the cursor. */
export type SpellAim = 'point' | 'area' | 'line';

/**
 * THE CHARGE MODEL (replaces "spend mana from a pool at cast time").
 * Mana trickles in from your people. It is poured, automatically and
 * evenly, into every known spell that is switched to charge and not full.
 * A spell that has soaked up `chargeMana` gains one charge, up to
 * `maxCharges`. Casting spends one charge — nothing else. So: small spells
 * come back in seconds, the big ones are a plan you make minutes ahead,
 * and switching spells off to feed one faster is a real decision.
 */
export interface SpellDef {
  id: SpellId;
  name: string;
  blurb: string;
  tier: SpellTier;
  /** Mana soaked up per charge. */
  chargeMana: number;
  maxCharges: number;
  /** Leader must be within this many tiles of the target. */
  range: number;
  /** Effect radius in tiles (for the aiming reticle). 0 for single-target. */
  radius: number;
  /** Seconds the leader stands casting. */
  castSeconds: number;
  /** Seconds the effect lasts in the world (0 = instant). */
  duration: number;
  aim: SpellAim;
  /** Can be aimed at water / unwalkable ground. */
  anywhere: boolean;
  /** Known from the start of a default skirmish. */
  starter: boolean;
}

/** Display order = panel order, grouped by tier. */
export const SPELLS: SpellDef[] = [
  // --- Tier 1: the everyday toolkit -----------------------------------------
  { id: 'blast', name: 'Blast', tier: 1, chargeMana: 14, maxCharges: 4, range: 14, radius: 4.5, castSeconds: 0.7, duration: 0, aim: 'area', anywhere: true, starter: true,
    blurb: 'A crater, and everyone near it thrown clear.' },
  { id: 'convert', name: 'Kindle', tier: 1, chargeMana: 12, maxCharges: 3, range: 12, radius: 5, castSeconds: 0.9, duration: 0, aim: 'area', anywhere: false, starter: true,
    blurb: 'Wanderers in the circle join your tribe.' },
  { id: 'flatten', name: 'Level', tier: 1, chargeMana: 22, maxCharges: 3, range: 14, radius: 5, castSeconds: 0.9, duration: 2.5, aim: 'area', anywhere: true, starter: false,
    blurb: 'Smooths the ground flat. Makes room to build; ruins a hillside defence.' },
  { id: 'bloom', name: 'Bloom', tier: 1, chargeMana: 24, maxCharges: 2, range: 12, radius: 6, castSeconds: 1.0, duration: 6, aim: 'area', anywhere: false, starter: false,
    blurb: 'Felled trees regrow at once, new ones sprout, and your people in the circle are healed.' },
  { id: 'ward', name: 'Stone Ward', tier: 1, chargeMana: 26, maxCharges: 2, range: 12, radius: 6, castSeconds: 0.8, duration: 22, aim: 'area', anywhere: false, starter: false,
    blurb: 'Your people and buildings in the circle take half damage for a while.' },
  // --- Tier 2: decide a battle ----------------------------------------------
  { id: 'lightning', name: 'Lightning', tier: 2, chargeMana: 34, maxCharges: 3, range: 16, radius: 1.5, castSeconds: 0.8, duration: 0, aim: 'point', anywhere: true, starter: false,
    blurb: 'One bolt. Kills what it hits, arcs to two more, sets wood alight.' },
  { id: 'warsong', name: 'Warsong', tier: 2, chargeMana: 36, maxCharges: 2, range: 10, radius: 7, castSeconds: 1.0, duration: 25, aim: 'area', anywhere: false, starter: false,
    blurb: 'Your fighters in the circle move and strike a third faster.' },
  { id: 'swamp', name: 'Mire', tier: 2, chargeMana: 38, maxCharges: 2, range: 14, radius: 4, castSeconds: 1.0, duration: 45, aim: 'area', anywhere: false, starter: false,
    blurb: 'Ground that swallows whoever walks in — yours included.' },
  { id: 'landbridge', name: 'Causeway', tier: 2, chargeMana: 40, maxCharges: 2, range: 22, radius: 2.5, castSeconds: 1.2, duration: 4, aim: 'line', anywhere: true, starter: false,
    blurb: 'Raises a road of land from your leader to the mark, across water or ravine.' },
  { id: 'cyclone', name: 'Cyclone', tier: 2, chargeMana: 55, maxCharges: 2, range: 15, radius: 3, castSeconds: 1.2, duration: 14, aim: 'point', anywhere: true, starter: false,
    blurb: 'A wandering funnel that lifts people, drops them, and peels roofs off.' },
  // --- Tier 3: reshape the planet -------------------------------------------
  { id: 'emberfall', name: 'Emberfall', tier: 3, chargeMana: 80, maxCharges: 1, range: 16, radius: 8, castSeconds: 1.6, duration: 9, aim: 'area', anywhere: true, starter: false,
    blurb: 'Burning stones rain on the circle. Forests and villages catch.' },
  { id: 'sink', name: 'Undertow', tier: 3, chargeMana: 90, maxCharges: 1, range: 14, radius: 7, castSeconds: 1.6, duration: 10, aim: 'area', anywhere: true, starter: false,
    blurb: 'The land in the circle slides, slowly and for good, under the sea.' },
  { id: 'earthquake', name: 'Quake', tier: 3, chargeMana: 100, maxCharges: 1, range: 16, radius: 9, castSeconds: 1.6, duration: 5, aim: 'line', anywhere: true, starter: false,
    blurb: 'A fault tears open along the line. Buildings on it fall.' },
  { id: 'volcano', name: 'Volcano', tier: 3, chargeMana: 160, maxCharges: 1, range: 16, radius: 9, castSeconds: 2.2, duration: 14, aim: 'area', anywhere: true, starter: false,
    blurb: 'A mountain of fire where there was none. Permanent.' },
];

export const spellDef = (id: SpellId): SpellDef => SPELLS.find((s) => s.id === id)!;

/**
 * Monuments (standing stones). Two flavours:
 *   `teach`  — the first leader to commune here learns the spell for the
 *              rest of the scenario;
 *   `gift`   — whoever communes gets `charges` free casts of the spell,
 *              known or not; the stone then sleeps for `cooldown` seconds.
 */
export interface MonumentDef {
  x: number;
  z: number;
  spell: SpellId;
  mode: 'teach' | 'gift';
  charges?: number;
  cooldown?: number;
  /** The stone sleeps (nobody can commune) until this many seconds into the scenario. */
  opensAt?: number;
  /** The stone sleeps until a scripted `openStone` action wakes it. */
  asleep?: boolean;
  /** Seconds of uninterrupted ritual to commune (default by tier: see COMMUNE). */
  communeSeconds?: number;
  /**
   * Guardians: fighters that belong to no tribe, stand around the stone and
   * do nothing — until someone starts a commune here (or hurts one). Then
   * they fight every tribe in reach, the communer first.
   */
  guards?: Partial<Record<UnitKind, number>>;
}

/**
 * THE RITUAL. Communing is not a click: the leader kneels at the stone for
 * `seconds[tier]` (gift stones take `giftFactor` of that), takes
 * `vulnerability`× damage while she does, and any hurt or shove breaks it.
 * A broken ritual keeps its progress but it drains away at `decayPerSecond`
 * of the full ritual per second, so a guarded leader can resume. While a
 * fighter hostile to the communer stands inside `ring` tiles of the stone
 * the ritual pauses (contested). One tribe at a stone at a time.
 */
export const COMMUNE = {
  seconds: { 1: 10, 2: 20, 3: 35 } as Record<SpellTier, number>,
  giftFactor: 0.6,
  vulnerability: 1.5,
  decayPerSecond: 1 / 60,
  ring: 6,
};

/** Seconds of ritual a stone asks for. */
export function communeSecondsFor(m: Pick<MonumentDef, 'spell' | 'mode' | 'communeSeconds'>): number {
  if (m.communeSeconds !== undefined) return m.communeSeconds;
  const base = COMMUNE.seconds[spellDef(m.spell).tier];
  return Math.round(m.mode === 'gift' ? base * COMMUNE.giftFactor : base);
}

// ---------------------------------------------------------------------------
// Scenarios & objectives
// ---------------------------------------------------------------------------

export type Objective =
  | { type: 'destroyTribe'; tribe: TribeId }
  | { type: 'destroyAll' }
  | { type: 'survive'; seconds: number }
  | { type: 'reachPopulation'; count: number }
  | { type: 'claimMonument'; index: number }
  | { type: 'buildCount'; kind: BuildingKind; count: number }
  | { type: 'leaderReach'; x: number; z: number; radius: number }
  | { type: 'holdPoint'; x: number; z: number; radius: number; seconds: number }
  /** The spell holds at least `charges` (default 1) real charges at once. */
  | { type: 'chargeSpell'; spell: SpellId; charges?: number }
  /**
   * The leader casts `spell` `count` times (default 1), landing inside the
   * circle if one is given. Counting starts when the objective becomes active.
   */
  | { type: 'castSpell'; spell: SpellId; count?: number; x?: number; z?: number; radius?: number }
  /** Kindle `count` wanderers into the tribe (counted from activation). */
  | { type: 'convertWanderers'; count: number }
  /** `count` of `tribe`'s people die (counted from activation). */
  | { type: 'killUnits'; tribe: TribeId; count: number }
  /** `count` stranded people (units with `joins`) reach the tribe (counted from activation). */
  | { type: 'rescueStranded'; count: number }
  /**
   * HELD objectives (meant to be optional): true until broken, and only
   * scored at victory. `failed` latches when broken.
   *   loseAtMost — no more than `count` of your people (of `kind`, if given) die;
   *   winWithin  — the scenario is won before `seconds`.
   */
  | { type: 'loseAtMost'; count: number; kind?: UnitKind }
  | { type: 'winWithin'; seconds: number };

export type FailCondition =
  | { type: 'tribeDestroyed' } // always implied
  | { type: 'leaderDies' } // no reincarnation in this scenario
  | { type: 'timeLimit'; seconds: number }
  | { type: 'buildingLost'; kind: BuildingKind }
  /** Another tribe communed at monument `index` before you did. */
  | { type: 'monumentTaken'; index: number };
// (Losing "too many people" is a scripted event: trigger `killed` on the player + action `defeat`.)

export interface ObjectiveState {
  objective: Objective;
  /** Player-facing sentence, e.g. "Reach 40 villagers". */
  text: string;
  done: boolean;
  /** 0..1 where it makes sense (population, survive, hold). */
  progress: number;
  optional: boolean;
  /**
   * False while the objective waits on an earlier one (`after`): the UI
   * hides it (or shows it greyed) and the sim doesn't evaluate it yet.
   */
  active: boolean;
  /** A held objective (loseAtMost, winWithin) that was broken — it can no longer be met. */
  failed: boolean;
}

/** What a tribe may use in a scenario. Omitted lists = everything. */
export interface Loadout {
  spells?: SpellId[]; // known at start
  buildings?: BuildingKind[]; // allowed to build
  startUnits?: Partial<Record<UnitKind, number>>;
  startWood?: number;
  /** Extra max charges on top of the catalog's maxCharges (campaign boons). */
  extraCharges?: Partial<Record<SpellId, number>>;
  /** Multiplier on a spell's chargeMana for this tribe (2 = charges half as fast). */
  chargeCost?: Partial<Record<SpellId, number>>;
  /** Free casts at the start, exactly as if a gift stone had given them. */
  gifts?: Partial<Record<SpellId, number>>;
  /** Complete buildings stood up around the home circle at the start. */
  startBuildings?: BuildingKind[];
  /**
   * Charges each known spell holds at t=0. Omitted spells start with the
   * default (START_CHARGES by tier: the first seconds are always playable).
   */
  startCharges?: Partial<Record<SpellId, number>>;
}

/** Charges a known spell holds at the start, by tier, unless the loadout says otherwise. */
export const START_CHARGES: Record<SpellTier, number> = { 1: 2, 2: 1, 3: 0 };

/**
 * How an AI god behaves (all optional; omitted = the standard rival).
 * Personality changes decisions only — never the rules it plays by.
 */
export interface AiPersonality {
  /** Army size at which it starts raiding (default 5) / marches in force (default 11). */
  harassAt?: number;
  assaultAt?: number;
  /** Stops training past this many fighters (default 24). */
  maxArmy?: number;
  /** Stops raising Dwellings past this many (default by difficulty: 6 / 8 / 11). */
  maxDwellings?: number;
  /** No raids or assaults until attacked, `wakeAt` passes, or a `wake` event fires. */
  passive?: boolean;
  wakeAt?: number;
  /** False = a war band: never raises buildings or trains. Default true. */
  builds?: boolean;
  /** False = never falls back home when hurt (raiders). Default true. */
  defends?: boolean;
  /** Leader visits standing stones. Default true. */
  seeksStones?: boolean;
  /** Train only at halls that turn out these kinds, in this order of preference. */
  prefer?: UnitKind[];
  /** Always makes war on this tribe (while it lives) instead of the nearest rival. */
  target?: TribeId;
}

/** When a scripted scenario event fires. */
export type ScenarioTrigger =
  | { type: 'time'; at: number }
  /**
   * At least `count` (default 1) visible units of `tribe` (default the
   * player; 'wild' allowed), of `kind` if given, stand within the circle.
   */
  | { type: 'zone'; x: number; z: number; radius: number; tribe?: Tribe; count?: number; kind?: UnitKind }
  /** Objective `index` is done. */
  | { type: 'objective'; index: number }
  /** `tribe` (default the player) has cast `spell` (any, if omitted), landing in the circle if one is given. */
  | { type: 'spellCast'; spell?: SpellId; tribe?: TribeId; x?: number; z?: number; radius?: number }
  /** At least `count` stranded people have joined `tribe` (default the player). */
  | { type: 'joined'; count: number; tribe?: TribeId }
  /** At least `count` of `tribe`'s people (of `kind`, if given; leaders never count in the total) have died. */
  | { type: 'killed'; tribe: TribeId; count: number; kind?: UnitKind }
  /** A commune has begun at stone `index` (by `tribe`, if given). */
  | { type: 'commune'; index: number; tribe?: TribeId }
  /** `tribe` (default the player) holds no cast of `spell` right now: no gift left and no charge of a known spell. */
  | { type: 'noCasts'; spell: SpellId; tribe?: TribeId }
  /** Any of these. */
  | { type: 'any'; of: ScenarioTrigger[] }
  /** All of these. */
  | { type: 'all'; of: ScenarioTrigger[] }
  /** This one does not hold. */
  | { type: 'not'; of: ScenarioTrigger };

export type ScenarioAction =
  /**
   * Units appear near (x, z); with `march` they set off for it at once.
   * `hold`: they wait at the march point that many seconds (from spawning)
   * before their god may send them on — a host massing on a beach.
   * `joins`: a STRANDED group — they spawn belonging to no one ('wild') and
   * join `joins` the moment a walking route links them to its home.
   * `by`: 'sea' = they come in by boat (a `landing` event at once, the crews
   * ashore a few seconds later when the hulls ground — sim/scenario-events.ts
   * LANDING); 'land' = they appear at once. Omitted: by sea when the tribe is
   * a homeless war band marching from a shore, otherwise by land.
   */
  | {
    type: 'spawn'; tribe: Tribe; units: Partial<Record<UnitKind, number>>; x: number; z: number;
    march?: { x: number; z: number }; hold?: number; joins?: TribeId; by?: 'sea' | 'land';
  }
  /** `tribe` is now allied with exactly these tribes (both ways); everyone else is hostile to it. */
  | { type: 'allies'; tribe: TribeId; allies: TribeId[] }
  /** A passive AI wakes up. */
  | { type: 'wake'; tribe: TribeId }
  | { type: 'teach'; tribe: TribeId; spell: SpellId }
  | { type: 'gift'; tribe: TribeId; spell: SpellId; charges: number }
  /** The world itself casts a spell at (x, z) on `tribe`'s behalf — no leader needed. */
  | { type: 'strike'; spell: SpellId; x: number; z: number; tribe: TribeId }
  /** Wake a stone that was `asleep`. */
  | { type: 'openStone'; index: number }
  /** The scenario is lost, for `reason` (a fail condition written as a story beat). */
  | { type: 'defeat'; reason: string }
  /** `focus`: where the narrator points (camera nudge / minimap ping). */
  | { type: 'message'; text: string; focus?: { x: number; z: number } };

export interface ScenarioEvent {
  when: ScenarioTrigger;
  /** Seconds between the trigger first holding and the event firing (a visible countdown). */
  delay?: number;
  /**
   * Fire again every `every` seconds after the first, `times` times in all
   * (default once). `while`: instead, it fires each time its trigger has
   * HELD for a whole `every` seconds (the first time too), up to `times` —
   * a recovery that lends another cast only while one is needed, never
   * the moment one is spent. (`delay` is ignored.)
   */
  repeat?: { every: number; times: number; while?: boolean };
  actions: ScenarioAction[];
  /** Shown to the player when it fires (world.messages). */
  message?: string;
  /** Where `message` points (copied onto the world.messages entry). */
  focus?: { x: number; z: number };
}

/** A narrator line. `focus` = the spot it is about: the UI may pan there / ping the minimap. */
export interface WorldMessage {
  at: number;
  text: string;
  focus?: { x: number; z: number };
}

export interface ScenarioRules {
  /** `name` is what the story calls the people ("the Ashmark"); omitted = "the Red tribe". */
  tribes: Array<{ id: TribeId; name?: string; ai: boolean; loadout?: Loadout; allies?: TribeId[]; personality?: AiPersonality }>;
  /** `after`: index of an objective that must be done before this one appears (a story in steps). */
  objectives: Array<{ objective: Objective; text: string; optional?: boolean; after?: number }>;
  fail?: FailCondition[];
  /** Shown before play: a title, a few sentences, and tips. */
  briefing: { title: string; body: string; tips: string[] };
  /** Scripted happenings: raids, betrayals, the sea rising. See sim/scenario-events.ts. */
  events?: ScenarioEvent[];
}

// ---------------------------------------------------------------------------
// What the UI may ask the sim (World implements this)
// ---------------------------------------------------------------------------

export interface SpellState {
  known: boolean;
  charges: number;
  max: number;
  /** 0..1 toward the next charge. */
  progress: number;
  /** Whether mana is being poured into it. */
  charging: boolean;
  /** Free casts from a `gift` monument (spent before real charges). */
  gifted: number;
  /** Estimated seconds to the next charge at the current mana income (Infinity if not charging). */
  eta: number;
  /** Mana per charge for THIS tribe (catalog chargeMana × scenario/boon chargeCost). */
  chargeMana: number;
  /** Charges above the catalog's maxCharges from the scenario/boons (already in `max`). */
  bonusCharges: number;
}

export interface BuildState {
  /** Allowed by the scenario loadout. */
  allowed: boolean;
  /** `requires` satisfied. */
  unlocked: boolean;
  affordable: boolean;
  /** Short reason when it can't be placed now, e.g. "Needs a War Lodge". */
  reason: string | null;
}

export interface TribeSummary {
  wood: number;
  /** Mana per second flowing into spells right now. */
  manaRate: number;
  population: number;
  popCap: number;
  housed: number;
  idleVillagers: number;
  counts: Record<UnitKind, number>;
  praying: number;
  leaderAlive: boolean;
  /** Seconds until the leader returns (0 if alive). */
  leaderRespawn: number;
}

export interface SimQueries {
  spellState(tribe: TribeId, id: SpellId): SpellState;
  setSpellCharging(tribe: TribeId, id: SpellId, on: boolean): void;
  buildState(tribe: TribeId, kind: BuildingKind): BuildState;
  tribeSummary(tribe: TribeId): TribeSummary;
  /** Queue `count` trainees at a training building (negative cancels). Returns the new queue length. */
  queueTraining(buildingId: number, count: number): number;
  /** Where freshly trained units gather. */
  setRally(buildingId: number, x: number, z: number): void;
  /**
   * Send villagers to pray at a shrine / fighters to man a tower. Says who
   * went in and who was turned away (wrong kind, full, no path to the door).
   */
  orderGarrison(unitIds: number[], buildingId: number): { accepted: number[]; refused: number[] };
  /** Would orderGarrison put at least one of these inside right now? (The cursor asks this.) */
  canGarrison(unitIds: number[], buildingId: number): boolean;
  ejectGarrison(buildingId: number): void;
  /** Tear down your own building (refunds half the wood). */
  demolish(buildingId: number): void;
  objectives: ObjectiveState[];
  /** Seconds of sim time since the scenario began. */
  elapsed: number;
}

// ---------------------------------------------------------------------------
// Events the sim emits for the renderer + audio (world.events[].type)
// ---------------------------------------------------------------------------

export const EFFECT_EVENTS = [
  // already emitted and drawn today (render/effects.ts) — keep these names
  'explosion', 'convert', 'lightning', 'swamp', 'quakeStart', 'volcanoStart', 'plume', 'rumbleSmall',
  'shake', 'splash', 'fireball', 'hit', 'death', 'castFlash', 'denied', 'unlock',
  // new
  'wardCast', 'warsongCast', 'cycloneTouch', 'emberStrike', 'sinkRumble', 'bloomCast',
  'chantStart', 'defect', 'dwellingGrow', 'trained', 'built', 'collapse', 'fireStart',
  'giftClaimed', 'objectiveDone', 'leaderDown', 'leaderReturn',
  // the opening + the ritual (fb-opening)
  /** Boats are running in to the beach at (x, z) (magnitude = how many aboard); the crews step ashore LANDING.seconds later. */
  'landing',
  /** A stranded person joined their tribe (tribe = who they joined). */
  'rescued',
  /** A commune began (tribe = communer, magnitude = the spell's tier). Rivals hear it. */
  'communeStart',
  /** A commune broke off before it finished (tribe = communer, magnitude = progress 0..1). */
  'communeInterrupted',
  /** A building site's footprint is being levelled (magnitude = size). */
  'siteLevel',
] as const;
export type EffectEvent = (typeof EFFECT_EVENTS)[number];
