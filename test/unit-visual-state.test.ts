import { describe, expect, it } from 'vitest';
import { cheerersFor, pickClip, statusTint, victoryCheer, VisualUnit } from '../src/render/unit-visual-state';

const unit = (over: Partial<VisualUnit> = {}): VisualUnit => ({
  id: 1, kind: 'brave', tribe: 'player', x: 10, z: 10, state: 'idle', task: 'none', carrying: false, castSpell: null,
  hidden: false, attackCooldown: 0, wardTime: 0, warsongTime: 0, lifted: 0, pacified: 0, chantBy: -1, ...over,
});
const ctx = { garrisonKind: null, inWater: false, speed: 0, runSpeed: 4, cheering: false, winner: null };

describe('unit visual state', () => {
  it('tints by buff: ward, warsong, both', () => {
    expect(statusTint(unit())).toBe('none');
    expect(statusTint(unit({ wardTime: 3 }))).toBe('ward');
    expect(statusTint(unit({ warsongTime: 3 }))).toBe('warsong');
    expect(statusTint(unit({ wardTime: 1, warsongTime: 1 }))).toBe('both');
  });

  it('a unit caught in a cyclone tumbles, even mid-fight', () => {
    expect(pickClip(unit({ lifted: 0.6 }), ctx).clip).toBe('tumble');
    expect(pickClip(unit({ lifted: 0.6, state: 'fighting', task: 'attack' }), ctx).clip).toBe('tumble');
  });

  it('a pacified unit stands slack instead of attacking', () => {
    const fighter = unit({ kind: 'warrior', state: 'fighting', task: 'attack' });
    expect(pickClip(fighter, ctx).clip).toBe('attack');
    expect(pickClip({ ...fighter, pacified: 0.3, chantBy: 5 }, ctx).clip).toBe('slack');
    // walking away under the chant still walks
    expect(pickClip(unit({ pacified: 0.3, state: 'moving' }), { ...ctx, speed: 2 }).clip).toBe('walk');
  });

  it('shrine worshippers pray; a chanter with listeners chants', () => {
    expect(pickClip(unit({ hidden: true }), { ...ctx, garrisonKind: 'shrine' }).clip).toBe('pray');
    expect(pickClip(unit({ task: 'worship' }), ctx).clip).toBe('pray');
    expect(pickClip(unit({ kind: 'chanter', task: 'chant' }), ctx).clip).toBe('chant');
    expect(pickClip(unit({ kind: 'chanter', task: 'chant', state: 'working' }), ctx).clip).toBe('chant');
  });

  it('warsong makes movers run', () => {
    expect(pickClip(unit({ state: 'moving' }), { ...ctx, speed: 2 }).clip).toBe('walk');
    expect(pickClip(unit({ state: 'moving', warsongTime: 2 }), { ...ctx, speed: 2 }).clip).toBe('run');
  });

  it('idle units cheer when told to, or when their side won', () => {
    expect(pickClip(unit(), { ...ctx, cheering: true }).clip).toBe('cheer');
    expect(pickClip(unit(), { ...ctx, winner: 'victory' }).clip).toBe('cheer');
    expect(pickClip(unit({ tribe: 'red' }), { ...ctx, winner: 'victory' }).clip).toBe('idle');
    expect(victoryCheer('defeat', 'red')).toBe(true);
    expect(victoryCheer('defeat', 'wild')).toBe(false);
    expect(victoryCheer(null, 'player')).toBe(false);
  });

  it('attack phase lines the clip impact up with the sim strike', () => {
    const def = { kind: 'warrior' as const, state: 'fighting' as const, task: 'attack' as const };
    const atStrike = pickClip(unit({ ...def, attackCooldown: 0 }), ctx);
    expect(atStrike.phase).toBeCloseTo(0.5);
  });
});

describe('cheerersFor', () => {
  const units = [
    unit({ id: 1, x: 10, z: 10 }),
    unit({ id: 2, x: 12, z: 11 }),
    unit({ id: 3, x: 40, z: 40 }), // too far
    unit({ id: 4, x: 11, z: 10, tribe: 'red' }), // other side
    unit({ id: 5, x: 11, z: 9, state: 'moving' }), // busy
  ];
  const buildings = [{ id: 9, tribe: 'player' as const }];

  it('a training hut finishing a recruit cheers the idle villagers around it', () => {
    const ids = cheerersFor([{ type: 'trained', x: 10, z: 10, magnitude: 9 }], units, buildings);
    expect(ids.sort()).toEqual([1, 2]);
  });

  it('an objective done cheers the player tribe near home', () => {
    const ids = cheerersFor([{ type: 'objectiveDone', x: 11, z: 11, magnitude: 0 }], units, buildings);
    expect(ids.sort()).toEqual([1, 2]);
  });

  it('other events cheer nobody', () => {
    expect(cheerersFor([{ type: 'hit', x: 10, z: 10 }], units, buildings)).toEqual([]);
  });
});
