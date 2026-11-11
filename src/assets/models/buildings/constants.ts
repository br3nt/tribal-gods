/**
 * assets/models/buildings/constants.ts — numbers the unit renderer shares
 * with the building models (where garrisoned figures stand).
 */

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
    return { x: Math.sin(a) * 0.75, z: Math.cos(a) * 0.75, y: TOWER_PLATFORM_Y, yaw: a };
  }
  if (kind === 'shrine') {
    const a = Math.PI * 0.5 + (i % 8) * (Math.PI / 4) + Math.PI / 8;
    const r = 2.9;
    return { x: Math.sin(a) * r, z: Math.cos(a) * r, y: 0.1, yaw: a + Math.PI };
  }
  return null;
}
