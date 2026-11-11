/**
 * Campaign scenarios played headlessly: the AI brain plays the player
 * ("bot") and must win chapters 1–3 inside a bounded number of sim
 * minutes; fail conditions fire when forced.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT as L8, OPENS_AT } from '../src/level/campaign/c08-firemount-race';
import { loadScenario, runUntilOver } from './campaign-helpers';
import { run } from './helpers';

const log = (id: string, w: { elapsed: number; gameOver: unknown; gameOverReason: string | null; objectives: Array<{ text: string; done: boolean }> }) =>
  console.log(id, Math.round(w.elapsed), w.gameOver, w.gameOverReason, w.objectives.map((o) => `${o.done ? '✓' : '·'} ${o.text}`).join(' | '));

describe('campaign: the bot can win the opening chapters', () => {
  it('1 Landfall: grows to the goal within 15 minutes', async () => {
    const w = await loadScenario('c01_landfall', { bot: true });
    runUntilOver(w, 15 * 60);
    log('c01', w);
    expect(w.gameOver).toBe('victory');
  }, 120_000);

  it('2 Speaking Stones: learns both stones and weathers the raids', async () => {
    const w = await loadScenario('c02_speaking_stones', { bot: true });
    runUntilOver(w, 12 * 60);
    log('c02', w);
    expect(w.gameOver).toBe('victory');
    expect(w.units.some((u) => u.tribe === 'violet') || w.messages.length >= 3).toBe(true);
  }, 120_000);

  it('3 Smoke Over the Ridge: a bot that masses its army before marching takes the valley within 20 minutes', async () => {
    const w = await loadScenario('c03_smoke_over_the_ridge', {
      bot: true,
      rules: (r) => (r.tribes[0].personality = { harassAt: 99, assaultAt: 18, maxArmy: 30 }),
    });
    runUntilOver(w, 20 * 60);
    log('c03', w);
    expect(w.gameOver).toBe('victory');
  }, 180_000);
});

describe('campaign: fail conditions fire when forced', () => {
  it('5 Caldera: losing the shrine ends the vigil', async () => {
    const w = await loadScenario('c05_vigil_at_the_caldera');
    run(w, 1);
    const shrine = w.buildings.find((b) => b.kind === 'shrine')!;
    w.hurtBuilding(shrine, 9999);
    run(w, 0.5);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/Shrine/);
  });

  it('5 Caldera: a fully charged Volcano wins', async () => {
    const w = await loadScenario('c05_vigil_at_the_caldera');
    run(w, 1);
    w.tribes.player!.spells.volcano.mana = 1e9;
    run(w, 0.5);
    expect(w.gameOver).toBe('victory');
  });

  it('6 Barefoot Road: the leader dies, the pilgrimage fails (no reincarnation)', async () => {
    const w = await loadScenario('c06_barefoot_road');
    run(w, 1);
    w.hurtUnit(w.leaderOf('player')!, 999);
    run(w, 0.5);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/leader/i);
  });

  it('8 Firemount: the Ashmark commune first → defeat; the stone sleeps until minute four', async () => {
    const w = await loadScenario('c08_firemount_race');
    const red = w.leaderOf('red')!;
    w.units = w.units.filter((u) => u.tribe !== 'violet'); // clear the Keepers for this test
    red.x = L8.summit.x + 1;
    red.z = L8.summit.z + 1;
    w.tribes.red!.ai = null; // hold still
    w.orderWorship([red.id], 0);
    run(w, 10);
    expect(w.gameOver).toBeNull();
    w.elapsed = OPENS_AT;
    w.orderWorship([red.id], 0);
    run(w, 10);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/stone/i);
  });

  it('8 Firemount: the half-hour runs out', async () => {
    const w = await loadScenario('c08_firemount_race');
    w.elapsed = 1799.9;
    run(w, 0.5);
    expect(w.gameOver).toBe('defeat');
    expect(w.gameOverReason).toMatch(/time/i);
  });

  it('9 Tide: holding the crown wins; the clock loses', async () => {
    const w = await loadScenario('c09_when_the_tide_came');
    const o = w.rules.objectives[0].objective as { x: number; z: number };
    // Only the hold is under test here: send the Saltborn's fighters home for good.
    w.units = w.units.filter((u) => u.tribe !== 'gold' || u.kind === 'brave');
    w.tribes.gold!.ai = null;
    for (let i = 0; i < 4; i++) w.spawn('warrior', 'player', o.x + (i % 2), o.z + (i >> 1));
    run(w, 152);
    expect(w.objectives[0].done).toBe(true);
    const v = await loadScenario('c09_when_the_tide_came');
    v.elapsed = 1499.9;
    run(v, 0.5);
    expect(v.gameOver).toBe('defeat');
  }, 60_000);

  it('7 Two Banners: the alliance breaks at minute fifteen', async () => {
    const w = await loadScenario('c07_two_banners');
    expect(w.hostile('red', 'gold')).toBe(false);
    w.elapsed = 899.9;
    run(w, 0.5);
    expect(w.hostile('red', 'gold')).toBe(true);
    expect(w.messages.at(-1)?.text).toMatch(/alliance/);
  });
});
