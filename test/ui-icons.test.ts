/**
 * The icon set (ui/icons.ts): hand-cut means jittered, but the jitter must
 * never break a path (arc flags and radii untouched), must be the same on
 * every load, and every icon must still be an icon.
 */
import { describe, expect, it } from 'vitest';
import { BUILDING_ICONS, icon, roughenPath, SPELL_ICONS, UI_ICONS, UNIT_ICONS } from '../src/ui/icons';

const tokens = (d: string) => d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];

describe('roughenPath', () => {
  it('keeps every command and the number of arguments', () => {
    const d = 'M12 2.5c3.5 4 6 7.25 6 11a6 6 0 0 1-12 0z';
    const r = roughenPath(d, 7);
    expect(tokens(r).filter((t) => /[a-z]/i.test(t))).toEqual(tokens(d).filter((t) => /[a-z]/i.test(t)));
    expect(tokens(r).length).toBe(tokens(d).length);
  });

  it('moves coordinates only a little, and never an arc radius or flag', () => {
    const d = 'M5 18.5a7 2.5 0 1 0 14 0';
    const r = tokens(roughenPath(d, 3)).map(Number);
    const o = tokens(d).map(Number);
    // indices: M x y a rx ry rot large sweep x y
    for (const i of [1, 2, 9, 10]) expect(Math.abs(r[i] - o[i])).toBeLessThanOrEqual(0.25);
    for (const i of [4, 5, 6, 7, 8]) expect(r[i]).toBe(o[i]);
  });

  it('is deterministic', () => {
    expect(roughenPath('M1 1L5 5', 42)).toBe(roughenPath('M1 1L5 5', 42));
  });
});

describe('the set', () => {
  it('every icon renders an svg with a cut layer and its own strokes', () => {
    const all = [...Object.values(UI_ICONS), ...Object.values(SPELL_ICONS), ...Object.values(BUILDING_ICONS), ...Object.values(UNIT_ICONS)];
    expect(all.length).toBeGreaterThan(60);
    for (const inner of all) expect(inner).toMatch(/<(path|circle)/);
    const html = icon('wood', 16);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('--ic-cut');
    expect(html).not.toContain('NaN');
  });
});
