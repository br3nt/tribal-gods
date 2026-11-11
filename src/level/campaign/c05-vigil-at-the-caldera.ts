/**
 * Chapter 5 — Vigil at the Caldera. Defend a shrine while a spell charges.
 *
 * Teaches: the charge model as a plan. Volcano is known but here it costs
 * eight times its usual mana — the ritual is the objective. Villagers
 * praying in the Shrine speed every charging spell; switching Blast and
 * Ward off pours everything into the ritual. But praying hands don't
 * fight, and the Unmoored come in waves through the three breaches in the
 * crater wall. Lose the Shrine and the vigil fails.
 *
 * The map: an old volcano's caldera — a lush round basin walled by steep
 * rock, open to the outside only through three breaches (north, south-
 * east, south-west). Raiders land on the outer shore and come through
 * them. Towers in the breaches are the whole game.
 */

import { arc, dist, inside, polar, Terrain, wanderers } from '../terrain-kit';
import type { Pt } from '../terrain-kit';
import type { ScenarioEvent, UnitKind } from '../../sim/catalog';
import { CampaignScenario, makeLevel, RAIDER_TRIBE } from './common';

const C = { x: 64, z: 64 };
const RIM_R = 23;
/** Breach angles (degrees; 90 = south). */
const BREACHES = [270, 30, 150];

export const LAYOUT = {
  centre: C,
  home: { x: 64, z: 72 },
  shrine: { x: 64, z: 61 },
  rimRadius: RIM_R,
  breaches: BREACHES.map((a) => polar(C.x, C.z, RIM_R, a)),
  landings: BREACHES.map((a) => polar(C.x, C.z, 39, a)),
};

function wave(at: number, breach: number, units: Partial<Record<UnitKind, number>>, message?: string, repeat?: ScenarioEvent['repeat']): ScenarioEvent {
  const p = LAYOUT.landings[breach];
  return {
    when: { type: 'time', at },
    ...(message ? { message } : {}),
    ...(repeat ? { repeat } : {}),
    actions: [{ type: 'spawn', tribe: 'violet', units, x: p.x, z: p.z, march: LAYOUT.breaches[breach] }],
  };
}

export const scenario: CampaignScenario = {
  id: 'c05_vigil_at_the_caldera',
  chapter: 5,
  title: 'Vigil at the Caldera',
  tagline: 'Keep the shrine standing until the mountain wakes.',
  teaches: 'Charging a great spell, the Shrine, defending breaches',
  async build() {
    const t = new Terrain(50505);
    const { home, shrine } = LAYOUT;
    t.landFrom((x, z) => inside(dist(x, z, C.x, C.z) + t.wobble(x, z, 1) * 9, 46, 8), { base: 2.0, roll: 1.4 });
    // Outer flanks: a gentle apron so the wall reads as a mountain from outside.
    t.apply((x, z, h) => {
      const d = dist(x, z, C.x, C.z);
      const apron = inside(Math.abs(d - RIM_R - 4), 6, 6) * 3;
      return h > 0 ? h + apron : h;
    });
    t.smooth(1);
    // The crater wall, in three arcs with the breaches between them.
    const gap = 9; // degrees either side of a breach
    const sorted = [...BREACHES].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      const a0 = sorted[i] + gap;
      const a1 = (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360) - gap;
      t.ridge(arc(C.x, C.z, RIM_R, a0, a1, 6), 6.5, 13, 0.35);
    }
    // The basin floor, and the breach floors.
    t.apply((x, z, h) => {
      const k = inside(dist(x, z, C.x, C.z), RIM_R - 7, 5);
      return k > 0 ? h * (1 - k) + (2.6 + t.wobble(x, z, 4) * 0.4) * k : h;
    });
    for (const a of BREACHES) {
      const inner: Pt = polar(C.x, C.z, RIM_R - 7, a);
      const outer: Pt = polar(C.x, C.z, RIM_R + 8, a);
      t.road([inner, outer], 6, 2.8);
    }
    t.pad(home.x, home.z, 5, 2.6, 3).pad(shrine.x, shrine.z, 4, 2.6, 3);
    t.addGrove(52, 58, 6, 0.8).addGrove(76, 58, 6, 0.8).addGrove(64, 88, 10, 0.3).addGrove(40, 40, 10, 0.4).addGrove(90, 92, 10, 0.4);
    const L = LAYOUT.landings;
    return makeLevel({
      name: 'Vigil at the Caldera',
      desc: 'Campaign V. Hold the shrine in the crater while the Volcano charges.',
      terrain: t,
      homes: { player: home, violet: L[0] },
      monuments: [{ x: 70, z: 52, spell: 'lightning', mode: 'gift', charges: 2, cooldown: 180 }],
      buildings: [
        { tribe: 'player', kind: 'shrine', x: shrine.x, z: shrine.z },
        { tribe: 'player', kind: 'hut', x: 55, z: 70 },
        { tribe: 'player', kind: 'hut', x: 73, z: 70 },
        { tribe: 'player', kind: 'warriorHut', x: 64, z: 52 },
      ],
      wildmen: wanderers(t.map, 51, 64, 64, 12, 3),
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: {
              spells: ['blast', 'convert', 'ward', 'volcano'],
              chargeCost: { volcano: 32 },
              buildings: ['hut', 'lumberyard', 'warriorHut', 'tower', 'shrine'],
              startUnits: { brave: 10, warrior: 3 },
              startWood: 16,
            },
          },
          { id: 'violet', name: 'the Unmoored', ...RAIDER_TRIBE },
        ],
        objectives: [
          { objective: { type: 'chargeSpell', spell: 'volcano' }, text: 'Charge the Volcano' },
          { objective: { type: 'buildCount', kind: 'tower', count: 3 }, text: 'A Watchtower in every breach', optional: true },
          { objective: { type: 'reachPopulation', count: 30 }, text: 'Grow the tribe to 30', optional: true },
          // Appended (stars index objectives): the ritual's point is the eruption.
          { objective: { type: 'castSpell', spell: 'volcano' }, text: 'Wake the mountain on the raiders’ shore', after: 0 },
        ],
        fail: [{ type: 'buildingLost', kind: 'shrine' }],
        events: [
          { when: { type: 'time', at: 2 }, message: 'Three wanderers in the basin. Kindle them — more hands to pray, more to fight.', focus: LAYOUT.centre, actions: [] },
          { when: { type: 'objective', index: 0 }, message: 'The mountain is awake in your hands. Cast the Volcano where the raiders land — the crater wall will never be breached there again.', focus: LAYOUT.landings[0], actions: [] },
          wave(70, 0, { warrior: 2 }, 'Unmoored boats on the northern shore.'),
          wave(150, 1, { warrior: 3 }, 'They are coming through the south-east breach.'),
          wave(230, 2, { warrior: 2, firewarrior: 1 }, 'South-west breach — and they carry fire.'),
          wave(310, 0, { warrior: 3, firewarrior: 1 }),
          wave(390, 1, { warrior: 3, firewarrior: 1 }, undefined, { every: 160, times: 4 }),
          wave(470, 2, { warrior: 3, firewarrior: 2 }, undefined, { every: 160, times: 4 }),
          wave(550, 0, { warrior: 4, warden: 1 }, 'A Warden among them. Stone mauls for the shrine.', { every: 160, times: 4 }),
        ],
        briefing: {
          title: 'Vigil at the Caldera',
          body:
            'Inside this dead volcano the Unmoored cannot reach us — except through the three breaches in its wall. ' +
            'The old song says the mountain can be woken, once, by a tribe that prays long enough: our Volcano is known, but this time it will take eight times the mana. ' +
            'Keep the Shrine standing and keep the prayers going until the charge is full. The raids will not stop until it is.',
          tips: [
            'Villagers praying in the Shrine speed every spell that is charging. Switch Blast and Ward off to feed only the ritual — and back on when a wave breaks through.',
            'Each breach is a few tiles wide. A garrisoned Watchtower in each one does most of the fighting.',
            'If the Shrine falls, the vigil fails. A second Shrine is insurance.',
          ],
        },
      },
    });
  },
};
