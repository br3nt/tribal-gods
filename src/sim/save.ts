/**
 * sim/save.ts — save and resume an in-progress game.
 *
 * saveWorld() turns a live World into plain JSON-able data; restoreWorld()
 * pours that data back into an EXISTING World (main.ts holds one instance
 * shared with the renderers, so we mutate rather than replace). The contract
 * is determinism: a restored world ticks forward exactly as the original
 * would have (test/save.test.ts proves it).
 *
 * What needs care beyond "copy the plain data":
 *   - the heightmap: a Float32Array, stored as base64 of its bytes;
 *   - Sets and Maps (tribe spell/building sets, swamp, unreachable, a sink
 *     job's `base`): stored as arrays IN INSERTION ORDER, since the sim
 *     iterates some of them;
 *   - shared identity: a tribe's `unlocked` IS its `known` Set, and a job's
 *     `aura` IS an entry of world.auras (the job moves it) — stored as an
 *     index and re-linked on restore;
 *   - the building obstacle set (pathfinding's, keyed by the heightmap):
 *     stored verbatim rather than rebuilt from footprints, so overlapping
 *     clears and door tiles come back exactly;
 *   - the Rng state (`rng.s`).
 *
 * world.events is NOT saved: it is a one-way queue the renderer drains
 * each frame and the sim never reads it.
 */

import { WORLD_SIZE } from '../config';
import type { BuildingKind, SpellId, TribeId } from './catalog';
import type { Aura, SpellJob } from './spells';
import type { SpellBook } from './spellbook';
import type { AiState, Building, GameSettings, Monument, Tree, TribeState, Unit, World } from './world-state';

export const SAVE_VERSION = 1;

export interface SavedTribe extends Omit<TribeState, 'known' | 'unlocked' | 'allowed' | 'everBuilt'> {
  known: SpellId[];
  /** Omitted when `unlocked` is the same Set as `known` (always, today). */
  unlocked?: SpellId[];
  allowed: BuildingKind[];
  everBuilt: BuildingKind[];
}

export interface SavedJob extends Omit<SpellJob, 'aura' | 'base'> {
  /** Index into SaveData.auras of the job's own aura (the same object), or an inline copy if it isn't listed. */
  aura?: number | Aura;
  base?: Array<[number, number]>;
}

export interface SaveData {
  v: 1;
  /** Wall-clock ms when saved (for a "Continue — saved 3 min ago" label). */
  savedAt: number;
  /** base64 of the heightmap's Float32Array bytes (little-endian). */
  heights: string;
  units: Unit[];
  /** Flat [x, z, alive 0|1, regrow, burning] per tree. */
  trees: number[];
  buildings: Building[];
  monuments: Monument[];
  tribes: Partial<Record<TribeId, SavedTribe>>;
  settings: GameSettings;
  rules: World['rules'];
  jobs: SavedJob[];
  auras: Aura[];
  swamp: Array<[number, number]>;
  objectives: World['objectives'];
  objectiveMemory: World['objectiveMemory'];
  gameOver: World['gameOver'];
  gameOverReason: string | null;
  elapsed: number;
  messages: World['messages'];
  messageSeq: number;
  eventMemory: World['eventMemory'];
  /** Boats still running in (absent in saves from before landings had a lead). */
  landings?: World['landings'];
  rng: number;
  nextId: number;
  unreachable: Array<[string, number]>;
  levelExtras: World['levelExtras'];
  obstacles: number[];
}

/** Deep copy of plain data (no Sets/Maps/typed arrays inside). */
const plain = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

// ---------------------------------------------------------------------------
// base64 for typed-array bytes (btoa/atob: browsers and Node 18+)
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const HEIGHT_BYTES = WORLD_SIZE * WORLD_SIZE * 4;

function encodeHeights(h: Float32Array): string {
  const bytes = new Uint8Array(HEIGHT_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < h.length; i++) view.setFloat32(i * 4, h[i], true);
  return bytesToBase64(bytes);
}

function decodeHeights(b64: string, into: Float32Array): void {
  const bytes = base64ToBytes(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < into.length; i++) into[i] = view.getFloat32(i * 4, true);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function saveTribe(t: TribeState): SavedTribe {
  const { known, unlocked, allowed, everBuilt, ...rest } = t;
  const out: SavedTribe = {
    ...plain(rest),
    known: [...known],
    allowed: [...allowed],
    everBuilt: [...everBuilt],
  };
  if (unlocked !== known) out.unlocked = [...unlocked];
  return out;
}

function saveJob(j: SpellJob, auras: Aura[]): SavedJob {
  const { aura, base, ...rest } = j;
  const out: SavedJob = plain(rest);
  if (aura) {
    const i = auras.indexOf(aura);
    out.aura = i >= 0 ? i : plain(aura);
  }
  if (base) out.base = [...base];
  return out;
}

export function saveWorld(world: World): SaveData {
  const trees: number[] = [];
  for (const t of world.trees) trees.push(t.x, t.z, t.alive ? 1 : 0, t.regrow, t.burning);
  const tribes: SaveData['tribes'] = {};
  for (const id of world.activeTribes()) tribes[id] = saveTribe(world.tribes[id]!);
  return {
    v: 1,
    savedAt: Date.now(),
    heights: encodeHeights(world.map.heights),
    units: plain(world.units),
    trees,
    buildings: plain(world.buildings),
    monuments: plain(world.monuments),
    tribes,
    settings: plain(world.settings),
    rules: plain(world.rules),
    jobs: world.jobs.map((j) => saveJob(j, world.auras)),
    auras: plain(world.auras),
    swamp: [...world.swamp],
    objectives: plain(world.objectives),
    objectiveMemory: plain(world.objectiveMemory),
    gameOver: world.gameOver,
    gameOverReason: world.gameOverReason,
    elapsed: world.elapsed,
    messages: plain(world.messages),
    messageSeq: world.messageSeq,
    eventMemory: plain(world.eventMemory),
    landings: plain(world.landings),
    rng: world.rng.s,
    nextId: world.nextId,
    unreachable: [...world.unreachable],
    levelExtras: plain(world.levelExtras),
    obstacles: [...world.obstacles],
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function restoreTribe(s: SavedTribe): TribeState {
  const { known, unlocked, allowed, everBuilt, ...rest } = plain(s);
  const knownSet = new Set<SpellId>(known);
  return {
    ...rest,
    spells: rest.spells as SpellBook,
    ai: rest.ai as AiState | null,
    known: knownSet,
    unlocked: unlocked ? new Set<SpellId>(unlocked) : knownSet,
    allowed: new Set<BuildingKind>(allowed),
    everBuilt: new Set<BuildingKind>(everBuilt),
  };
}

/** Pour a save into an existing World (its map and identity stay; everything else is replaced). */
export function restoreWorld(world: World, data: SaveData): void {
  const d = plain(data);
  decodeHeights(d.heights, world.map.heights);
  world.map.version++;

  world.units = d.units;
  const trees: Tree[] = [];
  for (let i = 0; i + 4 < d.trees.length; i += 5) {
    trees.push({ x: d.trees[i], z: d.trees[i + 1], alive: d.trees[i + 2] === 1, regrow: d.trees[i + 3], burning: d.trees[i + 4] });
  }
  world.trees = trees;
  world.treesVersion++;
  world.buildings = d.buildings;
  world.monuments = d.monuments;

  world.tribes = {};
  for (const [id, t] of Object.entries(d.tribes) as Array<[TribeId, SavedTribe]>) world.tribes[id] = restoreTribe(t);

  world.settings = d.settings;
  world.rules = d.rules;
  world.auras = d.auras;
  world.jobs = d.jobs.map((sj) => {
    const { aura, base, ...rest } = sj;
    const job: SpellJob = { ...rest };
    if (aura !== undefined) job.aura = typeof aura === 'number' ? world.auras[aura] : aura;
    if (base) job.base = new Map(base);
    return job;
  });
  world.swamp.clear();
  for (const [k, v] of d.swamp) world.swamp.set(k, v);

  world.objectives = d.objectives;
  world.objectiveMemory = d.objectiveMemory;
  world.gameOver = d.gameOver;
  world.gameOverReason = d.gameOverReason;
  world.elapsed = d.elapsed;
  world.messages = d.messages;
  world.messageSeq = d.messageSeq;
  world.eventMemory = d.eventMemory;
  world.landings = d.landings ?? [];
  world.events = [];
  world.rng.s = d.rng >>> 0;
  world.nextId = d.nextId;
  world.unreachable = new Map(d.unreachable);
  world.levelExtras = d.levelExtras ?? {};

  const obstacles = world.obstacles;
  obstacles.clear();
  for (const i of d.obstacles) obstacles.add(i);
}

// ---------------------------------------------------------------------------
// Validation: reject a corrupt or foreign save instead of crashing on it
// ---------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isArr = Array.isArray;
const numArr = (x: unknown) => isArr(x) && x.every(isNum);
const pairs = (x: unknown, key: (k: unknown) => boolean) =>
  isArr(x) && x.every((p) => isArr(p) && p.length === 2 && key(p[0]) && isNum(p[1]));
const TRIBES = ['player', 'red', 'gold', 'violet'];

function validUnit(u: unknown): boolean {
  return isObj(u) && isNum(u.id) && isStr(u.kind) && isStr(u.tribe) && isNum(u.x) && isNum(u.z) &&
    isNum(u.hp) && isStr(u.state) && isStr(u.task) && isArr(u.path);
}

function validBuilding(b: unknown): boolean {
  return isObj(b) && isNum(b.id) && isStr(b.tribe) && isStr(b.kind) && isNum(b.x) && isNum(b.z) &&
    (b.size === 3 || b.size === 5) && isNum(b.progress) && isNum(b.hp) && isArr(b.garrison);
}

function validTribe(t: unknown, id: string): boolean {
  if (!isObj(t) || t.id !== id || !isNum(t.wood) || !isObj(t.home) || !isStr(t.civ)) return false;
  if (!isArr(t.known) || !isArr(t.allowed) || !isArr(t.everBuilt) || !isArr(t.allies)) return false;
  if (t.unlocked !== undefined && !isArr(t.unlocked)) return false;
  if (!isObj(t.spells) || !Object.values(t.spells).every((s) => isObj(s) && isNum(s.charges) && isNum(s.mana))) return false;
  if (t.ai !== null && !(isObj(t.ai) && isStr(t.ai.state))) return false;
  return isObj(t.personality);
}

function validJob(j: unknown, auras: number): boolean {
  if (!isObj(j) || !isStr(j.spell) || !isNum(j.x) || !isNum(j.z) || !isNum(j.t) || !isNum(j.duration) || !isStr(j.tribe)) return false;
  if (j.aura !== undefined && !(isNum(j.aura) ? j.aura >= 0 && j.aura < auras : isObj(j.aura))) return false;
  return j.base === undefined || pairs(j.base, isNum);
}

export function validateSave(x: unknown): x is SaveData {
  try {
    if (!isObj(x) || x.v !== SAVE_VERSION) return false;
    if (!isStr(x.heights) || x.heights.length !== Math.ceil(HEIGHT_BYTES / 3) * 4) return false;
    if (base64ToBytes(x.heights).length !== HEIGHT_BYTES) return false;
    if (!isArr(x.units) || !x.units.every(validUnit)) return false;
    if (!numArr(x.trees) || (x.trees as number[]).length % 5 !== 0) return false;
    if (!isArr(x.buildings) || !x.buildings.every(validBuilding)) return false;
    if (!isArr(x.monuments) || !x.monuments.every((m) => isObj(m) && isNum(m.x) && isNum(m.z) && isStr(m.spell))) return false;
    if (!isObj(x.tribes) || !isObj(x.tribes.player)) return false;
    for (const [id, t] of Object.entries(x.tribes)) if (!TRIBES.includes(id) || !validTribe(t, id)) return false;
    if (!isObj(x.settings) || !isStr(x.settings.playerCiv) || !isStr(x.settings.difficulty)) return false;
    if (!isObj(x.rules) || !isArr(x.rules.tribes) || !isArr(x.rules.objectives)) return false;
    if (!isArr(x.auras) || !x.auras.every((a) => isObj(a) && isNum(a.t) && isNum(a.duration))) return false;
    if (!isArr(x.jobs) || !x.jobs.every((j) => validJob(j, (x.auras as unknown[]).length))) return false;
    if (!pairs(x.swamp, isNum) || !pairs(x.unreachable, isStr)) return false;
    if (!isArr(x.objectives) || !isArr(x.objectiveMemory) || !isArr(x.eventMemory) || !isArr(x.messages)) return false;
    if (x.gameOver !== null && x.gameOver !== 'victory' && x.gameOver !== 'defeat') return false;
    if (!isNum(x.elapsed) || !isNum(x.messageSeq) || !isNum(x.rng) || !isNum(x.nextId)) return false;
    if (!numArr(x.obstacles)) return false;
    if (x.levelExtras !== undefined && !isObj(x.levelExtras)) return false;
    return true;
  } catch {
    return false; // atob on non-base64, etc.
  }
}
