/**
 * Every chapter opens with something for the leader to do, and the stones
 * that chapters 2, 6 and 8 are built round are rituals with a cost.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT as L2 } from '../src/level/campaign/c02-speaking-stones';
import { LAYOUT as L6 } from '../src/level/campaign/c06-barefoot-road';
import { LAYOUT as L8, OPENS_AT } from '../src/level/campaign/c08-firemount-race';
import { SPELLS } from '../src/sim/catalog';
import { CAMPAIGN, homeOf, loadScenario, reaches } from './campaign-helpers';
import { run } from './helpers';

describe('every chapter: a meaningful cast inside the first minute', () => {
  for (const s of CAMPAIGN) {
    it(`${s.chapter}. ${s.title}: charged spells, a target in reach, the narrator pointing at it`, async () => {
      const w = await loadScenario(s.id);
      const home = homeOf(w, 'player');
      const ready = SPELLS.filter((d) => {
        const st = w.spellState('player', d.id);
        return st.gifted > 0 || (st.known && st.charges > 0);
      });
      expect(ready.length, 'charged spells at t=0').toBeGreaterThanOrEqual(2);
      // Something to cast at, a short walk away: wanderers, a stone, or an enemy.
      const near = (p: { x: number; z: number }) => Math.hypot(p.x - home.x, p.z - home.z) < 26 && reaches(w, home, p, 3);
      const target =
        w.units.some((u) => u.kind === 'wildman' && near(u)) ||
        w.units.some((u) => u.joins === 'player') ||
        w.monuments.some((m) => near(m)) ||
        w.units.some((u) => u.tribe !== 'player' && u.tribe !== 'wild' && near(u));
      expect(target, 'something to do near home').toBe(true);
      run(w, 5);
      expect(w.messages.some((m) => m.focus), 'a narrator line with a focus in the first seconds').toBe(true);
      expect(w.objectives.some((o) => o.active && !o.optional && !o.done)).toBe(true);
    });
  }
});

describe('stones as set pieces', () => {
  it('2 Speaking Stones: the wood stone’s keepers wake at the ritual; the knoll ritual brings a boat', async () => {
    const w = await loadScenario('c02_speaking_stones');
    const leader = w.leaderOf('player')!;
    const keepers = w.units.filter((u) => u.guardOf === 0);
    expect(keepers.length).toBe(2);
    leader.x = L2.bloom.x;
    leader.z = L2.bloom.z + 2;
    w.orderWorship([leader.id], 0);
    run(w, 3);
    expect(w.monuments[0].guardsAwake).toBe(true);
    run(w, 3);
    expect(leader.hp < leader.maxHp || leader.task !== 'worship').toBe(true);

    const v = await loadScenario('c02_speaking_stones');
    const l2 = v.leaderOf('player')!;
    l2.x = L2.level.x;
    l2.z = L2.level.z + 2;
    expect(v.units.some((u) => u.tribe === 'violet')).toBe(false);
    v.orderWorship([l2.id], 1);
    run(v, 2);
    expect(v.monuments[1].communing).toBe(true);
    const boat = v.units.filter((u) => u.tribe === 'violet');
    expect(boat.length).toBe(3);
    run(v, 12);
    expect(boat.some((u) => v.distTo(u, L2.level.x, L2.level.z) < 8 || u.hp <= 0)).toBe(true);
  }, 20_000);

  it('6 Barefoot Road: kneeling at the cairn calls the garrison down the gorge', async () => {
    const w = await loadScenario('c06_barefoot_road');
    w.units = w.units.filter((u) => u.tribe !== 'red' || u.hidden);
    const leader = w.leaderOf('player')!;
    leader.x = L6.cairn.x;
    leader.z = L6.cairn.z + 2;
    w.orderWorship([leader.id], 1);
    run(w, 2);
    expect(w.units.filter((u) => u.tribe === 'red' && !u.hidden).length).toBe(4);
  });

  it('8 Firemount: a ritual at the crown pauses while hostile spears stand in the ring', async () => {
    const w = await loadScenario('c08_firemount_race');
    w.units = w.units.filter((u) => u.tribe !== 'violet' && u.tribe !== 'red');
    w.tribes.red!.ai = null;
    w.elapsed = OPENS_AT;
    const leader = w.leaderOf('player') ?? w.spawn('shaman', 'player', L8.summit.x, L8.summit.z + 2);
    leader.x = L8.summit.x;
    leader.z = L8.summit.z + 2;
    w.orderWorship([leader.id], 0);
    run(w, 10);
    const p = w.monuments[0].communeProgress!;
    expect(p).toBeGreaterThan(0.2);
    const spear = w.spawn('warrior', 'red', L8.summit.x + 3, L8.summit.z - 2);
    spear.pacified = 999;
    run(w, 5);
    expect(w.monuments[0].contested).toBe(true);
    expect(w.monuments[0].communeProgress).toBeLessThan(p + 0.05);
    expect(w.messages.some((m) => /ritual has begun/.test(m.text))).toBe(true);
  });
});
