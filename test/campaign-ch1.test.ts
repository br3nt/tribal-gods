/**
 * Chapter 1, Landfall, played by the scripted human-paced player
 * (test/player-script.ts landfallExtra): every beat happens, in order, and
 * the leader always has something to do. Plus the map's promises and the
 * fail condition.
 */
import { describe, expect, it } from 'vitest';
import { HOST_HOLD, HUTS, LAYOUT } from '../src/level/campaign/c01-landfall';
import { spellDef } from '../src/sim/catalog';
import type { World } from '../src/sim/world-state';
import { homeOf, loadScenario, reaches } from './campaign-helpers';
import { run } from './helpers';
import { landfallExtra, PlayerScript } from './player-script';

function sites(w: World): number {
  const home = homeOf(w, 'player');
  let n = 0;
  for (let dz = -16; dz <= 16; dz += 2) for (let dx = -16; dx <= 20; dx += 2) if (w.siteFree('hut', home.x + dx, home.z + dz)) n++;
  return n;
}

describe('chapter 1, Landfall: the map', () => {
  it('kin stranded across the channel, a Causeway away; nowhere to build until Levelled', async () => {
    const w = await loadScenario('c01_landfall');
    const home = homeOf(w, 'player');
    const leader = w.leaderOf('player')!;
    expect(reaches(w, home, LAYOUT.sandbar)).toBe(false);
    for (const p of [LAYOUT.meadow, LAYOUT.meadow2, LAYOUT.strand, LAYOUT.headland, LAYOUT.lightning]) expect(reaches(w, home, p)).toBe(true);
    const kin = w.units.filter((u) => u.joins === 'player');
    expect(kin.length).toBe(6);
    expect(kin.every((u) => Math.hypot(u.x - LAYOUT.sandbar.x, u.z - LAYOUT.sandbar.z) < 5)).toBe(true);
    // The opening cast is right there: Causeway gifted, the sandbar in reach with a short walk at most.
    expect(w.spellState('player', 'landbridge').gifted).toBe(1);
    expect(w.castCheck('player', 'landbridge', LAYOUT.sandbar.x, LAYOUT.sandbar.z)).toBeNull();
    expect(Math.hypot(leader.x - LAYOUT.sandbar.x, leader.z - LAYOUT.sandbar.z)).toBeLessThan(spellDef('landbridge').range + 6);
    expect(w.spellState('player', 'blast').charges).toBeGreaterThanOrEqual(1);
    expect(w.spellState('player', 'convert').charges).toBeGreaterThanOrEqual(1);
    // The rumple: (almost) no Dwelling site near the landing until the ground is Levelled.
    expect(sites(w)).toBeLessThanOrEqual(4);
    w.tribes.player!.known.add('flatten');
    w.tribes.player!.spells.flatten.gifted = 2;
    for (const p of [{ x: home.x + 8, z: home.z + 3 }, { x: home.x + 7, z: home.z - 6 }]) {
      expect(w.orderCast('player', 'flatten', p.x, p.z)).toBeNull();
      run(w, 5);
    }
    expect(sites(w)).toBeGreaterThanOrEqual(16);
  });

  it('fails when ten villagers fall', async () => {
    const w = await loadScenario('c01_landfall');
    run(w, 1);
    for (let i = 0; i < 4; i++) w.spawn('brave', 'player', homeOf(w, 'player').x + i, homeOf(w, 'player').z + 3);
    for (const u of w.units.filter((q) => q.tribe === 'player' && q.kind === 'brave').slice(0, 9)) u.hp = 0;
    run(w, 0.5);
    expect(w.gameOver).toBeNull();
    w.units.find((u) => u.tribe === 'player' && u.kind === 'brave')!.hp = 0;
    run(w, 0.5);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/Ten/);
  });
});

describe('chapter 1, Landfall: a human-paced player wins it beat by beat', () => {
  it('causeway → kin home; Level then build; raiders; the Volcano buries the host and the strand stays a mountain', async () => {
    const w = await loadScenario('c01_landfall');
    const script = new PlayerScript({
      huts: HUTS, attackAt: 0, plan: [], extraFirst: true, extra: landfallExtra(LAYOUT),
      buildWhen: (q) => q.objectives[2].done,
    });
    const at: Record<string, number> = {};
    const mark = (k: string, cond: boolean) => {
      if (cond && at[k] === undefined) at[k] = w.elapsed;
    };
    let volcanoAt: { x: number; z: number } | null = null;
    let hostDeathsAtCast = 0;
    let hostSize = 0;
    let idleRequired = 0;
    const dt = 1 / 15;
    let second = 0;
    while (w.elapsed < 720 && !w.gameOver) {
      w.tick(dt);
      script.tick(w, dt);
      if (w.events.length > 500) w.events.length = 0;
      const casts = w.statsOf('player').casts;
      mark('causeway', casts.some((c) => c.spell === 'landbridge'));
      mark('kinHome', w.statsOf('player').joined >= 6);
      mark('level2', casts.filter((c) => c.spell === 'flatten').length >= 2);
      mark('firstHut', w.buildings.some((b) => b.tribe === 'player' && b.kind === 'hut'));
      mark('huts', w.buildings.filter((b) => b.tribe === 'player' && b.kind === 'hut' && b.progress >= 1).length >= HUTS);
      mark('raiders', w.units.some((u) => u.tribe === 'violet'));
      const holding = w.units.filter((u) => u.tribe === 'violet' && (u.holdUntil ?? 0) > w.elapsed).length;
      hostSize = Math.max(hostSize, holding);
      const v = casts.find((c) => c.spell === 'volcano');
      if (v && !volcanoAt) {
        volcanoAt = { x: v.x, z: v.z };
        hostDeathsAtCast = w.statsOf('violet').lostTotal;
        at.volcano = w.elapsed;
      }
      // Never a moment with nothing to do: some required objective is always live.
      if (Math.floor(w.elapsed) !== second) {
        second = Math.floor(w.elapsed);
        if (!w.gameOver && !w.objectives.some((o) => !o.optional && o.active && !o.done)) idleRequired++;
      }
    }
    console.log('c01 beats', JSON.stringify(Object.fromEntries(Object.entries(at).map(([k, t]) => [k, Math.round(t)]))), 'end', Math.round(w.elapsed), w.gameOver, script.log.join(' | '));
    expect(w.gameOver).toBe('victory');
    expect(w.elapsed).toBeLessThan(720);
    expect(idleRequired).toBe(0);
    // Inside thirty seconds the world has changed: a road out of the sea, kin on it.
    expect(at.causeway).toBeLessThan(30);
    expect(at.kinHome).toBeLessThan(60);
    // Level first, then the village rises on it.
    expect(at.level2).toBeLessThan(at.firstHut);
    expect(at.huts).toBeGreaterThan(at.level2);
    // Raiders come after the roofs; the host masses; the Volcano lands on it.
    expect(at.raiders).toBeGreaterThan(at.huts);
    expect(hostSize).toBeGreaterThanOrEqual(10);
    expect(volcanoAt).not.toBeNull();
    expect(Math.hypot(volcanoAt!.x - LAYOUT.strand.x, volcanoAt!.z - LAYOUT.strand.z)).toBeLessThan(9);
    expect(w.statsOf('violet').lostTotal - hostDeathsAtCast).toBeGreaterThanOrEqual(10); // most of the host
    expect(at.volcano - at.raiders).toBeLessThan(60 + HOST_HOLD + 120);
    // The land is changed for good: a mountain where the beach was.
    expect(w.map.heightAt(Math.round(volcanoAt!.x), Math.round(volcanoAt!.z + 3))).toBeGreaterThan(5);
    expect(w.objectives.find((o) => o.text.startsWith('Bury'))!.done).toBe(true);
  }, 60_000);
});
