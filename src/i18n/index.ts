/**
 * i18n/index.ts — the smallest translation layer that works.
 *
 * The English text stays in the code and *is* the key: `tr('Out of range')`.
 * A language file maps those English strings to its own; anything it lacks
 * falls back to English, so a missing entry is never an empty label.
 * Dynamic parts become numbered placeholders:
 *   tr('Needs {0} more wood', n)
 *
 * The language is fixed when the page loads (many labels are built once,
 * at module load, from catalog rows). Changing it stores the choice and
 * reloads the page.
 */
import { de } from './de';

export type Lang = 'en' | 'de';
export const LANGS: Record<Lang, string> = { en: 'English', de: 'Deutsch' };

const STORE_KEY = 'tribalgods.lang.v1';
const DICTS: Record<Lang, Record<string, string> | null> = { en: null, de };

function detect(): Lang {
  // Headless (tests, node): always English, whatever the machine's locale.
  if (typeof window === 'undefined') return 'en';
  try {
    const saved = window.localStorage.getItem(STORE_KEY);
    if (saved === 'en' || saved === 'de') return saved;
  } catch { /* storage blocked: fall through */ }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_DEFAULT_LANG;
  if (env === 'en' || env === 'de') return env;
  const nav = (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase();
  return nav.startsWith('de') ? 'de' : 'en';
}

export const LANG: Lang = detect();

/** Store the choice and reload, so every label is rebuilt in the new language. */
export function setLang(lang: Lang): void {
  try { window.localStorage.setItem(STORE_KEY, lang); } catch { /* ignore */ }
  window.location.reload();
}

/** Translate `text` (English) and fill `{0}`, `{1}`… with `args`. */
export function tr(text: string, ...args: unknown[]): string {
  const out = DICTS[LANG]?.[text] ?? text;
  return args.length ? out.replace(/\{(\d+)\}/g, (m, i: string) => (+i < args.length ? String(args[+i]) : m)) : out;
}
