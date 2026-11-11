/**
 * Level format v2: migration of v1 documents and TG1 share codes, TG2
 * codes, and a full load → capture round trip of every v2 field.
 */
import { describe, expect, it } from 'vitest';
import { codeToLevel, LevelData, LevelDataV1, levelToCode, migrateLevel, packTerrain } from '../src/level/level-format';
import { OFFICIAL_LEVELS } from '../src/level/official-levels';
import { World } from '../src/sim/world-state';
import { Heightmap } from '../src/world/heightmap';

const SETTINGS = { playerCiv: 'forest', difficulty: 'normal' } as const;

async function v1Level(): Promise<LevelDataV1> {
  const map = new Heightmap();
  map.heights.fill(3);
  return {
    v: 1,
    name: 'Old Planet',
    author: 'someone',
    desc: 'from before',
    terrain: await packTerrain(map.heights),
    trees: [10, 10, 12, 14],
    monuments: [{ x: 30, z: 30, spell: 'lightning' }],
    homes: { player: { x: 20, z: 20 }, red: { x: 80, z: 80 } },
    wildmen: [40, 40],
    redCiv: 'dynasty',
  };
}

/** Encode a document the way the v1 game did (TG1. + deflate-raw + base64). */
async function legacyCode(level: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(level));
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return 'TG1.' + btoa(bin);
}

describe('level format v2', () => {
  it('migrates a v1 document', async () => {
    const m = migrateLevel(await v1Level());
    expect(m.v).toBe(2);
    expect(m.homes.player).toEqual({ x: 20, z: 20 });
    expect(m.homes.red).toEqual({ x: 80, z: 80 });
    expect(m.monuments[0]).toEqual({ x: 30, z: 30, spell: 'lightning', mode: 'teach' });
    expect(m.civs?.red).toBe('dynasty');
    expect(m.rules).toBeUndefined();
  });

  it('a TG1 share code still imports (migrated)', async () => {
    const code = await legacyCode(await v1Level());
    const lvl = await codeToLevel(code);
    expect(lvl.v).toBe(2);
    expect(lvl.name).toBe('Old Planet');
  });

  it('new codes are TG2 and round-trip', async () => {
    const lvl = migrateLevel(await v1Level());
    const code = await levelToCode(lvl);
    expect(code.startsWith('TG2.')).toBe(true);
    expect(await codeToLevel(code)).toEqual(lvl);
    await expect(codeToLevel('nonsense')).rejects.toThrow();
  });

  it('v1 official levels still load and play as skirmishes', async () => {
    for (const o of OFFICIAL_LEVELS) {
      const w = new World();
      await w.loadLevel(await o.build(), SETTINGS);
      expect(w.activeTribes()).toEqual(['player', 'red']);
      for (let i = 0; i < 60; i++) w.tick(1 / 15);
      expect(w.gameOver).toBeNull();
    }
  });

  it('loads every v2 field and captures it back unchanged', async () => {
    const map = new Heightmap();
    map.heights.fill(2.5);
    const level: LevelData = {
      v: 2,
      name: 'Four Hearths',
      author: 'test',
      desc: 'all of it',
      terrain: await packTerrain(map.heights),
      trees: [5, 5, 6, 9],
      monuments: [
        { x: 40, z: 40, spell: 'ward', mode: 'teach' },
        { x: 60, z: 40, spell: 'landbridge', mode: 'gift', charges: 2, cooldown: 200, opensAt: 30 },
      ],
      homes: { player: { x: 20, z: 20 }, red: { x: 100, z: 20 }, gold: { x: 20, z: 100 }, violet: { x: 100, z: 100 } },
      civs: { red: 'dynasty', gold: 'north' },
      wildmen: [64, 64],
      buildings: [
        { tribe: 'gold', kind: 'tower', x: 30, z: 100, garrison: { warrior: 2 } },
        { tribe: 'red', kind: 'hut', x: 108, z: 20 },
      ],
      units: [{ tribe: 'violet', kind: 'warrior', x: 90, z: 90, count: 3 }],
      rules: {
        tribes: [
          { id: 'player', ai: false, loadout: { spells: ['blast'], buildings: ['hut'] } },
          { id: 'red', ai: true, allies: ['gold'] },
          { id: 'gold', ai: true, allies: ['red'], personality: { passive: true } },
          { id: 'violet', ai: false, loadout: { startUnits: { shaman: 0, brave: 0 } } },
        ],
        objectives: [{ objective: { type: 'destroyTribe', tribe: 'red' }, text: 'Burn the red hearth' }],
        fail: [{ type: 'leaderDies' }],
        briefing: { title: 'Four', body: 'b', tips: ['t'] },
        events: [{ when: { type: 'time', at: 60 }, actions: [{ type: 'message', text: 'hi' }] }],
      },
    };
    const w = new World();
    await w.loadLevel(level, SETTINGS);
    expect(w.activeTribes()).toEqual(['player', 'red', 'gold', 'violet']);
    expect(w.tribes.gold!.home).toEqual({ x: 20, z: 100 });
    expect(w.tribes.red!.civ).toBe('dynasty');
    expect(w.rules.briefing.title).toBe('Four');
    expect(w.tribes.player!.known.has('lightning')).toBe(false);
    const tower = w.buildings.find((b) => b.kind === 'tower')!;
    expect(tower.tribe).toBe('gold');
    expect(tower.garrison.length).toBe(2);
    expect(w.units.filter((u) => u.tribe === 'violet' && u.kind === 'warrior').length).toBe(3);
    expect(w.monuments[1].opensAt).toBe(30);

    const back = await w.captureLevel({ name: level.name, author: level.author, desc: level.desc });
    expect(back.v).toBe(2);
    expect(back.homes).toEqual(level.homes);
    expect(back.rules).toEqual(level.rules);
    expect(back.monuments).toEqual(level.monuments);
    expect(back.units).toEqual(level.units);
    expect(back.buildings).toEqual(level.buildings);
    expect(back.civs?.red).toBe('dynasty');
    // And the capture loads again.
    const w2 = new World();
    await w2.loadLevel(back, SETTINGS);
    expect(w2.activeTribes()).toEqual(['player', 'red', 'gold', 'violet']);
  });

  it('a random-skirmish world captures without baking in skirmish rules', async () => {
    const w = new World();
    w.reset(5, { ...SETTINGS, enemies: 2 });
    const lvl = await w.captureLevel({ name: 'x', author: 'y', desc: '' });
    expect(lvl.rules).toBeUndefined();
    expect(Object.keys(lvl.homes).sort()).toEqual(['gold', 'player', 'red']);
  });
});
