/**
 * ui/bar-fill.ts — how full a bar is, as pure math.
 *
 * Every bar in the interface (health over heads, construction, training,
 * the selection panel) draws its fill as `transform: scaleX(f)` on a
 * full-width child, where f comes ONLY from the value it shows. Nothing
 * about the camera, the bar's on-screen size, or which entity a pooled
 * bar showed last frame may enter into it.
 *
 * (The in-world bars once used `width: N%` with a CSS width transition on
 * pooled elements reassigned every frame by visibility order. While the
 * camera moved, a bar handed from one building to another animated from the
 * old building's fill, so progress appeared to change with camera angle.)
 */

/** Fill fraction 0..1 for value/max; NaN, negatives and over-full clamp. */
export function barFill(value: number, max = 1): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / max));
}

/** The CSS transform for a fill fraction, rounded so unchanged values don't restyle. */
export function fillTransform(frac: number): string {
  return `scaleX(${Math.round(barFill(frac) * 1000) / 1000})`;
}

/** Health colour class for a fill. */
export function hpClass(frac: number): '' | 'mid' | 'low' {
  return frac < 0.3 ? 'low' : frac < 0.6 ? 'mid' : '';
}
