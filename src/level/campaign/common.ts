/**
 * level/campaign/common.ts — what a campaign scenario is, and the one
 * function that turns a designer's recipe into a LevelData document.
 *
 * Each scenario file (c01-….ts … c10-….ts) exports a CampaignScenario: a
 * little metadata for the campaign map, and build(), which carves the
 * terrain with the terrain kit and hands everything to makeLevel(). The
 * rules (tribes, loadouts, objectives, briefing, scripted events) ride
 * inside the level, so a scenario is just a level that knows its story.
 *
 * The fiction, for anyone writing a new one: the world is small and the
 * sea is rising — the Long Tide. Four peoples share it:
 *   player  the Lantern-folk — newcomers by boat; their homeland drowned.
 *   red     the Ashmark — hill people of the ridges, quick to fight.
 *   gold    the Saltborn — coast traders, patient builders.
 *   violet  the Unmoored — drift-raiders whose isles went under first.
 * Standing stones remember spells; leaders who commune with them learn.
 */

import type { CivId } from '../../config';
import type { MonumentDef, ScenarioRules, TribeId } from '../../sim/catalog';
import { LevelData, packTerrain, PlacedBuilding, PlacedUnits } from '../level-format';
import { Pt, Terrain } from '../terrain-kit';

export interface CampaignScenario {
  /** Stable id: progress, the library and `?scenario=` all key on it. */
  id: string;
  /** 1-based position on the journey. */
  chapter: number;
  title: string;
  /** One line for the campaign map. */
  tagline: string;
  /** The lesson, in a few words (shown on the map card). */
  teaches: string;
  build(): Promise<LevelData>;
}

export interface LevelRecipe {
  name: string;
  desc: string;
  terrain: Terrain;
  homes: { player: Pt } & Partial<Record<TribeId, Pt>>;
  monuments?: MonumentDef[];
  wildmen?: number[];
  rules: ScenarioRules;
  buildings?: PlacedBuilding[];
  units?: PlacedUnits[];
  civs?: Partial<Record<TribeId, CivId>>;
  /** Background tree density (default 0.02). */
  treeDensity?: number;
}

/** Assemble the document. Trees keep clear of home circles, stones and placed buildings. */
export async function makeLevel(r: LevelRecipe): Promise<LevelData> {
  const map = r.terrain.finish();
  const clear = [
    ...Object.values(r.homes).map((h) => ({ ...h!, r: 4 })),
    ...(r.monuments ?? []).map((m) => ({ x: m.x, z: m.z, r: 2.5 })),
    ...(r.buildings ?? []).map((b) => ({ x: b.x, z: b.z, r: b.kind === 'shrine' || b.kind === 'wardenHall' ? 4 : 3 })),
  ];
  const level: LevelData = {
    v: 2,
    name: r.name,
    author: 'Tribal Gods',
    desc: r.desc,
    terrain: await packTerrain(map.heights),
    trees: r.terrain.trees(r.treeDensity ?? 0.02, clear),
    monuments: r.monuments ?? [],
    homes: r.homes,
    wildmen: r.wildmen ?? [],
    rules: r.rules,
  };
  if (r.civs) level.civs = r.civs;
  if (r.buildings?.length) level.buildings = r.buildings;
  if (r.units?.length) level.units = r.units;
  return level;
}

/** The drift-raiders' standing orders: no town, no retreat, straight at you. */
export const RAIDER_TRIBE = {
  ai: true,
  personality: { builds: false, defends: false, harassAt: 1, assaultAt: 1, seeksStones: false, target: 'player' as TribeId },
  loadout: { spells: [], buildings: [], startUnits: { shaman: 0, brave: 0 }, startWood: 0 },
};
