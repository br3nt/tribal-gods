/**
 * Tribal Gods icon set — original, HAND-CUT icons on a 24×24 grid.
 *
 * They are meant to look carved and painted by the same people who made
 * the panels: bold strokes (2.2) with round ends, the main mass filled with
 * pigment (`--ic-fill`, else the stroke colour, at .45), and a darker CUT
 * drawn beneath each stroke, nudged down-right, so every mark reads as a
 * groove with a lit edge on hide, timber or stone alike.
 *
 * And no ruler: every point of every path is moved by a small seeded
 * jitter (roughen(), below) when the set is built, so lines wander like
 * a knife's would — the same way on every load, so nothing shimmers.
 *
 * Everything tints from CSS `color` (and `--ic-fill`, `--ic-cut`). Strings
 * only — safe to import in Node (no DOM at import time).
 */
import type { BuildingKind, SpellId, UnitKind } from '../sim/catalog';

/** Duotone accent fill for the main mass of an icon. */
const A = (d: string): string => `<path fill="var(--ic-fill, currentColor)" fill-opacity=".45" stroke="none" d="${d}"/>`;
/** Stroked path. */
const P = (d: string): string => `<path d="${d}"/>`;
/** Stroked circle. */
const C = (cx: number, cy: number, r: number): string => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
/** Accent-filled circle. */
const AC = (cx: number, cy: number, r: number): string =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--ic-fill, currentColor)" fill-opacity=".45" stroke="none"/>`;
/** A round dot (zero-length stroke). */
const DOT = (x: number, y: number): string => `<path d="M${x} ${y}h.01"/>`;


// ---------------------------------------------------------------------------
// Figure parts (units)
// ---------------------------------------------------------------------------

/** Standing figure: head, tunic, body, legs. Centred on x. */
const figure = (x: number): string =>
  A(`M${x - 2} 9h4l1.25 6.5h-6.5z`) +
  C(x, 5.25, 2.25) +
  P(`M${x} 8.25v6.75M${x} 15l-2.5 5.5M${x} 15l2.5 5.5`);

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

export const SPELL_ICONS: Record<SpellId, string> = {
  // Crater with a burst flung up out of it.
  blast:
    AC(12, 10.5, 3.25) +
    C(12, 10.5, 3.25) +
    P('M12 2.5v2.5M5.75 5l1.75 1.75M18.25 5L16.5 6.75M3.5 11h2.5M20.5 11H18') +
    P('M2.5 17.5h4.5l1.5 3h7l1.5-3h4.5'),
  // A wanderer drawn in, a spark kindled above the head.
  convert:
    A('M7.5 20.5a4.5 4.5 0 0 1 9 0z') +
    C(12, 12.5, 2.25) +
    P('M7.5 20.5a4.5 4.5 0 0 1 9 0') +
    P('M12 2.5c1.5 1.4 2 2.4 2 3.4a2 2 0 0 1-4 0c0-1 .5-2 2-3.4z') +
    P('M2.5 11.5l2.5 2.5-2.5 2.5M21.5 11.5L19 14l2.5 2.5'),
  // A press bar pushing a hill down flat.
  flatten:
    A('M3 19.5c3 0 4.5-6.5 9-6.5s6 6.5 9 6.5z') +
    P('M2.5 19.5h19') +
    P('M4 3.5h16') +
    P('M8 6v5M5.75 8.75L8 11l2.25-2.25M16 6v5M13.75 8.75L16 11l2.25-2.25'),
  // A sprout with two leaves; a small heal cross.
  bloom:
    A('M12 14.5C7.5 14.5 5 12 5 7.5c4.5 0 7 2.5 7 7zM12 12c0-4.5 2.5-7 7-7 0 4.5-2.5 7-7 7z') +
    P('M12 20.5v-9') +
    P('M12 14.5C7.5 14.5 5 12 5 7.5c4.5 0 7 2.5 7 7zM12 12c0-4.5 2.5-7 7-7 0 4.5-2.5 7-7 7z') +
    P('M7.5 20.5h9'),
  // A stone dome over a dwelling.
  ward:
    A('M3 19.5a9 9 0 0 1 18 0z') +
    P('M3 19.5a9 9 0 0 1 18 0') +
    P('M2.5 19.5h19') +
    P('M9.5 19.5v-2.75L12 14.5l2.5 2.25v2.75'),
  // A single bolt.
  lightning:
    A('M13.5 2.5L6 13.5h5.5L10 21.5l8-11.5h-5.5z') +
    P('M13.5 2.5L6 13.5h5.5L10 21.5l8-11.5h-5.5z'),
  // A war drum being beaten.
  warsong:
    A('M5 10.5v7c0 1.4 3.1 3 7 3s7-1.6 7-3v-7c0 1.4-3.1 2.5-7 2.5s-7-1.1-7-2.5z') +
    P('M5 10.5a7 2.5 0 1 0 14 0a7 2.5 0 1 0-14 0z') +
    P('M5 10.5v7c0 1.4 3.1 3 7 3s7-1.6 7-3v-7') +
    P('M5 14.5l3.5 5.5M12 13v7.5M19 14.5L15.5 20M5.5 17.5l3-4.5M18.5 17.5l-3-4.5') +
    P('M4.5 2.5l5.5 6M19.5 2.5l-5.5 6'),
  // Muck that swallows: a head going under, bubbles.
  swamp:
    A('M2.5 15c1.6-1 3.1-1 4.75 0s3.1 1 4.75 0 3.1-1 4.75 0 3.1 1 4.75 0v5.5h-19z') +
    P('M2.5 15c1.6-1 3.1-1 4.75 0s3.1 1 4.75 0 3.1-1 4.75 0 3.1 1 4.75 0') +
    P('M5 19.5c1.6-1 3.1-1 4.75 0s3.1 1 4.75 0 3.1-1 4.75 0') +
    P('M9.25 14.25a2.75 2.75 0 0 1 5.5 0') +
    C(6.5, 8.5, 1.25) +
    C(17, 6.5, 1.75) +
    C(13, 4, 0.75),
  // A road raised between two banks over water.
  landbridge:
    A('M2.5 11c5-4.5 14-4.5 19 0v3.5c-5-4.5-14-4.5-19 0z') +
    P('M2.5 11c5-4.5 14-4.5 19 0M2.5 14.5c5-4.5 14-4.5 19 0') +
    P('M2.5 11v9.5M21.5 11v9.5') +
    P('M6 18.5c1-.7 2-.7 3 0s2 .7 3 0 2-.7 3 0 2 .7 3 0'),
  // A tapering, leaning funnel.
  cyclone:
    A('M3 4.5h18l-4.5 6-4 5.5-1.5 4.5-1-4.5-2.5-5.5z') +
    P('M3 4.5h18M5.5 8.5h13M8 12.5h8.5M9.5 16.5h4M11 20.5h1'),
  // Burning stones falling with trails.
  emberfall:
    A('M10.12 18.12A3 3 0 1 1 5.88 13.88L15 9z') +
    P('M10.12 18.12A3 3 0 1 1 5.88 13.88L15 9z') +
    P('M18.25 17.25a1.75 1.75 0 1 1-2.5-2.5L21 11.5z') +
    P('M12.75 6.25a1.5 1.5 0 1 1-2.1-2.1L15 2z') +
    P('M2.5 21.5h7'),
  // Land sliding under the sea.
  sink:
    A('M5.5 20.5c0-4.5 2.9-7.5 6.5-7.5s6.5 3 6.5 7.5z') +
    P('M5.5 20.5c0-4.5 2.9-7.5 6.5-7.5s6.5 3 6.5 7.5') +
    P('M2.5 14.5c1.6-1 3.1-1 4.75 0s3.1 1 4.75 0 3.1-1 4.75 0 3.1 1 4.75 0') +
    P('M12 2.5v6.5M9.5 6.5L12 9l2.5-2.5'),
  // Ground torn open along a jagged fault, slabs tilted.
  earthquake:
    A('M2.5 9.5H11l-2 4 2.5 3-2 4h-7zM21.5 7.5H13.5l-1.5 4.5 2.5 3-1.5 5.5h8.5z') +
    P('M2.5 9.5H11l-2 4 2.5 3-2 4M21.5 7.5H13.5l-1.5 4.5 2.5 3-1.5 5.5') +
    P('M2.5 20.5h19') +
    P('M4 5.5l2-2M7.5 5.5l2-2M15 4l2-2M18.5 4l2-2'),
  // A fire mountain erupting.
  volcano:
    A('M2.5 20.5l6-10h7l6 10z') +
    P('M2.5 20.5l6-10h7l6 10z') +
    P('M10.5 10.5l1.5 2.5 1.5-2.5') +
    P('M12 7.5V3M8.5 7L7 4.5M15.5 7L17 4.5'),
};

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/** Small lodge body used by the troop lodges (roof apex at 12,9). */
const lodge =
  A('M3.5 14.5L12 9l8.5 5.5z') +
  P('M3 14.5L12 9l9 5.5') +
  P('M5 14.5v6h14v-6') +
  P('M10.25 20.5v-3a1.75 1.75 0 0 1 3.5 0v3');

export const BUILDING_ICONS: Record<BuildingKind, string> = {
  // Thatched dwelling with crossed roof poles.
  hut:
    A('M2.5 12.5L12 4l9.5 8.5z') +
    P('M2.5 12.5L12 4l9.5 8.5z') +
    P('M12 4l-1.75-1.5M12 4l1.75-1.5') +
    P('M5 12.5v8h14v-8') +
    P('M10 20.5v-3.5a2 2 0 0 1 4 0v3.5'),
  // Lean-to shed over a log pile.
  lumberyard:
    A('M3 9l18-4v1.5L3 10.5z') +
    P('M3 9l18-4') +
    P('M4.5 8.7v11.8M19.5 5.3v15.2M2.5 20.5h19') +
    C(9, 17.75, 2) +
    C(15, 17.75, 2) +
    C(12, 13.75, 2),
  // Lookout platform on splayed legs.
  tower:
    A('M6.5 3.5h11v4h-11z') +
    P('M6.5 3.5h11v4h-11zM12 3.5v4') +
    P('M8 7.5L6 20.5M16 7.5l2 13') +
    P('M7.3 12h9.4M6.6 16.5h10.8M7.3 12l9.4 4.5M16.7 12l-9.4 4.5'),
  // Lodge with crossed spears.
  warriorHut:
    lodge +
    P('M5 3l5 5.5M19 3l-5 5.5') +
    P('M5 3l3 .75M5 3l.75 3M19 3l-3 .75M19 3l-.75 3'),
  // Lodge with a flame on the roof.
  fireHut:
    lodge +
    A('M12 2c1.7 1.6 2.5 2.8 2.5 4a2.5 2.5 0 0 1-5 0c0-1.2.8-2.4 2.5-4z') +
    P('M12 2c1.7 1.6 2.5 2.8 2.5 4a2.5 2.5 0 0 1-5 0c0-1.2.8-2.4 2.5-4z'),
  // Long hall with chant arcs rising from the roof.
  chantHall:
    lodge + P('M9.5 6a3.5 3.5 0 0 1 5 0M7.5 3.5a6.5 6.5 0 0 1 9 0'),
  // Crenellated keep with a tower-shield crest.
  wardenHall:
    P('M3.5 20.5V8h3v2h3V8h5v2h3V8h3v12.5') +
    P('M2.5 20.5h19') +
    A('M9 13.5l3-1 3 1V16c0 2-1.4 3.2-3 3.75C10.4 19.2 9 18 9 16z') +
    P('M9 13.5l3-1 3 1V16c0 2-1.4 3.2-3 3.75C10.4 19.2 9 18 9 16z'),
  // Trilithon with a spirit glow under the lintel.
  shrine:
    A('M3.5 5h17v3h-17z') +
    P('M3.5 5h17v3h-17z') +
    P('M5.5 8v12.5h3V8M15.5 8v12.5h3V8') +
    P('M2.5 20.5h19') +
    P('M12 11.5c1.3 1.2 2 2.2 2 3.25a2 2 0 0 1-4 0c0-1.05.7-2.05 2-3.25z'),
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UNIT_ICONS: Record<UnitKind, string> = {
  // Villager: axe over the shoulder.
  brave:
    figure(9) +
    P('M9 10.5l3.5 1.5') +
    P('M10.5 13.5L17 4') +
    A('M15.5 3.25c1.75-.25 3.5.5 4.5 2l-2.5 1.75z') +
    P('M15.5 3.25c1.75-.25 3.5.5 4.5 2l-2.5 1.75'),
  // Warrior: spear upright, round hide shield.
  warrior:
    figure(11) +
    P('M11 10.5l6 1') +
    P('M17.5 7v14') +
    A('M17.5 2.5l1.75 4.5h-3.5z') +
    P('M17.5 2.5l1.75 4.5h-3.5z') +
    AC(6.5, 13, 3.5) +
    C(6.5, 13, 3.5),
  // Emberthrower: arm cocked back with a burning pot.
  firewarrior:
    figure(9) +
    P('M9 10.5l5-2.5') +
    A('M14 10.5h6l-.75 3.5h-4.5z') +
    P('M14 10.5h6l-.75 3.5h-4.5z') +
    P('M17 2.5c1.7 1.5 2.5 2.7 2.5 3.9a2.5 2.5 0 0 1-5 0c0-1.2.8-2.4 2.5-3.9z'),
  // Warden: tower shield in front, stone maul on the shoulder.
  warden:
    C(11.5, 5.25, 2.25) +
    P('M11.5 8.25v6.75M11.5 15l-2.5 5.5M11.5 15l2.5 5.5') +
    A('M3 8.5h6.5v9L6.25 20 3 17.5z') +
    P('M3 8.5h6.5v9L6.25 20 3 17.5z') +
    P('M11.5 10.5l4.5 1') +
    P('M17.5 13.5V6') +
    A('M15 2.5h5v3.5h-5z') +
    P('M15 2.5h5v3.5h-5z'),
  // Chanter: hands raised, the chant spreading outward.
  chanter:
    figure(9) +
    P('M9 10.5L5.5 6.5M9 10.5l3.5-4') +
    P('M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11'),
  // Leader: long robe, feathered headdress, tall staff with orb.
  shaman:
    A('M8 9.5h4l2.5 11h-9z') +
    P('M8 9.5h4l2.5 11h-9z') +
    C(10, 6.25, 2.25) +
    P('M8 3.5L7 1.75M10 3V1.5M12 3.5l1-1.75') +
    P('M12 11.5l5-1') +
    P('M18 6.5v14') +
    C(18, 4.25, 1.75),
  // Wanderer: hunched, leaning on a stick.
  wildman:
    C(9, 6.5, 2.25) +
    A('M10.5 9.5c2.5 1.5 4 3.5 4 6.5h-4z') +
    P('M10.5 9.25c2.5 1.5 4 3.5 4 6.25') +
    P('M14.5 15.5l-2.5 5M14.5 15.5l2 5') +
    P('M11.25 11.5L7 14.5') +
    P('M6.5 12.5l-1 8'),
};

// ---------------------------------------------------------------------------
// UI icons
// ---------------------------------------------------------------------------

export type UiIconName =
  | 'wood' | 'mana' | 'population' | 'housed' | 'idle' | 'prayer' | 'leader' | 'clock'
  | 'move' | 'attack' | 'attackBuilding' | 'worship' | 'garrison' | 'rally' | 'eject' | 'demolish'
  | 'gather' | 'pause' | 'play' | 'speed' | 'menu' | 'lock' | 'gift' | 'charging' | 'chargingOff'
  | 'close' | 'check' | 'alert' | 'fire' | 'shield' | 'stone' | 'objective' | 'settings'
  | 'plus' | 'minus' | 'home' | 'target' | 'info' | 'trophy' | 'skull' | 'book' | 'hammer'
  | 'eye' | 'heart' | 'arrowRight';

/** A bowl with a live ember: mana is being poured into this spell. */
const chargingBase =
  A('M4 13.5h16c0 4-3.6 7-8 7s-8-3-8-7z') +
  P('M4 13.5h16c0 4-3.6 7-8 7s-8-3-8-7z') +
  A('M12 3c2.5 2.2 3.5 4.2 3.5 6a3.5 3.5 0 0 1-7 0c0-1.2.5-2.2 1.3-3 .2 1 .7 1.5 1.3 1.7C10.8 6.3 11 4.6 12 3z') +
  P('M12 3c2.5 2.2 3.5 4.2 3.5 6a3.5 3.5 0 0 1-7 0c0-1.2.5-2.2 1.3-3 .2 1 .7 1.5 1.3 1.7C10.8 6.3 11 4.6 12 3z');

/** The same bowl, snuffed: a curl of smoke, no flame. */
const chargingOffBase =
  A('M4 13.5h16c0 4-3.6 7-8 7s-8-3-8-7z') +
  P('M4 13.5h16c0 4-3.6 7-8 7s-8-3-8-7z') +
  P('M12 11c-1.5-1.2-1.5-2.3 0-3.5s1.5-2.3 0-3.5M15.5 11c-1-.8-1-1.5 0-2.3');

const fireD = 'M12 2.5c.5 3.5 6 5.5 6 11a6 6 0 0 1-12 0c0-2.75 1.5-4.5 3-5.5 0 2 .75 3 2 3.5-.5-3 0-6 1-9z';

export const UI_ICONS: Record<UiIconName, string> = {
  // Two stacked logs, side view.
  // A pile of logs, end-on: two below, one on top, growth rings showing.
  wood:
    AC(7.5, 16.5, 4.25) + AC(16.5, 16.5, 4.25) + AC(12, 8.5, 4.25) +
    C(7.5, 16.5, 4.25) + C(16.5, 16.5, 4.25) + C(12, 8.5, 4.25) +
    C(7.5, 16.5, 1.4) + C(16.5, 16.5, 1.4) + C(12, 8.5, 1.4),
  // Spirit droplet with an inner glint.
  // A spirit wisp: a flame that curls back on itself.
  mana:
    A('M12 2.5c4 3.5 6.5 7 6.5 11a6.5 6.5 0 0 1-13 0c0-2.6 1.2-4.6 2.8-6 .2 2 1 3.3 2.4 3.8C9.8 8 10.3 5.2 12 2.5z') +
    P('M12 2.5c4 3.5 6.5 7 6.5 11a6.5 6.5 0 0 1-13 0c0-2.6 1.2-4.6 2.8-6 .2 2 1 3.3 2.4 3.8C9.8 8 10.3 5.2 12 2.5z') +
    P('M12 20c-1.8 0-3-1.3-3-2.9 0-1.7 1.6-2.4 2.4-4 1.5 1.3 3.6 2.6 3.6 4.4 0 1.5-1.2 2.5-3 2.5z'),
  // Two heads and shoulders.
  // Three of the tribe: one tall, two small at their side.
  population:
    C(12, 5, 2.25) + A('M9 8.5h6l1 7H8z') + P('M9 8.5h6l1 7H8zM10 15.5v5M14 15.5v5') +
    C(4.75, 9.5, 1.75) + P('M3 12.5h3.5l.75 5h-5zM3.75 17.5v3M6.25 17.5v3') +
    C(19.25, 9.5, 1.75) + P('M17.5 12.5H21l.75 5h-5zM18.25 17.5v3M20.75 17.5v3'),
  // House with a person inside.
  housed:
    A('M2.5 11L12 3l9.5 8z') +
    P('M2.5 11L12 3l9.5 8') +
    P('M4.5 9.5v11h15v-11') +
    C(12, 12, 2) +
    P('M8.5 20.5a3.5 3.5 0 0 1 7 0'),
  // Person with zz.
  idle:
    A('M3 20.5a6 6 0 0 1 12 0z') +
    C(9, 10, 2.75) +
    P('M3 20.5a6 6 0 0 1 12 0z') +
    P('M15 3h4.5L15 8h4.5M13 9.5h2.5l-2.5 3h2.5'),
  // Figure kneeling, bowed, arms reaching forward.
  prayer:
    C(13, 6.5, 2.25) +
    A('M6.5 15.5l5-6.5 2 1.5-1 5h2a2.5 2.5 0 0 1 0 5H4.5z') +
    P('M6.5 15.5l5-6.5M6.5 15.5h8a2.5 2.5 0 0 1 0 5h-10') +
    P('M11 11l7.5-1.5') +
    P('M20.5 6.5l1-1M20.5 12.5l1 1'),
  // Staff with a crowned orb.
  leader:
    P('M12 12.75v8') +
    AC(12, 9.75, 3) +
    C(12, 9.75, 3) +
    P('M8.5 5.5V2.5l2 1.75L12 2l1.5 2.25 2-1.75v3z') +
    P('M9.5 20.5h5'),
  // Time: the sun over the horizon, its rays marking the day.
  clock:
    A('M5 16.5a7 7 0 0 1 14 0z') + P('M5 16.5a7 7 0 0 1 14 0') + P('M2.5 16.5h19M5 20h14') +
    P('M12 3.5v3M4.5 7l2 2M19.5 7l-2 2M12 16.5l3-5'),
  // Arrow coming down onto a ground marker.
  move:
    A('M5 18.5a7 2.5 0 1 0 14 0a7 2.5 0 1 0-14 0z') +
    P('M5 18.5a7 2.5 0 1 0 14 0a7 2.5 0 1 0-14 0z') +
    P('M12 2.5v12M8 10.5l4 4 4-4'),
  // Two crossed blades.
  attack:
    P('M3.5 3.5l12 12M12.5 18.5l6-6M15.5 15.5l4.5 4.5') +
    P('M20.5 3.5l-12 12M11.5 18.5l-6-6M8.5 15.5L4 20'),
  // Hammer striking a roof.
  attackBuilding:
    A('M2.5 15.5L8.5 11l6 4.5z') +
    P('M2.5 15.5L8.5 11l6 4.5') +
    P('M4 14.4v6.1h9v-6.1') +
    A('M13 3.5l5.5 5.5-2.5 2.5L10.5 6z') +
    P('M13 3.5l5.5 5.5-2.5 2.5L10.5 6z') +
    P('M17.25 7.75l4.25-4.25') +
    P('M8.5 8.5V7M5.5 10L4.5 9M11.5 10.5l1-.5'),
  // Standing stone giving off rays.
  worship:
    A('M9 20.5v-10a3 3 0 0 1 6 0v10z') +
    P('M9 20.5v-10a3 3 0 0 1 6 0v10') +
    P('M3 20.5h18') +
    P('M12 2.5V4.5M5.5 5.5l1.5 1.5M18.5 5.5L17 7M3.5 12h2.5M20.5 12H18'),
  // Tower with an arrow going in.
  garrison:
    A('M11.5 8h9v12.5h-9z') +
    P('M11.5 20.5V4.5h2.25v2h2.25v-2h2v2h2.25v-2h.25v16') +
    P('M11.5 8h9') +
    P('M14.5 20.5v-3a1.5 1.5 0 0 1 3 0v3') +
    P('M2.5 14h7M6.5 11l3 3-3 3'),
  // Flag on a pole.
  rally:
    A('M6 4h12.5l-3 3.75 3 3.75H6z') +
    P('M6 4h12.5l-3 3.75 3 3.75H6') +
    P('M6 21V2.5M3.5 21h5'),
  // Arrow leaving a doorway.
  eject:
    A('M3.5 4h7v16.5h-7z') +
    P('M3.5 20.5V4h7v3.5M10.5 17v3.5h-7') +
    P('M7 12.25h13.5M17 8.75l3.5 3.5-3.5 3.5'),
  // Crumbling brick wall, pieces falling away.
  demolish:
    A('M3 20.5V7h6l1.5 2.5 2.5-.5 1 4 2 1v6.5z') +
    P('M3 20.5V7h6l1.5 2.5 2.5-.5 1 4 2 1v6.5z') +
    P('M3 11h7M3 15.5h13M6.5 7v4M9.5 11v4.5M6 15.5v5M12 15.5v5') +
    P('M18 6.5l2 1-1 2-2-1zM19.5 12.5l1.5.5-.5 1.5') +
    P('M2.5 20.5h19'),
  // Axe bitten into a log.
  gather:
    A('M5 15h14v5.5H5z') +
    P('M19 15H5a2.75 2.75 0 0 0 0 5.5h14') +
    C(19, 17.75, 2.75) +
    P('M10.5 14.5l7-11') +
    A('M7 10.25l3.5-2 1.5 4.25-3 1.5z') +
    P('M7 10.25l3.5-2 1.5 4.25-3 1.5z'),
  // Two standing stones: the world holds still.
  pause:
    A('M6.5 20.5V6l2-2 2 1.5v15zM13.5 20.5V5.5l2.25-1.5 2 2v14.5z') +
    P('M6.5 20.5V6l2-2 2 1.5v15zM13.5 20.5V5.5l2.25-1.5 2 2v14.5zM3.5 20.5h17'),
  // A knapped flint point: go.
  play: A('M6 4l13 8-13 8 2.5-8z') + P('M6 4l13 8-13 8 2.5-8z') + P('M8.5 12l4-1.5M8.5 12l4 1.5'),
  // Two flint points flying.
  speed: A('M3.5 6l7.5 6-7.5 6 1.5-6zM11.5 6l7.5 6-7.5 6 1.5-6z') + P('M3.5 6l7.5 6-7.5 6 1.5-6zM11.5 6l7.5 6-7.5 6 1.5-6z'),
  // Three sticks lashed together at one end.
  menu: P('M4 6.5h16M4 12h16M4 17.5h16') + P('M6 4.5l2.5 15M8.5 4.5L6 19.5'),
  // Bound with cord: a bundle tied shut.
  lock:
    A('M6 9.5h12v11H6z') + P('M6 9.5h12v11H6z') +
    P('M6 13l12 4M6 17l12-4') +
    P('M10 9.5c-1.5-2.5-1-5.5 2-6 3 .5 3.5 3.5 2 6'),
  // A wrapped bundle with a bow.
  gift:
    A('M4.5 10.5h15v10h-15z') +
    P('M4.5 10.5h15v10h-15zM3 7h18v3.5H3zM12 7v13.5') +
    P('M12 7C11 4 8 3 7.25 4.5S9 7 12 7c3 0 5.5-1 4.75-2.5S13 4 12 7z'),
  // Spirit stream flowing into a vessel.
  charging: chargingBase,
  chargingOff: chargingOffBase,
  close: P('M6 6l12 12M18 6L6 18'),
  check: P('M4.5 12.5l5 5 10-11'),
  alert:
    A('M12 3.5l9.5 16.5h-19z') +
    P('M12 3.5l9.5 16.5h-19z') +
    P('M12 9.5v4.5') +
    DOT(12, 17),
  fire: A(fireD) + P(fireD) + P('M12 20.5a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1.25-2.5 2.5-4 1.25 1.5 2.5 2.5 2.5 4a2.5 2.5 0 0 1-2.5 2.5z'),
  shield:
    A('M12 2.5l8 3v6c0 4.75-3.4 8.25-8 10-4.6-1.75-8-5.25-8-10v-6z') +
    P('M12 2.5l8 3v6c0 4.75-3.4 8.25-8 10-4.6-1.75-8-5.25-8-10v-6z'),
  // A rough monolith.
  stone:
    A('M7.5 20.5l1.5-14 3.5-3.5 4 2.5.5 15z') +
    P('M7.5 20.5l1.5-14 3.5-3.5 4 2.5.5 15') +
    P('M3 20.5h18') +
    P('M12.5 3l-.5 5 1.5 3'),
  // Flag planted on a target.
  objective:
    A('M12 3.5h7.5l-2 2.75 2 2.75H12z') +
    P('M12 3.5h7.5l-2 2.75 2 2.75H12') +
    P('M12 18.5V2.5') +
    P('M4 18.5a8 3 0 1 0 16 0a8 3 0 1 0-16 0z') +
    P('M9 18.5a3 1 0 1 0 6 0a3 1 0 1 0-6 0z'),
  // A spindle whorl: the tool that sets the thread.
  settings:
    AC(12, 12, 8.75) + C(12, 12, 8.75) + C(12, 12, 2.25) +
    P('M12 3.25v3.5M12 17.25v3.5M3.25 12h3.5M17.25 12h3.5M5.8 5.8l2.5 2.5M15.7 15.7l2.5 2.5M5.8 18.2l2.5-2.5M15.7 8.3l2.5-2.5'),
  plus: P('M12 5v14M5 12h14'),
  minus: P('M5 12h14'),
  // Hearth: a ring of stones round a small fire.
  home:
    A('M3 17a9 3.5 0 1 0 18 0a9 3.5 0 1 0-18 0z') +
    P('M3 17a9 3.5 0 1 0 18 0a9 3.5 0 1 0-18 0z') +
    P('M8 18.5l8-3M8 15.5l8 3') +
    P('M12 3.5c2 2 3.5 4 3.5 6.5a3.5 3.5 0 0 1-7 0c0-2.5 1.5-4.5 3.5-6.5z'),
  target:
    C(12, 12, 7.5) +
    AC(12, 12, 2.5) +
    P('M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4'),
  info: C(12, 12, 9) + P('M12 11v5.5') + DOT(12, 7.75),
  // A victor's crown of antlers.
  trophy:
    A('M6 14.5h12v3.5H6z') + P('M6 14.5h12v3.5H6z') +
    P('M8 14.5C6 11 5 8 5.5 4M5.5 8.5L3 7M6.5 11.5L4 11') +
    P('M16 14.5c2-3.5 3-6.5 2.5-10.5M18.5 8.5L21 7M17.5 11.5L20 11') +
    P('M12 14.5V9M12 9l-1.5-2M12 9l1.5-2') + P('M9 21h6'),
  skull:
    A('M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.75 1.5 4.5 3 5.5v4.5h9V16c1.5-1 3-2.75 3-5.5A7.5 7.5 0 0 0 12 3z') +
    P('M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.75 1.5 4.5 3 5.5v4.5h9V16c1.5-1 3-2.75 3-5.5A7.5 7.5 0 0 0 12 3z') +
    C(9, 11, 1.5) +
    C(15, 11, 1.5) +
    P('M10.5 17.5v3M13.5 17.5v3'),
  // The spell book: a stone tablet cut with runes.
  book:
    A('M5.5 3.5h13l1 17h-15z') + P('M5.5 3.5h13l1 17h-15z') +
    P('M8.5 7.5l2 2 2-2 2 2M8.5 12h7M10 12v3.5M14 12l-2 4M8.5 17.5h7'),
  // A stone maul: a rock lashed to a haft.
  hammer:
    A('M11.5 3.5l6 2.5-1.5 6-6.5-2.5z') + P('M11.5 3.5l6 2.5-1.5 6-6.5-2.5z') +
    P('M13 8.25L5 20.5') + P('M11 9.5l2.75 1.25M12 7.6l2.75 1.25'),
  eye:
    P('M2.5 12c2.5-4.5 6-7 9.5-7s7 2.5 9.5 7c-2.5 4.5-6 7-9.5 7s-7-2.5-9.5-7z') +
    AC(12, 12, 3) +
    C(12, 12, 3),
  heart:
    A('M12 20s-8.5-5-8.5-11A4.5 4.5 0 0 1 12 6.5 4.5 4.5 0 0 1 20.5 9c0 6-8.5 11-8.5 11z') +
    P('M12 20s-8.5-5-8.5-11A4.5 4.5 0 0 1 12 6.5 4.5 4.5 0 0 1 20.5 9c0 6-8.5 11-8.5 11z'),
  // A spear: flint head, shaft.
  arrowRight: P('M3 12h12') + A('M15 8l6 4-6 4 1.25-4z') + P('M15 8l6 4-6 4 1.25-4z') + P('M5 10.5l1.5 1.5L5 13.5'),
};

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Roughening: no ruler-straight lines
// ---------------------------------------------------------------------------

/** How many numbers each path command takes. */
const ARGS: Record<string, number> = { m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7, z: 0 };

function seeded(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296 - 0.5;
  };
}

function hashStr(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Move every coordinate of a path by up to ±amp/2 (arc radii and flags are
 * left alone, so arcs stay valid). Relative commands drift a little, which
 * is exactly how a hand-cut line wanders.
 */
export function roughenPath(d: string, seed: number, amp = 0.5): string {
  const rnd = seeded(seed);
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let cmd = '';
  let k = 0;
  const out: string[] = [];
  for (const t of tokens) {
    if (/[a-z]/i.test(t)) {
      cmd = t;
      k = 0;
      out.push(t);
      continue;
    }
    const n = ARGS[cmd.toLowerCase()] ?? 2;
    const i = n ? k % n : 0;
    k++;
    const isCoord = cmd.toLowerCase() === 'a' ? i >= 5 : true;
    const v = Number(t) + (isCoord ? rnd() * amp : 0);
    out.push(String(Math.round(v * 100) / 100));
  }
  return out.join(' ').replace(/ ([MmLlHhVvCcSsQqTtAaZz]) /g, '$1').replace(/ ([MmLlHhVvCcSsQqTtAaZz])$/g, '$1');
}

/** Roughen every path and circle in an icon's markup (circles become slightly lopsided ellipses). */
export function roughen(inner: string, seed: number): string {
  const rnd = seeded(seed ^ 0x9e3779b9);
  let n = 0;
  return inner
    .replace(/ d="([^"]+)"/g, (_m, d: string) => ` d="${roughenPath(d, seed + n++ * 7919)}"`)
    .replace(/<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"/g, (_m, cx: string, cy: string, r: string) => {
      const R = Number(r);
      const rx = R * (1 + rnd() * 0.12);
      const ry = R * (1 + rnd() * 0.12);
      const f = (x: number) => String(Math.round(x * 100) / 100);
      return `<ellipse cx="${f(Number(cx) + rnd() * 0.3)}" cy="${f(Number(cy) + rnd() * 0.3)}" rx="${f(rx)}" ry="${f(ry)}"`;
    });
}

/** Strip the pigment fills (the cut layer is strokes only). */
const strokesOnly = (inner: string) => inner.replace(/<(path|circle|ellipse)[^>]*stroke="none"[^>]*\/>/g, '');

const cache = new Map<string, string>();
function cut(inner: string): string {
  let c = cache.get(inner);
  if (!c) {
    const r = roughen(inner, hashStr(inner));
    c = `<g transform="translate(.45 .7)" stroke="var(--ic-cut, rgba(18,9,3,.5))" stroke-width="3">${strokesOnly(r)}</g><g>${r}</g>`;
    cache.set(inner, c);
  }
  return c;
}

/** Full <svg> element string. `cls` adds a class; size in px (default 20) sets width/height attrs. */
export function svg(inner: string, size = 20, cls?: string): string {
  const c = cls ? ` class="${cls}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${c} width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${cut(inner)}</svg>`
  );
}

/** An icon's roughened markup without the svg wrapper (for cursors drawn elsewhere). */
export function iconMarkup(inner: string): string {
  return roughen(inner, hashStr(inner));
}

export function icon(name: UiIconName, size?: number, cls?: string): string {
  return svg(UI_ICONS[name], size, cls);
}

export function spellIcon(id: SpellId, size?: number, cls?: string): string {
  return svg(SPELL_ICONS[id], size, cls);
}

export function buildingIcon(kind: BuildingKind, size?: number, cls?: string): string {
  return svg(BUILDING_ICONS[kind], size, cls);
}

export function unitIcon(kind: UnitKind, size?: number, cls?: string): string {
  return svg(UNIT_ICONS[kind], size, cls);
}
