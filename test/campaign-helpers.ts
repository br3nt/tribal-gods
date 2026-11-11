/**
 * Helpers for the campaign tests: build + load a scenario headlessly,
 * reachability on the live map, and a "bot plays the player" switch.
 */
import { CAMPAIGN, campaignScenario } from '../src/level/campaign';
import type { LevelData } from '../src/level/level-format';
import { canReach, reachable } from '../src/level/terrain-kit';
import type { ScenarioRules, TribeId } from '../src/sim/catalog';
import { World } from '../src/sim/world-state';

export const SETTINGS = { playerCiv: 'forest', difficulty: 'normal' } as const;

const cache = new Map<string, LevelData>();

export async function levelOf(id: string): Promise<LevelData> {
  if (!cache.has(id)) cache.set(id, await campaignScenario(id)!.build());
  return structuredClone(cache.get(id)!);
}

/** Load a scenario. `bot` hands the player tribe to the AI brain. */
export async function loadScenario(id: string, opts: { bot?: boolean; rules?: (r: ScenarioRules) => void } = {}): Promise<World> {
  const level = await levelOf(id);
  const rules = level.rules!;
  if (opts.bot) rules.tribes.find((t) => t.id === 'player')!.ai = true;
  opts.rules?.(rules);
  const w = new World();
  await w.loadLevel(level, SETTINGS, rules);
  return w;
}

export function reachSet(w: World, x: number, z: number): Uint8Array {
  return reachable(w.map, Math.round(x), Math.round(z));
}

export function reaches(w: World, from: { x: number; z: number }, to: { x: number; z: number }, slack = 2): boolean {
  return canReach(reachSet(w, from.x, from.z), Math.round(to.x), Math.round(to.z), slack);
}

export function homeOf(w: World, id: TribeId) {
  return w.tribes[id]!.home;
}

/** Run until game over or `seconds` pass. Returns elapsed. */
export function runUntilOver(w: World, seconds: number, dt = 1 / 15): number {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n && !w.gameOver; i++) {
    w.tick(dt);
    if (w.events.length > 500) w.events.length = 0;
  }
  return w.elapsed;
}

export { CAMPAIGN };
