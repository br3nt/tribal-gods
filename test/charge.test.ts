import { describe, expect, it } from 'vitest';
import { spellDef } from '../src/sim/catalog';
import { flatWorld, rulesFor, run } from './helpers';

const twoSpells = rulesFor([
  { id: 'player', ai: false, loadout: { spells: ['blast', 'convert'], startUnits: { brave: 4 } } },
  { id: 'red', ai: false },
]);

function setup() {
  const w = flatWorld(twoSpells);
  w.spawn('shaman', 'player', 20, 20);
  for (let i = 0; i < 4; i++) w.spawn('brave', 'player', 22 + i, 22);
  return w;
}

describe('spell charge model', () => {
  it('mana income is split evenly between charging, not-full spells', () => {
    const w = setup();
    run(w, 5);
    const b = w.spellState('player', 'blast');
    const c = w.spellState('player', 'convert');
    const rate = w.tribeSummary('player').manaRate;
    expect(rate).toBeGreaterThan(0);
    const blastMana = (b.charges + b.progress) * spellDef('blast').chargeMana;
    const convMana = (c.charges + c.progress) * spellDef('convert').chargeMana;
    expect(blastMana).toBeCloseTo(convMana, 1);
    expect(blastMana + convMana).toBeCloseTo(rate * 5, 0);
  });

  it('charges accrue per chargeMana up to maxCharges, then stop soaking', () => {
    const w = setup();
    run(w, 400);
    const b = w.spellState('player', 'blast');
    expect(b.charges).toBe(spellDef('blast').maxCharges);
    expect(b.progress).toBe(0);
    expect(b.eta).toBe(Infinity);
  });

  it('switching a spell off sends all income to the others', () => {
    const w = setup();
    w.setSpellCharging('player', 'convert', false);
    expect(w.spellState('player', 'convert').charging).toBe(false);
    run(w, 6);
    const c = w.spellState('player', 'convert');
    expect(c.charges + c.progress).toBe(0);
    expect(c.eta).toBe(Infinity);
    const b = w.spellState('player', 'blast');
    const rate = w.tribeSummary('player').manaRate;
    expect((b.charges + b.progress) * spellDef('blast').chargeMana).toBeCloseTo(rate * 6, 0);
    // eta is the remaining mana over this spell's share of the income
    const remaining = (1 - b.progress) * spellDef('blast').chargeMana;
    expect(b.eta).toBeCloseTo(remaining / rate, 0);
  });

  it('unknown spells report not known and never charge', () => {
    const w = setup();
    run(w, 5);
    const s = w.spellState('player', 'volcano');
    expect(s.known).toBe(false);
    expect(s.charges).toBe(0);
    expect(s.progress).toBe(0);
  });

  it('shrine worshippers speed up charging', () => {
    const a = setup();
    run(a, 5);
    const base = a.tribeSummary('player').manaRate;
    const w = setup();
    const shrine = w.spawnBuilding('player', 'shrine', 30, 30);
    const ids = w.units.filter((u) => u.kind === 'brave').map((u) => u.id);
    w.orderGarrison(ids, shrine.id);
    run(w, 10);
    expect(w.tribeSummary('player').praying).toBe(4);
    // income per head is boosted by prayer
    expect(w.tribeSummary('player').manaRate).toBeGreaterThan(base * 1.3);
  });
});

describe('casting', () => {
  it('casting spends exactly one charge, nothing else', () => {
    const w = setup();
    run(w, 400);
    expect(w.spellState('player', 'blast').charges).toBe(4);
    expect(w.orderCast('player', 'blast', 24, 20)).toBeNull();
    run(w, 2);
    expect(w.spellState('player', 'blast').charges).toBe(3);
    expect(w.spellState('player', 'convert').charges).toBe(3);
  });

  it('with no charge the cast is refused', () => {
    const w = setup();
    expect(w.orderCast('player', 'blast', 24, 20)).toMatch(/charge/i);
    expect(w.events.some((e) => e.type === 'denied')).toBe(true);
  });

  it('a gifted cast is spent before a real charge', () => {
    const w = setup();
    run(w, 400);
    w.tribes.player!.spells.blast.gifted = 1;
    expect(w.spellState('player', 'blast').gifted).toBe(1);
    w.orderCast('player', 'blast', 24, 20);
    run(w, 2);
    expect(w.spellState('player', 'blast').gifted).toBe(0);
    expect(w.spellState('player', 'blast').charges).toBe(4);
  });

  it('a gift works for a spell the tribe does not know', () => {
    const w = setup();
    w.tribes.player!.spells.lightning.gifted = 1;
    expect(w.orderCast('player', 'lightning', 24, 20)).toBeNull();
    run(w, 2);
    expect(w.spellState('player', 'lightning').gifted).toBe(0);
    expect(w.events.some((e) => e.type === 'lightning')).toBe(true);
  });

  it('the leader stands for castSeconds before the spell lands', () => {
    const w = setup();
    run(w, 400);
    w.events = [];
    w.orderCast('player', 'blast', 24, 20);
    run(w, spellDef('blast').castSeconds - 0.2);
    expect(w.events.some((e) => e.type === 'explosion')).toBe(false);
    run(w, 0.4);
    expect(w.events.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('refuses a target out of range that the leader cannot walk to', () => {
    const w = setup();
    run(w, 400);
    // Sea everywhere except the leader's island.
    w.map.heights.fill(-3);
    for (let z = 15; z <= 25; z++) for (let x = 15; x <= 25; x++) w.map.heights[z * 128 + x] = 2;
    w.map.version++;
    expect(w.orderCast('player', 'blast', 60, 20)).toMatch(/range/i);
    expect(w.spellState('player', 'blast').charges).toBe(4);
  });

  it('walks into range for a reachable far target, then casts', () => {
    const w = setup();
    run(w, 400);
    expect(w.orderCast('player', 'blast', 50, 20)).toBeNull();
    const leader = w.units.find((u) => u.kind === 'shaman')!;
    w.events = [];
    run(w, 12);
    expect(w.events.some((e) => e.type === 'explosion')).toBe(true);
    expect(Math.abs(leader.x - 50)).toBeLessThanOrEqual(spellDef('blast').range + 0.5);
  });

  it('spells that need land refuse a water target', () => {
    const w = setup();
    run(w, 400);
    for (let z = 18; z <= 22; z++) for (let x = 26; x <= 30; x++) w.map.heights[z * 128 + x] = -3;
    w.map.version++;
    expect(spellDef('convert').anywhere).toBe(false);
    expect(w.orderCast('player', 'convert', 28, 20)).toMatch(/land/i);
    expect(w.orderCast('player', 'blast', 28, 20)).toBeNull();
  });
});
