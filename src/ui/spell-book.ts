/**
 * ui/spell-book.ts — the spell book: every spell, its charges, at a glance.
 *
 * One row per tier, straight from catalog SPELLS (the UI never lists spells
 * itself). Each slot shows, without hovering:
 *
 *   - the spell's icon and its hotkey (tier rows sit on keyboard rows);
 *   - charge pips (charges / max) and a radial RECHARGE SWEEP filling with
 *     spellState.progress toward the next charge;
 *   - a gold badge for gifted casts from a standing stone;
 *   - whether mana is being poured into it — a slot switched off shows a
 *     dashed rim and a crossed-out flow mark (right-click or the corner
 *     toggle switches it);
 *   - locked spells as padlocks; the tooltip says how to learn them.
 *
 * Clicking (or the hotkey) ARMS the spell: ui/spell-aim.ts takes over and
 * draws range and reticle in the world. If the spell can't be cast at all
 * right now the click is refused with the reason, near the slot.
 *
 * The rich tooltip carries everything else: blurb, range, radius,
 * duration, cast time, charges, mana per charge and the live ETA.
 */

import { SPELLS, SpellDef, SpellId, SpellState } from '../sim/catalog';
import { UiContext } from './context';
import { css, escapeHtml, h, setClass, setText } from './dom';
import { fmtEta, fmtEtaShort, fmtSeconds, fmtTiles } from './format';
import { labelFor } from './hotkeys';
import { icon, spellIcon } from './icons';
import { activeSpell } from './tools';
import { tip, toast } from './tooltip';

const TIER_NAMES = ['', 'Everyday', 'Battle', 'World-shaping'];
const ROMAN = ['', 'I', 'II', 'III'];

css('spell-book', `
.sb { padding: 0.5rem 0.625rem 0.625rem; }
.sb .tg-panel-head { margin: 0 0 0.375rem 0.125rem; }
.sb .tg-panel-head .flow { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--mana); }
.sb-row { display: grid; grid-template-columns: 1.1rem repeat(5, 3.25rem); gap: 0.3125rem; align-items: center; }
.sb-row + .sb-row { margin-top: 0.3125rem; }
.sb-tier { font: 700 0.625rem/1 var(--font-display); color: var(--text-3); text-align: center; letter-spacing: 0.04em; }
.sb-slot { position: relative; width: 3.25rem; height: 3.25rem; padding: 0; border-radius: var(--r2); cursor: pointer;
  border: 1px solid var(--rim); background: radial-gradient(120% 90% at 50% 0%, rgba(114,216,255,0.10), rgba(0,0,0,0.25));
  color: var(--text); display: grid; place-items: center; overflow: hidden;
  transition: border-color var(--fast) var(--ease), transform var(--fast) var(--ease), box-shadow var(--fast) var(--ease); }
.sb-slot:hover { border-color: var(--rim-strong); transform: translateY(-1px); }
.sb-slot > svg { position: relative; z-index: 1; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.5)); transition: opacity var(--fast); }
.sb-sweep { position: absolute; inset: 0; border-radius: inherit; z-index: 0;
  background: conic-gradient(from 0deg, rgba(114,216,255,0.32) calc(var(--p, 0) * 1turn), transparent 0); }
.sb-slot .kbd { position: absolute; top: 0.1875rem; left: 0.1875rem; z-index: 2; height: 0.9rem; min-width: 0.9rem; font-size: 0.5625rem; }
.sb-pips { position: absolute; bottom: 0.25rem; left: 0; right: 0; display: flex; justify-content: center; gap: 0.1875rem; z-index: 2; }
.sb-pips i { width: 0.375rem; height: 0.375rem; border-radius: 50%; background: rgba(255,255,255,0.18); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.35); }
.sb-pips i.on { background: var(--mana); box-shadow: 0 0 0.375rem rgba(114,216,255,0.8); }
.sb-gift { position: absolute; top: 0.1875rem; right: 0.1875rem; z-index: 2; display: flex; align-items: center; gap: 1px;
  padding: 0 0.2rem 0 0.1rem; height: 0.9rem; border-radius: var(--r-pill); background: var(--gold); color: #2a1d06; font: 800 0.5625rem/1 var(--font); }
.sb-eta { position: absolute; inset: 0 0 0.35rem; z-index: 2; display: grid; place-items: center; font: 700 0.8125rem/1 var(--font); color: var(--text); text-shadow: 0 1px 3px #000, 0 0 6px #000; pointer-events: none; }
.sb-eta:empty { display: none; }
.sb-slot.counting > svg { opacity: 0.3; }
.sb-toggle { position: absolute; right: 0.125rem; bottom: 0.125rem; z-index: 3; width: 1rem; height: 1rem; padding: 0; border-radius: 50%;
  border: 1px solid var(--rim-strong); background: var(--ink-solid); color: var(--mana); display: none; place-items: center; cursor: pointer; }
.sb-slot:hover .sb-toggle, .sb-slot:focus-within .sb-toggle, .sb-slot.off .sb-toggle { display: grid; }
.sb-slot.off .sb-toggle { color: var(--warn); }

.sb-slot.ready { border-color: rgba(114,216,255,0.55); box-shadow: inset 0 0 0.75rem rgba(114,216,255,0.18); }
.sb-slot.empty > svg { opacity: 0.55; }
.sb-slot.off { border-style: dashed; border-color: rgba(255,181,77,0.6); }
.sb-slot.off .sb-sweep { filter: grayscale(1); opacity: 0.5; }
.sb-slot.blocked > svg { opacity: 0.4; }
.sb-slot.locked { background: rgba(0,0,0,0.28); border-color: rgba(255,255,255,0.06); cursor: help; }
.sb-slot.locked > svg { opacity: 0.22; }
.sb-slot.locked .sb-lock { position: absolute; z-index: 2; color: var(--text-3); bottom: 0.2rem; right: 0.2rem; }
.sb-slot.gifted { border-color: rgba(244,198,106,0.7); }
.sb-slot.armed { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(244,198,106,0.45), 0 0 1rem rgba(244,198,106,0.4); transform: translateY(-2px); }
.sb-slot.flash { animation: sb-flash 600ms var(--ease); }
@keyframes sb-flash { 0% { box-shadow: 0 0 0 0 rgba(114,216,255,0.9); } 100% { box-shadow: 0 0 0 0.75rem rgba(114,216,255,0); } }
.sb-slot.deny { animation: sb-deny 320ms var(--ease); }
@keyframes sb-deny { 25% { transform: translateX(-3px); } 50% { transform: translateX(3px); } 75% { transform: translateX(-2px); } }
`);

interface Slot {
  def: SpellDef;
  el: HTMLButtonElement;
  sweep: HTMLDivElement;
  pips: HTMLDivElement;
  gift: HTMLDivElement;
  eta: HTMLDivElement;
  lastP: number;
  lastCharges: number;
  shown: string;
}

export class SpellBook {
  readonly el: HTMLDivElement;
  private readonly slots: Slot[] = [];
  private readonly flow: HTMLSpanElement;

  constructor(private readonly ctx: UiContext) {
    this.el = h('div.sb.tg-panel');
    this.flow = h('span.flow');
    this.el.appendChild(h('div.tg-panel-head', { html: `${icon('book', 14)}<span>Spells</span>` }, this.flow));

    for (const tier of [1, 2, 3] as const) {
      const row = h('div.sb-row');
      const label = h('div.sb-tier', { text: ROMAN[tier] });
      tip(label, () => `<h4>Tier ${ROMAN[tier]} · ${TIER_NAMES[tier]}</h4><p>${tier === 1 ? 'Cheap, quick to recharge — use them freely.' : tier === 2 ? 'Spells that decide a battle.' : 'Spells that reshape the planet. Plan minutes ahead.'}</p>`);
      row.appendChild(label);
      for (const def of SPELLS.filter((s) => s.tier === tier)) row.appendChild(this.slot(def));
      this.el.appendChild(row);
    }
  }

  private slot(def: SpellDef): HTMLButtonElement {
    const key = labelFor(`spell:${def.id}`);
    const el = h('button.sb-slot', { type: 'button', 'aria-label': def.name, html: spellIcon(def.id, 26) });
    const sweep = h('div.sb-sweep');
    const pips = h('div.sb-pips');
    const gift = h('div.sb-gift');
    const eta = h('div.sb-eta');
    const toggle = h('button.sb-toggle', { type: 'button', 'aria-label': `Toggle charging ${def.name}`, html: icon('charging', 11) });
    el.prepend(sweep);
    el.append(h('span.kbd', { text: key }), pips, gift, eta, toggle);
    const slot: Slot = { def, el, sweep, pips, gift, eta, lastP: -1, lastCharges: -1, shown: '' };

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sb-toggle')) return;
      this.arm(def.id, el);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.toggleCharging(def.id);
    });
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCharging(def.id);
    });
    tip(el, () => this.tooltip(def));
    this.slots.push(slot);
    return el;
  }

  private toggleCharging(id: SpellId): void {
    const s = this.ctx.world.spellState('player', id);
    if (!s.known) return;
    this.ctx.world.setSpellCharging('player', id, !s.charging);
  }

  /** Why this spell can't be cast anywhere right now (null = it can be aimed). */
  blockedReason(id: SpellId): string | null {
    const w = this.ctx.world;
    const leader = w.leaderOf('player');
    const at = leader ?? w.tribes.player?.home ?? { x: 0, z: 0 };
    const why = w.castCheck('player', id, at.x, at.z);
    // Land-only spells may refuse the leader's own tile for terrain reasons;
    // that's about the target, not the spell — aiming will show it.
    return why === 'Must target land' || why === 'Out of range' ? null : why;
  }

  arm(id: SpellId, el?: HTMLElement): void {
    const why = this.blockedReason(id);
    const slotEl = el ?? this.slots.find((s) => s.def.id === id)?.el;
    if (why) {
      if (slotEl) {
        const r = slotEl.getBoundingClientRect();
        toast(why, r.left + r.width / 2, r.top);
        slotEl.classList.remove('deny');
        void slotEl.offsetWidth;
        slotEl.classList.add('deny');
      }
      return;
    }
    this.ctx.actions.armSpell(id);
  }

  /** How a spell the tribe doesn't know could be learned on this planet. */
  private howToLearn(id: SpellId): string {
    const stones = this.ctx.world.monuments.filter((m) => m.spell === id);
    if (stones.some((m) => m.mode === 'teach' && this.ctx.world.monumentAvailable(m))) {
      return 'Taught by a standing stone. Send your leader to commune with it (select the leader, right-click the stone).';
    }
    if (stones.some((m) => m.mode === 'gift')) return 'A standing stone lends casts of this spell. Commune with it to borrow them.';
    if (stones.length > 0) return 'Its stone has already been claimed.';
    return 'No standing stone on this planet teaches it.';
  }

  private tooltip(def: SpellDef): string {
    const s = this.ctx.world.spellState('player', def.id);
    const key = labelFor(`spell:${def.id}`);
    const aim = def.aim === 'line' ? 'A line from your leader' : def.aim === 'point' ? 'A point' : 'An area';
    const charge = !s.known
      ? '—'
      : s.charges >= s.max
        ? 'Full'
        : !s.charging
          ? 'Not charging'
          : `in ${fmtEta(s.eta)}`;
    // The tribe's own numbers: campaign boons and loadouts change both.
    const cost = Math.round(s.chargeMana * 10) / 10;
    const manaLine = cost === def.chargeMana
      ? `${cost}`
      : `${cost} <span style="color:var(--${cost < def.chargeMana ? 'good' : 'warn'})">(usually ${def.chargeMana})</span>`;
    const bonus = s.bonusCharges ? ` <span style="color:var(--good)">(+${s.bonusCharges} from boons)</span>` : '';
    let html =
      `<div class="sub">Tier ${ROMAN[def.tier]} · ${TIER_NAMES[def.tier]}</div>` +
      `<h4>${escapeHtml(def.name)}<span class="kbd">${key}</span></h4>` +
      `<p>${escapeHtml(def.blurb)}</p><dl class="stats">` +
      `<dt>Charges</dt><dd>${s.known ? `${s.charges} / ${s.max}` : `holds ${s.max}`}${bonus}${s.gifted ? ` <span style="color:var(--gold)">+${s.gifted} gifted</span>` : ''}</dd>` +
      `<dt>Next charge</dt><dd>${charge}</dd>` +
      `<dt>Mana / charge</dt><dd>${manaLine}</dd>` +
      `<dt>Range</dt><dd>${fmtTiles(def.range)} from your leader</dd>` +
      (def.radius > 0 ? `<dt>${def.aim === 'line' ? 'Width' : 'Radius'}</dt><dd>${fmtTiles(def.radius)}</dd>` : '') +
      `<dt>Duration</dt><dd>${def.duration > 0 ? fmtSeconds(def.duration) : 'Instant'}</dd>` +
      `<dt>Cast time</dt><dd>${fmtSeconds(def.castSeconds)}</dd>` +
      `<dt>Target</dt><dd>${aim}${def.anywhere ? ', land or water' : ', land only'}</dd></dl>`;
    if (!s.known && s.gifted === 0) html += `<div class="note">${escapeHtml(this.howToLearn(def.id))}</div>`;
    else {
      const why = this.blockedReason(def.id);
      if (why) html += `<div class="why">${escapeHtml(why)}</div>`;
      if (s.known && !s.charging) html += `<div class="note">Not charging — mana goes to your other spells.</div>`;
      html += `<div class="hint">Click or press ${key}, then click the world. Right-click this slot to ${s.charging ? 'stop' : 'resume'} charging.</div>`;
    }
    return html;
  }

  /** Per frame: sweeps, pips, states. */
  update(): void {
    const w = this.ctx.world;
    const armed = activeSpell();
    let charging = 0;
    const leaderHere = !!w.leaderOf('player');
    for (const slot of this.slots) {
      const s: SpellState = w.spellState('player', slot.def.id);
      const usable = s.charges + s.gifted > 0;
      const locked = !s.known && s.gifted === 0;
      const full = s.charges >= s.max;
      if (s.known && s.charging && !full) charging++;

      const p = locked || full ? 0 : Math.round(s.progress * 400) / 400;
      if (p !== slot.lastP) {
        slot.sweep.style.setProperty('--p', String(p));
        slot.lastP = p;
      }
      const sig = `${s.known}|${s.charges}|${s.max}|${s.gifted}|${s.charging}|${locked}`;
      if (sig !== slot.shown) {
        slot.shown = sig;
        slot.pips.innerHTML = locked ? '' : Array.from({ length: s.max }, (_, i) => `<i class="${i < s.charges ? 'on' : ''}"></i>`).join('');
        slot.gift.hidden = s.gifted === 0;
        slot.gift.innerHTML = s.gifted ? `${icon('gift', 9)}${s.gifted}` : '';
        const lock = slot.el.querySelector('.sb-lock');
        if (locked && !lock) slot.el.insertAdjacentHTML('beforeend', icon('lock', 12, 'sb-lock'));
        if (!locked && lock) lock.remove();
        (slot.el.querySelector('.sb-toggle') as HTMLElement).innerHTML = icon(s.charging ? 'charging' : 'chargingOff', 11);
        if (s.charges > slot.lastCharges && slot.lastCharges >= 0) {
          slot.el.classList.remove('flash');
          void slot.el.offsetWidth;
          slot.el.classList.add('flash');
        }
        slot.lastCharges = s.charges;
      }
      const showEta = s.known && !usable && s.charging && Number.isFinite(s.eta);
      setText(slot.eta, showEta ? fmtEtaShort(s.eta) : '');
      setClass(slot.el, 'counting', showEta);
      setClass(slot.el, 'locked', locked);
      setClass(slot.el, 'ready', usable && !locked);
      setClass(slot.el, 'empty', !usable && !locked);
      setClass(slot.el, 'off', s.known && !s.charging);
      setClass(slot.el, 'gifted', s.gifted > 0);
      setClass(slot.el, 'armed', armed === slot.def.id);
      setClass(slot.el, 'blocked', usable && !leaderHere);
    }
    setText(this.flow, charging > 0 ? `${charging} charging` : 'none charging');
  }
}
