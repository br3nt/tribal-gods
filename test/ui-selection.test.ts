import { describe, expect, it } from 'vitest';
import { ControlGroups, groupByKind, mergeIds, nextInCycle, Selection } from '../src/ui/selection';

describe('Selection', () => {
  it('holds one kind of thing at a time', () => {
    const s = new Selection();
    s.setUnits([1, 2]);
    s.setBuilding(9);
    expect(s.units.size).toBe(0);
    expect(s.building).toBe(9);
    s.setUnits([3], 'add');
    expect(s.building).toBeNull();
    expect([...s.units]).toEqual([3]);
  });
  it('shift-click toggles a selected unit off, adds a new one', () => {
    const set = new Set([1, 2]);
    mergeIds(set, [2], 'toggle');
    expect([...set]).toEqual([1]);
    mergeIds(set, [5], 'toggle');
    expect([...set].sort()).toEqual([1, 5]);
  });
  it('prunes the dead and bumps its version', () => {
    const s = new Selection();
    s.setUnits([1, 2, 3]);
    const v = s.version;
    expect(s.prune((id) => id !== 2, () => true)).toBe(true);
    expect([...s.units]).toEqual([1, 3]);
    expect(s.version).toBeGreaterThan(v);
  });
});

describe('groupByKind', () => {
  it('orders leader, fighters, villagers', () => {
    const g = groupByKind([
      { id: 1, kind: 'brave' }, { id: 2, kind: 'warrior' }, { id: 3, kind: 'brave' }, { id: 4, kind: 'shaman' },
    ]);
    expect(g.map((x) => x.kind)).toEqual(['shaman', 'warrior', 'brave']);
    expect(g[2].ids).toEqual([1, 3]);
  });
});

describe('ControlGroups', () => {
  it('recalls a group minus the fallen', () => {
    const cg = new ControlGroups();
    cg.set(1, [4, 5, 6]);
    expect(cg.get(1, (id) => id !== 5)).toEqual([4, 6]);
    expect(cg.numbers()).toEqual([1]);
    expect(cg.get(1, () => false)).toEqual([]);
    expect(cg.numbers()).toEqual([]);
  });
});

describe('nextInCycle', () => {
  it('walks ids in order and wraps', () => {
    expect(nextInCycle([7, 3, 5], null)).toBe(3);
    expect(nextInCycle([7, 3, 5], 3)).toBe(5);
    expect(nextInCycle([7, 3, 5], 7)).toBe(3);
    expect(nextInCycle([], 1)).toBeNull();
  });
});
