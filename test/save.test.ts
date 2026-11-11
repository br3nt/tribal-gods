/**
 * Save / resume: a saved game, restored into a fresh World, must continue
 * EXACTLY as the original would have. The determinism tests below are the
 * proof that no hidden state was left out of the save.
 */
import { describe, expect, it } from 'vitest';
import { restoreWorld, saveWorld, SaveData, validateSave } from '../src/sim/save';
import { World } from '../src/sim/world-state';
import { loadScenario } from './campaign-helpers';
import { run } from './helpers';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A canonical fingerprint of the live world, computed from the World itself (not via save.ts). */
function digest(w: World) {
  let sum = 0;
  for (let i = 0; i < w.map.heights.length; i++) sum = (sum * 31 + Math.round(w.map.heights[i] * 1e4)) | 0;
  return {
    elapsed: r3(w.elapsed),
    rng: w.rng.s,
    nextId: w.nextId,
    heights: sum,
    units: w.units.map((u) => [u.id, u.kind, u.tribe, r3(u.x), r3(u.z), u.state, u.task, r3(u.hp)]),
    buildings: w.buildings.map((b) => [b.id, b.tribe, b.kind, b.x, b.z, r3(b.progress), r3(b.hp), b.residents, b.tier]),
    trees: w.trees.filter((t) => t.alive).length,
    tribes: w.activeTribes().map((id) => {
      const t = w.tribes[id]!;
      return [id, r3(t.wood), t.ai?.state ?? null, Object.values(t.spells).map((s) => [s.charges, r3(s.mana), s.gifted])];
    }),
    jobs: w.jobs.map((j) => [j.spell, r3(j.t), r3(j.x), r3(j.z)]),
    auras: w.auras.map((a) => [a.kind, r3(a.t), r3(a.x), r3(a.z)]),
    objectives: w.objectives.map((o) => [o.done, r3(o.progress)]),
    messages: w.messageSeq,
    gameOver: w.gameOver,
    obstacles: w.obstacles.size,
  };
}

/** Save, push through JSON (as localStorage would), restore into a new World. */
function roundTrip(w: World): { copy: World; json: string } {
  const json = JSON.stringify(saveWorld(w));
  const data = JSON.parse(json);
  expect(validateSave(data)).toBe(true);
  const copy = new World();
  restoreWorld(copy, data as SaveData);
  return { copy, json };
}

function expectSameFuture(a: World, b: World, seconds: number): void {
  expect(digest(b)).toEqual(digest(a));
  const step = 10;
  for (let s = 0; s < seconds; s += step) {
    run(a, step);
    run(b, step);
    expect(digest(b)).toEqual(digest(a));
  }
  // Belt and braces: the full saved state matches too.
  const state = (w: World) => JSON.stringify({ ...saveWorld(w), savedAt: 0 });
  expect(state(b)).toBe(state(a));
}

describe('save / resume', () => {
  it('a skirmish with three AI tribes resumes identically after a JSON round trip', () => {
    const w = new World();
    w.reset(4242, { playerCiv: 'forest', difficulty: 'normal', enemies: 2 });
    run(w, 120);
    w.events.length = 0;
    expect(w.units.length).toBeGreaterThan(10);
    expect(w.buildings.length).toBeGreaterThan(0);
    // Live "gave up on that target" memory: three braves may not chop any tree for 100 s.
    for (const u of w.units.filter((q) => q.tribe === 'player' && q.kind === 'brave').slice(0, 3)) {
      w.trees.forEach((_, i) => w.unreachable.set(`${u.id}:t${i}`, w.elapsed + 100));
    }
    expect(w.unreachable.size).toBeGreaterThan(0);

    const { copy, json } = roundTrip(w);
    console.log(`skirmish save at 120 s: ${(json.length / 1024).toFixed(1)} KB, ${w.units.length} units, ${w.buildings.length} buildings, ${w.trees.length} trees`);
    expect(json.length).toBeLessThan(1024 * 1024);
    expectSameFuture(w, copy, 60);
  }, 15000);

  it('a campaign scenario with a live sink job (aura + base heights) resumes identically', async () => {
    // An extra repeating scripted line, so eventMemory is mid-repeat at save time.
    const w = await loadScenario('c09_when_the_tide_came', {
      bot: true,
      rules: (r) => (r.events ??= []).push({ when: { type: 'time', at: 5 }, repeat: { every: 7, times: 6 }, message: 'The tide hums.', actions: [] }),
    });
    run(w, 20);
    const player = w.tribes.player!;
    player.spells.sink.gifted += 1;
    player.spells.swamp.gifted += 1;
    const leader = w.leaderOf('player')!;
    expect(w.orderCast('player', 'sink', leader.x + 3, leader.z)).toBeNull();
    for (let i = 0; i < 15 * 10 && !w.jobs.some((j) => j.spell === 'sink'); i++) w.tick(1 / 15);
    const sink = w.jobs.find((j) => j.spell === 'sink')!;
    expect(sink).toBeTruthy();
    expect(sink.base!.size).toBeGreaterThan(0);
    expect(w.orderCast('player', 'swamp', leader.x - 3, leader.z)).toBeNull();
    for (let i = 0; i < 15 * 10 && w.swamp.size === 0; i++) w.tick(1 / 15);
    expect(w.swamp.size).toBeGreaterThan(0);
    expect(w.jobs.some((j) => j.spell === 'sink')).toBe(true);
    expect(w.eventMemory.some((m) => m.fired > 0)).toBe(true);
    w.events.length = 0;

    const { copy } = roundTrip(w);
    // Identity the sim relies on survives: the job moves ITS aura, `known` IS `unlocked`.
    const cSink = copy.jobs.find((j) => j.spell === 'sink')!;
    expect(cSink.base).toBeInstanceOf(Map);
    expect(copy.auras).toContain(cSink.aura);
    for (const id of copy.activeTribes()) expect(copy.tribes[id]!.known).toBe(copy.tribes[id]!.unlocked);
    expect([...copy.obstacles].sort()).toEqual([...w.obstacles].sort());
    expect(copy.messages).toEqual(w.messages);

    expectSameFuture(w, copy, 30);
  }, 15000);

  it('restore mutates the same World in place and bumps render versions', () => {
    const a = new World();
    a.reset(7, { playerCiv: 'forest', difficulty: 'normal', enemies: 1 });
    run(a, 5);
    const data = JSON.parse(JSON.stringify(saveWorld(a)));
    const b = new World();
    b.reset(99, { playerCiv: 'forest', difficulty: 'easy', enemies: 3 });
    const map = b.map;
    const mv = b.map.version;
    const tv = b.treesVersion;
    restoreWorld(b, data);
    expect(b.map).toBe(map);
    expect(b.map.version).toBeGreaterThan(mv);
    expect(b.treesVersion).toBeGreaterThan(tv);
    expect(b.activeTribes()).toEqual(a.activeTribes());
    expect(b.settings).toEqual(a.settings);
    expect(digest(b)).toEqual(digest(a));
  });

  it('validateSave rejects garbage and other versions', () => {
    const w = new World();
    w.reset(3, { playerCiv: 'forest', difficulty: 'normal' });
    const good = JSON.parse(JSON.stringify(saveWorld(w)));
    expect(validateSave(good)).toBe(true);
    for (const bad of [null, undefined, 42, 'save', [], {}, { v: 1 }, { ...good, v: 2 }, { ...good, heights: 'AAAA' },
      { ...good, units: 'nope' }, { ...good, tribes: { player: { id: 'player' } } }, { ...good, rng: 'x' },
      { ...good, jobs: [{ spell: 'sink' }] }, { ...good, units: [{ id: 1 }] }]) {
      expect(validateSave(bad)).toBe(false);
    }
  });
});
