/**
 * assets/models/buildings.ts — compatibility shim for the v1 building API.
 *
 * The real kit lives in ./buildings/ (registry.ts is the front door). This
 * file keeps older callers (the build placer's ghost) compiling: each
 * legacy builder returns a finished v2 model with the old
 * `{ root, setProgress }` shape. New code should use
 * `buildBuildingModel` from ./registry.
 */

import * as THREE from 'three';
import { Civ, CIVS } from '../../config';
import { BuildingKind } from '../../sim/catalog';
import { buildBuilding } from './buildings/index';

export interface BuildingModel {
  root: THREE.Group;
  setProgress(p: number): void;
}

function legacy(kind: BuildingKind, civ: Civ = CIVS.forest): BuildingModel {
  const m = buildBuilding(kind, 'player', civ, 0);
  return { root: m.root, setProgress: (p) => m.update({ progress: p, hpFrac: 1, burning: false, dt: 0 }) };
}

export const buildHut = (_team?: number, civ?: Civ) => legacy('hut', civ);
export const buildWarriorHut = (_team?: number, civ?: Civ) => legacy('warriorHut', civ);
export const buildFireHut = (_team?: number, civ?: Civ) => legacy('fireHut', civ);
export const buildTower = (_team?: number, civ?: Civ) => legacy('tower', civ);

export { buildMonument, buildTotem, garrisonSpot, TOWER_PLATFORM_Y } from './buildings/index';
