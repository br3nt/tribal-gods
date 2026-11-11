/**
 * assets/models/registry.ts — the one door into the model kit.
 *
 *   buildUnitModel(kind, tribe, civ, seed)  → FigureModel (skinned, animatable)
 *   buildBuildingModel(kind, tribe, civ)    → BuildingModel (staged, damageable)
 *
 * Both cover every kind in sim/catalog.ts and NEVER throw: an unknown kind
 * (content added to the catalog before the art exists) gets a stand-in
 * and a console.warn, so new content shows up as "ugly but present"
 * rather than crashing the frame.
 */

import { Civ, CIVS } from '../../config';
import { BuildingKind, BUILDINGS, Tribe, UnitKind, UNITS } from '../../sim/catalog';
import { buildBuilding, BuildingModel } from './buildings/index';
import { buildFigure, FigureModel } from './people/figure';

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[models] ${msg}`);
}

export function buildUnitModel(kind: UnitKind | string, tribe: Tribe, civ: Civ | undefined, seed: number): FigureModel {
  const def = UNITS[kind as UnitKind];
  if (!def) warnOnce(`unknown unit kind "${kind}" — drawing a villager`);
  const k = (def ? kind : 'brave') as UnitKind;
  return buildFigure(k, tribe, civ ?? CIVS.forest, seed, (def ?? UNITS.brave).height);
}

export function buildBuildingModel(kind: BuildingKind | string, tribe: Tribe, civ: Civ | undefined, tier = 0): BuildingModel {
  const def = BUILDINGS[kind as BuildingKind];
  if (!def) warnOnce(`unknown building kind "${kind}" — drawing a dwelling`);
  return buildBuilding((def ? kind : 'hut') as BuildingKind, tribe, civ ?? CIVS.forest, tier);
}

export type { FigureModel, BuildingModel };
