/**
 * Chapter 9 — When the Tide Came. The world is sinking; hold the high ground.
 *
 * Teaches/tests: moving a whole tribe under pressure. The sea takes the
 * lowlands a piece at a time (scripted Undertow strikes on a schedule —
 * the village lands on the first fields to go), while the Saltborn, who
 * have learned Undertow and charge it cheaply, push from their own hill.
 * Win by holding the summit of the Last Hill, uncontested, for two and a
 * half minutes. Level and Ward make the terraces liveable.
 *
 * The map: a broad low island with one stepped mountain in the middle —
 * three terraces and a crown — and the Saltborn's hill in the east. The
 * lowland skirt is all good farmland. None of it will last.
 */

import { dist, inside, polar, Terrain, wanderers } from '../terrain-kit';
import type { ScenarioEvent } from '../../sim/catalog';
import { CampaignScenario, makeLevel } from './common';

export const LAYOUT = {
  home: { x: 28, z: 74 },
  gold: { x: 104, z: 58 },
  summit: { x: 62, z: 62 },
  ward: { x: 52, z: 46 },
};

/** Where and when the sea comes in: lowland first, then nearer the hill. */
export const TIDE: Array<{ at: number; x: number; z: number; say?: string }> = [
  { at: 150, ...polar(62, 62, 44, 160), say: 'The sea takes the western fields.' },
  { at: 200, ...polar(62, 62, 42, 230) },
  { at: 250, ...polar(62, 62, 44, 110) },
  { at: 300, ...polar(62, 62, 40, 190), say: 'The water is at the edge of the village.' },
  { at: 350, ...polar(62, 62, 44, 280) },
  { at: 400, ...polar(62, 62, 42, 60) },
  { at: 450, x: 28, z: 74, say: 'The old village is going under.' },
  { at: 500, ...polar(62, 62, 34, 140) },
  { at: 560, ...polar(62, 62, 33, 210) },
  { at: 620, ...polar(62, 62, 35, 320) },
  { at: 680, ...polar(62, 62, 32, 90) },
  { at: 740, ...polar(62, 62, 34, 250), say: 'Only the hills are left.' },
  { at: 820, ...polar(62, 62, 30, 175) },
  { at: 900, ...polar(62, 62, 30, 40) },
];

export const scenario: CampaignScenario = {
  id: 'c09_when_the_tide_came',
  chapter: 9,
  title: 'When the Tide Came',
  tagline: 'The sea is taking the island. Climb, and hold the top.',
  teaches: 'Relocating under pressure, holding a point',
  async build() {
    const t = new Terrain(90909);
    const { home, gold, summit, ward } = LAYOUT;
    t.landFrom((x, z) => inside(dist(x, z, 62, 64) + t.wobble(x, z, 1) * 12, 50, 8), { base: 1.7, roll: 0.7 });
    // The Last Hill: three terraces and a crown, each step a short steep bank.
    t.mesa(summit.x, summit.z, 22, 4.2, 3).mesa(summit.x + 1, summit.z - 1, 14, 7.2, 2.5).mesa(summit.x, summit.z, 6, 10, 2.5);
    // Cliffs on the north face: the hill is climbed from the south and west.
    t.ridge([{ x: 46, z: 46 }, { x: 62, z: 40 }, { x: 80, z: 48 }], 5, 13, 0.3);
    // The Saltborn's hill.
    t.mesa(gold.x, gold.z, 12, 4.6, 4).peak(gold.x + 8, gold.z - 8, 7, 3);
    t.smooth(1);
    t.pad(home.x, home.z, 8, 1.8, 5).pad(gold.x, gold.z, 7, 4.6, 3);
    t.addGrove(home.x - 4, home.z + 14, 10, 0.6).addGrove(summit.x - 12, summit.z + 10, 8, 0.6).addGrove(gold.x, gold.z + 14, 9, 0.6).addGrove(80, 86, 10, 0.5);
    const tide: ScenarioEvent[] = TIDE.map((p) => ({
      when: { type: 'time', at: p.at },
      ...(p.say ? { message: p.say } : {}),
      actions: [{ type: 'strike', spell: 'sink', x: p.x, z: p.z, tribe: 'gold' }],
    }));
    return makeLevel({
      name: 'When the Tide Came',
      desc: 'Campaign IX. The sea takes the lowlands. Hold the summit of the Last Hill.',
      terrain: t,
      homes: { player: home, gold },
      civs: { gold: 'dynasty' },
      monuments: [{ x: ward.x, z: ward.z, spell: 'ward', mode: 'gift', charges: 2, cooldown: 150 }],
      wildmen: wanderers(t.map, 91, 40, 92, 10, 4).concat(wanderers(t.map, 92, 82, 34, 8, 3)),
      rules: {
        tribes: [
          {
            id: 'player', ai: false,
            loadout: {
              spells: ['blast', 'convert', 'flatten', 'bloom', 'lightning'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower', 'shrine'],
              startUnits: { brave: 10, warrior: 2 },
              startWood: 16,
            },
          },
          {
            id: 'gold', ai: true,
            personality: { target: 'player', harassAt: 4, assaultAt: 9 },
            loadout: {
              spells: ['blast', 'convert', 'sink', 'lightning'],
              chargeCost: { sink: 0.6 },
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower', 'shrine'],
              startUnits: { brave: 9, warrior: 2 },
            },
          },
        ],
        objectives: [
          { objective: { type: 'holdPoint', x: summit.x, z: summit.z, radius: 6, seconds: 150 }, text: 'Hold the crown of the Last Hill (2½ minutes, uncontested)' },
          { objective: { type: 'destroyTribe', tribe: 'gold' }, text: 'Drive the Saltborn into the sea', optional: true },
        ],
        fail: [{ type: 'timeLimit', seconds: 1500 }],
        events: tide,
        briefing: {
          title: 'When the Tide Came',
          body:
            'It has come. The sea is rising over the island in a slow, grinding swallow, field by field, and our village sits on the first fields it wants. ' +
            'The Saltborn learned the tide’s own song — Undertow — and they will use it on whatever we build. ' +
            'In the middle of the island stands the Last Hill. Whoever holds its crown when the water stops holds the island.',
          tips: [
            'Do not wait for the water. Start building on the terraces early — Level makes room on the slopes.',
            'Holding the crown needs your people on it and no enemy in the circle, for two and a half minutes straight.',
            'A Watchtower on the top terrace covers the crown.',
          ],
        },
      },
    });
  },
};
