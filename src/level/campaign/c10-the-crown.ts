/**
 * Chapter 10 — The Crown. Three rivals, everything unlocked, last tribe standing.
 *
 * Tests: everything. Every building, the full everyday spell book, the
 * planet-breakers on stones around the ring — and three gods with three
 * temperaments: the Ashmark attack early and often, the Saltborn build
 * slowly toward Wardens, the Unmoored send Chanters. The Volcano stone is
 * on the Crown in the middle of the lagoon, reachable only by Causeway.
 *
 * The map: the last ring of land above the Long Tide — an atoll-like ring
 * island around a still lagoon, with the Crown, a steep islet, at its
 * heart. Four peoples sit on the ring a quarter-turn apart; low hills on
 * the diagonals split the ring into four marches with passes inside and
 * outside each hill.
 */

import { dist, inside, polar, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel } from './common';

const C = { x: 64, z: 64 };
const RING_R = 33;

export const LAYOUT = {
  centre: C,
  home: polar(C.x, C.z, RING_R, 90),
  red: polar(C.x, C.z, RING_R, 180),
  gold: polar(C.x, C.z, RING_R, 270),
  violet: polar(C.x, C.z, RING_R, 0),
  stones: {
    crown: C,
    // Beside each diagonal hill, on the outer pass.
    emberfall: polar(C.x, C.z, RING_R + 7, 135),
    cyclone: polar(C.x, C.z, RING_R + 7, 45),
    sink: polar(C.x, C.z, RING_R + 7, 225),
    earthquake: polar(C.x, C.z, RING_R + 7, 315),
  },
};

export const scenario: CampaignScenario = {
  id: 'c10_the_crown',
  chapter: 10,
  title: 'The Crown',
  tagline: 'The last ring of land above the tide. Four peoples. One will remain.',
  teaches: 'Everything: last tribe standing',
  async build() {
    const t = new Terrain(101010);
    const { home, red, gold, violet, stones } = LAYOUT;
    t.landFrom((x, z) => {
      const d = dist(x, z, C.x, C.z) + t.wobble(x, z, 1) * 9;
      const ring = inside(Math.abs(d - RING_R), 11, 5);
      const crown = inside(dist(x, z, C.x, C.z) + t.wobble(x, z, 2) * 2, 6, 3);
      return Math.max(ring, crown);
    }, { sea: -4, base: 2.3, roll: 1.4 });
    // Hills on the diagonals (with the stones beside them), passes inside and out.
    for (const a of [45, 135, 225, 315]) {
      const p = polar(C.x, C.z, RING_R, a);
      t.peak(p.x, p.z, 7, 8);
    }
    t.peak(C.x, C.z, 6, 6);
    t.smooth(1);
    t.pad(C.x, C.z, 2, 7.5, 2);
    for (const h of [home, red, gold, violet]) t.pad(h.x, h.z, 8, 2.5, 4);
    for (const p of [stones.emberfall, stones.cyclone, stones.sink, stones.earthquake]) t.pad(p.x, p.z, 2, 2.6, 3);
    for (const h of [home, red, gold, violet]) {
      const a = Math.atan2(h.z - C.z, h.x - C.x) * (180 / Math.PI);
      const g1 = polar(C.x, C.z, RING_R + 6, a + 14);
      const g2 = polar(C.x, C.z, RING_R - 6, a - 14);
      t.addGrove(g1.x, g1.z, 8, 0.7).addGrove(g2.x, g2.z, 7, 0.6);
    }
    const S = stones;
    return makeLevel({
      name: 'The Crown',
      desc: 'Campaign X. A ring of land around a lagoon, four tribes, the Volcano on the Crown.',
      terrain: t,
      homes: { player: home, red, gold, violet },
      civs: { red: 'north', gold: 'dynasty', violet: 'north' },
      monuments: [
        { x: S.crown.x, z: S.crown.z, spell: 'volcano', mode: 'teach' },
        { x: S.emberfall.x, z: S.emberfall.z, spell: 'emberfall', mode: 'gift', charges: 1, cooldown: 240 },
        { x: S.cyclone.x, z: S.cyclone.z, spell: 'cyclone', mode: 'teach' },
        { x: S.sink.x, z: S.sink.z, spell: 'sink', mode: 'gift', charges: 1, cooldown: 300 },
        { x: S.earthquake.x, z: S.earthquake.z, spell: 'earthquake', mode: 'teach' },
      ],
      wildmen: wanderers(t.map, 101, S.emberfall.x, S.emberfall.z, 6, 3)
        .concat(wanderers(t.map, 102, S.cyclone.x, S.cyclone.z, 6, 3))
        .concat(wanderers(t.map, 103, S.sink.x, S.sink.z, 6, 3))
        .concat(wanderers(t.map, 104, S.earthquake.x, S.earthquake.z, 6, 3)),
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: {
              spells: ['blast', 'convert', 'flatten', 'bloom', 'ward', 'lightning', 'warsong', 'swamp', 'landbridge'],
              startUnits: { brave: 10 },
              startWood: 14,
            },
          },
          {
            id: 'red', name: 'the Ashmark', ai: true,
            personality: { harassAt: 4, assaultAt: 9 },
            loadout: { spells: ['blast', 'convert', 'lightning', 'warsong'], startUnits: { brave: 9 } },
          },
          {
            id: 'gold', name: 'the Saltborn', ai: true,
            personality: { harassAt: 7, assaultAt: 15, prefer: ['warden', 'firewarrior', 'warrior'] },
            loadout: { spells: ['blast', 'convert', 'ward', 'swamp'], startUnits: { brave: 9 } },
          },
          {
            id: 'violet', name: 'the Unmoored', ai: true,
            personality: { harassAt: 5, assaultAt: 11, prefer: ['chanter', 'warrior'] },
            loadout: { spells: ['blast', 'convert', 'lightning', 'bloom'], startUnits: { brave: 9 } },
          },
        ],
        objectives: [
          { objective: { type: 'destroyAll' }, text: 'Be the last tribe standing' },
          { objective: { type: 'claimMonument', index: 0 }, text: 'Learn Volcano on the Crown', optional: true },
        ],
        briefing: {
          title: 'The Crown',
          body:
            'This is the last ring of land the Long Tide has not taken, and every people that survived it is here: the Ashmark to the west, the Saltborn to the north, the Unmoored to the east. ' +
            'In the still lagoon stands the Crown, and on it the stone of the mountain’s fire. Around the ring, the stones of quake and storm and undertow wait for whoever walks to them. ' +
            'Everything we have learned is ours to use. There will be no more shores after this one.',
          tips: [
            'The Ashmark will come early. Towers and Warriors first, ambition second.',
            'Only Causeway reaches the Crown. Volcano from the centre can reach any town on the ring.',
            'Three rivals fight each other too. Let them, when you can.',
          ],
        },
      },
    });
  },
};
