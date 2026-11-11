/**
 * Bar fills (ui/bar-fill.ts) depend on the value and nothing else — the
 * construction bar once appeared to change with the camera (see the header
 * of ui/bar-fill.ts for why).
 */
import { describe, expect, it } from 'vitest';
import { barFill, fillTransform, hpClass } from '../src/ui/bar-fill';

describe('barFill', () => {
  it('is value / max, clamped', () => {
    expect(barFill(0.3)).toBe(0.3);
    expect(barFill(30, 120)).toBe(0.25);
    expect(barFill(-1)).toBe(0);
    expect(barFill(2)).toBe(1);
  });
  it('treats junk as empty, never NaN', () => {
    expect(barFill(NaN)).toBe(0);
    expect(barFill(5, 0)).toBe(0);
    expect(barFill(Infinity, 10)).toBe(0);
  });
  it('the transform carries only the fraction', () => {
    expect(fillTransform(0.75)).toBe('scaleX(0.75)');
    expect(fillTransform(1 / 3)).toBe('scaleX(0.333)');
    expect(fillTransform(7)).toBe('scaleX(1)');
  });
  it('health colours', () => {
    expect(hpClass(0.9)).toBe('');
    expect(hpClass(0.5)).toBe('mid');
    expect(hpClass(0.1)).toBe('low');
  });
});
