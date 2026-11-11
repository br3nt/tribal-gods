/**
 * Balance runs (slow; skipped unless BALANCE=1):
 *
 *   BALANCE=1 npx vitest run test/balance.test.ts
 *
 * A scripted human-paced player (test/player-script.ts) plays chapters 1–5
 * and a default Normal skirmish; each run prints a timeline so a person can
 * judge pacing: when the village fills, when the first lodge stands, when
 * the enemy first shows up, how long spells take to come back, and whether
 * a reasonable player wins and how long it takes.
 */
import { describe, expect, it } from 'vitest';
import { wrapDelta } from '../src/core/util';
import { findCrossing } from '../src/sim/crossing';
import { regionNear } from '../src/sim/regions';
import { World } from '../src/sim/world-state';
import { loadScenario } from './campaign-helpers';
import { HUTS, LAYOUT as L1 } from '../src/level/campaign/c01-landfall';
import { LAYOUT as L5 } from '../src/level/campaign/c05-vigil-at-the-caldera';
import { landfallExtra, PlayerScript, ScriptOptions } from './player-script';

const RUN = !!process.env.BALANCE;

function play(w: World, script: PlayerScript, seconds: number, every = 60): string[] {
  const lines: string[] = [];
  const dt = 1 / 15;
  let next = every;
  while (w.elapsed < seconds && !w.gameOver) {
    w.tick(dt);
    script.tick(w, dt);
    if (w.events.length > 500) w.events.length = 0;
    if (w.elapsed >= next) {
      next += every;
      lines.push(snapshot(w));
    }
  }
  lines.push(`END ${Math.round(w.elapsed)}s ${w.gameOver ?? 'running'} ${w.gameOverReason ?? ''} | lodge@${script.firstLodgeAt?.toFixed(0) ?? '-'} contact@${script.firstEnemyContact?.toFixed(0) ?? '-'} attacks ${script.attacks} casts ${JSON.stringify(script.casts)}`);
  lines.push(`objectives: ${w.objectives.map((o) => `${o.done ? '✓' : '·'} ${o.text}`).join(' | ')}`);
  return lines;
}

function snapshot(w: World): string {
  const parts = [`${String(Math.round(w.elapsed / 60)).padStart(2)}m`];
  for (const id of w.activeTribes()) {
    const s = w.tribeSummary(id);
    const huts = w.buildings.filter((b) => b.tribe === id && b.kind === 'hut' && b.progress >= 1);
    const tiers = huts.map((b) => b.tier).join('');
    const army = s.counts.warrior + s.counts.firewarrior + s.counts.warden + s.counts.chanter;
    const blast = w.spellState(id, 'blast');
    parts.push(`${id}: pop ${s.population}/${s.popCap} wood ${s.wood} huts[${tiers}] army ${army} mana ${s.manaRate.toFixed(1)}/s blast ${blast.charges}/${blast.max}${blast.charges < blast.max && Number.isFinite(blast.eta) ? ` (${Math.round(blast.eta)}s)` : ''}`);
  }
  const l = w.leaderOf('player');
  const lb = w.spellState('player', 'landbridge');
  if (process.env.BALANCE_VERBOSE) parts.push(`leader ${l ? `${l.x.toFixed(0)},${l.z.toFixed(0)} ${l.state}/${l.task}` : 'down'} lb ${lb.charges}+${lb.gifted} stones ${w.monuments.map((m) => `${m.spell}:${Math.round(m.sleep)}${m.claimedBy ? '*' : ''}`).join(',')}`);
  return parts.join(' | ');
}

async function chapter(id: string, opts: ScriptOptions, minutes: number) {
  const w = await loadScenario(id);
  const s = new PlayerScript(opts);
  const lines = play(w, s, minutes * 60);
  console.log(`\n=== ${id}\n${lines.join('\n')}`);
  return w;
}

describe.skipIf(!RUN)('balance: a scripted player', () => {
  it('ch1 Landfall', async () => {
    const w = await chapter('c01_landfall', {
      huts: HUTS, attackAt: 0, plan: [], extraFirst: true, extra: landfallExtra(L1), buildWhen: (q) => q.objectives[2].done,
    }, 15);
    expect(w.gameOver).toBe('victory');
  }, 300_000);

  it('ch2 Speaking Stones', async () => {
    const w = await chapter('c02_speaking_stones', { huts: 6, attackAt: 0, plan: ['tower', 'lumberyard'] }, 15);
    expect(w.gameOver).toBe('victory');
  }, 300_000);

  it('ch3 Smoke Over the Ridge', async () => {
    const w = await chapter('c03_smoke_over_the_ridge', { huts: 7, attackAt: 14, plan: ['lumberyard', 'warriorHut', 'tower'], armyCap: 24 }, 30);
    expect(w.gameOver).toBe('victory');
  }, 300_000);

  it('ch4 Scattered Shallows', async () => {
    const extra = (w: World, s: PlayerScript) => {
      // Use the Causeway casts the stone lends: bridge toward the Ashmark, gap by gap.
      const t = w.tribes.player!;
      const red = w.tribes.red;
      const leader = w.leaderOf('player');
      if (!red || !leader || leader.castSpell) return;
      // The Holm first (its stone is the objective), then the Ashmark.
      const holm = w.monuments[1];
      const goal = t.known.has('ward') ? red.home : holm;
      if (regionNear(w.map, t.home.x, t.home.z) === regionNear(w.map, goal.x, goal.z)) {
        if (!t.known.has('ward') && leader.task === 'none') w.orderWorship([leader.id], 1);
        return;
      }
      const st = w.spellState('player', 'landbridge');
      if (st.gifted + st.charges <= 0) return;
      const c = findCrossing(w.map, t.home, goal);
      if (!c) return;
      if (w.distTo(leader, c.from.x, c.from.z) > 2.5) {
        if (leader.task === 'none' && !w.sendTo(leader, c.from.x, c.from.z) && process.env.BALANCE_VERBOSE) {
          console.log(`ch4: leader at ${leader.x.toFixed(0)},${leader.z.toFixed(0)} cannot walk to ${JSON.stringify(c)}`);
        }
        return;
      }
      const dx = wrapDelta(c.to.x - leader.x, 128);
      const dz = wrapDelta(c.to.z - leader.z, 128);
      const len = Math.hypot(dx, dz) || 1;
      const reach = Math.min(len + 2, 21);
      const why = w.orderCast('player', 'landbridge', leader.x + (dx / len) * reach, leader.z + (dz / len) * reach);
      if (why === null) s.casts.landbridge = (s.casts.landbridge ?? 0) + 1;
      if (process.env.BALANCE_VERBOSE) console.log(`ch4: ${Math.round(w.elapsed)}s cast from ${leader.x.toFixed(0)},${leader.z.toFixed(0)} → ${why ?? 'ok'} ${JSON.stringify(c)}`);
    };
    const w = await chapter('c04_scattered_shallows', { huts: 7, attackAt: 16, plan: ['lumberyard', 'warriorHut', 'tower', 'fireHut'], armyCap: 26, extra }, 35);
    expect(w.gameOver).toBe('victory');
  }, 300_000);

  it('ch5 Vigil at the Caldera', async () => {
    const extra = (w: World, s: PlayerScript) => {
      // Pour mana into the Volcano (Blast stays on for defence), keep a few
      // villagers praying, and keep the soldiers standing by the shrine.
      for (const id of ['convert', 'ward'] as const) w.setSpellCharging('player', id, false);
      const shrine = w.buildings.find((b) => b.tribe === 'player' && b.kind === 'shrine');
      if (!shrine) return;
      const braves = w.units.filter((u) => u.tribe === 'player' && u.kind === 'brave' && !u.hidden && u.task === 'none');
      const want = w.tribePopulation('player') >= 16 ? 4 : 2;
      if (shrine.garrison.length < want && braves.length > 4) w.orderGarrison(braves.slice(0, want - shrine.garrison.length).map((u) => u.id), shrine.id);
      const idle = s.fighters(w).filter((u) => u.task === 'none' && u.state === 'idle' && w.distTo(u, shrine.x, shrine.z) > 7);
      if (idle.length) w.orderMove(idle.map((u) => u.id), shrine.x, shrine.z + 5);
      const leader = w.leaderOf('player');
      // Charged: wake the mountain where the most raiders are coming through (chapter 5's finale).
      const v = w.spellState('player', 'volcano');
      if (leader && !leader.castSpell && v.charges > 0) {
        const breach = L5.breaches
          .map((b) => ({ b, n: w.units.filter((u) => u.tribe === 'violet' && w.distTo(u, b.x, b.z) < 12).length }))
          .sort((a, b) => b.n - a.n)[0].b;
        if (s.cast(w, 'volcano', breach.x, breach.z)) return;
      }
      if (leader && leader.task === 'none' && !leader.castSpell && w.distTo(leader, shrine.x, shrine.z) > 9) w.sendTo(leader, shrine.x + 2, shrine.z + 6);
    };
    const w = await chapter('c05_vigil_at_the_caldera', { huts: 6, attackAt: 0, plan: ['tower', 'lumberyard'], armyCap: 14, extra }, 30);
    expect(w.gameOver).toBe('victory');
  }, 300_000);

  it('skirmish on Normal: the first ten minutes', () => {
    for (const seed of [11, 22, 33]) {
      const w = new World();
      w.reset(seed, { playerCiv: 'forest', difficulty: 'normal', enemies: 1 });
      const s = new PlayerScript({ huts: 7, attackAt: 0, plan: ['lumberyard', 'warriorHut', 'tower', 'shrine'] });
      const lines = play(w, s, 600);
      console.log(`\n=== skirmish seed ${seed}\n${lines.join('\n')}`);
    }
  }, 300_000);
});
