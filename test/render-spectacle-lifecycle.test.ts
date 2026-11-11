import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EffectsRenderer } from '../src/render/effects';
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

function rig() {
  return { camera: new THREE.PerspectiveCamera(38, 1.6, 0.5, 900), shake() {} };
}

/** Run the renderer's frame loop for `seconds` alongside the sim. */
function frames(fx: EffectsRenderer, w: ReturnType<typeof flatWorld>, seconds: number): void {
  const cam = new THREE.Vector3(40, 0, 40);
  for (let t = 0; t < seconds; t += 1 / 15) {
    run(w, 1 / 15);
    fx.sync(w, cam, 1 / 15);
  }
}

describe('spell set pieces across a world change', () => {
  it('a volcano running when the world changes leaves no vent on the new world', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsRenderer(scene, rig() as never);
    const w = flatWorld();
    castSpell(w, 'volcano', 30, 30, 25, 25, 'player');
    frames(fx, w, 3);
    const spectacle = (fx as unknown as { spectacle: { vents: unknown[]; states: Map<unknown, unknown> } }).spectacle;
    expect(spectacle.states.size).toBe(1);
    // a different world: the old job is simply gone
    fx.reset();
    w.jobs = [];
    frames(fx, w, 1);
    expect(spectacle.vents.length).toBe(0);
    expect(spectacle.states.size).toBe(0);
  });

  it('a volcano that ends normally leaves its vent smoking', () => {
    const scene = new THREE.Scene();
    const fx = new EffectsRenderer(scene, rig() as never);
    const w = flatWorld();
    castSpell(w, 'volcano', 30, 30, 25, 25, 'player');
    frames(fx, w, 16);
    const spectacle = (fx as unknown as { spectacle: { vents: unknown[] } }).spectacle;
    expect(spectacle.vents.length).toBe(1);
  });
});
