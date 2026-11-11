/**
 * campaign/boons.ts — gifts the tribe carries forward between chapters.
 *
 * After some chapters the debrief offers a choice of three boons. Each is
 * plain data: a few Loadout fields (extra charges, cheaper charging, more
 * people, wood, a building, free casts) merged into the player's loadout
 * of every LATER scenario by applyBoons(). The sim never hears the word
 * "boon" — it just sees a richer loadout.
 *
 * Scenario restrictions win: a building boon does nothing where that
 * building isn't allowed (the Barefoot Road has no buildings at all), and
 * a spell boon only matters where the spell is in your book.
 */

import { START_BRAVES, START_WOOD } from '../config';
import type { BuildingKind, Loadout, ScenarioRules, SpellId, UnitKind } from '../sim/catalog';

export type BoonId =
  | 'deepWell' | 'kinfolk' | 'secondHearth' | 'stockpile' | 'quickKindle'
  | 'spearGuard' | 'wardstone' | 'swiftBlast' | 'stormCarrier';

export interface BoonGrant {
  extraCharges?: Partial<Record<SpellId, number>>;
  /** Multipliers on charge cost (0.8 = 20% cheaper). */
  chargeCost?: Partial<Record<SpellId, number>>;
  /** Added to the scenario's starting units. */
  startUnits?: Partial<Record<UnitKind, number>>;
  startWood?: number;
  startBuildings?: BuildingKind[];
  gifts?: Partial<Record<SpellId, number>>;
}

export interface BoonDef {
  id: BoonId;
  name: string;
  blurb: string;
  grant: BoonGrant;
}

export const BOONS: Record<BoonId, BoonDef> = {
  deepWell: { id: 'deepWell', name: 'Deep Well', blurb: 'Blast holds one more charge.', grant: { extraCharges: { blast: 1 } } },
  kinfolk: { id: 'kinfolk', name: 'Kinfolk', blurb: 'Three more villagers at every landing.', grant: { startUnits: { brave: 3 } } },
  secondHearth: { id: 'secondHearth', name: 'Second Hearth', blurb: 'Start with a Dwelling already standing.', grant: { startBuildings: ['hut'] } },
  stockpile: { id: 'stockpile', name: 'Stockpile', blurb: 'Eight more wood at the start.', grant: { startWood: 8 } },
  quickKindle: { id: 'quickKindle', name: 'Quick Kindle', blurb: 'Kindle charges a third faster and holds one more.', grant: { chargeCost: { convert: 0.75 }, extraCharges: { convert: 1 } } },
  spearGuard: { id: 'spearGuard', name: 'Spear Guard', blurb: 'Two Warriors walk with your leader from the start.', grant: { startUnits: { warrior: 2 } } },
  wardstone: { id: 'wardstone', name: 'Wardstone', blurb: 'Begin each scenario with one free Stone Ward.', grant: { gifts: { ward: 1 } } },
  swiftBlast: { id: 'swiftBlast', name: 'Swift Blast', blurb: 'Blast charges a fifth faster.', grant: { chargeCost: { blast: 0.8 } } },
  stormCarrier: { id: 'stormCarrier', name: 'Storm Carrier', blurb: 'Lightning holds one more charge.', grant: { extraCharges: { lightning: 1 } } },
};

/** Which chapters end with a boon choice, and the three on offer. */
export const BOON_OFFERS: Record<string, BoonId[]> = {
  c02_speaking_stones: ['kinfolk', 'deepWell', 'stockpile'],
  c04_scattered_shallows: ['secondHearth', 'quickKindle', 'spearGuard'],
  c06_barefoot_road: ['wardstone', 'swiftBlast', 'kinfolk'],
  c08_firemount_race: ['stormCarrier', 'secondHearth', 'spearGuard'],
};

const add = <K extends string>(a: Partial<Record<K, number>> | undefined, b: Partial<Record<K, number>> | undefined) => {
  const out: Partial<Record<K, number>> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {}) as Array<[K, number]>) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** One boon merged into a loadout (pure; returns a new loadout). */
export function applyGrant(lo: Loadout, g: BoonGrant): Loadout {
  const out: Loadout = structuredClone(lo);
  if (g.extraCharges) out.extraCharges = add(out.extraCharges, g.extraCharges);
  if (g.gifts) out.gifts = add(out.gifts, g.gifts);
  if (g.chargeCost) {
    out.chargeCost = { ...(out.chargeCost ?? {}) };
    for (const [k, v] of Object.entries(g.chargeCost) as Array<[SpellId, number]>) out.chargeCost[k] = (out.chargeCost[k] ?? 1) * v;
  }
  if (g.startUnits) {
    // An absent count means "the default" (START_BRAVES villagers), not zero.
    const base: Partial<Record<UnitKind, number>> = { brave: START_BRAVES, ...(out.startUnits ?? {}) };
    out.startUnits = add(base, g.startUnits);
  }
  if (g.startWood) out.startWood = (out.startWood ?? START_WOOD) + g.startWood;
  if (g.startBuildings) {
    const allowed = g.startBuildings.filter((k) => !out.buildings || out.buildings.includes(k));
    if (allowed.length) out.startBuildings = [...(out.startBuildings ?? []), ...allowed];
  }
  return out;
}

/** The scenario's rules with every boon applied to the player's loadout (pure). */
export function applyBoons(rules: ScenarioRules, boons: BoonId[]): ScenarioRules {
  const out: ScenarioRules = structuredClone(rules);
  const player = out.tribes.find((t) => t.id === 'player');
  if (!player) return out;
  let lo: Loadout = player.loadout ?? {};
  for (const id of boons) {
    const def = BOONS[id];
    if (def) lo = applyGrant(lo, def.grant);
  }
  player.loadout = lo;
  return out;
}
