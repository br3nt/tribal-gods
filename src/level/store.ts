/**
 * level/store.ts — the level library's shelf: localStorage today, a server
 * someday.
 *
 * Everything the library screen needs is behind these few functions, and
 * none of them know they're talking to localStorage — swap this module's
 * internals for fetch() calls against a level-sharing API and the whole UI
 * comes along for free. That seam is deliberate: design the storage
 * interface around the FEATURE (save, list, rate, import), not the
 * backend you happen to have.
 *
 * Ratings are stored separately from levels, keyed by level id, so you can
 * rate official levels too (they aren't yours to edit, but your opinion of
 * them is yours). With a real backend these become community averages;
 * locally they're your personal stars.
 */

import { LevelData } from './level-format';

export interface StoredLevel {
  id: string;
  level: LevelData;
  /** Milliseconds since epoch, for "newest" sorting. */
  savedAt: number;
}

const LEVELS_KEY = 'tribalgods.levels.v1';
const RATINGS_KEY = 'tribalgods.ratings.v1';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback; // corrupted storage shouldn't brick the game
  }
}

export function listLevels(): StoredLevel[] {
  return read<StoredLevel[]>(LEVELS_KEY, []);
}

/** Insert or overwrite (same id = same level, updated). Returns the id. */
export function saveLevel(level: LevelData, existingId?: string): string {
  const all = listLevels();
  const id = existingId ?? `lvl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const entry: StoredLevel = { id, level, savedAt: Date.now() };
  const i = all.findIndex((s) => s.id === id);
  if (i >= 0) all[i] = entry;
  else all.push(entry);
  localStorage.setItem(LEVELS_KEY, JSON.stringify(all));
  return id;
}

export function deleteLevel(id: string): void {
  localStorage.setItem(LEVELS_KEY, JSON.stringify(listLevels().filter((s) => s.id !== id)));
}

/** Your stars for a level id (official ids included). 0 = unrated. */
export function getRating(id: string): number {
  return read<Record<string, number>>(RATINGS_KEY, {})[id] ?? 0;
}

export function setRating(id: string, stars: number): void {
  const all = read<Record<string, number>>(RATINGS_KEY, {});
  all[id] = stars;
  localStorage.setItem(RATINGS_KEY, JSON.stringify(all));
}
