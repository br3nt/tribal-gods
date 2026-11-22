/**
 * ui/format.ts — numbers and states turned into words a player reads.
 *
 * Every panel formats time, rates and "what is this person doing?" the
 * same way because they all come through here. Pure functions (tested in
 * test/ui-format.test.ts).
 */

import { BUILDINGS, DWELLING_TIERS, spellDef, UNITS } from '../sim/catalog';
import type { Building, Unit } from '../sim/world-state';
import { tr } from '../i18n';

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
  return `${v} ${v === 1 ? tr('tile') : tr('tiles')}`;
}

/** 0 → "Instant", 2.5 → "2.5s". */
export function fmtSeconds(n: number): string {
  return n <= 0 ? tr('Instant') : `${Math.round(n * 10) / 10}s`;
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
  if (u.hp <= 0) return tr('Fallen');
  if (u.lifted > 0) return tr('Caught in the wind');
  if (u.pacified > 0) return tr('Spellbound by a chant');
  if (u.castSpell) return u.state === 'working' ? tr('Casting {0}', spellDef(u.castSpell).name) : tr('Going to cast {0}', spellDef(u.castSpell).name);
  if (u.garrison >= 0 || (u.hidden && u.state === 'inside')) {
    if (insideKind === 'shrine') return tr('Praying at the shrine');
    if (insideKind === 'tower') return tr('Manning the watchtower');
    if (insideKind && BUILDINGS[insideKind as keyof typeof BUILDINGS]?.trains) return tr('In training');
    return tr('At home');
  }
  switch (u.task) {
    case 'chop':
      return u.state === 'working' ? tr('Felling a tree') : tr('Going to fell a tree');
    case 'deliverWood':
      return tr('Hauling wood');
    case 'build':
      return u.state === 'working' ? tr('Building') : tr('Going to build');
    case 'goHome':
      return tr('Heading home');
    case 'train':
      return tr('Going to train');
    case 'attack':
      return u.state === 'fighting' ? tr('Fighting') : tr('Charging an enemy');
    case 'attackBuilding':
      return u.state === 'fighting' ? tr('Wrecking a building') : tr('Marching on a building');
    case 'worship':
      return u.state === 'working' ? tr('Communing with a stone') : tr('Going to a standing stone');
    case 'garrison':
      return tr('Heading inside');
    case 'chant':
      return tr('Chanting');
    default:
      break;
  }
  if (u.state === 'fighting') return tr('Fighting');
  if (u.state === 'moving') return u.carrying ? tr('Hauling wood') : tr('Walking');
  if (u.kind === 'brave') return tr('Idle');
  if (u.kind === 'shaman') return tr('Ready to cast');
  return UNITS[u.kind].sight > 0 ? tr('Standing guard') : tr('Waiting');
}
