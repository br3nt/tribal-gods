/**
 * ui/stones.ts — what the interface knows about standing stones.
 *
 * Communing is a RITUAL (sim catalog COMMUNE): the leader kneels at the
 * stone for 10–35 s by tier, takes extra damage meanwhile, any hit breaks
 * it (the progress then drains slowly, so a guarded leader can resume), and
 * hostile fighters inside the ring hold it still (CONTESTED). Some stones
 * have GUARDIANS that wake when a ritual begins. The sim publishes it all on
 * the monument — `communeProgress`, `communer` (tribe), `communerId`,
 * `communing`, `contested`, `guardsAwake`, `guards`, `asleep` — and every
 * panel, marker, tooltip and alert asks THIS module, so there is one place
 * that knows the shape. Fields are read defensively (old saves lack them).
 */

import { communeSecondsFor, spellDef, Tribe, tribeName, TribeId, UNITS, UnitKind } from '../sim/catalog';
import type { Monument, World } from '../sim/world-state';
import { fmtSeconds } from './format';

export interface Ritual {
  tribe: Tribe;
  /** 0..1 */
  progress: number;
  /** The leader performing it (null = nobody kneels: the progress is draining). */
  unit: number | null;
  /** Live (kneeling) — a broken ritual keeps draining progress with communing false. */
  communing: boolean;
  /** Hostile fighters in the ring are holding it still. */
  contested: boolean;
}

/** How long communing at this stone takes, in seconds. */
export function ritualSeconds(m: Monument): number {
  return communeSecondsFor(m);
}

/** The ritual under way (or left half-done and draining) at stone `index`, or null. */
export function ritualAt(world: World, index: number): Ritual | null {
  const m = world.monuments[index];
  if (!m) return null;
  const progress = m.communeProgress ?? 0;
  const tribe = typeof m.communer === 'string' ? m.communer : null;
  if (!tribe || (progress <= 0 && !m.communing)) return null;
  const unit = m.communerId !== undefined && m.communerId >= 0 ? m.communerId : null;
  return { tribe, progress: Math.max(0, Math.min(1, progress)), unit, communing: !!m.communing, contested: !!m.contested };
}

/** The ritual this unit is performing, if any. */
export function ritualOf(world: World, unitId: number): { index: number; ritual: Ritual } | null {
  const index = world.monuments.findIndex((m) => m.communerId === unitId && m.communing);
  if (index < 0) return null;
  const r = ritualAt(world, index);
  return r ? { index, ritual: r } : null;
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

/** The guardians' line for a tooltip, or null when the stone has none. */
export function stoneGuards(m: Monument): string | null {
  const g = m.guards ? (Object.entries(m.guards) as Array<[UnitKind, number]>).filter(([, n]) => n > 0) : [];
  if (g.length === 0) return null;
  const who = g.map(([k, n]) => `${n} ${UNITS[k].name}${n === 1 ? '' : 's'}`).join(', ');
  return m.guardsAwake ? `Guarded — ${who}, awake and fighting!` : `Guarded — ${who} wake when a ritual begins`;
}

/** Why the stone can't be communed with now, or null. */
export function stoneBlocked(world: World, m: Monument): string | null {
  if (world.monumentAvailable(m)) return null;
  if (m.asleep) return 'Asleep — not yet awake to anyone';
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
