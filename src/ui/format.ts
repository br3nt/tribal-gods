/**
 * ui/format.ts — numbers and states turned into words a player reads.
 *
 * Every panel formats time, rates and "what is this person doing?" the
 * same way because they all come through here. Pure functions (tested in
 * test/ui-format.test.ts).
 */

import { BUILDINGS, DWELLING_TIERS, spellDef, UNITS } from '../sim/catalog';
import type { Building, Unit } from '../sim/world-state';

/** 75 → "1:15", 3725 → "1:02:05". */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** A countdown: 4.2 → "5s", 95 → "1m 35s", Infinity → "—". */
export function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

/** ETA that fits a spell slot: "45s", "2m 05s", then whole minutes from ten ("14m"). */
export function fmtEtaShort(seconds: number): string {
  if (Number.isFinite(seconds) && seconds >= 600) return `${Math.ceil(seconds / 60)}m`;
  return fmtEta(seconds);
}

/** Mana per second, one decimal: 1.53 → "+1.5/s". */
export function fmtRate(perSecond: number): string {
  return `+${(Math.round(perSecond * 10) / 10).toFixed(1)}/s`;
}

/** 1 → "1 tile", 4.5 → "4.5 tiles". */
export function fmtTiles(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v} ${v === 1 ? 'tile' : 'tiles'}`;
}

/** 0 → "Instant", 2.5 → "2.5s". */
export function fmtSeconds(n: number): string {
  return n <= 0 ? 'Instant' : `${Math.round(n * 10) / 10}s`;
}

/** Player-facing name of a building (dwellings by their tier). */
export function buildingName(b: Pick<Building, 'kind' | 'tier'>): string {
  return b.kind === 'hut' ? DWELLING_TIERS[Math.max(0, Math.min(2, b.tier))].name : BUILDINGS[b.kind].name;
}

type ActivityUnit = Pick<
  Unit,
  'kind' | 'state' | 'task' | 'carrying' | 'castSpell' | 'garrison' | 'hidden' | 'pacified' | 'lifted' | 'hp'
>;

/**
 * "What is this person doing?" in a few words. `buildingKindOf` resolves
 * the building a garrisoned unit is inside (null if unknown).
 */
export function activityText(u: ActivityUnit, insideKind: string | null = null): string {
  if (u.hp <= 0) return 'Fallen';
  if (u.lifted > 0) return 'Caught in the wind';
  if (u.pacified > 0) return 'Spellbound by a chant';
  if (u.castSpell) return u.state === 'working' ? `Casting ${spellDef(u.castSpell).name}` : `Going to cast ${spellDef(u.castSpell).name}`;
  if (u.garrison >= 0 || (u.hidden && u.state === 'inside')) {
    if (insideKind === 'shrine') return 'Praying at the shrine';
    if (insideKind === 'tower') return 'Manning the watchtower';
    if (insideKind && BUILDINGS[insideKind as keyof typeof BUILDINGS]?.trains) return 'In training';
    return 'At home';
  }
  switch (u.task) {
    case 'chop':
      return u.state === 'working' ? 'Felling a tree' : 'Going to fell a tree';
    case 'deliverWood':
      return 'Hauling wood';
    case 'build':
      return u.state === 'working' ? 'Building' : 'Going to build';
    case 'goHome':
      return 'Heading home';
    case 'train':
      return 'Going to train';
    case 'attack':
      return u.state === 'fighting' ? 'Fighting' : 'Charging an enemy';
    case 'attackBuilding':
      return u.state === 'fighting' ? 'Wrecking a building' : 'Marching on a building';
    case 'worship':
      return u.state === 'working' ? 'Communing with a stone' : 'Going to a standing stone';
    case 'garrison':
      return 'Heading inside';
    case 'chant':
      return 'Chanting';
    default:
      break;
  }
  if (u.state === 'fighting') return 'Fighting';
  if (u.state === 'moving') return u.carrying ? 'Hauling wood' : 'Walking';
  if (u.kind === 'brave') return 'Idle';
  if (u.kind === 'shaman') return 'Ready to cast';
  return UNITS[u.kind].sight > 0 ? 'Standing guard' : 'Waiting';
}
