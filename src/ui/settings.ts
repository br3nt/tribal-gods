/**
 * ui/settings.ts — player preferences, remembered in localStorage.
 *
 *   quality  — graphics tier. The renderer reads it from `?q=` at boot
 *              (render/look.ts); changing it rewrites the URL (so a reload
 *              keeps it) and main.ts applies it live — post chain, pixel
 *              ratio, shadows, ground cover. Only the terrain mesh's
 *              subdivision waits for the next load. 'auto' removes `?q=`
 *              and lets the governor adapt.
 *   uiScale  — 'auto' fits the HUD to the window, or a fixed factor.
 *   edgePan  — move the camera when the cursor touches a screen edge.
 *   hints    — first-minutes hint chips on/off (dismissals live in hints.ts).
 *   leftClickOrders — with your people selected, a plain left click on the
 *              ground (or a target) gives the same order as a right click.
 *              On by default: trackpads make right-clicking awkward.
 *
 * applyUiScale() sets --ui-scale on <html>; every HUD size is in rem.
 */

export type QualitySetting = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  quality: QualitySetting;
  uiScale: 'auto' | number;
  edgePan: boolean;
  hints: boolean;
  leftClickOrders: boolean;
}

const KEY = 'tg.settings.v1';
const DEFAULTS: Settings = { quality: 'auto', uiScale: 'auto', edgePan: false, hints: true, leftClickOrders: true };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* private mode / corrupt — defaults */
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: settings last for this session only */
  }
}

/**
 * The HUD scale for a window size. Designed at 1440×900 = 1; shrinks to
 * stay out of the way on small windows, grows on big screens so text stays
 * readable at a sofa's distance.
 */
export function autoUiScale(w: number, h: number): number {
  const s = Math.min(w / 1440, h / 900);
  return Math.round(Math.max(0.82, Math.min(1.4, s)) * 100) / 100;
}

export function applyUiScale(): void {
  const s = settings.uiScale === 'auto' ? autoUiScale(innerWidth, innerHeight) : settings.uiScale;
  document.documentElement.style.setProperty('--ui-scale', String(s));
}

/**
 * Quality comes from `?q=` (render/look.ts reads it once, at boot). Writing
 * the URL without navigating keeps the current game; `reload` applies it.
 */
export function setQuality(q: QualitySetting): void {
  settings.quality = q;
  saveSettings();
  writeQualityToUrl();
}

/**
 * Mirror the saved quality into the URL. Call with `boot` before the
 * renderer starts; an explicit `?q=` already in the URL wins at boot.
 */
export function writeQualityToUrl(boot = false): void {
  const url = new URL(location.href);
  if (boot && url.searchParams.has('q')) return;
  if (settings.quality === 'auto') url.searchParams.delete('q');
  else url.searchParams.set('q', settings.quality);
  if (url.href !== location.href) history.replaceState(history.state, '', url.href);
}
