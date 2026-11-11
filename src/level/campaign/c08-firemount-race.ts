/**
 * Chapter 8 — The Firemount Race. Be first to the stone, against a clock.
 *
 * Teaches/tests: timing and positioning. The Volcano stone on the summit
 * of the Firemount sleeps until the fourth minute; whoever communes first
 * learns Volcano for good — and if the Ashmark get it, it's over. Their
 * town is closer. The summit is held by the mountain's Keepers (the
 * Unmoored who made it a shrine), who fight anyone who climbs. Then the
 * clock: the Ashmark must fall within thirty minutes.
 *
 * The map: twin continents joined by one narrow isthmus, with the
 * Firemount — a broad cone with a flat crown — standing on it. Our land is
 * the western one, larger and further; theirs is the eastern. A mere lies
 * across our road to the mountain; Causeway is known, and a bridge over it
 * cuts the walk.
 */

import { dist, inside, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel } from './common';

export const OPENS_AT = 240;

export const LAYOUT = {
  home: { x: 18, z: 70 },
  red: { x: 104, z: 60 },
  summit: { x: 66, z: 62 },
  bay: { x: 40, z: 66 },
  lightning: { x: 22, z: 44 },
  swamp: { x: 108, z: 80 },
};

export const scenario: CampaignScenario = {
  id: 'c08_firemount_race',
  chapter: 8,
  title: 'The Firemount Race',
  tagline: 'The mountain’s stone wakes in the fourth minute. Be there.',
  teaches: 'Timing, contested stones, a deadline',
  async build() {
    const t = new Terrain(80808);
    const { home, red, summit, bay } = LAYOUT;
    t.landFrom((x, z) => {
      const westL = inside(Math.hypot((x - 26) / 24, (z - 64) / 42) * 30 + t.wobble(x, z, 1) * 7, 30, 6);
      const eastL = inside(Math.hypot((x - 102) / 22, (z - 62) / 36) * 30 + t.wobble(x, z, 2) * 7, 30, 6);
      const isthmus = inside(Math.abs(z - 62 - Math.sin(x / 6) * 2) + t.wobble(x, z, 3) * 2, 7, 4) * inside(Math.abs(x - 64), 20, 4);
      const cut = inside(dist(x, z, bay.x, bay.z) + t.wobble(x, z, 4) * 4, 8, 4);
      return Math.max(westL, eastL, isthmus) * (1 - cut);
    }, { base: 2.2, roll: 1.4 });
    // The Firemount: a broad cone with a crown flat enough to stand on.
    t.peak(summit.x, summit.z, 15, 11);
    t.smooth(1);
    t.pad(summit.x, summit.z, 3, 9.6, 3);
    t.ridge([{ x: 6, z: 36 }, { x: 14, z: 26 }, { x: 28, z: 24 }], 7, 6, 0.4).ridge([{ x: 114, z: 36 }, { x: 120, z: 50 }], 6, 6, 0.4);
    t.pad(home.x, home.z, 8, 2.4, 5).pad(red.x, red.z, 8, 2.6, 5);
    t.addGrove(home.x + 4, home.z + 16, 10, 0.7).addGrove(home.x + 12, home.z - 6, 8, 0.5).addGrove(red.x - 6, red.z + 16, 10, 0.7);
    return makeLevel({
      name: 'The Firemount Race',
      desc: 'Campaign VIII. Twin continents, one mountain, one stone that wakes at minute four.',
      terrain: t,
      homes: { player: home, red, violet: summit },
      civs: { red: 'north' },
      monuments: [
        { x: summit.x, z: summit.z, spell: 'volcano', mode: 'teach', opensAt: OPENS_AT },
        { x: LAYOUT.lightning.x, z: LAYOUT.lightning.z, spell: 'lightning', mode: 'teach' },
        { x: LAYOUT.swamp.x, z: LAYOUT.swamp.z, spell: 'swamp', mode: 'teach' },
      ],
      units: [
        { tribe: 'violet', kind: 'warrior', x: summit.x - 3, z: summit.z + 2, count: 3 },
        { tribe: 'violet', kind: 'warrior', x: summit.x + 3, z: summit.z - 2, count: 2 },
      ],
      wildmen: wanderers(t.map, 81, 30, 92, 8, 4).concat(wanderers(t.map, 82, 96, 40, 8, 3)),
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: {
              spells: ['blast', 'convert', 'flatten', 'bloom', 'ward', 'landbridge'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower', 'shrine'],
              startUnits: { brave: 8, warrior: 2 },
              startWood: 12,
            },
          },
          {
            id: 'red', name: 'the Ashmark', ai: true,
            personality: { target: 'player', harassAt: 5, assaultAt: 11 },
            loadout: {
              spells: ['blast', 'convert', 'ward'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'fireHut', 'tower', 'shrine'],
              startUnits: { brave: 8, warrior: 2 },
            },
          },
          { id: 'violet', name: 'the Keepers', ai: false, loadout: { spells: [], buildings: [], startUnits: { shaman: 0, brave: 0 } } },
        ],
        objectives: [
          { objective: { type: 'claimMonument', index: 0 }, text: 'Be first to commune at the Firemount' },
          { objective: { type: 'destroyTribe', tribe: 'red' }, text: 'Break the Ashmark before the half-hour' },
          { objective: { type: 'destroyTribe', tribe: 'violet' }, text: 'Clear the Keepers from the mountain', optional: true },
        ],
        fail: [{ type: 'monumentTaken', index: 0 }, { type: 'timeLimit', seconds: 1800 }],
        events: [
          { when: { type: 'time', at: OPENS_AT - 30 }, actions: [{ type: 'message', text: 'The Firemount rumbles. Its stone wakes in thirty heartbeats.' }] },
          { when: { type: 'time', at: OPENS_AT }, actions: [{ type: 'message', text: 'The Firemount stone is awake.' }] },
        ],
        briefing: {
          title: 'The Firemount Race',
          body:
            'Between the twin lands stands the Firemount, and on its crown a stone that teaches the mountain’s own fire. It sleeps until the fourth minute. ' +
            'The Ashmark are closer to it than we are. If their leader sits with that stone first, we will not survive what she learns. ' +
            'The Keepers guard the crown and fight anyone who climbs, and the tide gives us half an hour to finish the Ashmark after.',
          tips: [
            'Get your leader — and spears — to the foot of the mountain before the stone wakes.',
            'Causeway across the mere shortens the walk. It is already in your book.',
            'With Volcano learned, a single charge can unmake a town. It takes a long time to charge: start early.',
          ],
        },
      },
    });
  },
};
