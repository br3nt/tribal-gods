/**
 * Perf guards: generous ceilings on the sim's worst tick, so a hot loop or
 * a frame-stalling burst of path searches can't creep back in unnoticed.
 * Thresholds are several times what this machine measures — they catch
 * regressions of the "70 ms when the AIs wake" kind, not noise.
 */
import { describe, expect, it } from 'vitest';
import type { TribeId } from '../src/sim/catalog';
import { pathStats } from '../src/sim/pathfinding';
import { World } from '../src/sim/world-state';
import { rulesFor } from './helpers';

/** A real generated planet, three awake AIs with big armies, the player's village idle. */
function crowdedWorld(perTribe: number): World {
  const w = new World();
  const ais: TribeId[] = ['red', 'gold', 'violet'];
  w.reset(7, { playerCiv: 'forest', difficulty: 'hard' }, rulesFor([{ id: 'player', ai: false }, ...ais.map((id) => ({ id, ai: true }))]));
  for (const id of ais) {
    const home = w.tribes[id]!.home;
    for (let i = 0; i < perTribe; i++) {
      const kind = i % 5 === 0 ? 'firewarrior' : 'warrior';
      w.spawnNearWalkable(kind, id, home.x + (i % 9) - 4, home.z + Math.floor(i / 9) - 4);
    }
    w.tribes[id]!.ai!.awake = true;
    w.tribes[id]!.ai!.evalTimer = 0; // every AI thinks on the same first tick: the worst case
  }
  const home = w.tribes.player!.home;
  for (let i = 0; i < 60; i++) w.spawnNearWalkable('brave', 'player', home.x + (i % 8) - 4, home.z + Math.floor(i / 8) - 4);
  return w;
}

describe('perf guards', () => {
  it('~350 units: no tick over the ceiling when three AI armies wake and march', () => {
    // Warm the JIT on a smaller copy first: the guard is about the sim, not V8's first compile.
    const warm = crowdedWorld(30);
    for (let i = 0; i < 15 * 8; i++) warm.tick(1 / 15);
    const w = crowdedWorld(95);
    expect(w.units.length).toBeGreaterThan(330);
    const dt = 1 / 15;
    const times: number[] = [];
    const exps: number[] = [];
    for (let i = 0; i < 15 * 40; i++) {
      const e0 = pathStats.expansions;
      const t0 = performance.now();
      w.tick(dt);
      times.push(performance.now() - t0);
      exps.push(pathStats.expansions - e0);
      w.events.length = 0;
    }
    const sorted = [...times].sort((a, b) => a - b);
    const worst = sorted[sorted.length - 1];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const maxExp = Math.max(...exps);
    console.log(`perf: units=${w.units.length} worst=${worst.toFixed(1)}ms p95=${p95.toFixed(1)}ms mean=${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}ms maxExpansions/tick=${maxExp}`);
    // The deterministic guard: path-search work in any one tick (machine-independent).
    // ~13k at the wake-up tick now; one A* per soldier made it ~42k.
    expect(maxExp).toBeLessThan(30_000);
    // Wall-clock ceilings, generous because the suite runs files in parallel:
    // ~17 ms worst / ~7 ms p95 alone on a laptop; 141 ms worst before group moves.
    expect(worst).toBeLessThan(100);
    expect(p95).toBeLessThan(20);
  }, 120_000);
});
