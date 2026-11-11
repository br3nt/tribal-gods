/**
 * Shared campaign soak: a scenario plays N headless minutes with the bot
 * as the player and the game never allowed to end, and every AI rival
 * that builds must actually develop (no stalled tribes). Nothing may throw.
 *
 * Minutes default to 10; set CAMPAIGN_SOAK_MINUTES to change (CI can go lower).
 */
import { expect, it } from 'vitest';
import { BUILDINGS, EFFECT_EVENTS, TribeId, UNITS } from '../src/sim/catalog';
import { CAMPAIGN, loadScenario } from './campaign-helpers';

export const SOAK_MINUTES = Number(process.env.CAMPAIGN_SOAK_MINUTES ?? 10);

export function soakScenarios(chapters: number[]): void {
  for (const s of CAMPAIGN.filter((c) => chapters.includes(c.chapter))) {
    it(`${s.chapter}. ${s.title}: ${SOAK_MINUTES} soak minutes, rivals develop`, async () => {
      const w = await loadScenario(s.id, { bot: true });
      w.endGame = () => {}; // keep playing past victory/defeat
      const start = new Map<TribeId, number>();
      const maxPop = new Map<TribeId, number>();
      const built = new Map<TribeId, Set<string>>();
      const trained = new Map<TribeId, number>();
      const seen = new Set<TribeId>();
      for (const t of w.activeTribes()) start.set(t, w.tribePopulation(t));
      const events = new Set<string>();
      const ticks = SOAK_MINUTES * 60 * 15;
      for (let i = 0; i < ticks; i++) {
        w.tick(1 / 15);
        for (const e of w.events) {
          events.add(e.type);
          if (e.type === 'trained') {
            const b = w.buildings.find((q) => Math.hypot(q.x - e.x, q.z - e.z) < 8);
            if (b) trained.set(b.tribe, (trained.get(b.tribe) ?? 0) + 1);
          }
        }
        w.events.length = 0;
        if (i % 150 === 0) {
          for (const t of w.activeTribes()) {
            const pop = w.tribePopulation(t);
            if (pop > 0) seen.add(t);
            maxPop.set(t, Math.max(maxPop.get(t) ?? 0, pop));
            const set = built.get(t) ?? new Set<string>();
            for (const b of w.buildings) if (b.tribe === t && b.progress >= 1) set.add(`${b.kind}@${b.x},${b.z}`);
            built.set(t, set);
          }
        }
      }
      expect(w.elapsed).toBeGreaterThan(SOAK_MINUTES * 60 - 1);
      for (const t of w.rules.tribes) {
        if (t.id === 'player' || !t.ai) continue;
        const p = t.personality ?? {};
        const allowed = t.loadout?.buildings;
        if (p.builds === false || (allowed && allowed.length === 0)) {
          // War bands / raiders: they must at least have shown up.
          if ((w.rules.events ?? []).some((e) => e.actions.some((a) => a.type === 'spawn' && a.tribe === t.id))) {
            expect(seen.has(t.id), `${t.id} raiders arrived`).toBe(true);
          }
          continue;
        }
        const label = `${s.id} ${t.id}`;
        expect(built.get(t.id)!.size, `${label} raised buildings`).toBeGreaterThanOrEqual(4);
        expect(maxPop.get(t.id)!, `${label} grew`).toBeGreaterThan(start.get(t.id)! + 4);
        const canTrain = !allowed || allowed.some((k) => BUILDINGS[k].trains && UNITS[BUILDINGS[k].trains!]);
        if (canTrain && SOAK_MINUTES >= 8) expect(trained.get(t.id) ?? 0, `${label} trained`).toBeGreaterThan(0);
      }
      for (const type of events) expect(EFFECT_EVENTS as readonly string[]).toContain(type);
    }, 300_000);
  }
}
