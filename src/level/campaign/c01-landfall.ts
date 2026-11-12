/**
 * Chapter 1 — Landfall. The boats are ashore; the sea is not done with us.
 *
 * A power-fantasy opening that teaches the basics by having the leader
 * reshape the world from the first seconds:
 *
 *   1. KIN ON THE SANDBAR. The last boat grounded on a sandbar across a
 *      channel. The leader holds a gifted Causeway: raise a road out of the
 *      sea and they walk across (stranded units join when a route reaches
 *      home). Meanwhile wanderers on the north meadow → Kindle (2 ready).
 *   2. THE LEVELLING SONG. The rescued kin carry the Level chant (taught +
 *      two gifted casts). The only ground near the landing is a rumpled,
 *      boulder-strewn slope: Level it twice, then raise four Dwellings
 *      (builders auto-work; sites level their own footprints).
 *   3. SAILS. With the roofs up, the narrator points at the Black Strand:
 *      Unmoored boats, landing in 40 seconds. The stone above the strand
 *      wakes and lends three Lightnings; Blast throws raiders into the sea.
 *   4. THE HOST. Their first boats beaten, the great fleet comes. It lands
 *      on the Black Strand and MASSES there (spawn `hold`) for a minute and
 *      a half before it marches. The headland stone wakes: kneel there (the
 *      host's scouts may come for you) and it lends ONE Volcano. Wake the
 *      mountain under the host — the strand becomes a mountain for good.
 *
 * Nobody is soft-locked: a Causeway that missed is lent again while the kin
 * wait; Level and Kindle are taught and recharge; both stones lend again
 * after a cooldown; a host that marches before the Volcano lands can still
 * be broken with Lightning, Blast and the villagers, who fight back.
 *
 * Fail: ten villagers dead (a scripted `killed` → `defeat`). Optional:
 * lose nobody, Kindle every wanderer, bury the host with the Volcano,
 * win inside twelve minutes.
 *
 * The map: "the Hook" — a rounded island; the landing (home) on its west
 * shore facing the sandbar across a narrow channel; the north meadow with
 * wanderers; a rumpled slope east of the landing; the Black Strand, a broad
 * beach in the south-east, watched by a stone on a headland.
 */

import { hash2 } from '../../core/noise';
import type { ScenarioEvent } from '../../sim/catalog';
import { smoothstep } from '../../core/util';
import { dist, inside, lineDist, Terrain, wanderers } from '../terrain-kit';
import { CampaignScenario, makeLevel, RAIDER_TRIBE } from './common';

export const LAYOUT = {
  home: { x: 46, z: 66 },
  /** The kin's sandbar, across the channel to the west. */
  sandbar: { x: 25, z: 64 },
  /** Where the leader stands to raise the Causeway (west shore). */
  shore: { x: 39, z: 65 },
  meadow: { x: 50, z: 47 },
  meadow2: { x: 73, z: 47 },
  /** The hillside east of the landing — the building ground, once Levelled. */
  slope: { x: 57, z: 70 },
  slopeRadius: 15,
  /** Stone above the strand: Lightning (gift). */
  lightning: { x: 55, z: 82 },
  /** The Black Strand: where raiders come ashore and the host masses. */
  landing: { x: 81, z: 101 },
  strand: { x: 74, z: 93 },
  /** The headland stone: one Volcano (gift). */
  headland: { x: 87, z: 85 },
};

const KIN = { brave: 4, warrior: 2 };
/** The crater walls: they start WALL_IN tiles from home, climb WALL_SLOPE per tile for WALL_W tiles, then fall away as steeply. */
const WALL_IN = 3.5;
const WALL_W = 4;
const WALL_SLOPE = 2.4;
/** How steeply the floor falls to the sea through the gap (per tile). */
const SHINGLE = 1.8;
const WAVE = 4;
export const HUTS = 4;
/** The great fleet: big enough to read as a host on the strand, small enough to be broken without the Volcano by a player who missed it. */
const HOST = { warrior: 10, firewarrior: 2 };
export const HOST_HOLD = 95;
/** Seconds from the first raid's end to the host coming ashore (the fleet is on the horizon meanwhile). */
const FLEET_DELAY = 60;
/** A spent Causeway that left the kin stranded is lent again after this long. */
const CAUSEWAY_AGAIN = 30;
/** The headland stone lends its Volcano again after this long (a missed or wasted cast is not the end). */
const VOLCANO_AGAIN = 100;

/** Objective indices (events refer to them). */
const O = { kin: 0, kindle: 1, level: 2, huts: 3, raid: 4, stone: 5, host: 6 };

export const scenario: CampaignScenario = {
  id: 'c01_landfall',
  chapter: 1,
  title: 'Landfall',
  tagline: 'Raise a road out of the sea. Then a mountain.',
  teaches: 'Causeway, Kindle, Level, Dwellings, Blast & Lightning, a great spell',
  async build() {
    const t = new Terrain(10101);
    const { home, sandbar, meadow, meadow2, slope, lightning, strand, headland, landing } = LAYOUT;
    t.landFrom((x, z) => {
      const main = inside(Math.hypot((x - 64) / 27, (z - 72) / 31) * 30 + t.wobble(x, z, 1) * 3, 30, 5);
      const cape = inside(lineDist(x, z, [{ x: 80, z: 82 }, { x: 90, z: 85 }]) + t.wobble(x, z, 2) * 1.2, 5, 3);
      const bar = inside(dist(x, z, sandbar.x, sandbar.z) + t.wobble(x, z, 3) * 1.2, 5, 2.5);
      return Math.max(main, cape, bar);
    }, { base: 2.6, roll: 0.9 });
    // The cove: the landing sits at the bottom of an old crater whose west
    // wall the sea broke long ago. The walls rise steadily all round — easy
    // to climb, nowhere flat enough for a Dwelling — until Level cuts shelves
    // into them. (Cone profile: a constant slope has no flat spots, unlike a
    // rounded hill's crown and foot.)
    t.apply((x, z, h) => {
      if (h < 0.3) return h;
      const d = dist(x, z, home.x, home.z);
      const c = Math.cos(Math.atan2(z - home.z, x - home.x)); // −1 = due west, the sea gap
      const f = smoothstep(-0.97, -0.82, c);
      const up = Math.min(Math.max(0, d - WALL_IN), WALL_W) - Math.max(0, d - WALL_IN - WALL_W);
      const wall = Math.max(0, up) * WALL_SLOPE;
      const stony = (hash2(x, z, 5151) - 0.5) * 0.8;
      const walled = h + (wall + (wall > 0 ? stony : 0)) * f;
      // Through the gap the cove floor drops straight to the water: a steep shingle, no building ground.
      const shingle = Math.min(walled, 2.8 - SHINGLE * Math.max(0, d - WALL_IN));
      return walled + (shingle - walled) * (1 - f);
    });
    t.pad(home.x, home.z, 3, 2.8, 1.5);
    // The sandbar: low and flat — the tide is at its edges.
    t.pad(sandbar.x, sandbar.z, 3, 0.9, 2);
    // The Black Strand: a broad flat beach.
    t.pad(strand.x, strand.z, 6, 1.0, 4).pad(landing.x, landing.z, 3, 0.7, 3);
    // The headland: a high shelf above the strand, its stone on top.
    t.mesa(headland.x, headland.z, 3.5, 4.2, 2.5);
    t.pad(headland.x, headland.z, 2, 4.4, 2);
    t.addGrove(home.x - 6, home.z - 9, 6, 0.8).addGrove(home.x - 3, home.z + 11, 6, 0.8)
      .addGrove(slope.x + 8, slope.z - 12, 7, 0.6).addGrove(meadow2.x + 6, meadow2.z + 8, 6, 0.5);
    const raid = (n: number) => ({ type: 'spawn' as const, tribe: 'violet' as const, units: { warrior: n }, x: landing.x, z: landing.z, march: home });
    const events: ScenarioEvent[] = [
      { when: { type: 'time', at: 2 }, message: 'Kin on the sandbar! The last boat ran aground across the channel. Raise a Causeway to them.', focus: sandbar, actions: [] },
      { when: { type: 'time', at: 20 }, message: 'Wanderers on the north meadow. Kindle them into the tribe.', focus: meadow, actions: [] },
      // Recovery: a Causeway that missed (or was spent elsewhere) leaves the kin
      // stranded for good — so while they still wait and no Causeway is in
      // hand, the tide-song lends another.
      {
        when: { type: 'all', of: [{ type: 'not', of: { type: 'objective', index: O.kin } }, { type: 'noCasts', spell: 'landbridge' }] },
        repeat: { every: CAUSEWAY_AGAIN, times: 8, while: true },
        message: 'The kin still wait across the channel. The tide-song gives you another Causeway — from the shore, straight at the sandbar.',
        focus: sandbar,
        actions: [{ type: 'gift', tribe: 'player', spell: 'landbridge', charges: 1 }],
      },
      {
        when: { type: 'objective', index: O.kin },
        message: 'The kin are home — and they remember the Levelling chant. Cut shelves into the hillside so the village can rise.',
        focus: slope,
        actions: [{ type: 'teach', tribe: 'player', spell: 'flatten' }, { type: 'gift', tribe: 'player', spell: 'flatten', charges: 2 }],
      },
      { when: { type: 'objective', index: O.level }, message: 'Good ground. Place Dwellings on it — the villagers will raise them.', focus: slope, actions: [] },
      // The first sails: a visible countdown, and the strand stone wakes.
      {
        when: { type: 'objective', index: O.huts },
        message: 'Sails off the Black Strand! Unmoored raiders, ashore in forty-five heartbeats. The stone above the strand has woken: kneel there for Lightning.',
        focus: strand,
        actions: [{ type: 'openStone', index: 0 }],
      },
      { when: { type: 'objective', index: O.huts }, delay: 45, message: 'Their boats are running in to the Black Strand! Blast them as they step ashore.', focus: landing, actions: [raid(WAVE)] },
      // The host.
      {
        when: { type: 'objective', index: O.raid },
        delay: 8,
        message: 'The horizon is full of sails — the whole Unmoored fleet. The headland stone burns with the mountain’s fire: kneel there, and it will lend you one Volcano.',
        focus: headland,
        actions: [{ type: 'openStone', index: 1 }],
      },
      {
        when: { type: 'objective', index: O.raid },
        delay: FLEET_DELAY,
        message: 'The host is landing on the Black Strand. They will mass there before they march — wake the mountain under them!',
        focus: strand,
        actions: [{ type: 'spawn', tribe: 'violet', units: HOST, x: landing.x, z: landing.z, march: strand, hold: HOST_HOLD }],
      },
      {
        // The host was not buried: it is about to march. The strand stone wakes again so the
        // village is not left to spears alone (a missed or late Volcano is not the end).
        when: { type: 'objective', index: O.raid },
        delay: FLEET_DELAY + HOST_HOLD - 15,
        unless: { type: 'spellCast', spell: 'volcano', x: strand.x, z: strand.z, radius: 9 },
        message: 'Drums on the strand — the host is about to march on the village! Both stones wake again: Lightning above the strand, the mountain on the headland.',
        focus: strand,
        actions: [{ type: 'openStone', index: 0 }, { type: 'openStone', index: 1 }],
      },
      { when: { type: 'spellCast', spell: 'volcano', x: strand.x, z: strand.z, radius: 9 }, delay: 3, message: 'The Black Strand is a mountain now. Let the Unmoored tell their children.', focus: strand, actions: [] },
      // Fail: too many of us fall.
      { when: { type: 'killed', tribe: 'player', count: 10, kind: 'brave' }, actions: [{ type: 'defeat', reason: 'Ten of our people lie on the sand. The Lantern-folk take to the boats again.' }] },
    ];
    return makeLevel({
      name: 'Landfall',
      desc: 'Campaign I. Kin on a sandbar, a slope to Level, and the Unmoored fleet on the horizon.',
      terrain: t,
      homes: { player: home, violet: landing },
      monuments: [
        { x: lightning.x, z: lightning.z, spell: 'lightning', mode: 'gift', charges: 3, cooldown: 75, asleep: true },
        { x: headland.x, z: headland.z, spell: 'volcano', mode: 'gift', charges: 1, cooldown: VOLCANO_AGAIN, asleep: true, communeSeconds: 14 },
      ],
      units: [
        { tribe: 'player', joins: 'player', kind: 'brave', x: sandbar.x, z: sandbar.z, count: KIN.brave },
        { tribe: 'player', joins: 'player', kind: 'warrior', x: sandbar.x + 1, z: sandbar.z + 1, count: KIN.warrior },
      ],
      wildmen: wanderers(t.map, 11, meadow.x, meadow.z, 3, 5).concat(wanderers(t.map, 12, meadow2.x, meadow2.z, 3, 3)),
      treeDensity: 0.015,
      rules: {
        tribes: [
          {
            id: 'player', name: 'the Lantern-folk', ai: false,
            loadout: {
              spells: ['blast', 'convert'],
              gifts: { landbridge: 1 },
              buildings: ['hut', 'lumberyard'],
              startUnits: { brave: 6 },
              startWood: 15,
            },
          },
          { id: 'violet', name: 'the Unmoored', ...RAIDER_TRIBE },
        ],
        objectives: [
          { objective: { type: 'rescueStranded', count: KIN.brave + KIN.warrior }, text: 'Raise a Causeway to the kin on the sandbar' },
          { objective: { type: 'convertWanderers', count: 3 }, text: 'Kindle the wanderers on the north meadow' },
          { objective: { type: 'castSpell', spell: 'flatten', count: 2, x: slope.x, z: slope.z, radius: LAYOUT.slopeRadius }, text: 'Level the hillside (twice)', after: O.kin },
          { objective: { type: 'buildCount', kind: 'hut', count: HUTS }, text: `Raise ${HUTS} Dwellings`, after: O.level },
          { objective: { type: 'killUnits', tribe: 'violet', count: WAVE - 1 }, text: 'Drive the raiders off the Black Strand', after: O.huts },
          { objective: { type: 'claimMonument', index: 1 }, text: 'Kneel at the headland stone', after: O.raid },
          { objective: { type: 'killUnits', tribe: 'violet', count: 9 }, text: 'Break the Unmoored host', after: O.raid },
          { objective: { type: 'castSpell', spell: 'volcano', x: strand.x, z: strand.z, radius: 9 }, text: 'Bury the host under a mountain', optional: true, after: O.raid },
          { objective: { type: 'loseAtMost', count: 0, kind: 'brave' }, text: 'Lose no villagers', optional: true },
          { objective: { type: 'convertWanderers', count: 8 }, text: 'Kindle every wanderer on the Hook', optional: true },
          { objective: { type: 'winWithin', seconds: 720 }, text: 'Win within 12 minutes', optional: true },
        ],
        events,
        briefing: {
          title: 'Landfall',
          body:
            'The Long Tide took the old shore, and the boats carried the Lantern-folk to this hook of land. ' +
            'The last boat ran aground on a sandbar across the channel, and the water is rising round it. ' +
            'You are their leader, and the land listens to you: raise a road out of the sea, make room for roofs — and be ready, because the Unmoored raid every shore that smokes.',
          tips: [
            'Select your leader, pick a spell (or press its key) and click where it should land. Causeway runs from her feet to the mark.',
            'Kneel at a standing stone to take what it offers — but a kneeling leader is helpless, and any blow breaks the ritual.',
            'If ten villagers die, the landing fails. Keep the raiders off the village.',
          ],
        },
      },
    });
  },
};
