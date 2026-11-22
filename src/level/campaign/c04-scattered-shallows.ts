/**
 * Chapter 4 — The Scattered Shallows. An island start; Causeway is a gift.
 *
 * Teaches: Causeway raises a road across water — but you don't know the
 * spell. A gift stone on your isle hands out two casts and then sleeps for
 * a long time. Two gaps stand between you and the Ashmark: every cast
 * matters (bridge in the wrong place and you wait). Also: the Ember Lodge.
 *
 * The map: three isles in a shallow sea. Ours in the west is small and
 * crowded with trees; the Holm in the middle holds a Stone Ward stone and
 * a band of wanderers; the Ashmark have the big eastern isle. A scatter
 * of skerries makes it look like a place, not a diagram — none of them
 * shortens a gap.
 */

import { dist, inside, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel } from './common';
import { tr } from '../../i18n';

export const LAYOUT = {
  home: { x: 22, z: 64 },
  causewayStone: { x: 30, z: 54 },
  holm: { x: 64, z: 62 },
  red: { x: 102, z: 64 },
  /** The intended bridges: shore to shore, each inside Causeway's reach. */
  bridges: [
    { from: { x: 37, z: 62 }, to: { x: 57, z: 62 } },
    { from: { x: 74, z: 62 }, to: { x: 90, z: 63 } },
  ],
};

const ISLES = [
  { x: 25, z: 64, r: 14 },
  { x: 64, z: 62, r: 11 },
  { x: 102, z: 64, r: 17 },
];
const SKERRIES = [
  { x: 46, z: 30, r: 3.5 }, { x: 84, z: 96, r: 4.5 }, { x: 60, z: 100, r: 3 },
  { x: 36, z: 94, r: 3 }, { x: 86, z: 28, r: 4 }, { x: 64, z: 22, r: 2.5 },
];

export const scenario: CampaignScenario = {
  id: 'c04_scattered_shallows',
  chapter: 4,
  title: tr('The Scattered Shallows'),
  tagline: tr('Three isles, two gaps, and a stone that lends two bridges.'),
  teaches: tr('Causeway by gift, Ember Lodge, spending scarce casts'),
  async build() {
    const t = new Terrain(40404);
    const { home, causewayStone, holm, red } = LAYOUT;
    t.landFrom((x, z) => {
      let m = 0;
      for (const i of ISLES) m = Math.max(m, inside(dist(x, z, i.x, i.z) + t.wobble(x, z, 1) * 5, i.r, 5));
      for (const s of SKERRIES) m = Math.max(m, inside(dist(x, z, s.x, s.z) + t.wobble(x, z, 2) * 2, s.r, 3));
      return m;
    }, { sea: -3.2, base: 2.2, roll: 1.4 });
    t.peak(red.x + 8, red.z + 9, 8, 4).peak(holm.x + 3, holm.z - 5, 5, 2.5).peak(home.x - 7, home.z - 6, 6, 3);
    t.smooth(1);
    t.pad(home.x, home.z, 6, 2.4, 4).pad(red.x, red.z, 8, 2.5, 5).pad(holm.x, holm.z, 3, 2.6, 4);
    t.addGrove(home.x - 2, home.z + 9, 7, 0.9).addGrove(red.x - 4, red.z - 11, 10, 0.7).addGrove(holm.x, holm.z + 6, 5, 0.5);
    return makeLevel({
      name: tr('The Scattered Shallows'),
      desc: tr('Campaign IV. Three isles. Causeway is a gift — two casts, then a long sleep.'),
      terrain: t,
      homes: { player: home, red },
      civs: { red: 'north' },
      monuments: [
        { x: causewayStone.x, z: causewayStone.z, spell: 'landbridge', mode: 'gift', charges: 2, cooldown: 240 },
        { x: holm.x, z: holm.z, spell: 'ward', mode: 'teach' },
      ],
      wildmen: wanderers(t.map, 41, holm.x, holm.z, 8, 6),
      treeDensity: 0.03,
      rules: {
        tribes: [
          {
            id: 'player', name: tr('the Lantern-folk'), ai: false,
            loadout: {
              spells: ['blast', 'convert', 'bloom', 'flatten'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower'],
              startUnits: { brave: 8 },
              startWood: 12,
            },
          },
          {
            id: 'red', name: tr('the Ashmark'), ai: true,
            personality: { passive: true, wakeAt: 540, harassAt: 6, assaultAt: 10, maxArmy: 10, maxDwellings: 6 },
            loadout: {
              spells: ['blast', 'convert', 'lightning'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut'],
            },
          },
        ],
        objectives: [
          { objective: { type: 'claimMonument', index: 1 }, text: tr('Learn Stone Ward on the Holm') },
          { objective: { type: 'destroyTribe', tribe: 'red' }, text: tr('Drive the Ashmark from the eastern isle') },
          { objective: { type: 'reachPopulation', count: 35 }, text: tr('Grow the tribe to 35'), optional: true },
        ],
        events: [
          { when: { type: 'time', at: 2 }, message: tr('The stone on our shore lends Causeway — two roads out of the sea. Kneel there, then bridge to the Holm.'), focus: LAYOUT.causewayStone, actions: [] },
          { when: { type: 'spellCast', spell: 'landbridge' }, message: tr('The sea gives way. One road left before the stone sleeps — spend it well.'), actions: [] },
        ],
        briefing: {
          title: tr('The Scattered Shallows'),
          body:
            tr('The Ashmark fled east over the water and took the biggest isle in the Shallows. We have the smallest. ') +
            tr('Between us lies the Holm, with a stone that teaches the ward, and open sea either side of it. ') +
            tr('On our own shore stands a stone that lends Causeway — two roads of raised land, and then it sleeps for seven minutes. Choose where each road goes.'),
          tips: [
            tr('Commune at the gift stone: you get two free Causeway casts, known spell or not.'),
            tr('Causeway runs from your leader to the mark, up to 22 tiles. Stand on the shore, aim at the far shore.'),
            tr('Emberthrowers from the Ember Lodge outrange Watchtowers. Bring them to a siege.'),
          ],
        },
      },
    });
  },
};
