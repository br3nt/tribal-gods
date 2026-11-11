/**
 * ui/settings-panel.ts — the Settings form (main menu and in-game menu).
 *
 * Sound (volume, mute), graphics quality, interface size, edge panning,
 * left-click orders and hints. Each control writes its setting and applies at once — graphics
 * too (main.ts rebuilds the post chain live; only the terrain mesh's
 * detail waits for the next load, and the panel says so when it matters).
 */

import { getVolume, isMuted, setMuted, setVolume, uiClick } from '../core/audio';
import { css, h } from './dom';
import { applyUiScale, QualitySetting, saveSettings, setQuality, settings } from './settings';

css('settings-panel', `
.set { display: grid; gap: 1.1rem; }
.set-row { display: grid; grid-template-columns: 10rem 1fr; gap: 1rem; align-items: center; }
.set-row .name { font-weight: 600; color: var(--text); font-size: var(--t-md); }
.set-row .desc { grid-column: 2; margin-top: -0.6rem; font-size: var(--t-xs); color: var(--text-3); }
.seg { justify-self: start; display: inline-flex; gap: 0.125rem; padding: 0.125rem; border-radius: var(--r2); background: rgba(0,0,0,0.3); border: 1px solid var(--rim); flex-wrap: wrap; }
.seg .tg-btn { border: 0; background: transparent; min-height: 1.9rem; padding: 0 0.8rem; color: var(--text-2); }
.seg .tg-btn.on { background: var(--gold-soft); color: var(--gold); }
.switch { position: relative; width: 2.6rem; height: 1.5rem; border-radius: var(--r-pill); border: 1px solid var(--rim-strong); background: rgba(0,0,0,0.35); cursor: pointer; padding: 0; }
.switch::after { content: ''; position: absolute; top: 0.15rem; left: 0.15rem; width: 1.1rem; height: 1.1rem; border-radius: 50%; background: var(--text-2); transition: transform var(--fast) var(--ease), background var(--fast); }
.switch.on { background: var(--gold-soft); border-color: var(--gold); }
.switch.on::after { transform: translateX(1.1rem); background: var(--gold); }
.set-note { font-size: var(--t-sm); color: var(--text-3); display: flex; align-items: center; gap: 0.6rem; }
.vol { display: flex; align-items: center; gap: 0.75rem; }
.vol input[type=range] { width: 12rem; accent-color: var(--gold); }
.vol .pct { min-width: 2.6rem; font-variant-numeric: tabular-nums; color: var(--text-2); font-size: var(--t-sm); }
@media (max-width: 640px) { .set-row { grid-template-columns: 1fr; } .set-row .desc { grid-column: 1; margin-top: -0.6rem; } }
`);

export interface SettingsHooks {
  /** True while a game is running (quality then asks before reloading). */
  inGame(): boolean;
  onEdgePan(on: boolean): void;
  onResetHints(): void;
  /** Apply a new graphics tier now. Returns true if the terrain detail still needs a reload. */
  onQuality?(q: QualitySetting): boolean;
}

function seg<T extends string | number>(options: Array<[T, string]>, current: () => T, pick: (v: T) => void): HTMLDivElement {
  const el = h('div.seg', { role: 'radiogroup' });
  const paint = () => {
    for (const b of el.children) b.classList.toggle('on', (b as HTMLElement).dataset.v === String(current()));
  };
  for (const [v, label] of options) {
    const b = h('button.tg-btn', { type: 'button', role: 'radio', text: label });
    b.dataset.v = String(v);
    b.addEventListener('click', () => {
      pick(v);
      paint();
    });
    el.appendChild(b);
  }
  paint();
  return el;
}

function toggle(on: () => boolean, set: (v: boolean) => void, label: string): HTMLButtonElement {
  const b = h('button.switch', { type: 'button', role: 'switch', 'aria-label': label });
  const paint = () => {
    b.classList.toggle('on', on());
    b.setAttribute('aria-checked', String(on()));
  };
  b.addEventListener('click', () => {
    set(!on());
    paint();
  });
  paint();
  return b;
}

export function settingsPanel(hooks: SettingsHooks): HTMLDivElement {
  const root = h('div.set');
  const row = (name: string, control: HTMLElement, desc: string) =>
    root.append(h('div.set-row', {}, h('div.name', { text: name }), control, h('div.desc', { text: desc })));

  // Sound: master volume + mute (core/audio.ts remembers both).
  const pct = h('span.pct');
  const slider = h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Volume' });
  slider.value = String(Math.round(getVolume() * 100));
  const paintVol = () => (pct.textContent = isMuted() ? 'muted' : `${slider.value}%`);
  slider.addEventListener('input', () => {
    setVolume(Number(slider.value) / 100);
    if (isMuted()) setMuted(false);
    paintVol();
    paintMute();
  });
  slider.addEventListener('change', () => uiClick());
  slider.addEventListener('keydown', (e) => e.stopPropagation());
  const mute = toggle(() => !isMuted(), (on) => {
    setMuted(!on);
    paintVol();
  }, 'Sound on');
  const paintMute = () => {
    mute.classList.toggle('on', !isMuted());
    mute.setAttribute('aria-checked', String(!isMuted()));
  };
  paintVol();
  row('Sound', h('div.vol', {}, mute, slider, pct), 'Master volume for effects and the quiet ambient bed. The switch mutes everything.');

  const note = h('div.set-note');
  note.hidden = true;
  row('Graphics', seg<QualitySetting>([['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], () => settings.quality, (q) => {
    setQuality(q);
    const needsReload = hooks.onQuality?.(q) ?? true;
    note.hidden = !needsReload;
    if (needsReload) {
      note.replaceChildren(
        h('span', { text: 'Applied. Terrain detail follows the next time the game loads.' }),
      );
    }
  }), 'Applies at once. Auto starts high and steps down if frames get slow. Low suits older laptops.');
  root.appendChild(note);

  row('Interface size', seg<string>([['auto', 'Auto'], ['0.9', '90%'], ['1', '100%'], ['1.15', '115%'], ['1.3', '130%']], () => String(settings.uiScale), (v) => {
    settings.uiScale = v === 'auto' ? 'auto' : Number(v);
    saveSettings();
    applyUiScale();
  }), 'Auto fits the window: smaller on a laptop, larger on a big screen.');

  row('Edge panning', toggle(() => settings.edgePan, (v) => {
    settings.edgePan = v;
    saveSettings();
    hooks.onEdgePan(v);
  }, 'Edge panning'), 'Move the view when the cursor touches the edge of the window.');

  row('Left-click orders', toggle(() => settings.leftClickOrders, (v) => {
    settings.leftClickOrders = v;
    saveSettings();
  }, 'Left-click orders'), 'With your people selected, clicking the ground (or an enemy, a stone, your tower) sends them, like a right-click. Clicking your own people or buildings still selects them.');

  const hintsRow = h('div', { style: 'display:flex;gap:0.75rem;align-items:center' },
    toggle(() => settings.hints, (v) => {
      settings.hints = v;
      saveSettings();
    }, 'Hints'),
    h('button.tg-btn', { type: 'button', text: 'Show all hints again', onclick: () => hooks.onResetHints() }),
  );
  row('Hints', hintsRow, 'Small tips during your first games.');
  return root;
}
