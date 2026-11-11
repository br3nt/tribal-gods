/**
 * Ground-based box selection (ui/marquee.ts): the rectangle is laid on the
 * land along the camera's axes, and membership is tested on the torus.
 */
import { describe, expect, it } from 'vitest';
import { WORLD_SIZE } from '../src/config';
import { groundRect, inGroundQuad, quadArea } from '../src/ui/marquee';

describe('groundRect', () => {
  it('is axis-aligned when the camera looks along -z (right = +x)', () => {
    const q = groundRect({ x: 10, z: 10 }, { x: 14, z: 7 }, { x: 1, z: 0 });
    expect(q.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100])).toEqual([[10, 10], [14, 10], [14, 7], [10, 7]]);
    expect(quadArea(q)).toBeCloseTo(12);
  });

  it('turns with the camera: a 45° view gives a diamond with the drag points as opposite corners', () => {
    const r = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    const q = groundRect({ x: 0, z: 0 }, { x: 4, z: 0 }, r);
    expect(q[2]).toEqual({ x: 4, z: 0 });
    expect(q[1].x).toBeCloseTo(2);
    expect(q[1].z).toBeCloseTo(2);
    expect(q[3].x).toBeCloseTo(2);
    expect(q[3].z).toBeCloseTo(-2);
  });

  it('spans the seam the short way: a drag from tile 126 to tile 2 is 4 tiles wide, not 124', () => {
    const q = groundRect({ x: 126, z: 50 }, { x: 2, z: 54 }, { x: 1, z: 0 });
    expect(quadArea(q)).toBeCloseTo(16);
  });
});

describe('inGroundQuad', () => {
  const q = groundRect({ x: 10, z: 10 }, { x: 20, z: 16 }, { x: 1, z: 0 });

  it('inside, outside, and on the edge', () => {
    expect(inGroundQuad({ x: 15, z: 13 }, q)).toBe(true);
    expect(inGroundQuad({ x: 9, z: 13 }, q)).toBe(false);
    expect(inGroundQuad({ x: 15, z: 17 }, q)).toBe(false);
    expect(inGroundQuad({ x: 10, z: 12 }, q)).toBe(true);
  });

  it('either winding works (dragging up-left instead of down-right)', () => {
    const back = groundRect({ x: 20, z: 16 }, { x: 10, z: 10 }, { x: 1, z: 0 });
    expect(inGroundQuad({ x: 15, z: 13 }, back)).toBe(true);
    expect(inGroundQuad({ x: 21, z: 13 }, back)).toBe(false);
  });

  it('wraps: a person just past the seam is inside a box that crosses it', () => {
    const seam = groundRect({ x: WORLD_SIZE - 3, z: 40 }, { x: 3, z: 46 }, { x: 1, z: 0 });
    expect(inGroundQuad({ x: 1, z: 43 }, seam)).toBe(true);
    expect(inGroundQuad({ x: WORLD_SIZE - 1, z: 43 }, seam)).toBe(true);
    expect(inGroundQuad({ x: 64, z: 43 }, seam)).toBe(false);
    // The same person an exact lap away is the same person.
    expect(inGroundQuad({ x: 1 + WORLD_SIZE, z: 43 - WORLD_SIZE }, seam)).toBe(true);
  });

  it('a rotated box keeps out what an axis-aligned one would let in', () => {
    const r = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    const d = groundRect({ x: 0, z: 0 }, { x: 4, z: 0 }, r);
    expect(inGroundQuad({ x: 2, z: 0 }, d)).toBe(true);
    expect(inGroundQuad({ x: 0.3, z: 1.5 }, d)).toBe(false); // inside the bounding box, outside the diamond
  });

  it('a degenerate (zero-area) quad holds nobody', () => {
    const line = groundRect({ x: 5, z: 5 }, { x: 5, z: 5 }, { x: 1, z: 0 });
    expect(inGroundQuad({ x: 5, z: 5 }, line)).toBe(false);
  });
});
