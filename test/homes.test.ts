/**
 * Every random skirmish planet gives every tribe room to build around its
 * home: a planet where the home has nowhere to put a dwelling or a hall is a
 * game bug, not bad luck. (300 seeds were checked by hand when this was
 * written; this samples 40 so the suite stays quick.)
 */
import { expect, it } from 'vitest';
import { World } from '../src/sim/world-state';

it('every tribe on 40 random planets has room for dwellings and 5x5 halls near home', () => {
  const bad: string[] = [];
  for (let i = 1; i <= 40; i++) {
    const seed = i * 7919;
    const w = new World();
    w.reset(seed, { playerCiv: 'forest', difficulty: 'normal' });
    for (const id of w.activeTribes()) {
      const h = w.tribes[id]!.home;
      let small = 0;
      let large = 0;
      for (let dz = -24; dz <= 24; dz += 2) {
        for (let dx = -24; dx <= 24; dx += 2) {
          if (w.siteFree('hut', h.x + dx, h.z + dz)) small++;
          if (w.siteFree('shrine', h.x + dx, h.z + dz)) large++;
        }
      }
      if (small < 12 || large < 4) bad.push(`seed ${seed} ${id}: ${small} dwelling sites, ${large} hall sites`);
    }
  }
  expect(bad).toEqual([]);
}, 120_000);
