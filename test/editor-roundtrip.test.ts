/**
 * The editor's Save: loading a level, stripping it to clay (as main.ts
 * editLevel does) and capturing it again must give back the same level —
 * no duplicated wanderers, no loadout start buildings baked in as extras.
 */
import { describe, expect, it } from 'vitest';
import type { LevelData } from '../src/level/level-format';
import { World } from '../src/sim/world-state';
import { levelOf, SETTINGS } from './campaign-helpers';

async function editAndSave(level: LevelData): Promise<LevelData> {
  const w = new World();
  await w.loadLevel(level, SETTINGS);
  w.units = w.units.filter((u) => u.kind === 'wildman'); // what the editor keeps
  return w.captureLevel({ name: level.name, author: level.author, desc: level.desc });
}

function census(l: LevelData) {
  const wild = l.wildmen.length / 2 + (l.units ?? []).filter((u) => u.tribe === 'wild').reduce((s, u) => s + (u.count ?? 1), 0);
  return { wild, buildings: (l.buildings ?? []).length, tribeUnits: (l.units ?? []).filter((u) => u.tribe !== 'wild').reduce((s, u) => s + (u.count ?? 1), 0) };
}

describe('editor round trip', () => {
  it('placed wanderers and loadout start buildings survive save → load → save unchanged', async () => {
    const level = await levelOf('c01_landfall');
    level.units = [...(level.units ?? []), { tribe: 'wild', kind: 'wildman', x: level.homes.player.x + 6, z: level.homes.player.z, count: 3 }];
    const rules = level.rules!;
    rules.tribes[0].loadout = { ...(rules.tribes[0].loadout ?? {}), startBuildings: ['hut', 'tower'] };
    const before = census(level);
    const once = await editAndSave(level);
    const twice = await editAndSave(once);
    expect(census(once)).toEqual(before);
    expect(census(twice)).toEqual(before);
    expect(twice.rules?.tribes[0].loadout?.startBuildings).toEqual(['hut', 'tower']);
  });

  it('the home tool adds a third and fourth tribe, and Save keeps them', async () => {
    const w = new World();
    w.reset(5, { ...SETTINGS, enemies: 1 });
    w.units = w.units.filter((u) => u.kind === 'wildman');
    w.setHome('gold', 30, 90);
    w.setHome('violet', 90, 30);
    const level = await w.captureLevel({ name: 'Four', author: 't', desc: '' });
    expect(level.rules?.tribes.map((t) => t.id).sort()).toEqual(['gold', 'player', 'red', 'violet']);
    expect(level.homes.gold).toEqual({ x: 30, z: 90 });
    const back = new World();
    await back.loadLevel(level, SETTINGS);
    expect(back.activeTribes()).toEqual(['player', 'red', 'gold', 'violet']);
    expect(back.tribes.violet!.ai).toBeTruthy();
    expect(back.removeTribe('violet')).toBe(true);
    expect(back.removeTribe('player')).toBe(false);
    expect((await back.captureLevel({ name: 'Three', author: 't', desc: '' })).rules?.tribes.length).toBe(3);
  });

  it('every campaign chapter round-trips without growing', async () => {
    for (const id of ['c02_speaking_stones', 'c05_vigil_at_the_caldera', 'c07_two_banners', 'c10_the_crown']) {
      const level = await levelOf(id);
      const once = await editAndSave(level);
      const twice = await editAndSave(once);
      expect(census(twice), id).toEqual(census(once));
      expect(census(once).buildings, id).toBe((level.buildings ?? []).length);
    }
  });
});
