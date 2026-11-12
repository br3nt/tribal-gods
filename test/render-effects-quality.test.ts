import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EffectsRenderer } from '../src/render/effects';
import { FX_DETAIL, QUALITY } from '../src/render/look';
import { castSpell } from '../src/sim/spells';
import { flatWorld, run } from './helpers';

// The renderer reads a few browser globals when it sizes point sprites.
const g = globalThis as Record<string, unknown>;
const saved = { innerHeight: g.innerHeight, devicePixelRatio: g.devicePixelRatio };
beforeAll(() => {
  g.innerHeight = 900;
  g.devicePixelRatio = 1;
});
afterAll(() => Object.assign(g, saved));

const rig = () => ({ camera: new THREE.PerspectiveCamera(38, 1.6, 0.5, 900), shake() {} });
const live = (fx: EffectsRenderer) => Math.max((fx.glow as unknown as { count: number }).count, (fx.matter as unknown as { count: number }).count);
const lifeOn = (fx: EffectsRenderer) => (fx as unknown as { life: { enabled: boolean } }).life.enabled;

/** Volcanoes every few frames for `seconds`: the peak live particle count in either pool. */
function storm(fx: EffectsRenderer, seconds: number): number {
  const w = flatWorld();
  const cam = new THREE.Vector3(40, 0, 40);
  let peak = 0;
  for (let i = 0, t = 0; t < seconds; t += 1 / 15, i++) {
    if (i % 3 === 0) castSpell(w, 'volcano', 20 + (i % 7), 20, 20, 20, 'player');
    run(w, 1 / 15);
    fx.sync(w, cam, 1 / 15);
    peak = Math.max(peak, live(fx));
  }
  return peak;
}

describe('effects follow the quality tier live', () => {
  it('applyQuality moves the particle budget, the emission detail and ambient life', () => {
    const fx = new EffectsRenderer(new THREE.Scene(), rig() as never, undefined, undefined, QUALITY.high);
    expect(fx.glow.limit).toBe(QUALITY.high.particles);
    fx.applyQuality(QUALITY.low);
    expect(fx.tier).toBe('low');
    expect(fx.detail).toBe(FX_DETAIL.low);
    expect(fx.glow.limit).toBe(QUALITY.low.particles);
    expect(fx.matter.limit).toBe(QUALITY.low.particles);
    expect(lifeOn(fx)).toBe(false);
    fx.applyQuality(QUALITY.medium);
    expect(fx.glow.limit).toBe(QUALITY.medium.particles);
    expect(lifeOn(fx)).toBe(true);
  });

  it('a downgraded renderer never holds more live particles than the new budget', () => {
    const fx = new EffectsRenderer(new THREE.Scene(), rig() as never, undefined, undefined, QUALITY.high);
    fx.applyQuality(QUALITY.low);
    const peak = storm(fx, 6);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(QUALITY.low.particles);
  });

  it('an upgrade lets the pools grow past the old budget (the arrays are sized for the top tier)', () => {
    const fx = new EffectsRenderer(new THREE.Scene(), rig() as never, undefined, undefined, QUALITY.low);
    fx.applyQuality(QUALITY.high);
    expect(storm(fx, 6)).toBeGreaterThan(QUALITY.low.particles);
  });
});
