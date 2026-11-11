import { describe, expect, it } from 'vitest';
import { BUILD_ORDER, BUILDINGS, SPELLS, UNITS } from '../src/sim/catalog';

describe('catalog', () => {
  it('every trainable unit names a building that trains it', () => {
    for (const u of Object.values(UNITS)) {
      if (u.trainedAt) expect(BUILDINGS[u.trainedAt].trains).toBe(u.kind);
    }
  });
  it('build menu lists every building once, prerequisites before dependants', () => {
    expect([...BUILD_ORDER].sort()).toEqual(Object.keys(BUILDINGS).sort());
    for (const b of Object.values(BUILDINGS)) {
      for (const r of b.requires) expect(BUILD_ORDER.indexOf(r)).toBeLessThan(BUILD_ORDER.indexOf(b.kind));
    }
  });
  it('spell ids are unique and tiers ascend in panel order', () => {
    expect(new Set(SPELLS.map((s) => s.id)).size).toBe(SPELLS.length);
    for (let i = 1; i < SPELLS.length; i++) expect(SPELLS[i].tier).toBeGreaterThanOrEqual(SPELLS[i - 1].tier);
  });
});
