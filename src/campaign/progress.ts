/**
 * campaign/progress.ts — where the journey stands, and the rules of moving
 * along it.
 *
 * Pure functions over a small CampaignProgress record, plus a storage seam
 * (ProgressStore) like level/store.ts: localStorage in the browser, an
 * in-memory store for tests, a server some day.
 *
 *   - Chapter 1 is always open; winning chapter N opens chapter N+1.
 *   - A win records the best (lowest) time and adds any optional
 *     objectives met to the stars already earned (stars never go away).
 *   - Chapters listed in BOON_OFFERS offer a boon after a win. The choice
 *     is stored per chapter, so replaying it lets you choose again.
 *   - A scenario is played with the boons chosen in EARLIER chapters —
 *     replaying chapter 3 never sees what chapter 8 gave you.
 */

import { CAMPAIGN } from '../level/campaign';
import type { ScenarioRules } from '../sim/catalog';
import { applyBoons, BOON_OFFERS, BoonId, BOONS } from './boons';

export interface ScenarioRecord {
  /** Best winning time, sim seconds. */
  bestTime: number | null;
  /** Indices (into rules.objectives) of optional objectives ever met in a win. */
  stars: number[];
  wins: number;
  attempts: number;
}

export interface CampaignProgress {
  v: 1;
  records: Record<string, ScenarioRecord>;
  /** Chapter id → the boon chosen at its debrief. */
  boons: Record<string, BoonId>;
}

export interface ProgressStore {
  load(): CampaignProgress;
  save(p: CampaignProgress): void;
}

export const emptyProgress = (): CampaignProgress => ({ v: 1, records: {}, boons: {} });

/** The campaign order (ids). Overridable for tests. */
export const ORDER: string[] = CAMPAIGN.map((s) => s.id);

const indexOf = (id: string, order = ORDER) => order.indexOf(id);

export function isCompleted(p: CampaignProgress, id: string): boolean {
  return (p.records[id]?.wins ?? 0) > 0;
}

export function isUnlocked(p: CampaignProgress, id: string, order = ORDER): boolean {
  const i = indexOf(id, order);
  if (i < 0) return false;
  return i === 0 || isCompleted(p, order[i - 1]);
}

/** The first unlocked chapter not yet won (or the last one, when all are). */
export function currentChapter(p: CampaignProgress, order = ORDER): string {
  return order.find((id) => isUnlocked(p, id, order) && !isCompleted(p, id)) ?? order[order.length - 1];
}

export function nextScenario(id: string, order = ORDER): string | null {
  const i = indexOf(id, order);
  return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
}

export interface PlayResult {
  victory: boolean;
  /** Sim seconds the attempt lasted. */
  seconds: number;
  /** Indices of optional objectives done at the end. */
  optionalMet: number[];
}

/** Record one finished attempt (pure; returns new progress). */
export function recordResult(p: CampaignProgress, id: string, r: PlayResult): CampaignProgress {
  const out = structuredClone(p);
  const rec: ScenarioRecord = out.records[id] ?? { bestTime: null, stars: [], wins: 0, attempts: 0 };
  rec.attempts++;
  if (r.victory) {
    rec.wins++;
    rec.bestTime = rec.bestTime === null ? r.seconds : Math.min(rec.bestTime, r.seconds);
    rec.stars = [...new Set([...rec.stars, ...r.optionalMet])].sort((a, b) => a - b);
  }
  out.records[id] = rec;
  return out;
}

/** Boons offered after winning `id` (empty when none, or not yet won). */
export function boonOffer(p: CampaignProgress, id: string): BoonId[] {
  return isCompleted(p, id) ? (BOON_OFFERS[id] ?? []) : [];
}

/** Choose a boon at chapter `id` (ignored unless it was on offer there). */
export function chooseBoon(p: CampaignProgress, id: string, boon: BoonId): CampaignProgress {
  if (!boonOffer(p, id).includes(boon)) return p;
  const out = structuredClone(p);
  out.boons[id] = boon;
  return out;
}

/** Boons in force when playing `id`: those chosen in earlier chapters, in order. */
export function boonsFor(p: CampaignProgress, id: string, order = ORDER): BoonId[] {
  const i = indexOf(id, order);
  return order.slice(0, Math.max(0, i)).map((c) => p.boons[c]).filter((b): b is BoonId => !!b && !!BOONS[b]);
}

/** The scenario's own rules with the carried boons applied. */
export function rulesForPlay(p: CampaignProgress, id: string, rules: ScenarioRules, order = ORDER): ScenarioRules {
  return applyBoons(rules, boonsFor(p, id, order));
}

/** Sanitise whatever storage handed back (corrupt or old data never bricks the campaign). */
export function parseProgress(raw: unknown): CampaignProgress {
  const p = emptyProgress();
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return p;
  const r = raw as Partial<CampaignProgress>;
  for (const [id, rec] of Object.entries(r.records ?? {})) {
    if (!rec || typeof rec !== 'object') continue;
    p.records[id] = {
      bestTime: typeof rec.bestTime === 'number' ? rec.bestTime : null,
      stars: Array.isArray(rec.stars) ? rec.stars.filter((n) => typeof n === 'number') : [],
      wins: typeof rec.wins === 'number' ? rec.wins : 0,
      attempts: typeof rec.attempts === 'number' ? rec.attempts : 0,
    };
  }
  for (const [id, b] of Object.entries(r.boons ?? {})) if (BOONS[b as BoonId]) p.boons[id] = b as BoonId;
  return p;
}

const KEY = 'tribalgods.campaign.v1';

/** localStorage-backed store (browser). Reads never throw. */
export function localProgressStore(storage: Pick<Storage, 'getItem' | 'setItem'> = globalThis.localStorage, key = KEY): ProgressStore {
  return {
    load() {
      try {
        const raw = storage.getItem(key);
        return parseProgress(raw ? JSON.parse(raw) : null);
      } catch {
        return emptyProgress();
      }
    },
    save(p) {
      try {
        storage.setItem(key, JSON.stringify(p));
      } catch {
        // storage full / blocked: progress lives for this session only
      }
    },
  };
}

/** In-memory store (tests, private windows). */
export function memoryProgressStore(initial = emptyProgress()): ProgressStore {
  let p = structuredClone(initial);
  return { load: () => structuredClone(p), save: (q) => (p = structuredClone(q)) };
}
