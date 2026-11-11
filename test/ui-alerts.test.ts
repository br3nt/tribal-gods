import { describe, expect, it } from 'vitest';
import { AlertMemory, castsBetween, deriveAlerts, ritualBrokenAlert, Snapshot } from '../src/ui/alert-rules';

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    t: 0, leaderAlive: true, known: ['blast'], casts: { blast: 2 }, gifted: {},
    units: new Map([[1, { hp: 10, x: 5, z: 5 }]]),
    buildings: new Map([[9, { kind: 'hut', hp: 40, tier: 0, burning: false, done: true, x: 8, z: 8 }]]),
    objectives: [{ text: 'Destroy the rival tribe', done: false }],
    population: 10,
    ...over,
  };
}
const mem = (): AlertMemory => ({ attacks: [] });

describe('deriveAlerts', () => {
  it('says nothing when nothing changed', () => {
    expect(deriveAlerts(snap(), snap({ t: 1 }), mem())).toEqual([]);
  });
  it('raises one attack alert per area per cooldown', () => {
    const m = mem();
    const hurt = (t: number, hp: number) => snap({ t, units: new Map([[1, { hp, x: 5, z: 5 }]]) });
    expect(deriveAlerts(snap(), hurt(1, 8), m).map((a) => a.kind)).toEqual(['attack']);
    expect(deriveAlerts(hurt(1, 8), hurt(2, 6), m)).toEqual([]);
    expect(deriveAlerts(hurt(2, 6), hurt(30, 4), m).map((a) => a.kind)).toEqual(['attack']);
  });
  it('reports leader loss and return', () => {
    expect(deriveAlerts(snap(), snap({ leaderAlive: false }), mem())[0].kind).toBe('leaderDown');
    expect(deriveAlerts(snap({ leaderAlive: false }), snap(), mem())[0].kind).toBe('leaderBack');
  });
  it('reports learned spells, gifts, growth, fire, loss, objectives', () => {
    const b = snap({
      known: ['blast', 'lightning'],
      gifted: { volcano: 1 },
      buildings: new Map([[9, { kind: 'hut', hp: 40, tier: 1, burning: true, done: true, x: 8, z: 8 }]]),
      objectives: [{ text: 'Destroy the rival tribe', done: true }],
    });
    const kinds = deriveAlerts(snap(), b, mem()).map((a) => a.kind);
    expect(kinds).toEqual(['learned', 'gift', 'grew', 'burning', 'objective']);
    expect(deriveAlerts(snap(), snap({ buildings: new Map() }), mem())[0].kind).toBe('lost');
  });
});

describe('castsBetween', () => {
  it('a rival beginning a ritual at a stone is an alert you can jump to', () => {
    const r = { index: 0, tribe: 'red', who: 'the Ashmark', spell: 'lightning' as const, x: 30, z: 40 };
    const a = deriveAlerts(snap(), snap({ t: 1, rituals: [r] }), mem());
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'ritual', text: 'The Ashmark are communing at the Lightning stone', x: 30, z: 40 });
    // Still going: no repeat.
    expect(deriveAlerts(snap({ rituals: [r] }), snap({ t: 1, rituals: [r] }), mem())).toEqual([]);
  });
  it('your own ritual ending is never guessed from a diff (a finished ritual looks the same)', () => {
    const r = { index: 1, tribe: 'player', who: 'your tribe', spell: 'swamp' as const, x: 3, z: 4 };
    expect(deriveAlerts(snap({ rituals: [r] }), snap({ t: 1 }), mem())).toEqual([]);
  });
  it('the sim saying your ritual was interrupted is an alert, but not for a rival', () => {
    const a = ritualBrokenAlert({ type: 'communeInterrupted', tribe: 'player', x: 3, z: 4, magnitude: 0.4 }, 'swamp');
    expect(a).toMatchObject({ kind: 'ritualBroken', text: "Your leader's ritual at the Mire stone was broken at 40%", x: 3, z: 4 });
    expect(ritualBrokenAlert({ type: 'communeInterrupted', tribe: 'red', x: 3, z: 4 }, 'swamp')).toBeNull();
  });
  it('counts spent charges, not gifts received', () => {
    expect(castsBetween(snap(), snap({ casts: { blast: 1 } }))).toBe(1);
    expect(castsBetween(snap(), snap({ casts: { blast: 3 }, gifted: { blast: 1 } }))).toBe(0);
  });
});
