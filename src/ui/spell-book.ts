/**
 * ui/spell-book.ts — the spell book: every spell, its charges, at a glance.
 *
 * One row per tier, straight from catalog SPELLS (the UI never lists spells
 * itself). Each slot shows, without hovering:
 *
 *   - the spell's icon and its hotkey (tier rows sit on keyboard rows);
 *   - each spell is a rune-stone set in the slab: its rune is CARVED (a
 *     plain groove) while it holds no charge and PAINTED, glowing, when it
 *     does; charges are beads inlaid along its foot; the RECHARGE is a glow
 *     creeping round the stone's rim with spellState.progress, and the
 *     seconds to go sit on a bone tag — gathering power, never "broken";
 *   - a gold badge for gifted casts from a standing stone;
 *   - whether mana is being poured into it — the ember at its corner is lit
 *     or snuffed (right-click or the ember switches it);
 *   - spells not yet learned are blank, uncut stones; the tooltip says how
 *     to learn them.
 *
 * Clicking (or the hotkey) ARMS the spell: ui/spell-aim.ts takes over and
 * draws range and reticle in the world. If the spell can't be cast at all
 * right now the click is refused with the reason, near the slot.
 *
 * The rich tooltip carries everything else: blurb, range, radius,
 * duration, cast time, charges, mana per charge and the live ETA.
 */

import { spellDef, SPELLS, SpellDef, SpellId, SpellState } from '../sim/catalog';
import { UiContext } from './context';
import { css, escapeHtml, h, setClass, setText } from './dom';
import { fmtEta, fmtEtaShort, fmtSeconds, fmtTiles } from './format';
import { labelFor } from './hotkeys';
import { icon, spellIcon } from './icons';
import { carve } from './lettering';
import { activeSpell } from './tools';
import { tip, toast } from './tooltip';

const TIER_NAMES = ['', 'Everyday', 'Battle', 'World-shaping'];
const ROMAN = ['', 'I', 'II', 'III'];

css('spell-book', `
.sb { padding: 0.3rem 0.5rem 0.5rem; }
.sb .tg-panel-head { margin: 0 0 0.3rem 0.1rem; }
.sb .tg-panel-head .flow { margin-left: 0.4rem; font: 700 var(--t-xs)/1 var(--font); color: var(--spirit); text-shadow: 0 1px 0 #000; white-space: nowrap; }
.sb-row { display: grid; grid-template-columns: 1.1rem repeat(5, 3.1rem); gap: 0.3rem; align-items: center; }
.sb-row + .sb-row { margin-top: 0.3rem; }
.sb-tier { display: grid; place-items: center; font-size: 0.85rem; cursor: help; }

/* Each spell is a rune-stone set in a socket of the slab. */
.sb-slot { position: relative; width: 3.1rem; height: 3.1rem; padding: 0; cursor: pointer; border: 0;
  border-radius: 46% 54% 48% 52% / 50% 46% 54% 50%;
  background: radial-gradient(circle at 38% 30%, rgba(255,248,232,0.3), rgba(255,248,232,0) 55%), radial-gradient(circle at 50% 65%, rgba(150,142,128,0.15), rgba(30,26,22,0.5) 80%), var(--tex-stone) var(--sx, 0) var(--sy, 0) / 6rem;
  box-shadow: inset 0 -0.18rem 0.3rem rgba(0,0,0,0.5), inset 0 0.1rem 0 rgba(255,250,235,0.35), 0 0 0 0.16rem #2e2a25, 0 0 0 0.22rem rgba(255,245,225,0.12), 0 0.18rem 0.3rem rgba(0,0,0,0.55);
  color: #2b241d; display: grid; place-items: center;
  transition: transform var(--fast) var(--ease), box-shadow var(--fast) var(--ease), filter var(--fast); }
.sb-slot:nth-child(3n+2) { border-radius: 52% 48% 55% 45% / 46% 54% 46% 54%; --sx: 2rem; --sy: 1rem; }
.sb-slot:nth-child(3n) { border-radius: 44% 56% 50% 50% / 55% 47% 53% 45%; --sx: 4rem; --sy: 3rem; }
.sb-slot:nth-child(4n+1) { --sx: 1rem; --sy: 4.5rem; }
.sb-slot:hover { transform: translateY(-1px); filter: brightness(1.08); }
.sb-slot:active { transform: translateY(1px); }
/* The rune: CARVED (a dark groove, lit along its lower lip) until a charge is held, then PAINTED and glowing. */
.sb-slot > svg { position: relative; z-index: 1; color: #2b241d; filter: drop-shadow(0 1px 0 rgba(255,248,230,0.45)); transition: color var(--med), filter var(--med); }
.sb-slot.ready > svg { color: var(--spirit); filter: drop-shadow(0 0 0.3rem rgba(134,227,234,0.85)) drop-shadow(0 1px 0 rgba(0,0,0,0.7)); }
/* Recharge: a glow creeping round the rim of the stone. */
.sb-sweep { position: absolute; inset: -0.16rem; border-radius: inherit; z-index: 0; pointer-events: none;
  background: conic-gradient(from 0deg, var(--spirit) calc(var(--p, 0) * 1turn), transparent 0);
  -webkit-mask: radial-gradient(closest-side, transparent 80%, #000 82%); mask: radial-gradient(closest-side, transparent 80%, #000 82%);
  filter: drop-shadow(0 0 0.2rem rgba(134,227,234,0.8)); }
.sb-slot .kbd { position: absolute; top: -0.05rem; left: -0.05rem; z-index: 2; height: 0.85rem; min-width: 0.85rem; font-size: 0.5625rem; padding: 0 0.15rem; }
/* Charges: beads inlaid along the bottom, dark until filled. */
.sb-pips { position: absolute; bottom: 0.18rem; left: 0; right: 0; display: flex; justify-content: center; gap: 0.14rem; z-index: 2; }
.sb-pips i { width: 0.36rem; height: 0.36rem; border-radius: 50%; background: radial-gradient(circle at 40% 35%, #3b3631, #1d1a17); box-shadow: inset 0 1px 1px rgba(0,0,0,0.8), 0 1px 0 rgba(255,250,235,0.3); }
.sb-pips i.on { background: radial-gradient(circle at 40% 35%, #ffffff, var(--spirit) 45%, #2b9aa5); box-shadow: 0 0 0.3rem rgba(134,227,234,0.95), 0 0 0 1px rgba(10,40,44,0.7); }
.sb-gift { position: absolute; top: -0.05rem; right: -0.05rem; z-index: 2; display: flex; align-items: center; gap: 1px;
  padding: 0 0.2rem 0 0.12rem; height: 0.85rem; border-radius: 0.15rem 0.28rem; background: linear-gradient(#ffd27a, #d39537); color: #2a1606; font: 800 0.5625rem/1 var(--font); box-shadow: 0 0 0 1px rgba(30,14,2,0.8); }
/* Seconds to the next charge, on a bone tag: "gathering power", not "broken". */
.sb-eta { position: absolute; top: -0.05rem; right: -0.05rem; z-index: 2; height: 0.85rem; padding: 0 0.2rem; display: grid; place-items: center;
  border-radius: 0.15rem 0.28rem; background: linear-gradient(#fbf3df, #ddc9a2); color: #1f4a50; font: 800 0.625rem/1 var(--font); box-shadow: 0 0 0 1px rgba(30,16,6,0.75); pointer-events: none; }
.sb-eta:empty { display: none; }
/* The ember: lit while mana is poured in, snuffed when it isn't. */
.sb-toggle { position: absolute; right: -0.15rem; bottom: -0.15rem; z-index: 3; width: 1.05rem; height: 1.05rem; padding: 0; border: 0; border-radius: 50%;
  background: radial-gradient(circle at 45% 40%, #3a2a1c, #160d07); box-shadow: 0 0 0 1px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,220,170,0.2); color: #ffb35a; display: none; place-items: center; cursor: pointer; }
.sb-slot:hover .sb-toggle, .sb-slot:focus-within .sb-toggle, .sb-slot.off .sb-toggle { display: grid; }
.sb-slot.off .sb-toggle { color: #8d8378; }
.sb-slot.off { filter: saturate(0.6); }
.sb-slot.off .sb-sweep { filter: grayscale(1); opacity: 0.45; }
.sb-slot.blocked > svg { opacity: 0.55; }
/* Not learned: a blank stone, nothing cut in it yet. */
.sb-slot.locked { cursor: help; filter: brightness(0.82) saturate(0.7); }
.sb-slot.locked > svg { opacity: 0.1; filter: none; }
.sb-slot.locked .sb-lock { display: none; }
.sb-slot.gifted { box-shadow: inset 0 -0.18rem 0.3rem rgba(0,0,0,0.5), 0 0 0 0.16rem #2e2a25, 0 0 0 0.24rem var(--ochre); }
.sb-slot.armed { transform: translateY(-2px); box-shadow: inset 0 -0.18rem 0.3rem rgba(0,0,0,0.5), 0 0 0 0.16rem #2e2a25, 0 0 0 0.3rem var(--ochre-hi), 0 0 1rem rgba(242,197,106,0.7); }
.sb-slot.flash { animation: sb-flash 700ms var(--ease); }
@keyframes sb-flash { 0% { box-shadow: 0 0 0 0 rgba(134,227,234,0.95); } 100% { box-shadow: 0 0 0 0.9rem rgba(134,227,234,0); } }
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
    this.el = h('div.sb.tg-panel.mat-stone');
    this.flow = h('span.flow');
    this.el.appendChild(h('div.tg-panel-head', { html: `${carve('Spells')}<span class="cloth" style="flex:1"></span>` }, this.flow));

    for (const tier of [1, 2, 3] as const) {
      const row = h('div.sb-row');
      const label = h('div.sb-tier', { html: carve(ROMAN[tier]) });
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
    if (why === 'Must target land' || why === 'Out of range') return null;
    if (why === 'No charges ready') {
      // Not broken, just not ready: say what is happening and when.
      const s = w.spellState('player', id);
      const name = spellDef(id).name;
      if (!s.charging) return `${name} is not charging — right-click it to pour mana in`;
      return Number.isFinite(s.eta) ? `${name} is gathering power — ready in ${fmtEta(s.eta)}` : `${name} is gathering power`;
    }
    return why;
  }

  arm(id: SpellId, el?: HTMLElement): void {
    const why = this.blockedReason(id);
    const slotEl = el ?? this.slots.find((s) => s.def.id === id)?.el;
    if (why) {
      if (slotEl) {
        const r = slotEl.getBoundingClientRect();
        toast(why, r.left + r.width / 2, r.top, /gathering power|not charging/.test(why) ? 'info' : 'bad');
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
      // Charging is a state, not a fault: amber note, not a red refusal.
      if (why) html += `<div class="${/gathering power|not charging/.test(why) ? 'note' : 'why'}">${escapeHtml(why)}</div>`;
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
