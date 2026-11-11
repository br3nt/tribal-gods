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
import { carve } from './lettering';
import { activeBuilding } from './tools';
import { tip, toast } from './tooltip';

css('build-menu', `
.bm { padding: 0.3rem 0.45rem 0.45rem; }
.bm .tg-panel-head { margin: 0 0 0.3rem 0.1rem; }
.bm-grid { display: grid; grid-template-columns: repeat(4, 3.1rem); gap: 0.3rem; }
/* Each building is a carved wooden token: the plan burnt into its face, the cost on a bone tag. */
.bm-tile { position: relative; width: 3.1rem; height: 3.1rem; padding: 0 0 0.7rem; cursor: pointer; border: 0;
  border-radius: 0.3rem 0.45rem 0.35rem 0.5rem / 0.45rem 0.3rem 0.5rem 0.35rem;
  background: linear-gradient(180deg, rgba(255,226,180,0.22), rgba(255,226,180,0) 45%, rgba(0,0,0,0.25)), var(--tex-wood-light) 0 0 / 8rem;
  box-shadow: inset 0 1px 0 rgba(255,236,200,0.5), inset 0 -2px 0 rgba(0,0,0,0.35), 0 0 0 1px #1d1008, 0 2px 0 1px #1d1008;
  color: #2a1708; display: grid; place-items: center; transition: transform var(--fast) var(--ease), filter var(--fast); }
.bm-tile > svg { filter: drop-shadow(0 1px 0 rgba(255, 230, 190, 0.45)); }
.bm-tile:hover { transform: translateY(-1px); filter: brightness(1.1); }
.bm-tile:active { transform: translateY(1px); }
.bm-tile .kbd { position: absolute; top: 0.15rem; left: 0.15rem; height: 0.85rem; min-width: 0.85rem; font-size: 0.5625rem; padding: 0 0.15rem; }
.bm-cost { position: absolute; bottom: 0.14rem; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 0.1rem;
  padding: 0.08rem 0.25rem 0.06rem 0.15rem; border-radius: 0.15rem 0.25rem; background: #2a190d; color: #f3c27a;
  font: 700 0.625rem/1 var(--font); box-shadow: 0 0 0 1px rgba(0,0,0,0.6); }
.bm-tile.poor .bm-cost { background: #6a1b0e; color: #ffd8cc; }
.bm-tile.poor > svg { opacity: 0.6; }
/* Locked: a rough, uncut blank, the plan only scratched in. */
.bm-tile.locked { background: linear-gradient(rgba(20,12,6,0.55), rgba(20,12,6,0.65)), var(--tex-wood) 0 0 / 8rem; color: rgba(244,232,207,0.55); }
.bm-tile.locked > svg { opacity: 0.4; filter: none; }
.bm-tile.locked .bm-cost { background: #20140b; color: var(--bone-3); }
.bm-tile .bm-lock { position: absolute; top: 0.18rem; right: 0.18rem; color: var(--bone-2); display: none; }
.bm-tile.locked .bm-lock { display: block; }
.bm-tile.armed { transform: translateY(-2px); box-shadow: inset 0 1px 0 rgba(255,236,200,0.5), 0 0 0 1px #1d1008, 0 0 0 3px var(--ochre-hi), 0 0 0.9rem rgba(242,197,106,0.6); }
.bm-tile.deny { animation: sb-deny 320ms var(--ease); }
.tg-tip .req { list-style: none; padding: 0; margin: var(--s2) 0 0; font-size: var(--t-xs); }
.tg-tip .req li { display: flex; align-items: center; gap: 0.375rem; font-weight: 700; }
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
    this.el.appendChild(h('div.tg-panel-head', { html: `${carve('Build')}<span class="cloth" style="flex:1"></span>` }));
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
