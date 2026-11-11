/**
 * Chapter 1 — Landfall. Settle and grow; nobody else is here.
 *
 * Teaches: dwellings breed villagers, villagers chop wood, wood raises
 * dwellings; Kindle turns wanderers into villagers. No rival, no stones —
 * one quiet island to learn the loop on.
 *
 * The map: "the Hook", a crescent island curled around a sheltered bay
 * where the boats came in. The village lands on the inner shore of the
 * southern arm; the long northern horn is wooded and full of wanderers
 * (the reason to walk your leader somewhere). A rocky spine runs along
 * the outer curve; a lone islet sits in the bay.
 */

import { dist, inside, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel } from './common';

export const LAYOUT = {
  home: { x: 54, z: 86 },
  /** Where the wanderers roam: the far horn. */
  horn: { x: 74, z: 28 },
  bay: { x: 80, z: 56 },
};

export const scenario: CampaignScenario = {
  id: 'c01_landfall',
  chapter: 1,
  title: 'Landfall',
  tagline: 'The boats are ashore. Make this hook of land a home.',
  teaches: 'Dwellings, wood, growth',
  async build() {
    const t = new Terrain(10101);
    const { home, horn, bay } = LAYOUT;
    // Crescent: a big disc minus the bay, with wobbling coasts.
    t.landFrom((x, z) => {
      const outer = inside(dist(x, z, 64, 62) + t.wobble(x, z, 1) * 16, 42, 8);
      const cut = inside(dist(x, z, bay.x, bay.z) + t.wobble(x, z, 2) * 9, 23, 7);
      const islet = inside(dist(x, z, 88, 54), 4, 3);
      return Math.max(outer * (1 - cut), islet);
    }, { base: 2.4, roll: 1.8 });
    // The spine along the outer curve, highest in the west.
    t.ridge([{ x: 44, z: 92 }, { x: 30, z: 72 }, { x: 28, z: 52 }, { x: 40, z: 32 }, { x: 58, z: 24 }], 9, 7.5, 0.6);
    t.peak(30, 58, 8, 3);
    t.smooth(1);
    t.pad(home.x, home.z, 8, 2.6, 5);
    t.addGrove(home.x - 12, home.z - 6, 9, 0.7).addGrove(home.x + 10, home.z + 6, 7, 0.5).addGrove(horn.x, horn.z, 14, 0.5);
    return makeLevel({
      name: 'Landfall',
      desc: 'Campaign I. A crescent island and a sheltered bay. Grow.',
      terrain: t,
      homes: { player: home },
      wildmen: wanderers(t.map, 11, horn.x, horn.z, 14, 8).concat(wanderers(t.map, 12, 40, 66, 8, 3)),
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: { spells: ['convert'], buildings: ['hut', 'lumberyard'], startUnits: { brave: 6 }, startWood: 10 },
          },
        ],
        objectives: [
          { objective: { type: 'buildCount', kind: 'hut', count: 6 }, text: 'Raise 6 Dwellings' },
          { objective: { type: 'reachPopulation', count: 40 }, text: 'Grow the tribe to 40' },
          { objective: { type: 'buildCount', kind: 'lumberyard', count: 1 }, text: 'Build a Lumberyard', optional: true },
          { objective: { type: 'reachPopulation', count: 60 }, text: 'Grow the tribe to 60', optional: true },
        ],
        briefing: {
          title: 'Landfall',
          body:
            'The Long Tide took the old shore, and the boats carried what was left of the Lantern-folk here: a hook of land around a quiet bay. ' +
            'Nobody else has claimed it. The wood is good, the ground is soft, and the people are tired of the sea. ' +
            'Give them roofs and children, and make a home before the tide finds this place too.',
          tips: [
            'Villagers fell trees and raise buildings on their own — you choose where the Dwellings go.',
            'A full Dwelling breeds; a Dwelling full for long enough grows bigger. More roofs, more people.',
            'Walk your leader to the wanderers on the northern horn and Kindle them into the tribe.',
          ],
        },
      },
    });
  },
};
