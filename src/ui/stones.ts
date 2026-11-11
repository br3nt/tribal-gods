/**
 * ui/stones.ts — what the interface knows about standing stones.
 *
 * Communing is a RITUAL: the leader stands at the stone for a while
 * (longer for stronger spells), can be interrupted by damage, and a rival
 * can contest it. The sim exposes that on the monument as
 * `communeProgress` (0..1) and `communer` (the tribe at it), plus a
 * `communeSeconds` length. Those fields are read defensively here: until a
 * sim build provides them, the same answer is derived from the leader
 * standing at the stone (task 'worship', state 'working', workTimer
 * counting down from WORSHIP_SECONDS). Every panel, marker, tooltip and
 * alert asks THIS module, so there is one place that knows the shape.
 */

import { WORSHIP_SECONDS } from '../config';
import { spellDef, Tribe, tribeName, TribeId } from '../sim/catalog';
import type { Monument, World } from '../sim/world-state';
import { fmtSeconds } from './format';

/** The ritual fields the sim may add to a monument. */
interface RitualFields {
  communeProgress?: number;
  communer?: Tribe | null;
  communeSeconds?: number;
}

export interface Ritual {
  tribe: Tribe;
  /** 0..1 */
  progress: number;
  /** The unit performing it, when we can tell. */
  unit: number | null;
}

/** How long communing at this stone takes, in seconds. */
export function ritualSeconds(m: Monument): number {
  const s = (m as Monument & RitualFields).communeSeconds;
  return typeof s === 'number' && s > 0 ? s : WORSHIP_SECONDS;
}

/** The ritual under way at stone `index`, or null. */
export function ritualAt(world: World, index: number): Ritual | null {
  const m = world.monuments[index] as (Monument & RitualFields) | undefined;
  if (!m) return null;
  const performer = world.units.find((u) => u.task === 'worship' && u.targetMonument === index && u.state === 'working' && !u.hidden);
  if (typeof m.communeProgress === 'number' && m.communer) {
    if (m.communeProgress <= 0 && !performer) return null;
    return { tribe: m.communer, progress: Math.max(0, Math.min(1, m.communeProgress)), unit: performer?.id ?? null };
  }
  if (!performer) return null;
  const total = ritualSeconds(m);
  return { tribe: performer.tribe, progress: Math.max(0, Math.min(1, 1 - performer.workTimer / total)), unit: performer.id };
}

/** The ritual this unit is performing, if any. */
export function ritualOf(world: World, unitId: number): { index: number; ritual: Ritual } | null {
  const u = world.unitById(unitId);
  if (!u || u.task !== 'worship') return null;
  const r = ritualAt(world, u.targetMonument);
  return r ? { index: u.targetMonument, ritual: r } : null;
}

/** "Lightning stone" */
export function stoneName(m: Monument): string {
  return `${spellDef(m.spell).name} stone`;
}

/** One line: what it holds and on what terms. */
export function stoneTerms(m: Monument): string {
  return m.mode === 'teach'
    ? `Teaches ${spellDef(m.spell).name} for good`
    : `Lends ${m.charges ?? 2} free cast${(m.charges ?? 2) === 1 ? '' : 's'} of ${spellDef(m.spell).name}`;
}

/** Why the stone can't be communed with now, or null. */
export function stoneBlocked(world: World, m: Monument): string | null {
  if (world.monumentAvailable(m)) return null;
  if (m.mode === 'teach' && m.claimedBy) return m.claimedBy === 'player' ? 'Your tribe already learned it here' : 'Already claimed';
  if (m.sleep > 0) return `Sleeping — wakes in ${fmtSeconds(Math.ceil(m.sleep))}`;
  if (m.opensAt && world.elapsed < m.opensAt) return `Wakes in ${fmtSeconds(Math.ceil(m.opensAt - world.elapsed))}`;
  return 'Not open now';
}

/** Display name for a tribe ("the Ashmark", "your tribe"). */
export function tribeLabelOf(world: World, t: Tribe): string {
  if (t === 'wild') return 'wanderers';
  return tribeName(world.rules, t as TribeId);
}
