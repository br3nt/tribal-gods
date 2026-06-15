/**
 * level/level-format.ts — what a level IS, and how it travels.
 *
 * A level is a JSON document: metadata, both tribes' home tiles, monument
 * placements, trees, wildmen — and the terrain. The terrain is the bulky
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
 * a "TG1." version prefix, Factorio-blueprint style: anyone can paste a
 * planet to anyone. The same format is what we store in localStorage and
 * what an online level server would store someday — design the document
 * first and every transport gets it for free.
 */

import { CivId, WORLD_SIZE } from '../config';
import { SpellId } from '../sim/spells';

export interface LevelData {
  /** Format version — lets a future loader migrate old levels. */
  v: 1;
  name: string;
  author: string;
  desc: string;
  /** Base64 of deflated Int16 heights (see header). */
  terrain: string;
  /** Flat [x,z, x,z, ...] tile pairs. */
  trees: number[];
  monuments: Array<{ x: number; z: number; spell: SpellId }>;
  homes: { player: { x: number; z: number }; red: { x: number; z: number } };
  wildmen: number[]; // flat [x,z] pairs
  /** Suggested enemy civ (cosmetic); omit for random. */
  redCiv?: CivId;
}

const CODE_PREFIX = 'TG1.';

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

/** Throws on anything that isn't a valid code — callers show the error. */
export async function codeToLevel(code: string): Promise<LevelData> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CODE_PREFIX)) throw new Error('Not a Tribal Gods level code (missing TG1. prefix)');
  const inflated = await pump(base64ToBytes(trimmed.slice(CODE_PREFIX.length)), new DecompressionStream('deflate-raw'));
  const level = JSON.parse(new TextDecoder().decode(inflated)) as LevelData;
  if (level.v !== 1 || !level.terrain || !level.homes) throw new Error('Level code is damaged or from an unknown version');
  return level;
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
