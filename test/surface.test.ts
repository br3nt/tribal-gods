/** The CPU copy of the terrain's bicubic surface (world/surface.ts). */
import { describe, expect, it } from 'vitest';
import { footprintRange, surfaceHeight } from '../src/world/surface';

const N = 128;
const wrap = (i: number) => ((i % N) + N) % N;
const mapOf = (f: (x: number, z: number) => number) => ({ heightAt: (x: number, z: number) => f(wrap(x), wrap(z)) });

describe('surfaceHeight', () => {
  it('passes exactly through every tile height', () => {
    const m = mapOf((x, z) => Math.sin(x * 0.7) * 3 + Math.cos(z * 1.3) * 2);
    for (const [x, z] of [[3, 4], [10, 99], [127, 0]]) {
      expect(surfaceHeight(m, x, z)).toBeCloseTo(m.heightAt(x, z), 9);
    }
  });

  it('reproduces a plane (Catmull-Rom is exact on linear ground)', () => {
    const m = mapOf((x, z) => 0.3 * x - 0.2 * z + 5);
    expect(surfaceHeight(m, 10.25, 20.75)).toBeCloseTo(0.3 * 10.25 - 0.2 * 20.75 + 5, 9);
  });

  it('wraps across the world seam', () => {
    const m = mapOf((x, z) => Math.sin((x / N) * Math.PI * 2) * 4 + z * 0);
    expect(surfaceHeight(m, -0.5, 3)).toBeCloseTo(surfaceHeight(m, N - 0.5, 3), 9);
  });

  it('footprintRange spans the slope under a footprint', () => {
    const m = mapOf((x) => x * 0.5);
    const r = footprintRange(m, 20, 20, 1.5);
    expect(r.lo).toBeCloseTo(18.5 * 0.5, 6);
    expect(r.hi).toBeCloseTo(21.5 * 0.5, 6);
    expect(r.mean).toBeCloseTo(10, 6);
  });
});
