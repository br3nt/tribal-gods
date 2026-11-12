/**
 * level/level-format.ts — what a level IS, and how it travels.
 *
 * A level is a JSON document: metadata, up to four tribes' home tiles,
 * monument placements, trees, wildmen, optional scenario rules (objectives,
 * loadouts, scripted events) and pre-placed buildings/units — and the
 * terrain. v1 documents are migrated on read (migrateLevel). The terrain is the bulky
 * part: 128×128 floats. Three classic tricks shrink it from 130KB of JSON
 * numbers to a few KB of pasteable text:
 *
 *   1. QUANTIZE — heights don't need float64 precision. Multiply by 128,
 *      round to a 16-bit integer: sub-centimeter accuracy, 1/4 the bytes.
 *   2. COMPRESS — terrain is smooth, so neighboring values are similar
 *      and deflate eats it alive. Browsers ship a native compressor
 *      (CompressionStream) — the same algorithm inside .zip files.
 *   3. BASE64 — binary → text that survives chat apps and forum posts.
 *
 * The share code is the whole level JSON put through compress+base64 with
 * a version prefix ("TG2." today; the first release's "TG1." codes are still
 * read and migrated), Factorio-blueprint style: anyone can paste a
 * planet to anyone. The same format is what we store in localStorage and
 * what an online level server would store someday — design the document
 * first and every transport gets it for free.
 */

import { CivId, WORLD_SIZE } from '../config';
import { BUILDINGS, SPELLS, TRIBE_IDS, UNITS } from '../sim/catalog';
import type { BuildingKind, MonumentDef, ScenarioRules, SpellId, Tribe, TribeId, UnitKind } from '../sim/catalog';

type Pt = { x: number; z: number };

/** A building standing when the scenario opens (complete unless `complete: false`). */
export interface PlacedBuilding {
  tribe: TribeId;
  kind: BuildingKind;
  x: number;
  z: number;
  complete?: boolean;
  /** Fighters (towers) or worshippers (shrines) already inside. */
  garrison?: Partial<Record<UnitKind, number>>;
}

/** Units standing somewhere at the start: guards, a stranded band, wanderers' champions. */
export interface PlacedUnits {
  tribe: Tribe;
  kind: UnitKind;
  x: number;
  z: number;
  count?: number;
  /** A STRANDED group: they stand unclaimed ('wild') until a walking route links them to this tribe's home, then join it. */
  joins?: TribeId;
}

/**
 * v2 — the current document. Everything past `wildmen` is optional, so a
 * plain editor planet is still just terrain + trees + stones + homes.
 */
export interface LevelData {
  /** Format version — old versions are migrated on read (migrateLevel). */
  v: 2;
  name: string;
  author: string;
  desc: string;
  /** Base64 of deflated, delta-coded Int16 heights (see header). */
  terrain: string;
  /** Flat [x,z, x,z, ...] tile pairs. */
  trees: number[];
  monuments: MonumentDef[];
  /** Home circle per tribe. A tribe in the rules without one settles somewhere sensible. */
  homes: { player: Pt } & Partial<Record<TribeId, Pt>>;
  wildmen: number[]; // flat [x,z] pairs
  /** Suggested civ (cosmetic) per AI tribe; omitted = random. */
  civs?: Partial<Record<TribeId, CivId>>;
  /** The scenario: tribes, loadouts, objectives, briefing, scripted events. Omitted = skirmish. */
  rules?: ScenarioRules;
  buildings?: PlacedBuilding[];
  units?: PlacedUnits[];
}

/** v1 — what the first release wrote (and what TG1. codes carry). */
export interface LevelDataV1 {
  v: 1;
  name: string;
  author: string;
  desc: string;
  terrain: string;
  trees: number[];
  monuments: Array<{ x: number; z: number; spell: SpellId; mode?: 'teach' | 'gift'; charges?: number; cooldown?: number }>;
  homes: { player: Pt; red: Pt };
  wildmen: number[];
  redCiv?: CivId;
}

export type AnyLevelData = LevelData | LevelDataV1;

/**
 * Shape check for a level's scenario rules (they arrive in pasted codes):
 * throws a readable error instead of letting a hand-edited code crash the
 * loader halfway through. Checks structure and ids, not balance.
 */
export function validateRules(rules: unknown): void {
  const r = rules as ScenarioRules;
  const fail = (why: string) => {
    throw new Error(`Level rules are damaged: ${why}`);
  };
  if (!r || typeof r !== 'object') fail('not an object');
  if (!Array.isArray(r.tribes) || r.tribes.length === 0) fail('no tribes');
  if (!r.tribes.some((t) => t?.id === 'player')) fail('no player tribe');
  for (const t of r.tribes) {
    if (!TRIBE_IDS.includes(t?.id)) fail(`unknown tribe ${String(t?.id)}`);
    for (const s of t.loadout?.spells ?? []) if (!SPELLS.some((d) => d.id === s)) fail(`unknown spell ${s}`);
    for (const b of t.loadout?.buildings ?? []) if (!BUILDINGS[b]) fail(`unknown building ${b}`);
    for (const b of t.loadout?.startBuildings ?? []) if (!BUILDINGS[b]) fail(`unknown building ${b}`);
    for (const u of Object.keys(t.loadout?.startUnits ?? {})) if (!UNITS[u as UnitKind]) fail(`unknown unit ${u}`);
    for (const k of [...Object.keys(t.loadout?.extraCharges ?? {}), ...Object.keys(t.loadout?.chargeCost ?? {}), ...Object.keys(t.loadout?.gifts ?? {})]) {
      if (!SPELLS.some((d) => d.id === k)) fail(`unknown spell ${k}`);
    }
  }
  if (!Array.isArray(r.objectives)) fail('no objectives');
  if (!r.briefing || typeof r.briefing.title !== 'string' || !Array.isArray(r.briefing.tips)) fail('no briefing');
  for (const e of r.events ?? []) {
    if (!e?.when || !Array.isArray(e.actions)) fail('a scripted event has no trigger or actions');
    for (const a of e.actions) {
      if ('spell' in a && !SPELLS.some((d) => d.id === a.spell)) fail(`unknown spell ${a.spell}`);
      if (a.type === 'spawn') for (const u of Object.keys(a.units ?? {})) if (!UNITS[u as UnitKind]) fail(`unknown unit ${u}`);
    }
  }
}

/** Bring any known version up to v2. v2 documents pass through untouched (their rules are shape-checked). */
export function migrateLevel(level: AnyLevelData): LevelData {
  if (level.v === 2) {
    if (level.rules !== undefined) validateRules(level.rules);
    for (const m of level.monuments ?? []) if (!SPELLS.some((d) => d.id === m.spell)) throw new Error(`Level has a stone of unknown spell ${m.spell}`);
    return level;
  }
  if (level.v !== 1) throw new Error('Level is from an unknown version');
  const out: LevelData = {
    v: 2,
    name: level.name,
    author: level.author,
    desc: level.desc,
    terrain: level.terrain,
    trees: level.trees,
    monuments: level.monuments.map((m) => ({ ...m, mode: m.mode ?? 'teach' })),
    homes: { player: { ...level.homes.player }, red: { ...level.homes.red } },
    wildmen: level.wildmen,
  };
  if (level.redCiv) out.civs = { red: level.redCiv };
  return out;
}

const CODE_PREFIX = 'TG2.';
const LEGACY_PREFIXES = ['TG1.'];

// ---------------------------------------------------------------------------
// Terrain packing
// ---------------------------------------------------------------------------

export async function packTerrain(heights: Float32Array): Promise<string> {
  // Quantize, then DELTA-ENCODE: store each value as its difference from
  // the previous one. Terrain is smooth, so the deltas are tiny numbers
  // clustered around zero — far more repetitive than the raw values, and
  // repetition is exactly what deflate compresses. This one line of
  // preprocessing cuts share codes to a fraction of their raw size; it's
  // the same idea PNG filters use before compressing image rows.
  const q = new Int16Array(heights.length);
  let prev = 0;
  for (let i = 0; i < heights.length; i++) {
    const v = Math.round(heights[i] * 128);
    q[i] = v - prev;
    prev = v;
  }
  const deflated = await pump(new Uint8Array(q.buffer), new CompressionStream('deflate-raw'));
  return bytesToBase64(deflated);
}

export async function unpackTerrain(packed: string): Promise<Float32Array> {
  const inflated = await pump(base64ToBytes(packed), new DecompressionStream('deflate-raw'));
  const q = new Int16Array(inflated.buffer, 0, WORLD_SIZE * WORLD_SIZE);
  const heights = new Float32Array(q.length);
  let acc = 0;
  for (let i = 0; i < q.length; i++) {
    acc += q[i]; // undo the delta chain
    heights[i] = acc / 128;
  }
  return heights;
}

/** Run bytes through a (de)compression stream and collect the result. */
async function pump(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Share codes
// ---------------------------------------------------------------------------

export async function levelToCode(level: LevelData): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(level));
  const deflated = await pump(bytes, new CompressionStream('deflate-raw'));
  return CODE_PREFIX + bytesToBase64(deflated);
}

/** Throws on anything that isn't a valid code — callers show the error. TG1. codes are migrated. */
export async function codeToLevel(code: string): Promise<LevelData> {
  const trimmed = code.trim();
  const prefix = [CODE_PREFIX, ...LEGACY_PREFIXES].find((p) => trimmed.startsWith(p));
  if (!prefix) throw new Error('Not a Tribal Gods level code (missing TG2. prefix)');
  let level: AnyLevelData;
  try {
    const inflated = await pump(base64ToBytes(trimmed.slice(prefix.length)), new DecompressionStream('deflate-raw'));
    level = JSON.parse(new TextDecoder().decode(inflated)) as AnyLevelData;
  } catch {
    throw new Error('Level code is damaged');
  }
  if ((level.v !== 1 && level.v !== 2) || !level.terrain || !level.homes?.player) {
    throw new Error('Level code is damaged or from an unknown version');
  }
  return migrateLevel(level);
}

// ---------------------------------------------------------------------------
// Base64 helpers (the built-ins want "binary strings"; wrap the awkwardness)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // String.fromCharCode has argument-count limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
