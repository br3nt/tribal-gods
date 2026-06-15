/**
 * level/official-levels.ts — the levels that ship with the game.
 *
 * Official levels are RECIPES, not stored files: each one generates a
 * deterministic world (fixed seed → identical noise on every machine, see
 * core/noise.ts) and then applies hand-authored edits — carve a strait
 * here, put the volcano monument exactly there. The designer's intent is
 * readable as code, diffable in git, and weighs nothing.
 *
 * Everything chooses deterministically (no Math.random — settle sites are
 * found by scoring every tile and taking the best), so "The Strait" is the
 * same planet for every player. That's what makes a level a shared
 * experience instead of a dice roll.
 */

import { WORLD_SIZE } from '../config';
import { hash2 } from '../core/noise';
import { wrapDelta } from '../core/util';
import { Heightmap } from '../world/heightmap';
import { walkable } from '../sim/pathfinding';
import { SpellId } from '../sim/spells';
import { LevelData, packTerrain } from './level-format';

export interface OfficialLevel {
  id: string;
  build(): Promise<LevelData>;
}

const N = WORLD_SIZE;

/** Score a tile as a settle site: walkable openness + nearby trees. */
function siteScore(map: Heightmap, trees: number[], x: number, z: number): number {
  const h = map.heightAt(x, z);
  if (h < 1 || h > 7 || !walkable(map, x, z)) return -1;
  let open = 0;
  for (let dz = -4; dz <= 4; dz += 2) {
    for (let dx = -4; dx <= 4; dx += 2) {
      if (walkable(map, x + dx, z + dz)) open++;
    }
  }
  if (open < 20) return -1;
  let near = 0;
  for (let i = 0; i < trees.length; i += 2) {
    if (Math.hypot(wrapDelta(trees[i] - x, N), wrapDelta(trees[i + 1] - z, N)) < 14) near++;
  }
  return near < 3 ? -1 : open + near;
}

/** Deterministic tree scatter (same rule the skirmish generator uses). */
function scatterTrees(map: Heightmap, seed: number): number[] {
  const trees: number[] = [];
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const h = map.heightAt(x, z);
      if (h < 1.2 || h > 9 || !walkable(map, x, z)) continue;
      if (hash2(x, z, seed + 555) < 0.022) trees.push(x, z);
    }
  }
  return trees;
}

/** Best site overall, and best site at least `minSep` from the first. */
function findHomes(map: Heightmap, trees: number[], minSep: number) {
  let best = { x: N / 2, z: N / 2, s: -1 };
  for (let z = 0; z < N; z += 2) {
    for (let x = 0; x < N; x += 2) {
      const s = siteScore(map, trees, x, z);
      if (s > best.s) best = { x, z, s };
    }
  }
  let second = { x: (best.x + N / 2) % N, z: (best.z + N / 2) % N, s: -1 };
  for (let z = 0; z < N; z += 2) {
    for (let x = 0; x < N; x += 2) {
      const sep = Math.hypot(wrapDelta(x - best.x, N), wrapDelta(z - best.z, N));
      if (sep < minSep) continue;
      const s = siteScore(map, trees, x, z);
      if (s > second.s) second = { x, z, s };
    }
  }
  return { player: { x: best.x, z: best.z }, red: { x: second.x, z: second.z } };
}

/** Nearest walkable tile to a preferred spot (deterministic spiral). */
function placeNear(map: Heightmap, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 12; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (walkable(map, x + dx, z + dz)) return { x: map.wrap(x + dx), z: map.wrap(z + dz) };
      }
    }
  }
  return { x: map.wrap(x), z: map.wrap(z) };
}

/** Shared assembly: monuments near homes + at chosen spots, wildmen scattered. */
async function assemble(
  map: Heightmap,
  seed: number,
  meta: { name: string; desc: string },
  homes: { player: { x: number; z: number }; red: { x: number; z: number } },
  monuments: Array<{ x: number; z: number; spell: SpellId }>,
): Promise<LevelData> {
  const trees = scatterTrees(map, seed);
  const wildmen: number[] = [];
  for (let i = 0; i < 12; i++) {
    // Deterministic pseudo-random wildman spots from the seed.
    const x = Math.floor(hash2(i, 7, seed) * N);
    const z = Math.floor(hash2(i, 13, seed) * N);
    if (walkable(map, x, z)) wildmen.push(x, z);
  }
  return {
    v: 1,
    ...meta,
    author: 'Tribal Gods',
    terrain: await packTerrain(map.heights),
    trees,
    monuments: monuments.map((m) => ({ ...placeNear(map, m.x, m.z), spell: m.spell })),
    homes,
    wildmen,
  };
}

export const OFFICIAL_LEVELS: OfficialLevel[] = [
  {
    id: 'official_first_light',
    async build() {
      // A gentle start: one generous continent, every monument close to a
      // straight walk, the enemy a long march away.
      const map = new Heightmap();
      map.generate(1001);
      const homes = findHomes(map, scatterTrees(map, 1001), 50);
      return assemble(
        map,
        1001,
        { name: 'First Light', desc: 'A kind world to learn godhood on. The stones are near; the enemy is far.' },
        homes,
        [
          { x: homes.player.x + 10, z: homes.player.z + 6, spell: 'flatten' },
          { x: homes.player.x - 12, z: homes.player.z - 4, spell: 'lightning' },
          { x: homes.red.x + 10, z: homes.red.z - 6, spell: 'swamp' },
          { x: (homes.player.x + homes.red.x) >> 1, z: (homes.player.z + homes.red.z) >> 1, spell: 'landbridge' },
          { x: ((homes.player.x + homes.red.x) >> 1) + 14, z: ((homes.player.z + homes.red.z) >> 1) + 10, spell: 'earthquake' },
          { x: ((homes.player.x + homes.red.x) >> 1) - 14, z: ((homes.player.z + homes.red.z) >> 1) - 10, spell: 'volcano' },
        ],
      );
    },
  },
  {
    id: 'official_the_strait',
    async build() {
      // Two tribes, one ocean between them: a channel carved straight
      // through the world. Nobody marches anywhere until somebody learns
      // Landbridge — which sits on YOUR side. Use the head start.
      const map = new Heightmap();
      map.generate(2002);
      // The carve: a sine-wavy band of deep water across the whole planet.
      for (let x = 0; x < N; x++) {
        const center = N / 2 + Math.sin((x / N) * Math.PI * 4) * 6;
        for (let dz = -5; dz <= 5; dz++) {
          const z = map.wrap(Math.round(center + dz));
          const fade = 1 - Math.abs(dz) / 6; // soft shoulders, not a trench wall
          const i = z * N + x;
          map.heights[i] = Math.min(map.heights[i], -6 * fade);
        }
      }
      map.version++;
      const trees = scatterTrees(map, 2002);
      // Homes on opposite sides of the channel: best site in each half.
      const top = { x: 0, z: 0, s: -1 };
      const bottom = { x: 0, z: 0, s: -1 };
      for (let z = 0; z < N; z += 2) {
        for (let x = 0; x < N; x += 2) {
          const s = siteScore(map, trees, x, z);
          const side = z < N / 2 - 8 ? top : z > N / 2 + 8 ? bottom : null;
          if (side && s > side.s) Object.assign(side, { x, z, s });
        }
      }
      const homes = { player: { x: top.x, z: top.z }, red: { x: bottom.x, z: bottom.z } };
      return assemble(
        map,
        2002,
        { name: 'The Strait', desc: 'An ocean apart. Landbridge is on your shore — claim it before the water stops protecting you.' },
        homes,
        [
          { x: homes.player.x + 9, z: homes.player.z + 5, spell: 'landbridge' },
          { x: homes.player.x - 11, z: homes.player.z - 5, spell: 'flatten' },
          { x: homes.red.x + 9, z: homes.red.z + 5, spell: 'lightning' },
          { x: homes.red.x - 11, z: homes.red.z - 5, spell: 'swamp' },
          { x: homes.player.x + 30, z: N / 2 - 10, spell: 'earthquake' },
          { x: homes.red.x - 30, z: N / 2 + 10, spell: 'volcano' },
        ],
      );
    },
  },
  {
    id: 'official_crucible',
    async build() {
      // One small shared continent, the volcano monument dead center on a
      // rocky knoll. Both gods can see it from home. There is no plan B.
      const map = new Heightmap();
      map.generate(3003);
      // Pull the whole world up a little (more land, less moat) and raise
      // the central knoll where the prize sits.
      for (let i = 0; i < map.heights.length; i++) map.heights[i] += 1.2;
      map.raise(N / 2, N / 2, 7, 4);
      map.flatten(N / 2, N / 2, 3, 1);
      map.version++;
      const homes = findHomes(map, scatterTrees(map, 3003), 40);
      return assemble(
        map,
        3003,
        { name: 'The Crucible', desc: 'One continent, one volcano, two gods. It is exactly the standoff it looks like.' },
        homes,
        [
          { x: homes.player.x + 9, z: homes.player.z - 6, spell: 'flatten' },
          { x: homes.red.x - 9, z: homes.red.z + 6, spell: 'swamp' },
          { x: N / 2 + 16, z: N / 2 - 12, spell: 'lightning' },
          { x: N / 2 - 16, z: N / 2 + 12, spell: 'landbridge' },
          { x: N / 2 + 4, z: N / 2 + 16, spell: 'earthquake' },
          { x: N / 2, z: N / 2, spell: 'volcano' }, // the whole point of the map
        ],
      );
    },
  },
];
