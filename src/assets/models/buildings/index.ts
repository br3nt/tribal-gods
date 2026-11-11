import * as THREE from 'three';
import { Civ } from '../../../config';
import { BuildingKind, Tribe } from '../../../sim/catalog';

export interface BuildingModel {
  root: THREE.Group;
  kind: BuildingKind;
  tier: number;
  update(s: { progress: number; hp: number; burning: boolean; dt: number }): void;
  dispose(): void;
}

/** Tower platform height (world units above the ground under the tower centre). */
export const TOWER_PLATFORM_Y = 4.4;

/**
 * Where the i-th garrisoned figure stands, relative to the building centre
 * (world units): lookouts on the tower platform, worshippers kneeling in a
 * ring round the shrine altar, facing it.
 */
export function garrisonSpot(kind: string, i: number): { x: number; z: number; y: number; yaw: number } | null {
  if (kind === 'tower') {
    const a = Math.PI * 0.25 + i * Math.PI;
    return { x: Math.sin(a) * 0.9, z: Math.cos(a) * 0.9, y: TOWER_PLATFORM_Y, yaw: a };
  }
  if (kind === 'shrine') {
    const a = Math.PI + (i - 2.5) * 0.55;
    const r = 3.0;
    return { x: Math.sin(a) * r, z: Math.cos(a) * r, y: 0, yaw: a + Math.PI };
  }
  return null;
}

export function buildBuilding(kind: BuildingKind, _tribe: Tribe, _civ: Civ, tier: number): BuildingModel {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5), new THREE.MeshStandardMaterial()));
  return { root, kind, tier, update() {}, dispose() {} };
}
