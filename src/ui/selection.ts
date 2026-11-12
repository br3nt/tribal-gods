/**
 * ui/selection.ts — what is selected, as plain data.
 *
 * The player selects exactly one KIND of thing at a time:
 *
 *   units     — any number of YOUR OWN people (only they take orders)
 *   building  — one building (yours: full controls; theirs: read-only)
 *   monument  — one standing stone
 *   inspect   — one person who is NOT yours (a wanderer, a rival): a
 *               read-only card. Never in `units`, so never ordered, never
 *               box-selected, never ringed as yours.
 *
 * `units` stays a Set<number> of unit ids because the unit renderer draws
 * selection rings straight from it. The rest is pure logic — grouping a
 * multi-selection by kind, merging shift-clicks, control groups, cycling
 * idle villagers — kept free of DOM and three.js and tested in
 * test/ui-selection.test.ts.
 */

import { UnitKind } from '../sim/catalog';

/** Panel order for a mixed selection: leader first, then fighters, then villagers. */
export const KIND_ORDER: UnitKind[] = ['shaman', 'warrior', 'firewarrior', 'warden', 'chanter', 'brave', 'wildman'];

export class Selection {
  /** Unit ids (shared with the unit renderer for selection rings). */
  readonly units = new Set<number>();
  building: number | null = null;
  monument: number | null = null;
  /** A wanderer or rival being looked at (read-only; see the header). */
  inspect: number | null = null;
  /** Bumped on every change so panels know to rebuild. */
  version = 0;

  clear(): void {
    if (this.units.size === 0 && this.building === null && this.monument === null && this.inspect === null) return;
    this.units.clear();
    this.building = null;
    this.monument = null;
    this.inspect = null;
    this.version++;
  }

  setUnits(ids: Iterable<number>, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    const list = [...ids];
    if (mode === 'replace') this.clear();
    this.building = null;
    this.monument = null;
    this.inspect = null;
    mergeIds(this.units, list, mode);
    this.version++;
  }

  setBuilding(id: number): void {
    this.clear();
    this.building = id;
    this.version++;
  }

  setMonument(index: number): void {
    this.clear();
    this.monument = index;
    this.version++;
  }

  /** Look at someone who isn't yours (read-only card; your selection is dropped). */
  inspectUnit(id: number): void {
    this.clear();
    this.inspect = id;
    this.version++;
  }

  /** Drop ids the predicate says no longer exist. Returns true if anything changed. */
  prune(alive: (id: number) => boolean, buildingAlive: (id: number) => boolean): boolean {
    let changed = false;
    for (const id of this.units) {
      if (!alive(id)) {
        this.units.delete(id);
        changed = true;
      }
    }
    if (this.inspect !== null && !alive(this.inspect)) {
      this.inspect = null;
      changed = true;
    }
    if (this.building !== null && !buildingAlive(this.building)) {
      this.building = null;
      changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  get empty(): boolean {
    return this.units.size === 0 && this.building === null && this.monument === null && this.inspect === null;
  }
}

/** replace/add: union. toggle: each id flips (shift-click on a selected unit removes it). */
export function mergeIds(set: Set<number>, ids: number[], mode: 'replace' | 'add' | 'toggle'): void {
  if (mode === 'toggle' && ids.length > 0 && ids.every((id) => set.has(id))) {
    for (const id of ids) set.delete(id);
    return;
  }
  for (const id of ids) set.add(id);
}

export interface KindGroup {
  kind: UnitKind;
  ids: number[];
}

/** Group a selection by unit kind, in KIND_ORDER. */
export function groupByKind(units: Array<{ id: number; kind: UnitKind }>): KindGroup[] {
  const map = new Map<UnitKind, number[]>();
  for (const u of units) {
    const list = map.get(u.kind);
    if (list) list.push(u.id);
    else map.set(u.kind, [u.id]);
  }
  // Kinds the catalog adds later still show, after the known ones.
  const order = [...KIND_ORDER.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !KIND_ORDER.includes(k))];
  return order.map((k) => ({ kind: k, ids: map.get(k)! }));
}

/** Ctrl+N stores the selection; N recalls it (minus anyone who has died since). */
export class ControlGroups {
  private readonly groups = new Map<number, number[]>();

  set(n: number, ids: Iterable<number>): void {
    const list = [...ids];
    if (list.length === 0) this.groups.delete(n);
    else this.groups.set(n, list);
  }

  get(n: number, alive: (id: number) => boolean): number[] {
    const list = (this.groups.get(n) ?? []).filter(alive);
    if (list.length === 0) this.groups.delete(n);
    else this.groups.set(n, list);
    return list;
  }

  clear(): void {
    this.groups.clear();
  }

  /** Which group numbers are set (for the little group badges). */
  numbers(): number[] {
    return [...this.groups.keys()].sort((a, b) => a - b);
  }
}

/**
 * Cycle through candidates: the first id after `last` (by id order), or the
 * first one. Used by "next idle villager".
 */
export function nextInCycle(ids: number[], last: number | null): number | null {
  if (ids.length === 0) return null;
  const sorted = [...ids].sort((a, b) => a - b);
  if (last === null) return sorted[0];
  return sorted.find((id) => id > last) ?? sorted[0];
}
