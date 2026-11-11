/**
 * config.ts — every tunable constant in the game, in one place.
 *
 * Each constant notes what changing it FEELS like, not just what it does.
 * When you want to play god with the game itself, start here.
 */

import { TRIBE_COLORS as CATALOG_TRIBE_COLORS } from './sim/catalog';

// ---------------------------------------------------------------------------
// The world grid
// ---------------------------------------------------------------------------

/**
 * The world is a square grid of height values, WORLD_SIZE tiles on a side,
 * that wraps at both edges (see world/heightmap.ts for why that makes a
 * "planet"). 128 tiles a side is enough for a small planet. Bigger = a larger
 * planet that takes longer to walk around; must stay a power of two so the
 * tileable noise octaves in heightmap generation divide it evenly.
 */
export const WORLD_SIZE = 128;

/** Width of one tile in world units. Scales the whole planet uniformly. */
export const TILE = 2;

/** Heights are clamped to this range. Sea level is always 0. */
export const MIN_HEIGHT = -7;
export const MAX_HEIGHT = 18;

// ---------------------------------------------------------------------------
// The curvature illusion (the whole "planet" effect — see world/curvature.ts)
// ---------------------------------------------------------------------------

/**
 * How hard the world bends away from the camera target. Vertices drop by
 * CURVATURE * distance² — so at 60 world units away, land sits
 * 0.0045 * 3600 ≈ 16 units below where it "really" is. (v2 raised it from
 * 0.0035 for the bigger camera range; past LIMB_START in render/look.ts the
 * ground falls away faster still, so the far view ends in a round limb.)
 *
 * Raise it and the planet feels tiny and toy-like; lower it and the world
 * flattens out into an ordinary RTS map. 0 disables the illusion entirely
 * (try it — the game instantly loses its soul).
 */
export const CURVATURE = 0.0045;

// ---------------------------------------------------------------------------
// Rendering window
// ---------------------------------------------------------------------------

/**
 * We never render "the whole planet" — we render a VIEW_TILES × VIEW_TILES
 * window of terrain around the camera target, sampling the wrapped heightmap.
 * Set equal to WORLD_SIZE so the horizon never runs out of land; the
 * curvature drops the window's far edge well below the horizon line.
 */
export const VIEW_TILES = 128;

// ---------------------------------------------------------------------------
// Camera rig
// ---------------------------------------------------------------------------

/** Closest / farthest orbit distance, in world units. */
export const CAM_DIST_MIN = 22;
export const CAM_DIST_MAX = 130;

/**
 * Camera pitch (radians above the horizon) at min / max zoom. Low and
 * cinematic up close, high and god-like zoomed out — the feel of swooping down
 * into your village.
 */
export const CAM_PITCH_MIN = 0.6; // ~34° when zoomed in
export const CAM_PITCH_MAX = 1.1; // ~63° when zoomed out

/** Ground pan speed in world units/sec (scaled up when zoomed out). */
export const CAM_PAN_SPEED = 45;

/** Rotation speed for Q/E keys, radians/sec. */
export const CAM_ROT_SPEED = 1.8;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Fixed simulation rate. Gameplay logic always steps in exact 1/TICK_HZ
 * slices regardless of framerate — that determinism is what will make the
 * sim testable and (later) replayable. Rendering interpolates between ticks.
 */
export const TICK_HZ = 15;

// ---------------------------------------------------------------------------
// Civilizations — who walks this earth
// ---------------------------------------------------------------------------

export type CivId = 'forest' | 'dynasty' | 'north';

/**
 * A civilization is a THEME, not a rules change: leader model and
 * architecture differ, the simulation stays identical (asymmetric balance
 * is a fun problem for another decade). Tribe color (blue/red) stays the
 * readability channel; civ is the flavor channel.
 */
export interface Civ {
  id: CivId;
  name: string;
  leaderTitle: string;
  blurb: string;
  /** Hut roof construction: cone of thatch, stepped sandstone, steep timber. */
  roof: 'thatch' | 'stepped' | 'gabled';
  roofColor: number;
  wallColor: number;
  /** Trim/jewelry color on leaders and finials. */
  accent: number;
}

export const CIVS: Record<CivId, Civ> = {
  forest: {
    id: 'forest',
    name: 'Forest Tribe',
    leaderTitle: 'the Grove-Speaker',
    blurb: 'Thatch, totems, and a leader who listens to the trees.',
    roof: 'thatch',
    roofColor: 0xc9a84c,
    wallColor: 0xb08d5e,
    accent: 0x88eaff,
  },
  dynasty: {
    id: 'dynasty',
    name: 'River Dynasty',
    leaderTitle: 'the God-King',
    blurb: 'Sandstone, gold, and a crown that touches the sky.',
    roof: 'stepped',
    roofColor: 0xd8b36a,
    wallColor: 0xcfb284,
    accent: 0xf0c75e,
  },
  north: {
    id: 'north',
    name: 'Northmen',
    leaderTitle: 'the Far-Seer',
    blurb: 'Steep timber halls and weather gods with short tempers.',
    roof: 'gabled',
    roofColor: 0x5e4a32,
    wallColor: 0x8a6a47,
    accent: 0xa8d8e8,
  },
};

// ---------------------------------------------------------------------------
// Difficulty — how hard the red god plays
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * Difficulty tunes the AI's tempo, never its rules: it decides more or
 * less often (a slow god is a beatable god), waits longer or shorter
 * between spells (`aiCastGap`, seconds), stops raising dwellings sooner or
 * later (`aiDwellings` — an AI town is a size, not a flood), and starts
 * with more or less of a head start in followers.
 */
export const DIFFICULTIES: Record<Difficulty, { aiEvalSeconds: number; aiCastGap: number; aiDwellings: number; redStartBraves: number; label: string }> = {
  easy: { aiEvalSeconds: 4, aiCastGap: 16, aiDwellings: 6, redStartBraves: 6, label: 'A patient, sleepy god' },
  normal: { aiEvalSeconds: 2, aiCastGap: 9, aiDwellings: 8, redStartBraves: 8, label: 'An even match' },
  hard: { aiEvalSeconds: 1.3, aiCastGap: 5.5, aiDwellings: 11, redStartBraves: 11, label: 'It dreams of your extinction' },
};

// ---------------------------------------------------------------------------
// Gameplay tuning that is not per-kind content.
//
// Per-kind numbers (unit stats, building costs/hp/footprints, spell charge
// costs, dwelling tiers, population economy) live in sim/catalog.ts — the
// v2 contract. What stays here are the sim's global knobs.
// ---------------------------------------------------------------------------

/** Seconds the leader spends communing at a monument to claim its gift. */
export const WORSHIP_SECONDS = 6;

/** Seconds before a fallen leader returns at the home circle. */
export const LEADER_RESPAWN_SECONDS = 15;

/**
 * Land must be at least this high to walk on. Slightly above 0 so units
 * don't paddle along the waterline pretending the shallows are a road.
 */
export const WALK_MIN_HEIGHT = 0.2;

/**
 * Max height difference between adjacent tiles a unit will climb. Lower it
 * and cliffs become real walls (and Flatten becomes a strategic tool for
 * carving ramps); raise it and units goat their way up anything.
 */
export const MAX_WALK_STEP = 3.2;

/** AI tribes keep at least this many villagers out of training queues. */
export const MIN_BRAVES = 4;

/** Villagers bolt for home when enemy soldiers get this close (tiles). */
export const FLEE_RADIUS = 4.5;

/** Wood in the stockpile when a tribe starts (skirmish default). */
export const START_WOOD = 8;

/** Villagers in a default skirmish (AI tribes use the difficulty's count). */
export const START_BRAVES = 8;

/** Idle villagers keep chopping until the stockpile reaches this. */
export const WOOD_TARGET = 14;

/** Seconds of axe-swinging to fell one tree (yields 1 wood). */
export const CHOP_SECONDS = 3.5;

/** Seconds before a felled tree regrows. */
export const TREE_REGROW_SECONDS = 100;

/** Lumberyard: radius of its effect, chop speed bonus, regrow time factor. */
export const LUMBERYARD = { radius: 12, chopBonus: 1.33, regrowFactor: 0.35 };

/** At most this many villagers raise one building at once. */
export const MAX_BUILDERS = 4;

/** Residents pop outside for a stroll about this often — village theatre. */
export const OUTING_SECONDS = 16;

/** Footprint height spread a building site will tolerate (builders flatten it). */
export const BUILD_FLAT_TOLERANCE = 2.4;

/**
 * Mana income per second = (base + followers*k + housed*k2) — then
 * multiplied by (1 + praying * ECONOMY.shrinePrayerBonus) — and poured
 * evenly into the spells that are charging (see catalog.ts).
 */
export const MANA_BASE_RATE = 0.4;
export const MANA_PER_FOLLOWER = 0.12;
export const MANA_PER_RESIDENT = 0.35;

/** Watchtower occupants: added reach (tiles) and damage multiplier. */
export const TOWER_BONUS = { range: 3, minRange: 5, dmg: 1.5 };

/** Warden vs buildings damage multiplier; share of spell damage wardens ignore. */
export const WARDEN = { buildingBonus: 3, spellResist: 0.5 };

/**
 * Fire. A burning building loses `buildingDps` × its max hp per second for
 * `buildingSeconds`, then burns out; it may light trees within `spreadRadius`.
 * A burning tree burns `treeSeconds`, then falls.
 */
export const FIRE = {
  buildingSeconds: 18,
  buildingDps: 0.03,
  treeSeconds: 5,
  spreadRadius: 3.5,
  spreadChancePerSecond: 0.25,
  emberIgniteChance: 0.3,
};

/** Buff tuning for timed spells (radius/duration come from the catalog). */
export const BUFFS = { wardFactor: 0.5, warsongFactor: 1.33, bloomHealPerSecond: 0.15 };

// ---------------------------------------------------------------------------
// Sculpting brush (the Phase 1 stand-in for god powers)
// ---------------------------------------------------------------------------

/** Default / min / max brush radius, in tiles. */
export const BRUSH_RADIUS = 4;
export const BRUSH_RADIUS_MIN = 1;
export const BRUSH_RADIUS_MAX = 12;

/** Raise/lower speed at the brush center, world units per second. */
export const BRUSH_RATE = 10;

/** How aggressively Flatten pulls land toward the local average, per second. */
export const FLATTEN_RATE = 4;

// ---------------------------------------------------------------------------
// Palette — the painted, saturated look lives in these numbers
// ---------------------------------------------------------------------------

export const COLOR_SKY = 0x8db8d8;
export const COLOR_WATER = 0x3f86bd;
export const COLOR_DEEP_SEAFLOOR = 0x5d6f56; // murky green far underwater
export const COLOR_WET_SAND = 0xc3ab79; // seafloor near the shore
export const COLOR_SAND = 0xd9c389; // beaches just above sea level
export const COLOR_GRASS_A = 0x6fa04b; // two grass tones, dithered by noise,
export const COLOR_GRASS_B = 0x8ab35a; // fake the hand-painted texture look
export const COLOR_ROCK = 0x8a8276; // steep slopes
export const COLOR_SNOW = 0xe9eded; // high peaks

// People & props
export const COLOR_TEAM_PLAYER = 0x3a6fd0; // your tribe wears blue, as is right and proper
export const COLOR_TEAM_RED = 0xc23b2e; // the enemy wears red, as is traditional
export const TRIBE_COLORS: Record<string, number> = {
  ...CATALOG_TRIBE_COLORS,
  player: COLOR_TEAM_PLAYER,
  red: COLOR_TEAM_RED,
};
export const COLOR_WILD_CLOTH = 0x6e665a; // wildmen wear undyed rags
export const COLOR_SKIN = 0xc98e5a;
export const COLOR_HAIR = 0x3b2c20;
export const COLOR_TRUNK = 0x6e4f30;
export const COLOR_CANOPY = 0x3f7034;
export const COLOR_HUT_WALL = 0xb08d5e; // mud-and-timber walls
export const COLOR_HUT_ROOF = 0xc9a84c; // thatch
export const COLOR_SELECTION = 0xffe9a8; // selection rings + brush ring share this UI gold
