import { describe, expect, it } from 'vitest';
import { EFFECT_EVENTS } from '../src/sim/catalog';
import { RateLimiter, Soundscape, attenuation, hasSoundRule, tileDistance } from '../src/core/sfx';
import * as audio from '../src/core/audio';

describe('sfx router', () => {
  it('maps every effect event the sim emits to a sound or to explicit silence', () => {
    expect(EFFECT_EVENTS.filter((e) => !hasSoundRule(e))).toEqual([]);
  });

  it('attenuates with distance and is silent beyond 70 tiles', () => {
    expect(attenuation(0)).toBe(1);
    expect(attenuation(10)).toBe(1);
    expect(attenuation(40)).toBeLessThan(attenuation(20));
    expect(attenuation(70)).toBe(0);
    expect(attenuation(100)).toBe(0);
  });

  it('measures distance across the world wrap', () => {
    expect(tileDistance(1, 0, 127, 0)).toBeCloseTo(2);
    expect(tileDistance(0, 2, 0, 126)).toBeCloseTo(4);
  });

  it('rate limits per key within a window', () => {
    const r = new RateLimiter();
    expect(r.allow('hit', 0, 3, 100)).toBe(true);
    expect(r.allow('hit', 10, 3, 100)).toBe(true);
    expect(r.allow('hit', 20, 3, 100)).toBe(true);
    expect(r.allow('hit', 30, 3, 100)).toBe(false);
    expect(r.allow('fireball', 30, 3, 100)).toBe(true);
    expect(r.allow('hit', 150, 3, 100)).toBe(true);
  });

  it('is safe without an AudioContext', () => {
    const s = new Soundscape();
    const evs = [...EFFECT_EVENTS, 'explosion', 'unknown'].map((type) => ({ type, x: 1, z: 1 }));
    expect(() => s.hear(evs, 0, 0, 50)).not.toThrow();
    expect(() => s.ambient({ seaFraction: 0.3, treeFraction: 0.1, camDistance: 80, paused: false }, 0.016)).not.toThrow();
    expect(() => {
      audio.boom(); audio.orderAck('move'); audio.alertSound('attack'); audio.uiClick(); audio.uiHover();
      audio.setVolume(0.5); audio.setMuted(true);
    }).not.toThrow();
    expect(audio.getVolume()).toBe(0.5);
    expect(audio.isMuted()).toBe(true);
  });
});
