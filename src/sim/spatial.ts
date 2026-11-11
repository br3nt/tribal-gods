/**
 * sim/spatial.ts — "who is near here?" without asking everyone.
 *
 * A SPATIAL HASH: the planet is cut into square buckets CELL tiles wide,
 * and each tick every person is dropped into the bucket under their feet.
 * A question like "any enemy within 9 tiles?" then reads only the few
 * buckets that circle can touch, instead of every unit on the planet. With
 * 350 people and dozens of idle soldiers scanning each tick, that is the
 * difference between ~10,000 distance checks a tick and a few hundred.
 *
 * Two details make it fit this world:
 *
 *   WRAPPING. The planet is a torus, so bucket coordinates wrap too: a
 *   query near the east edge also reads buckets on the west edge. If the
 *   circle is wide enough to cover every bucket in a row, each is read
 *   once (no duplicates).
 *
 *   BUILT ONCE PER TICK. Rebuilding costs one pass over the units; people
 *   then move a fraction of a tile during the tick, so queries widen their
 *   radius by MARGIN tiles. Callers still test the exact distance — the
 *   hash only narrows down who is worth testing. Someone spawned or flung
 *   far mid-tick is found from the next tick on.
 */

import { WORLD_SIZE } from '../config';
import type { Unit } from './world-state';

/** Bucket width in tiles (divides WORLD_SIZE). */
const CELL = 8;
const SIDE = WORLD_SIZE / CELL;
/** Extra reach (tiles) covering movement since the rebuild. */
const MARGIN = 2;

const cellOf = (v: number) => (((Math.floor(v / CELL) % SIDE) + SIDE) % SIDE);

export class UnitGrid {
  private readonly cells: Unit[][] = Array.from({ length: SIDE * SIDE }, () => []);

  /** Re-bucket every visible person (hidden ones are inside buildings: nobody's neighbour). */
  rebuild(units: readonly Unit[]): void {
    for (const c of this.cells) c.length = 0;
    for (const u of units) {
      if (u.hidden) continue;
      this.cells[cellOf(u.z) * SIDE + cellOf(u.x)].push(u);
    }
  }

  /** Call `fn` for every visible person who MAY be within `r` tiles of (x, z) (callers test exactly). */
  forEachNear(x: number, z: number, r: number, fn: (u: Unit) => void): void {
    const k = Math.ceil((r + MARGIN) / CELL);
    const cx = cellOf(x);
    const cz = cellOf(z);
    const span = 2 * k + 1;
    const xs = span >= SIDE ? SIDE : span;
    const zs = span >= SIDE ? SIDE : span;
    const x0 = span >= SIDE ? 0 : cx - k;
    const z0 = span >= SIDE ? 0 : cz - k;
    for (let j = 0; j < zs; j++) {
      const row = (((z0 + j) % SIDE) + SIDE) % SIDE;
      for (let i = 0; i < xs; i++) {
        const cell = this.cells[row * SIDE + ((((x0 + i) % SIDE) + SIDE) % SIDE)];
        for (let n = 0; n < cell.length; n++) if (!cell[n].hidden) fn(cell[n]); // went indoors since the rebuild
      }
    }
  }
}
