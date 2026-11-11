/**
 * Campaign progression and boons: pure logic, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { applyBoons, applyGrant, BOON_OFFERS, BOONS } from '../src/campaign/boons';
import {
  boonOffer, boonsFor, chooseBoon, currentChapter, emptyProgress, isUnlocked, localProgressStore,
  memoryProgressStore, nextScenario, ORDER, parseProgress, recordResult, rulesForPlay,
} from '../src/campaign/progress';
import { START_BRAVES } from '../src/config';
import type { ScenarioRules } from '../src/sim/catalog';
import { World } from '../src/sim/world-state';
import { levelOf, SETTINGS } from './campaign-helpers';

const win = (seconds: number, optionalMet: number[] = []) => ({ victory: true, seconds, optionalMet });

describe('progress', () => {
  it('chapter 1 is open; each win opens the next', () => {
    let p = emptyProgress();
    expect(ORDER.length).toBe(10);
    expect(isUnlocked(p, ORDER[0])).toBe(true);
    expect(isUnlocked(p, ORDER[1])).toBe(false);
    p = recordResult(p, ORDER[0], { victory: false, seconds: 100, optionalMet: [] });
    expect(isUnlocked(p, ORDER[1])).toBe(false);
    p = recordResult(p, ORDER[0], win(300));
    expect(isUnlocked(p, ORDER[1])).toBe(true);
    expect(isUnlocked(p, ORDER[2])).toBe(false);
    expect(currentChapter(p)).toBe(ORDER[1]);
    expect(nextScenario(ORDER[0])).toBe(ORDER[1]);
    expect(nextScenario(ORDER[9])).toBeNull();
    expect(isUnlocked(p, 'nope')).toBe(false);
  });

  it('keeps the best time and accumulates stars; losses only count attempts', () => {
    let p = emptyProgress();
    p = recordResult(p, ORDER[0], win(500, [2]));
    p = recordResult(p, ORDER[0], win(420, [3]));
    p = recordResult(p, ORDER[0], win(600, []));
    p = recordResult(p, ORDER[0], { victory: false, seconds: 10, optionalMet: [2, 3, 4] });
    expect(p.records[ORDER[0]]).toEqual({ bestTime: 420, stars: [2, 3], wins: 3, attempts: 4 });
  });

  it('boons: offered only after a win at an offering chapter; chosen once per chapter; carried forward only', () => {
    const at = 'c02_speaking_stones';
    let p = emptyProgress();
    expect(boonOffer(p, at)).toEqual([]);
    p = recordResult(p, at, win(800));
    expect(boonOffer(p, at)).toEqual(BOON_OFFERS[at]);
    expect(chooseBoon(p, at, 'wardstone')).toBe(p); // not on offer here
    p = chooseBoon(p, at, 'kinfolk');
    p = chooseBoon(p, at, 'deepWell'); // replay: change your mind
    expect(p.boons[at]).toBe('deepWell');
    expect(boonsFor(p, 'c01_landfall')).toEqual([]);
    expect(boonsFor(p, at)).toEqual([]); // not in its own chapter
    expect(boonsFor(p, 'c03_smoke_over_the_ridge')).toEqual(['deepWell']);
    p = recordResult(p, 'c04_scattered_shallows', win(900));
    p = chooseBoon(p, 'c04_scattered_shallows', 'secondHearth');
    expect(boonsFor(p, 'c10_the_crown')).toEqual(['deepWell', 'secondHearth']);
  });

  it('every offered boon exists and every offering chapter is in the campaign', () => {
    for (const [id, offers] of Object.entries(BOON_OFFERS)) {
      expect(ORDER).toContain(id);
      expect(offers.length).toBe(3);
      for (const b of offers) expect(BOONS[b]).toBeDefined();
    }
  });

  it('stores survive a round trip and corrupt storage yields a fresh campaign', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = localProgressStore(storage);
    let p = recordResult(emptyProgress(), ORDER[0], win(77, [1]));
    s.save(p);
    expect(s.load()).toEqual(p);
    mem.set('tribalgods.campaign.v1', '{not json');
    expect(s.load()).toEqual(emptyProgress());
    expect(parseProgress({ v: 1, records: { x: { bestTime: 'no', stars: [1, 'a'] } }, boons: { a: 'bogus', b: 'kinfolk' } })).toEqual({
      v: 1, records: { x: { bestTime: null, stars: [1], wins: 0, attempts: 0 } }, boons: { b: 'kinfolk' },
    });
    const m = memoryProgressStore();
    p = recordResult(m.load(), ORDER[0], win(5));
    m.save(p);
    expect(m.load().records[ORDER[0]].wins).toBe(1);
  });
});

describe('boons applied to a loadout', () => {
  const rules = (loadout: ScenarioRules['tribes'][number]['loadout']): ScenarioRules => ({
    tribes: [{ id: 'player', ai: false, loadout }, { id: 'red', ai: true }],
    objectives: [{ objective: { type: 'destroyAll' }, text: 'x' }],
    briefing: { title: 't', body: 'b', tips: [] },
  });

  it('adds to defaults rather than replacing them', () => {
    const lo = applyGrant({}, { startUnits: { brave: 3 }, startWood: 8 });
    expect(lo.startUnits!.brave).toBe(START_BRAVES + 3);
    expect(lo.startWood).toBeGreaterThan(8);
    expect(applyGrant({ startUnits: { brave: 2 } }, { startUnits: { brave: 3, warrior: 2 } }).startUnits).toEqual({ brave: 5, warrior: 2 });
  });

  it('stacks charges and multiplies costs; respects building restrictions; never mutates the input', () => {
    const base = rules({ buildings: [], spells: ['blast', 'convert'] });
    const out = applyBoons(base, ['deepWell', 'secondHearth', 'quickKindle', 'swiftBlast', 'deepWell']);
    const lo = out.tribes[0].loadout!;
    expect(lo.extraCharges).toEqual({ blast: 2, convert: 1 });
    expect(lo.chargeCost!.convert).toBeCloseTo(0.75);
    expect(lo.chargeCost!.blast).toBeCloseTo(0.8);
    expect(lo.startBuildings).toBeUndefined(); // no buildings allowed here
    expect(base.tribes[0].loadout).toEqual({ buildings: [], spells: ['blast', 'convert'] });
    expect(applyBoons(rules({}), ['secondHearth']).tribes[0].loadout!.startBuildings).toEqual(['hut']);
  });

  it('every chapter, with every building/people boon stacked, lays out without overlaps', async () => {
    const { CAMPAIGN } = await import('../src/level/campaign');
    for (const c of CAMPAIGN) {
      const level = await levelOf(c.id);
      const r = applyBoons(level.rules!, ['secondHearth', 'secondHearth', 'kinfolk', 'kinfolk', 'spearGuard', 'stockpile']);
      const w = new World();
      await w.loadLevel(level, SETTINGS, r);
      const bs = w.buildings;
      for (const a of bs) {
        for (const b of bs) {
          if (a === b) continue;
          const gap = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
          expect(gap, `${c.id}: ${a.kind}@${a.x},${a.z} vs ${b.kind}@${b.x},${b.z}`).toBeGreaterThanOrEqual((a.size + b.size) / 2);
        }
      }
      const allowed = r.tribes[0].loadout?.buildings;
      if (!allowed || allowed.includes('hut')) {
        const placed = level.buildings?.filter((b) => b.tribe === 'player' && b.kind === 'hut').length ?? 0;
        expect(bs.filter((b) => b.tribe === 'player' && b.kind === 'hut').length, c.id).toBe(placed + 2);
      }
    }
  });

  it('a carried boon shows up in the world', async () => {
    let p = recordResult(emptyProgress(), 'c02_speaking_stones', win(800));
    p = chooseBoon(p, 'c02_speaking_stones', 'deepWell');
    p = recordResult(p, 'c04_scattered_shallows', win(900));
    p = chooseBoon(p, 'c04_scattered_shallows', 'secondHearth');
    const level = await levelOf('c05_vigil_at_the_caldera');
    const r = rulesForPlay(p, 'c05_vigil_at_the_caldera', level.rules!);
    const w = new World();
    await w.loadLevel(level, SETTINGS, r);
    expect(w.spellState('player', 'blast').max).toBe(5);
    expect(w.buildings.filter((b) => b.tribe === 'player' && b.kind === 'hut').length).toBe(3); // two placed + the hearth
  });
});
