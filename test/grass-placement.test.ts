/**
 * Ground cover is anchored to the WORLD: a clump's root is a pure function
 * of its world cell, whatever the camera does, and the carpet wraps with
 * the planet.
 */
import { describe, expect, it } from 'vitest';
import {
  GRASS_CELLS_PER_LAP, GRASS_SPACING, LAP_UNITS, grassCellAt, grassClump, instanceCell, tgHash,
} from '../src/world/grass-placement';

describe('grass placement', () => {
  it('spacing divides one lap of the planet exactly', () => {
    expect(GRASS_SPACING * GRASS_CELLS_PER_LAP).toBeCloseTo(LAP_UNITS, 9);
    expect(Number.isInteger(GRASS_CELLS_PER_LAP)).toBe(true);
  });

  it('is deterministic per cell', () => {
    for (const [i, j] of [[0, 0], [17, -3], [399, 400], [-1200, 77]]) {
      expect(grassClump(i, j)).toEqual(grassClump(i, j));
    }
  });

  it('the same world cell gets the same clump one lap away (wrap-aware)', () => {
    for (const [i, j] of [[3, 5], [250, 12], [-7, 399]]) {
      const a = grassClump(i, j);
      const b = grassClump(i + GRASS_CELLS_PER_LAP, j - 2 * GRASS_CELLS_PER_LAP);
      expect(b.r1).toBe(a.r1);
      expect(b.r2).toBe(a.r2);
      expect(b.r3).toBe(a.r3);
      expect(b.x - a.x).toBeCloseTo(LAP_UNITS, 6);
      expect(b.z - a.z).toBeCloseTo(-2 * LAP_UNITS, 6);
    }
  });

  it('roots stay inside their own cell (no two cells collide)', () => {
    for (let i = -20; i < 20; i++) {
      for (let j = -20; j < 20; j++) {
        const c = grassClump(i, j);
        expect(grassCellAt(c.x, c.z)).toEqual({ i, j });
      }
    }
  });

  it('panning the camera 1, 5 and 20 units never moves a blade', () => {
    const n = 140;
    const cam = { x: 113.37, z: 61.9 };
    // Root of every drawn instance, keyed by its world cell.
    const roots = (cx: number, cz: number) => {
      const m = new Map<string, { x: number; z: number }>();
      for (let b = 0; b < n; b++) {
        for (let a = 0; a < n; a++) {
          const { i, j } = instanceCell(cx, cz, a, b, n);
          const c = grassClump(i, j);
          m.set(`${i},${j}`, { x: c.x, z: c.z });
        }
      }
      return m;
    };
    const base = roots(cam.x, cam.z);
    let shared = 0;
    for (const d of [1, 5, 20]) {
      for (const [dx, dz] of [[d, 0], [0, -d], [d * 0.7, d * 0.7]]) {
        const moved = roots(cam.x + dx, cam.z + dz);
        for (const [k, p] of moved) {
          const q = base.get(k);
          if (!q) continue;
          shared++;
          expect(p).toEqual(q);
        }
      }
    }
    expect(shared).toBeGreaterThan(100);
  });

  it('hash matches the GLSL definition on known inputs', () => {
    // fract(p * (0.1031, 0.1030)); p += dot(p, p.yx + 33.33); fract((p.x + p.y) * p.x)
    const ref = (x: number, y: number) => {
      let px = (x * 0.1031) % 1, py = (y * 0.103) % 1;
      const d = px * (py + 33.33) + py * (px + 33.33);
      px += d; py += d;
      const v = (px + py) * px;
      return v - Math.floor(v);
    };
    for (const [x, y] of [[1, 2], [17.3, 18.3], [250, 399]]) {
      expect(tgHash(x, y)).toBeCloseTo(ref(x, y), 2);
    }
  });
});
