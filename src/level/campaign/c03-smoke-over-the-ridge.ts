/**
 * Chapter 3 — Smoke Over the Ridge. The first rival tribe.
 *
 * Teaches: War Lodges turn villagers into Warriors; an army takes a town.
 * Watchtowers hold a choke. Tests: building an economy and an army at
 * once against a god who is doing the same (a young, smaller tribe — the
 * first war should be winnable by a learner).
 *
 * The map: "Twofold", one island cut north–south by a spine of bare rock.
 * Two ways across: the high pass in the middle — where the Lightning
 * stone stands — and the long shore path round the southern tip. The
 * Ashmark hold the eastern valley; we land in the west.
 */

import { inside, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel } from './common';

export const LAYOUT = {
  home: { x: 30, z: 62 },
  red: { x: 98, z: 66 },
  pass: { x: 64, z: 58 },
  ward: { x: 22, z: 44 },
  shore: { x: 64, z: 96 },
};

export const scenario: CampaignScenario = {
  id: 'c03_smoke_over_the_ridge',
  chapter: 3,
  title: 'Smoke Over the Ridge',
  tagline: 'Someone else’s cookfires, just over the rock. The Ashmark.',
  teaches: 'War Lodge, warriors, holding a pass',
  async build() {
    const t = new Terrain(30303);
    const { home, red, pass, ward } = LAYOUT;
    t.landFrom((x, z) => {
      const dx = (x - 64) / 54;
      const dz = (z - 64) / 36;
      return inside(Math.hypot(dx, dz) * 40 + t.wobble(x, z, 1) * 10, 40, 7);
    }, { base: 2.3, roll: 1.7 });
    t.peak(44, 38, 9, 4).peak(86, 90, 9, 4);
    t.smooth(1);
    // The spine: impassable but for the pass and the southern shore.
    t.ridge([{ x: 66, z: 20 }, { x: 62, z: 40 }, { x: 65, z: 54 }], 9, 14, 0.3);
    t.ridge([{ x: 63, z: 63 }, { x: 61, z: 74 }, { x: 63, z: 84 }], 9, 14, 0.3);
    t.road([{ x: pass.x - 9, z: pass.z }, { x: pass.x + 9, z: pass.z + 1 }], 6, 4.2);
    t.pad(pass.x, pass.z, 3, 4.6, 3);
    t.pad(home.x, home.z, 8, 2.4, 5).pad(red.x, red.z, 8, 2.6, 5);
    t.addGrove(home.x - 6, home.z + 14, 10, 0.7).addGrove(red.x + 8, red.z - 14, 10, 0.7).addGrove(44, 86, 8, 0.4).addGrove(90, 40, 8, 0.4);
    return makeLevel({
      name: 'Smoke Over the Ridge',
      desc: 'Campaign III. One spine of rock, one pass, one rival.',
      terrain: t,
      homes: { player: home, red },
      civs: { red: 'north' },
      monuments: [
        { x: pass.x, z: pass.z, spell: 'lightning', mode: 'teach' },
        { x: ward.x, z: ward.z, spell: 'ward', mode: 'gift', charges: 2, cooldown: 240 },
      ],
      wildmen: wanderers(t.map, 31, 40, 84, 8, 4).concat(wanderers(t.map, 32, 88, 44, 8, 4)),
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: {
              spells: ['blast', 'convert', 'bloom', 'flatten'],
              buildings: ['hut', 'lumberyard', 'warriorHut', 'tower'],
              startUnits: { brave: 8 },
              startWood: 10,
            },
          },
          {
            id: 'red', name: 'the Ashmark', ai: true,
            personality: { passive: true, wakeAt: 480, harassAt: 4, assaultAt: 8, maxArmy: 8, maxDwellings: 4 },
            loadout: {
              spells: ['blast', 'convert'],
              buildings: ['hut', 'lumberyard', 'warriorHut'],
              startUnits: { brave: 4 },
              startWood: 0,
            },
          },
        ],
        objectives: [
          { objective: { type: 'destroyTribe', tribe: 'red' }, text: 'Drive the Ashmark from Twofold' },
          { objective: { type: 'claimMonument', index: 0 }, text: 'Learn Lightning at the stone in the pass', optional: true },
          { objective: { type: 'buildCount', kind: 'tower', count: 2 }, text: 'Raise 2 Watchtowers', optional: true },
        ],
        briefing: {
          title: 'Smoke Over the Ridge',
          body:
            'The far valley smokes in the mornings. The Ashmark came down from their burnt hills a season before us, and they do not share. ' +
            'Twofold is split by a spine of rock with a single high pass, and a stone in that pass that teaches the lightning. ' +
            'They are few yet — fewer than us — but that will not last. Build a War Lodge, raise spears, and take the valley before they fill it.',
          tips: [
            'A War Lodge turns villagers into Warriors. Queue a few, then rally them where you want them.',
            'The pass is the short road for both of you; a Watchtower beside it sees them coming.',
            'Keep enough villagers working — an army is only as big as the wood behind it.',
          ],
        },
      },
    });
  },
};
