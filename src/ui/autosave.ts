/**
 * ui/autosave.ts — the one saved game behind the title screen's Continue.
 *
 * main.ts writes it whenever play stops being watched: the in-game menu
 * opens, you quit to the title, the tab is hidden or closed — and once a
 * minute while you play. A finished game clears it. The world itself is
 * serialised by sim/save.ts; this file adds what the shell needs to pick
 * up where you left off (which campaign chapter, or the level document so
 * Restart still works) and keeps it in localStorage.
 */

import type { LevelData } from '../level/level-format';
import { SaveData, validateSave } from '../sim/save';

const KEY = 'tg.save.v1';

export interface SavedGame {
  v: 1;
  /** What kind of game: a random skirmish, a campaign chapter, or any other level. */
  kind: 'skirmish' | 'campaign' | 'level';
  /** Campaign chapter id (kind 'campaign'). */
  campaign?: string;
  /** The level document (kind 'level'), so Restart replays it. */
  level?: LevelData;
  /** Shown on the Continue button. */
  label: string;
  world: SaveData;
  /** The game-over numbers so far (ui/alerts.ts GameTally), so Continue doesn't start them over. */
  tally?: { peakPopulation: number; spellsCast: number };
}

/** The saved tally if it is well-formed, else null (an old save without one still loads). */
export function savedTally(g: SavedGame): { peakPopulation: number; spellsCast: number } | null {
  const t = g.tally;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return t && ok(t.peakPopulation) && ok(t.spellsCast) ? { peakPopulation: t.peakPopulation, spellsCast: t.spellsCast } : null;
}

export function writeSave(game: SavedGame): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(game));
    return true;
  } catch {
    clearSave(); // storage full or blocked: never leave an older, unrelated game behind Continue
    return false;
  }
}

export function readSave(): SavedGame | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as SavedGame;
    if (g?.v !== 1 || !['skirmish', 'campaign', 'level'].includes(g.kind) || typeof g.label !== 'string' || !validateSave(g.world)) {
      clearSave();
      return null;
    }
    return g;
  } catch {
    clearSave();
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

/** "12:04" from seconds. */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
