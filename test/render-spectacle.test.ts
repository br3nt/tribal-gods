import { describe, expect, it } from 'vitest';
import { cheerersFor, figureTribe, hasHomeCircle, pickClip, VisualUnit } from '../src/render/unit-visual-state';

const unit = (over: Partial<VisualUnit> = {}): VisualUnit => ({
  id: 1, kind: 'brave', tribe: 'player', x: 10, z: 10, state: 'idle', task: 'none', carrying: false, castSpell: null,
  hidden: false, attackCooldown: 0, wardTime: 0, warsongTime: 0, lifted: 0, pacified: 0, chantBy: -1, ...over,
});
const ctx = { garrisonKind: null, inWater: false, speed: 0, runSpeed: 4, cheering: false, winner: null };

describe('stranded kin', () => {
  it('wear the colours of the tribe they will join', () => {
    expect(figureTribe(unit({ tribe: 'wild', joins: 'player' }))).toBe('player');
    expect(figureTribe(unit({ tribe: 'wild', joins: null }))).toBe('wild');
    expect(figureTribe(unit({ tribe: 'red' }))).toBe('red');
  });

  it('beckon while they wait, walk when they move', () => {
    expect(pickClip(unit({ tribe: 'wild', joins: 'player' }), ctx).clip).toBe('beckon');
    expect(pickClip(unit({ tribe: 'wild', joins: 'player', state: 'moving' }), { ...ctx, speed: 2 }).clip).toBe('walk');
    expect(pickClip(unit({ tribe: 'wild' }), ctx).clip).toBe('idle');
  });

  it('the kin cheer when one of them makes it home', () => {
    const units = [
      unit({ id: 1, x: 10, z: 10 }),
      unit({ id: 2, x: 13, z: 10 }),
      unit({ id: 3, x: 40, z: 40 }),
      unit({ id: 4, x: 11, z: 10, tribe: 'red' }),
    ];
    const ids = cheerersFor([{ type: 'rescued', x: 10, z: 10, tribe: 'player' }], units, []);
    expect(ids.sort()).toEqual([1, 2]);
  });
});

describe('stone guardians', () => {
  it('kneel dormant while their stone sleeps', () => {
    const g = unit({ tribe: 'wild', kind: 'warrior', guardOf: 0 });
    expect(pickClip(g, { ...ctx, dormant: true }).clip).toBe('dormant');
    expect(pickClip(g, { ...ctx, dormant: false }).clip).toBe('idle');
    // a woken guardian fights like anyone else
    expect(pickClip({ ...g, state: 'fighting', task: 'attack' }, { ...ctx, dormant: false }).clip).toBe('attack');
  });
});

describe('home circles', () => {
  it('a war band with no buildings, ever, has no home circle', () => {
    expect(hasHomeCircle({ personality: { builds: false }, everBuilt: new Set() }, 0)).toBe(false);
    expect(hasHomeCircle({ personality: { builds: false }, everBuilt: new Set(['hut']) }, 0)).toBe(true);
    expect(hasHomeCircle({ personality: { builds: false }, everBuilt: new Set() }, 2)).toBe(true);
  });

  it('a settling tribe keeps its circle before its first roof', () => {
    expect(hasHomeCircle({ personality: {}, everBuilt: new Set() }, 0)).toBe(true);
  });

  it('an explicit flag wins', () => {
    expect(hasHomeCircle({ homeless: true, personality: {}, everBuilt: new Set(['hut']) }, 3)).toBe(false);
    expect(hasHomeCircle({ homeless: false, personality: { builds: false }, everBuilt: new Set() }, 0)).toBe(true);
  });
});
