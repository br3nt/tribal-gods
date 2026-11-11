import { describe, expect, it } from 'vitest';
import { BUILDINGS, TribeId } from '../src/sim/catalog';
import { World } from '../src/sim/world-state';
import { rulesFor } from './helpers';

function soak(seed: number, tribes: TribeId[], minutes: number) {
  const w = new World();
  w.reset(
    seed,
    { playerCiv: 'forest', difficulty: 'normal' },
    rulesFor(tribes.map((id) => ({ id, ai: true }))),
  );
  const stats = {
    trainingBuilt: new Map<TribeId, Set<string>>(),
    trained: new Set<string>(),
    garrisoned: 0,
    praying: 0,
    events: new Map<string, number>(),
    maxPop: new Map<TribeId, number>(),
  };
  const ticks = minutes * 60 * 15;
  for (let i = 0; i < ticks; i++) {
    w.tick(1 / 15);
    for (const e of w.events) stats.events.set(e.type, (stats.events.get(e.type) ?? 0) + 1);
    w.events.length = 0;
    if (i % 75 === 0) {
      for (const b of w.buildings) {
        if (b.progress >= 1 && BUILDINGS[b.kind].trains) {
          if (!stats.trainingBuilt.has(b.tribe)) stats.trainingBuilt.set(b.tribe, new Set());
          stats.trainingBuilt.get(b.tribe)!.add(b.kind);
        }
        if (b.kind === 'tower') stats.garrisoned = Math.max(stats.garrisoned, b.garrison.length);
        if (b.kind === 'shrine') stats.praying = Math.max(stats.praying, b.garrison.length);
      }
      for (const u of w.units) if (u.kind !== 'brave' && u.kind !== 'shaman' && u.kind !== 'wildman') stats.trained.add(u.kind);
      for (const t of tribes) stats.maxPop.set(t, Math.max(stats.maxPop.get(t) ?? 0, w.tribePopulation(t)));
    }
  }
  return { w, stats };
}

describe('AI soak', () => {
  it('two AIs play 20 headless minutes without exceptions, and both raise training buildings', () => {
    const { w, stats } = soak(11, ['red', 'gold'], 20);
    console.log(
      'soak:',
      JSON.stringify({
        elapsed: Math.round(w.elapsed),
        training: Object.fromEntries([...stats.trainingBuilt].map(([k, v]) => [k, [...v]])),
        trained: [...stats.trained],
        maxPop: Object.fromEntries(stats.maxPop),
        garrisoned: stats.garrisoned,
        praying: stats.praying,
        events: Object.fromEntries(stats.events),
        alive: w.activeTribes().filter((t) => w.tribeAlive(t)),
      }),
    );
    expect(w.elapsed).toBeGreaterThan(20 * 60 - 1);
    expect(stats.trainingBuilt.get('red')?.size ?? 0).toBeGreaterThan(0);
    expect(stats.trainingBuilt.get('gold')?.size ?? 0).toBeGreaterThan(0);
    expect(stats.trained.has('warrior')).toBe(true);
    expect(stats.events.get('trained') ?? 0).toBeGreaterThan(3);
  }, 240_000);

  it('three AIs share a planet for five minutes without exceptions', () => {
    const { w, stats } = soak(23, ['red', 'gold', 'violet'], 5);
    expect(w.elapsed).toBeGreaterThan(5 * 60 - 1);
    expect(stats.events.get('built') ?? 0).toBeGreaterThan(3);
  }, 120_000);

  it('is deterministic: the same seed plays the same game', () => {
    const a = soak(5, ['red', 'gold'], 2).w;
    const b = soak(5, ['red', 'gold'], 2).w;
    const snap = (w: World) => w.units.map((u) => `${u.id}:${u.kind}:${u.tribe}:${u.x.toFixed(2)}`).join('|');
    expect(snap(a)).toBe(snap(b));
  }, 60_000);
});
