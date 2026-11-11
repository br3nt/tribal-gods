/**
 * Every campaign scenario is sound as a place: it loads, its briefing is
 * complete, homes stand on walkable ground with room to build, and every
 * stone / objective target is reachable — or unreachable exactly where
 * the design says a spell is the way across.
 */
import { describe, expect, it } from 'vitest';
import { LAYOUT as L4 } from '../src/level/campaign/c04-scattered-shallows';
import { LAYOUT as L5 } from '../src/level/campaign/c05-vigil-at-the-caldera';
import { LAYOUT as L6 } from '../src/level/campaign/c06-barefoot-road';
import { LAYOUT as L8, OPENS_AT } from '../src/level/campaign/c08-firemount-race';
import { LAYOUT as L10 } from '../src/level/campaign/c10-the-crown';
import { arc, canReach, polar } from '../src/level/terrain-kit';
import { UNITS } from '../src/sim/catalog';
import { findPath, walkable } from '../src/sim/pathfinding';
import { CAMPAIGN, homeOf, loadScenario, reaches, reachSet, SETTINGS } from './campaign-helpers';
import { run } from './helpers';

describe('campaign: every scenario', () => {
  it('has ten chapters in order with unique ids', () => {
    expect(CAMPAIGN.map((s) => s.chapter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(CAMPAIGN.map((s) => s.id)).size).toBe(10);
  });

  for (const s of CAMPAIGN) {
    it(`${s.chapter}. ${s.title}: loads, briefs, and its homes and targets make sense`, async () => {
      const w = await loadScenario(s.id);
      const rules = w.rules;
      expect(w.activeTribes()).toEqual(rules.tribes.map((t) => t.id).sort((a, b) => ['player', 'red', 'gold', 'violet'].indexOf(a) - ['player', 'red', 'gold', 'violet'].indexOf(b)));
      // Briefing: title, 3–5 sentences, 2–3 tips.
      expect(rules.briefing.title).toBe(s.title);
      const sentences = rules.briefing.body.split(/[.!?](\s|$)/).filter((x) => x.trim().length > 3).length;
      expect(sentences).toBeGreaterThanOrEqual(3);
      expect(sentences).toBeLessThanOrEqual(5);
      expect(rules.briefing.tips.length).toBeGreaterThanOrEqual(2);
      expect(rules.briefing.tips.length).toBeLessThanOrEqual(3);
      expect(rules.objectives.some((o) => !o.optional)).toBe(true);
      // Every people is named by the scenario (briefings read names from the data).
      for (const t of rules.tribes) expect(t.name, `${s.id}: ${t.id}`).toMatch(/^the /);

      // Homes: walkable, and tribes that build have room for a village.
      for (const t of rules.tribes) {
        const home = homeOf(w, t.id);
        expect(walkable(w.map, home.x, home.z), `${t.id} home walkable`).toBe(true);
        const allowed = t.loadout?.buildings;
        if (allowed && allowed.length === 0) continue;
        if (t.loadout?.startUnits?.brave === 0) continue; // a war band / raiders: no village
        let sites = 0;
        for (let dz = -14; dz <= 14; dz += 2) {
          for (let dx = -14; dx <= 14; dx += 2) if (w.siteFree('hut', home.x + dx, home.z + dz)) sites++;
        }
        expect(sites, `${t.id} room to build`).toBeGreaterThanOrEqual(12);
        const trees = w.trees.filter((tr) => Math.hypot(tr.x - home.x, tr.z - home.z) < 18).length;
        expect(trees, `${t.id} wood nearby`).toBeGreaterThanOrEqual(5);
      }

      // Objective references point at real things.
      for (const o of rules.objectives) {
        const ob = o.objective;
        if (ob.type === 'claimMonument') expect(w.monuments[ob.index]).toBeDefined();
        if (ob.type === 'destroyTribe') expect(w.tribes[ob.tribe]).toBeDefined();
        if (ob.type === 'holdPoint' || ob.type === 'leaderReach') {
          expect(reaches(w, homeOf(w, 'player'), ob)).toBe(true);
        }
      }
      for (const f of rules.fail ?? []) if (f.type === 'monumentTaken') expect(w.monuments[f.index]).toBeDefined();
      // Scripted spawns land on walkable ground.
      for (const e of rules.events ?? []) {
        for (const a of e.actions) {
          if (a.type === 'spawn') expect(canReach(reachSet(w, a.x, a.z), a.x, a.z, 3) || walkable(w.map, a.x, a.z)).toBe(true);
        }
      }
    });
  }
});

describe('campaign: intended routes', () => {
  it('1 Landfall: the wanderers’ horn is a walk from home', async () => {
    const w = await loadScenario('c01_landfall');
    const set = reachSet(w, homeOf(w, 'player').x, homeOf(w, 'player').z);
    const wild = w.units.filter((u) => u.kind === 'wildman');
    expect(wild.length).toBeGreaterThanOrEqual(8);
    expect(wild.filter((u) => canReach(set, Math.round(u.x), Math.round(u.z))).length).toBe(wild.length);
  });

  it('2 Speaking Stones: both stones on foot (over the ford); raiders can reach the village', async () => {
    const w = await loadScenario('c02_speaking_stones');
    const home = homeOf(w, 'player');
    for (const m of w.monuments) expect(reaches(w, home, m)).toBe(true);
    expect(reaches(w, homeOf(w, 'violet'), home)).toBe(true);
  });

  it('3 Smoke Over the Ridge: two ways across the spine — the pass and the southern shore', async () => {
    const w = await loadScenario('c03_smoke_over_the_ridge');
    const home = homeOf(w, 'player');
    const red = homeOf(w, 'red');
    expect(reaches(w, home, red)).toBe(true);
    expect(reaches(w, home, w.monuments[0])).toBe(true);
    // Close the pass: still a way round by the shore.
    for (let z = 50; z <= 66; z++) for (let x = 56; x <= 72; x++) w.map.heights[z * 128 + x] = 16;
    expect(reaches(w, home, red)).toBe(true);
    // Close the shore too: now the spine is a wall.
    for (let z = 84; z <= 112; z++) for (let x = 56; x <= 72; x++) w.map.heights[z * 128 + x] = -4;
    expect(reaches(w, home, red)).toBe(false);
  });

  it('4 Scattered Shallows: unreachable without Causeway; the gift stone’s two casts bridge both gaps', async () => {
    const w = await loadScenario('c04_scattered_shallows');
    const home = homeOf(w, 'player');
    const red = homeOf(w, 'red');
    expect(reaches(w, home, L4.causewayStone)).toBe(true);
    expect(reaches(w, home, L4.holm)).toBe(false);
    expect(reaches(w, home, red)).toBe(false);
    expect(w.tribes.player!.known.has('landbridge')).toBe(false);

    const leader = w.leaderOf('player')!;
    w.orderWorship([leader.id], 0);
    run(w, 25);
    expect(w.spellState('player', 'landbridge').gifted).toBe(2);
    for (const [i, b] of L4.bridges.entries()) {
      w.orderMove([leader.id], b.from.x, b.from.z);
      run(w, 25);
      expect(w.distTo(leader, b.from.x, b.from.z), `leader at bridgehead ${i}`).toBeLessThan(5);
      expect(w.orderCast('player', 'landbridge', b.to.x, b.to.z)).toBeNull();
      run(w, 8);
    }
    expect(w.spellState('player', 'landbridge').gifted).toBe(0);
    expect(reaches(w, home, L4.holm)).toBe(true);
    expect(reaches(w, home, red)).toBe(true);
    expect(w.monuments[0].sleep).toBeGreaterThan(300); // and the stone sleeps a long time
  }, 30_000);

  it('5 Caldera: raiders reach the shrine only through the three breaches', async () => {
    const w = await loadScenario('c05_vigil_at_the_caldera');
    for (const p of L5.landings) expect(reaches(w, p, L5.home)).toBe(true);
    // Fill every breach: the basin is sealed.
    for (const b of L5.breaches) {
      for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) w.map.heights[((b.z + dz + 128) % 128) * 128 + ((b.x + dx + 128) % 128)] = 16;
    }
    for (const p of L5.landings) expect(reaches(w, p, L5.home)).toBe(false);
  });

  it('6 Barefoot Road: the cairn is only reached up the gorge; the side valley is open', async () => {
    const w = await loadScenario('c06_barefoot_road');
    const start = homeOf(w, 'player');
    expect(reaches(w, start, L6.cairn)).toBe(true);
    expect(reaches(w, start, L6.lightning)).toBe(true);
    for (let z = 50; z <= 72; z++) for (let x = 64; x <= 72; x++) w.map.heights[z * 128 + x] = 16;
    expect(reaches(w, start, L6.cairn)).toBe(false);
  });

  it('7 Two Banners: both rivals and the fen stone are reachable over the fords', async () => {
    const w = await loadScenario('c07_two_banners');
    const home = homeOf(w, 'player');
    expect(reaches(w, home, homeOf(w, 'red'))).toBe(true);
    expect(reaches(w, home, homeOf(w, 'gold'))).toBe(true);
    expect(reaches(w, home, w.monuments[0])).toBe(true);
    expect(w.hostile('red', 'gold')).toBe(false);
  });

  it('8 Firemount: both sides can climb; our leader can be at the crown before it wakes', async () => {
    const w = await loadScenario('c08_firemount_race');
    expect(reaches(w, homeOf(w, 'player'), L8.summit)).toBe(true);
    expect(reaches(w, homeOf(w, 'red'), L8.summit)).toBe(true);
    const leader = w.leaderOf('player')!;
    const path = findPath(w.map, leader.x, leader.z, L8.summit.x, L8.summit.z + 2, 20000)!;
    expect(path).not.toBeNull();
    expect(path.length / UNITS.shaman.speed).toBeLessThan(OPENS_AT * 0.6);
    expect(w.monumentAvailable(w.monuments[0])).toBe(false);
  });

  it('9 Tide: the summit is reachable from both villages, and the tide drowns the old village', async () => {
    const w = await loadScenario('c09_when_the_tide_came');
    const summit = w.rules.objectives[0].objective as { x: number; z: number };
    expect(reaches(w, homeOf(w, 'player'), summit)).toBe(true);
    expect(reaches(w, homeOf(w, 'gold'), summit)).toBe(true);
    const home = homeOf(w, 'player');
    w.elapsed = 449;
    run(w, 14);
    expect(w.map.heightAt(home.x, home.z)).toBeLessThan(0);
  });

  it('10 Crown: the ring connects every people; the Crown needs one Causeway from the inner shore', async () => {
    const w = await loadScenario('c10_the_crown');
    const home = homeOf(w, 'player');
    for (const t of ['red', 'gold', 'violet'] as const) expect(reaches(w, home, homeOf(w, t))).toBe(true);
    expect(reaches(w, home, L10.centre)).toBe(false);
    // Nearest reachable inner-shore tile is within Causeway reach of the Crown's shore.
    const set = reachSet(w, home.x, home.z);
    let best = Infinity;
    for (const p of arc(64, 64, 26, 0, 360, 2)) {
      for (let r = 14; r <= 30; r++) {
        const q = polar(64, 64, r, Math.atan2(p.z - 64, p.x - 64) * 57.2958);
        if (set[q.z * 128 + q.x]) best = Math.min(best, Math.hypot(q.x - 64, q.z - 64));
      }
    }
    expect(best - 6).toBeLessThan(22);
    expect(SETTINGS.difficulty).toBe('normal');
  });
});
