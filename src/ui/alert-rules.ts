/**
 * ui/alert-rules.ts — "what just happened that the player should know?"
 *
 * The sim's event list says WHAT happened WHERE but not to WHOM, so alerts
 * are derived the robust way: snapshot the player's side of the world a
 * few times a second and diff consecutive snapshots. A unit whose hp went
 * down is under attack; a building whose tier went up grew; a spell that
 * appeared in `known` was learned; a charge that vanished was cast.
 *
 * Pure (no DOM, no World import) so the rules are unit-tested in
 * test/ui-alerts.test.ts; ui/alerts.ts builds snapshots and draws the feed.
 */

import { BuildingKind, DWELLING_TIERS, BUILDINGS, spellDef, SpellId } from '../sim/catalog';

export interface Snapshot {
  /** Sim seconds. */
  t: number;
  leaderAlive: boolean;
  known: SpellId[];
  /** charges + gifted per spell (a drop = a cast). */
  casts: Partial<Record<SpellId, number>>;
  gifted: Partial<Record<SpellId, number>>;
  units: Map<number, { hp: number; x: number; z: number }>;
  buildings: Map<number, { kind: BuildingKind; hp: number; tier: number; burning: boolean; done: boolean; x: number; z: number }>;
  objectives: Array<{ text: string; done: boolean }>;
  population: number;
  /** Rituals under way at standing stones (optional: older snapshots have none). */
  rituals?: Array<{ index: number; tribe: string; who: string; spell: SpellId; x: number; z: number }>;
}

export type AlertKind = 'attack' | 'leaderDown' | 'leaderBack' | 'learned' | 'gift' | 'grew' | 'burning' | 'built' | 'lost' | 'objective' | 'ritual' | 'ritualBroken';

export interface Alert {
  kind: AlertKind;
  text: string;
  tone: 'bad' | 'good' | 'info';
  x?: number;
  z?: number;
}

/** Remembered between diffs so "under attack" doesn't fire every quarter second. */
export interface AlertMemory {
  attacks: Array<{ x: number; z: number; t: number }>;
}

/** Seconds before another attack alert may fire within ATTACK_AREA tiles of the last. */
export const ATTACK_COOLDOWN = 20;
export const ATTACK_AREA = 16;

function near(ax: number, az: number, bx: number, bz: number, r: number, size = 128): boolean {
  const w = (d: number) => {
    const m = ((d % size) + size) % size;
    return m > size / 2 ? m - size : m;
  };
  return Math.hypot(w(ax - bx), w(az - bz)) < r;
}

/** Alerts implied by going from `a` to `b`. Mutates `mem` (attack throttle). */
export function deriveAlerts(a: Snapshot, b: Snapshot, mem: AlertMemory): Alert[] {
  const out: Alert[] = [];

  // --- Under attack: any of ours lost hp ---
  let hit: { x: number; z: number } | null = null;
  for (const [id, u] of b.units) {
    const was = a.units.get(id);
    if (was && u.hp < was.hp - 0.01) {
      hit = { x: u.x, z: u.z };
      break;
    }
  }
  if (!hit) {
    for (const [id, bl] of b.buildings) {
      const was = a.buildings.get(id);
      if (was && was.done && bl.hp < was.hp - 0.01) {
        hit = { x: bl.x, z: bl.z };
        break;
      }
    }
  }
  if (hit) {
    mem.attacks = mem.attacks.filter((p) => b.t - p.t < ATTACK_COOLDOWN);
    if (!mem.attacks.some((p) => near(p.x, p.z, hit!.x, hit!.z, ATTACK_AREA))) {
      mem.attacks.push({ ...hit, t: b.t });
      out.push({ kind: 'attack', text: 'Your people are under attack', tone: 'bad', ...hit });
    }
  }

  // --- Leader ---
  if (a.leaderAlive && !b.leaderAlive) out.push({ kind: 'leaderDown', text: 'Your leader has fallen', tone: 'bad' });
  if (!a.leaderAlive && b.leaderAlive) out.push({ kind: 'leaderBack', text: 'Your leader has returned', tone: 'good' });

  // --- Spells learned / gifted ---
  for (const id of b.known) {
    if (!a.known.includes(id)) out.push({ kind: 'learned', text: `Learned ${spellDef(id).name}`, tone: 'good' });
  }
  for (const [id, n] of Object.entries(b.gifted) as Array<[SpellId, number]>) {
    const was = a.gifted[id] ?? 0;
    if (n > was) out.push({ kind: 'gift', text: `A stone lends you ${n - was}× ${spellDef(id).name}`, tone: 'good' });
  }

  // --- Buildings ---
  for (const [id, bl] of b.buildings) {
    const was = a.buildings.get(id);
    if (!was) continue;
    if (bl.done && !was.done) out.push({ kind: 'built', text: `${BUILDINGS[bl.kind].name} finished`, tone: 'info', x: bl.x, z: bl.z });
    if (bl.kind === 'hut' && bl.tier > was.tier) {
      out.push({ kind: 'grew', text: `A dwelling grew into a ${DWELLING_TIERS[Math.min(2, bl.tier)].name}`, tone: 'good', x: bl.x, z: bl.z });
    }
    if (bl.burning && !was.burning) out.push({ kind: 'burning', text: `${BUILDINGS[bl.kind].name} is burning`, tone: 'bad', x: bl.x, z: bl.z });
  }
  for (const [id, was] of a.buildings) {
    if (!b.buildings.has(id) && was.done) {
      out.push({ kind: 'lost', text: `${BUILDINGS[was.kind].name} lost`, tone: 'bad', x: was.x, z: was.z });
    }
  }

  // --- Rituals at the stones ---
  const ra = a.rituals ?? [];
  const rb = b.rituals ?? [];
  for (const r of rb) {
    if (r.tribe === 'player' || ra.some((x) => x.index === r.index && x.tribe === r.tribe)) continue;
    const name = spellDef(r.spell).name;
    const who = r.who.charAt(0).toUpperCase() + r.who.slice(1);
    out.push({ kind: 'ritual', text: `${who} ${r.who.startsWith('the ') ? 'are' : 'is'} communing at the ${name} stone`, tone: 'bad', x: r.x, z: r.z });
  }
  for (const r of ra) {
    if (r.tribe !== 'player' || rb.some((x) => x.index === r.index && x.tribe === 'player')) continue;
    // Gone without a reward: the ritual was broken.
    const learned = b.known.includes(r.spell) && !a.known.includes(r.spell);
    const lent = (b.gifted[r.spell] ?? 0) > (a.gifted[r.spell] ?? 0);
    if (!learned && !lent) out.push({ kind: 'ritualBroken', text: `Your leader's ritual at the ${spellDef(r.spell).name} stone was broken`, tone: 'bad', x: r.x, z: r.z });
  }

  // --- Objectives ---
  b.objectives.forEach((o, i) => {
    if (o.done && a.objectives[i] && !a.objectives[i].done) out.push({ kind: 'objective', text: `Objective complete: ${o.text}`, tone: 'good' });
  });

  return out;
}

/** How many casts happened between snapshots (charges + gifts that went down). */
export function castsBetween(a: Snapshot, b: Snapshot): number {
  let n = 0;
  for (const [id, now] of Object.entries(b.casts) as Array<[SpellId, number]>) {
    const was = a.casts[id] ?? 0;
    const gainedGift = Math.max(0, (b.gifted[id] ?? 0) - (a.gifted[id] ?? 0));
    if (now < was + gainedGift) n += was + gainedGift - now;
  }
  return n;
}
