/**
 * ui/victory-beat.ts — how long a won game lets the world have its moment
 * before the game-over card covers it. Pure (no DOM) so Vitest can check it.
 */

import { spellDef } from '../sim/catalog';
import type { World } from '../sim/world-state';

/**
 * Seconds a victory waits before its card: 2.5, or until a great (tier-3)
 * spell cast in the last moments has had ~8 s on screen — the Volcano that
 * won the chapter erupts in full instead of behind a panel.
 */
export function victoryBeat(w: World): number {
  let beat = 2.5;
  for (const j of w.jobs) if (spellDef(j.spell).tier === 3) beat = Math.max(beat, 8 - j.t);
  return Math.min(8, beat);
}
