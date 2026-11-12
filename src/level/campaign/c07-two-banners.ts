/**
 * Chapter 7 — Two Banners. Two rivals, allied against you.
 *
 * Teaches: Chanters (Shrine → Chant Hall) as the answer to being
 * outnumbered — they stop enemy fighters and, given time, turn them. Tests:
 * fighting on two fronts across a river delta, where fords are the only
 * roads. Twist: the alliance is not forever — after fifteen minutes the
 * Saltborn tire of the Ashmark's war and the two turn on each other.
 *
 * The map: "the Fan", a great river delta. We hold the upland at the
 * delta's head; the river runs out of the hills behind us and splits in
 * two. The Ashmark hold the western lobe, the Saltborn the eastern, and
 * the wedge of fen between the branches holds the Warsong stone. Fords
 * cross each branch, and one crosses the trunk below our village.
 */

import { inside, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel } from './common';

export const LAYOUT = {
  home: { x: 64, z: 24 },
  red: { x: 26, z: 82 },
  gold: { x: 102, z: 82 },
  split: { x: 64, z: 54 },
  wedge: { x: 64, z: 88 },
  mire: { x: 46, z: 20 },
  trunk: [{ x: 64, z: 38 }, { x: 64, z: 54 }],
  west: [{ x: 64, z: 54 }, { x: 50, z: 72 }, { x: 46, z: 92 }, { x: 44, z: 116 }],
  east: [{ x: 64, z: 54 }, { x: 78, z: 72 }, { x: 82, z: 92 }, { x: 84, z: 116 }],
  fords: [
    [{ x: 56, z: 46 }, { x: 72, z: 46 }],
    [{ x: 40, z: 80 }, { x: 56, z: 84 }],
    [{ x: 72, z: 84 }, { x: 88, z: 80 }],
  ],
};

export const scenario: CampaignScenario = {
  id: 'c07_two_banners',
  chapter: 7,
  title: 'Two Banners',
  tagline: 'The Ashmark and the Saltborn march together now.',
  teaches: 'Chanters, two fronts, fords',
  async build() {
    const t = new Terrain(70707);
    const { home, red, gold, trunk, west, east, fords, wedge, mire } = LAYOUT;
    t.landFrom((x, z) => {
      const upland = inside(Math.hypot((x - 64) / 54, (z - 34) / 24) * 40 + t.wobble(x, z, 1) * 8, 40, 7);
      const delta = inside(Math.hypot((x - 64) / 58, (z - 82) / 30) * 40 + t.wobble(x, z, 2) * 9, 40, 7);
      return Math.max(upland, delta);
    }, { base: 2.0, roll: 1.2 });
    // Hills behind the village where the river is born.
    t.ridge([{ x: 30, z: 16 }, { x: 52, z: 10 }, { x: 78, z: 10 }, { x: 98, z: 18 }], 10, 7, 0.5);
    t.peak(64, 36, 6, 2);
    t.smooth(1);
    t.channel(trunk, 7, -2.6).channel(west, 6, -2.6).channel(east, 6, -2.6);
    for (const f of fords) t.road(f, 5, 0.8);
    t.pad(home.x, home.z, 8, 2.8, 5).pad(red.x, red.z, 8, 2.2, 5).pad(gold.x, gold.z, 8, 2.2, 5).pad(wedge.x, wedge.z, 3, 2, 3);
    t.addGrove(home.x + 16, home.z + 4, 9, 0.7).addGrove(home.x - 16, home.z + 6, 9, 0.6)
      .addGrove(red.x + 4, red.z + 14, 10, 0.6).addGrove(gold.x - 4, gold.z + 14, 10, 0.6).addGrove(wedge.x, wedge.z + 8, 6, 0.5);
    return makeLevel({
      name: 'Two Banners',
      desc: 'Campaign VII. A river delta, two allied rivals, and Chanters.',
      terrain: t,
      homes: { player: home, red, gold },
      civs: { red: 'north', gold: 'dynasty' },
      monuments: [
        { x: wedge.x, z: wedge.z, spell: 'warsong', mode: 'teach' },
        { x: mire.x, z: mire.z, spell: 'swamp', mode: 'gift', charges: 2, cooldown: 200 },
      ],
      wildmen: wanderers(t.map, 71, wedge.x, wedge.z, 8, 6).concat(wanderers(t.map, 72, 78, 30, 3, 4)),
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: {
              spells: ['blast', 'convert', 'bloom', 'flatten', 'lightning'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower', 'shrine', 'chantHall'],
              startUnits: { brave: 9 },
              startWood: 14,
            },
          },
          {
            id: 'red', name: 'the Ashmark', ai: true, allies: ['gold'],
            personality: { target: 'player', harassAt: 5, assaultAt: 10 },
            loadout: {
              spells: ['blast', 'convert', 'lightning'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower'],
              startUnits: { brave: 7 },
            },
          },
          {
            id: 'gold', name: 'the Saltborn', ai: true, allies: ['red'],
            personality: { target: 'player', assaultAt: 12, prefer: ['firewarrior', 'warrior'] },
            loadout: {
              spells: ['blast', 'convert', 'ward'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower', 'shrine'],
              startUnits: { brave: 7 },
            },
          },
        ],
        objectives: [
          { objective: { type: 'destroyAll' }, text: 'Bring down both banners' },
          { objective: { type: 'buildCount', kind: 'chantHall', count: 1 }, text: 'Raise a Chant Hall', optional: true },
          { objective: { type: 'claimMonument', index: 0 }, text: 'Learn Warsong in the fen', optional: true },
          { objective: { type: 'castSpell', spell: 'swamp' }, text: 'Mire a ford under an army', optional: true },
        ],
        events: [
          { when: { type: 'time', at: 2 }, message: 'Wanderers on the slope east of the village. Kindle them, then fetch the Mire from the western stone — the fords are where they must cross.', focus: { x: 78, z: 30 }, actions: [] },
          {
            when: { type: 'time', at: 900 },
            message: 'The Saltborn have had enough of the Ashmark’s war. The alliance is broken — they fight each other now.',
            actions: [{ type: 'allies', tribe: 'gold', allies: [] }],
          },
        ],
        briefing: {
          title: 'Two Banners',
          body:
            'The Ashmark we drove from Twofold have found friends: the Saltborn, patient traders of the delta, who fear us more than they like them. ' +
            'Their banners fly over both lobes of the Fan, and both armies will come for the delta head where we live. ' +
            'We cannot out-breed two tribes. But a Chant can stop a spear mid-swing, and a long Chant turns the spear around.',
          tips: [
            'A Chant Hall needs a Shrine first. Chanters stop enemy fighters in earshot and, given time, bring them over.',
            'Keep Chanters behind Warriors: they are unarmed, and another tribe’s Chanter breaks the spell.',
            'Allies of convenience fall out. Hold on, and the banners may turn on each other.',
          ],
        },
      },
    });
  },
};
