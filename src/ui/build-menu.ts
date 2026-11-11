/**
 * ui/build-menu.ts — what you can build, and why not.
 *
 * Tiles in catalog BUILD_ORDER, each with its icon, wood cost and hotkey.
 * State comes from world.buildState('player', kind):
 *
 *   ready        — bright; click (or Shift+N) to start placing
 *   unaffordable — cost shown in red; you can still see what it needs
 *   locked       — padlock; prerequisites unmet ("Needs a War Lodge")
 *   not allowed  — hidden from view by the scenario's loadout
 *
 * The tooltip carries the blurb, footprint, build time, what it trains and
 * the requirement list with ticks. Placement itself is ui/build-placer.ts.
 */

import { BUILD_ORDER, BUILDINGS, BuildingKind, UNITS } from '../sim/catalog';
import { UiContext } from './context';
import { css, escapeHtml, h, setClass } from './dom';
import { fmtSeconds } from './format';
import { labelFor } from './hotkeys';
import { buildingIcon, icon } from './icons';
import { activeBuilding } from './tools';
import { tip, toast } from './tooltip';

css('build-menu', `
.bm { padding: 0.5rem 0.625rem 0.625rem; }
.bm .tg-panel-head { margin: 0 0 0.375rem 0.125rem; }
.bm-grid { display: grid; grid-template-columns: repeat(4, 3.25rem); gap: 0.3125rem; }
.bm-tile { position: relative; width: 3.25rem; height: 3.25rem; padding: 0 0 0.75rem; border-radius: var(--r2); cursor: pointer;
  border: 1px solid var(--rim); background: radial-gradient(120% 90% at 50% 0%, rgba(226,165,100,0.12), rgba(0,0,0,0.25));
  color: var(--text); display: grid; place-items: center; transition: border-color var(--fast) var(--ease), transform var(--fast) var(--ease); }
.bm-tile:hover { border-color: var(--rim-strong); transform: translateY(-1px); }
.bm-tile .kbd { position: absolute; top: 0.1875rem; left: 0.1875rem; height: 0.9rem; min-width: 0.9rem; font-size: 0.5625rem; }
.bm-cost { position: absolute; bottom: 0.1875rem; left: 0; right: 0; display: flex; align-items: center; justify-content: center; gap: 0.125rem;
  font: 700 0.625rem/1 var(--font); color: var(--wood); }
.bm-tile.poor .bm-cost { color: var(--bad); }
.bm-tile.poor > svg { opacity: 0.6; }
.bm-tile.locked { background: rgba(0,0,0,0.28); border-color: rgba(255,255,255,0.06); }
.bm-tile.locked > svg { opacity: 0.25; }
.bm-tile.locked .bm-cost { color: var(--text-3); }
.bm-tile .bm-lock { position: absolute; top: 0.2rem; right: 0.2rem; color: var(--text-3); display: none; }
.bm-tile.locked .bm-lock { display: block; }
.bm-tile.armed { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(244,198,106,0.45), 0 0 1rem rgba(244,198,106,0.35); transform: translateY(-2px); }
.bm-tile.deny { animation: sb-deny 320ms var(--ease); }
.tg-tip .req { list-style: none; padding: 0; margin: var(--s2) 0 0; font-size: var(--t-xs); }
.tg-tip .req li { display: flex; align-items: center; gap: 0.375rem; }
.tg-tip .req li.ok { color: var(--good); }
.tg-tip .req li.no { color: var(--bad); }
`);

interface Tile {
  kind: BuildingKind;
  el: HTMLButtonElement;
}

export class BuildMenu {
  readonly el: HTMLDivElement;
  private readonly tiles: Tile[] = [];

  constructor(private readonly ctx: UiContext) {
    this.el = h('div.bm.tg-panel');
    this.el.appendChild(h('div.tg-panel-head', { html: `${icon('hammer', 14)}<span>Build</span>` }));
    const grid = h('div.bm-grid');
    for (const kind of BUILD_ORDER) {
      const def = BUILDINGS[kind];
      const el = h('button.bm-tile', { type: 'button', 'aria-label': def.name, html: buildingIcon(kind, 26) });
      el.append(
        h('span.kbd', { text: labelFor(`build:${kind}`) }),
        h('span.bm-cost', { html: `${icon('wood', 11)}${def.wood}` }),
      );
      el.insertAdjacentHTML('beforeend', icon('lock', 12, 'bm-lock'));
      el.addEventListener('click', () => this.arm(kind));
      tip(el, () => this.tooltip(kind));
      grid.appendChild(el);
      this.tiles.push({ kind, el });
    }
    this.el.appendChild(grid);
  }

  arm(kind: BuildingKind): void {
    const st = this.ctx.world.buildState('player', kind);
    if (!st.allowed || !st.unlocked || !st.affordable) {
      const t = this.tiles.find((x) => x.kind === kind);
      if (t) {
        const r = t.el.getBoundingClientRect();
        toast(st.reason ?? 'Not available', r.left + r.width / 2, r.top);
        t.el.classList.remove('deny');
        void t.el.offsetWidth;
        t.el.classList.add('deny');
      }
      return;
    }
    this.ctx.actions.armBuilding(kind);
  }

  private tooltip(kind: BuildingKind): string {
    const def = BUILDINGS[kind];
    const w = this.ctx.world;
    const st = w.buildState('player', kind);
    const have = (k: BuildingKind) => w.buildings.some((b) => b.tribe === 'player' && b.kind === k && b.progress >= 1);
    let html =
      `<h4>${escapeHtml(def.name)}<span class="kbd">${labelFor(`build:${kind}`)}</span></h4>` +
      `<p>${escapeHtml(def.blurb)}</p><dl class="stats">` +
      `<dt>Cost</dt><dd>${def.wood} wood</dd>` +
      `<dt>Footprint</dt><dd>${def.size} × ${def.size} tiles</dd>` +
      `<dt>Build time</dt><dd>${fmtSeconds(def.buildSeconds)} of work</dd>` +
      (def.trains ? `<dt>Trains</dt><dd>${UNITS[def.trains].name} (${UNITS[def.trains].trainWood} wood each)</dd>` : '') +
      `</dl>`;
    if (def.requires.length) {
      html += `<ul class="req">${def.requires
        .map((r) => `<li class="${have(r) ? 'ok' : 'no'}">${icon(have(r) ? 'check' : 'close', 12)}Needs a ${escapeHtml(BUILDINGS[r].name)}</li>`)
        .join('')}</ul>`;
    }
    if (st.reason) html += `<div class="why">${escapeHtml(st.reason)}</div>`;
    else html += `<div class="hint">Click, then click the ground. Shift-click to place several. Esc cancels.</div>`;
    return html;
  }

  update(): void {
    const armed = activeBuilding();
    const w = this.ctx.world;
    for (const t of this.tiles) {
      const st = w.buildState('player', t.kind);
      t.el.hidden = !st.allowed;
      setClass(t.el, 'locked', !st.unlocked);
      setClass(t.el, 'poor', st.unlocked && !st.affordable);
      setClass(t.el, 'armed', armed === t.kind);
    }
  }
}
