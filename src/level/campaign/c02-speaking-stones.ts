/**
 * Chapter 2 — The Speaking Stones. First stones, first raiders.
 *
 * Teaches: leaders commune at standing stones to learn spells (Bloom on
 * this bank, Level across the river); a garrisoned Watchtower and Blast
 * hold off a raid. Tests: walking the leader out while the village is
 * under threat.
 *
 * The map: "Riverholm", a long island split by a cold river running from
 * the northern fells to the southern sea. The one ford sits mid-island.
 * The village is on the west bank by the old wood (and the Bloom stone);
 * the Level stone crowns a knoll on the east bank — the side the
 * Unmoored land on. Each raid comes over the ford.
 */

import { inside, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel, RAIDER_TRIBE } from './common';

export const LAYOUT = {
  home: { x: 36, z: 70 },
  bloom: { x: 24, z: 58 },
  level: { x: 92, z: 60 },
  ford: { x: 63, z: 64 },
  landing: { x: 106, z: 74 },
  river: [
    { x: 66, z: 30 },
    { x: 60, z: 52 },
    { x: 64, z: 64 },
    { x: 69, z: 80 },
    { x: 62, z: 104 },
  ],
};

const raid = (at: number, warriors: number, message: string) => ({
  when: { type: 'time' as const, at },
  message,
  actions: [{ type: 'spawn' as const, tribe: 'violet' as const, units: { warrior: warriors }, x: LAYOUT.landing.x, z: LAYOUT.landing.z, march: LAYOUT.ford }],
});

export const scenario: CampaignScenario = {
  id: 'c02_speaking_stones',
  chapter: 2,
  title: 'The Speaking Stones',
  tagline: 'Two stones that remember. And sails on the eastern sea.',
  teaches: 'Standing stones, towers, the first raid',
  async build() {
    const t = new Terrain(20202);
    const { home, bloom, level, ford, river } = LAYOUT;
    t.landFrom((x, z) => {
      const dx = (x - 64) / 50;
      const dz = (z - 66) / 31;
      return inside(Math.hypot(dx, dz) * 40 + t.wobble(x, z, 1) * 12, 40, 7);
    }, { base: 2.2, roll: 1.6 });
    // The northern fells the river runs out of.
    t.ridge([{ x: 30, z: 44 }, { x: 50, z: 36 }, { x: 78, z: 36 }, { x: 100, z: 46 }], 11, 9, 0.5);
    t.peak(level.x + 2, level.z - 2, 10, 3.2);
    t.smooth(1);
    t.channel(river, 6, -2.2, 2.5);
    t.road([{ x: ford.x - 8, z: ford.z - 1 }, { x: ford.x + 8, z: ford.z + 1 }], 5, 0.8);
    t.pad(home.x, home.z, 8, 2.4, 5);
    t.addGrove(bloom.x, bloom.z, 12, 0.8).addGrove(home.x + 8, home.z + 12, 8, 0.5).addGrove(84, 82, 10, 0.4);
    return makeLevel({
      name: 'The Speaking Stones',
      desc: 'Campaign II. A river island; two stones; raiders from the east.',
      terrain: t,
      homes: { player: home, violet: LAYOUT.landing },
      monuments: [
        { x: bloom.x, z: bloom.z, spell: 'bloom', mode: 'teach' },
        { x: level.x, z: level.z, spell: 'flatten', mode: 'teach' },
      ],
      wildmen: wanderers(t.map, 21, 86, 78, 10, 5).concat(wanderers(t.map, 22, 40, 86, 6, 2)),
      rules: {
        tribes: [
          {
            id: 'player', ai: false,
            loadout: { spells: ['blast', 'convert'], buildings: ['hut', 'lumberyard', 'tower'], startUnits: { brave: 7, warrior: 2 }, startWood: 12 },
          },
          { id: 'violet', ...RAIDER_TRIBE },
        ],
        objectives: [
          { objective: { type: 'claimMonument', index: 0 }, text: 'Learn Bloom at the west-bank stone' },
          { objective: { type: 'claimMonument', index: 1 }, text: 'Learn Level at the stone across the river' },
          { objective: { type: 'survive', seconds: 600 }, text: 'Weather the raids (10 minutes)' },
          { objective: { type: 'buildCount', kind: 'tower', count: 1 }, text: 'Raise a Watchtower by the ford', optional: true },
          { objective: { type: 'reachPopulation', count: 30 }, text: 'Grow the tribe to 30', optional: true },
        ],
        events: [
          raid(170, 2, 'Sails on the eastern beach — the Unmoored are coming for the ford.'),
          raid(340, 3, 'More Unmoored boats. They smell the smoke of your hearths.'),
          raid(510, 4, 'The largest boat yet. Hold the ford!'),
          { when: { type: 'time', at: 600 }, actions: [{ type: 'message', text: 'The raiders turn back to the sea. Riverholm is yours.' }] },
        ],
        briefing: {
          title: 'The Speaking Stones',
          body:
            'Riverholm has standing stones older than any tribe, and the old songs say a leader who sits with one comes away knowing a spell. ' +
            'One stands in the wood on our bank; the other crowns a knoll across the cold river. ' +
            'We are not the first boats to find this island. The Unmoored, whose isles drowned before ours, raid every shore that smokes — and the only crossing is the ford.',
          tips: [
            'Send your leader to a stone: she sits, she learns, and the spell joins your book for the rest of the scenario.',
            'Your two spear-bearers fight best from a Watchtower — order them inside, near the ford.',
            'Blast throws raiders clear; thrown into the river, they drown.',
          ],
        },
      },
    });
  },
};
