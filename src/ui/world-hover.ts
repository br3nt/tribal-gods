/**
 * ui/world-hover.ts — "you could click this": hover feedback in the world.
 *
 * Reads the one hover hook (UiContext.hover, kept by ui/orders.ts) and
 * draws, every frame:
 *
 *   - a RING on the ground under whatever is hovered — a person, a
 *     building's footprint, a standing stone — painted by relation:
 *     ochre-gold for yours, red for a rival's, bone-white for wanderers,
 *     spirit-turquoise for stones. Drawn with ui/drape.ts, so it hugs the
 *     curved ground like the spell reticles; the renderers are untouched.
 *   - a steadier ring under someone you are INSPECTING (a wanderer or rival
 *     card is open) and small rings under the people a drag would select;
 *   - after a short rest (HOVER_DELAY), a compact NAME TAG by the cursor:
 *     who or what it is, and what a click will do. A stone's tag says what
 *     it holds, teach or lend, how long the ritual takes and that it can be
 *     broken — and, with your leader selected, that a click sends them.
 */

import { BUILDINGS, spellDef, UNITS } from '../sim/catalog';
import type { Building, Unit } from '../sim/world-state';
import { appState } from './app-state';
import { UiContext } from './context';
import { css, escapeHtml, h } from './dom';
import { Drape } from './drape';
import { activityText, buildingName, fmtSeconds } from './format';
import { orderVerb } from './hotkeys';
import { spellIcon } from './icons';
import { settings } from './settings';
import { ritualAt, ritualSeconds, stoneBlocked, stoneName, stoneTerms, tribeLabelOf } from './stones';
import { toolState } from './tools';

const HOVER_DELAY = 0.45;
const OWN = 0xf2d27a;
const FOE = 0xff6a4d;
const WILD = 0xf3e6c8;
const STONE = 0x7fe0e8;

css('world-hover', `
.wh-tag { position: fixed; z-index: 56; pointer-events: none; max-width: 17rem; transform: translate(16px, 18px); }
.wh-tag h4 { margin: 0; }
.wh-tag p { margin: 0.15rem 0 0; }
.wh-tag .act { margin-top: 0.3rem; font-size: var(--t-xs); font-weight: 700; color: var(--ink-accent, #7a3b12); }
.wh-tag .spell { display: flex; align-items: center; gap: 0.45rem; margin: 0.25rem 0 0.1rem; }
`);

export class WorldHover {
  private readonly ring: Drape;
  private readonly tag: HTMLDivElement;
  private key = '';
  private rest = 0;

  /** Set by game-ui: the units a drag would select (ui/orders.ts preview). */
  preview: ReadonlySet<number> = new Set();

  constructor(private readonly ctx: UiContext) {
    this.ring = new Drape(ctx.scene, 0.9, 2500, 17);
    this.tag = h('div.wh-tag.tg-tip');
    document.body.appendChild(this.tag);
  }

  update(dt: number): void {
    const { world, view, hover, selection, pointer } = this.ctx;
    const inGame = appState.mode === 'game';
    this.ring.begin(OWN);
    let drew = false;
    const unitRing = (u: Unit, col: number, r0: number, r1: number) => {
      if (u.hidden) return;
      this.ring.color(col);
      this.ring.ring(view, u.x, u.z, r0, r1);
      drew = true;
    };
    if (inGame) {
      for (const id of this.preview) {
        const u = world.unitById(id);
        if (u) unitRing(u, OWN, 0.55, 0.68);
      }
      if (selection.inspect !== null) {
        const u = world.unitById(selection.inspect);
        if (u) unitRing(u, this.colorOf(u.tribe), 0.85, 1.08);
      }
      const hu = hover.unit !== null ? world.unitById(hover.unit) : undefined;
      const hb = hover.building !== null ? world.getBuilding(hover.building) : undefined;
      const hm = hover.monument !== null ? world.monuments[hover.monument] : undefined;
      if (hu) unitRing(hu, this.colorOf(hu.tribe), 0.95, 1.25);
      else if (hb) {
        this.ring.color(this.colorOf(hb.tribe));
        const r = hb.size / 2 + 0.6;
        this.ring.ring(view, hb.x, hb.z, r, r + 0.3);
        drew = true;
      } else if (hm) {
        this.ring.color(STONE);
        this.ring.ring(view, hm.x, hm.z, 1.7, 2.05, 2);
        drew = true;
      }
    }
    if (drew) this.ring.end();
    else this.ring.hide();

    // Name tag after a short rest on the same thing.
    const key = !inGame || !pointer.onCanvas || toolState.tool !== 'select'
      ? ''
      : hover.unit !== null ? `u${hover.unit}` : hover.building !== null ? `b${hover.building}` : hover.monument !== null ? `m${hover.monument}` : '';
    if (key !== this.key) {
      this.key = key;
      this.rest = 0;
      this.tag.classList.remove('show');
    }
    if (!key) return;
    this.rest += dt;
    if (this.rest < HOVER_DELAY) return;
    const html = this.describe();
    if (this.tag.innerHTML !== html) this.tag.innerHTML = html;
    this.tag.style.left = `${Math.min(pointer.x, innerWidth - 300)}px`;
    this.tag.style.top = `${Math.min(pointer.y, innerHeight - 160)}px`;
    this.tag.classList.add('show');
  }

  private colorOf(tribe: string): number {
    if (tribe === 'player') return OWN;
    if (tribe === 'wild') return WILD;
    return this.ctx.world.hostile('player', tribe as never) ? FOE : WILD;
  }

  private haveOwnPeople(): boolean {
    const w = this.ctx.world;
    return [...this.ctx.selection.units].some((id) => w.unitById(id)?.tribe === 'player');
  }

  private leaderSelected(): boolean {
    const w = this.ctx.world;
    return [...this.ctx.selection.units].some((id) => w.unitById(id)?.kind === 'shaman' && w.unitById(id)?.tribe === 'player');
  }

  /** The tag's content for what is hovered now. */
  private describe(): string {
    const { world, hover } = this.ctx;
    const verb = orderVerb(settings.leftClickOrders);
    const Verb = verb[0].toUpperCase() + verb.slice(1);
    if (hover.unit !== null) {
      const u = world.unitById(hover.unit);
      if (!u) return '';
      return this.unitTag(u, Verb);
    }
    if (hover.building !== null) {
      const b = world.getBuilding(hover.building);
      if (!b) return '';
      return this.buildingTag(b, Verb);
    }
    if (hover.monument !== null) return this.stoneTag(hover.monument, Verb);
    return '';
  }

  private unitTag(u: Unit, Verb: string): string {
    const def = UNITS[u.kind];
    const w = this.ctx.world;
    if (u.tribe === 'player') {
      return `<h4>${escapeHtml(def.name)}</h4><p>${escapeHtml(activityText(u))}</p><div class="act">Click to select</div>`;
    }
    if (u.tribe === 'wild') {
      return `<div class="sub">Wanderer · no tribe</div><h4>${escapeHtml(def.name)}</h4><p>${escapeHtml(def.blurb)}</p>` +
        `<div class="act">Kindle converts wanderers to your tribe</div>`;
    }
    const who = tribeLabelOf(w, u.tribe);
    const act = this.haveOwnPeople() ? `${Verb} to attack` : 'Click to look';
    return `<div class="sub">${escapeHtml(who)}</div><h4>${escapeHtml(def.name)}</h4><div class="act">${act}</div>`;
  }

  private buildingTag(b: Building, Verb: string): string {
    const w = this.ctx.world;
    if (b.tribe === 'player') {
      let act = 'Click to select';
      if (this.haveOwnPeople() && (b.kind === 'tower' || b.kind === 'shrine') && b.progress >= 1) {
        act += ` · right-click to ${b.kind === 'tower' ? 'man it' : 'pray there'}`;
      }
      return `<h4>${escapeHtml(buildingName(b))}</h4>${b.progress < 1 ? `<p>${Math.floor(b.progress * 100)}% built</p>` : ''}<div class="act">${act}</div>`;
    }
    const act = this.haveOwnPeople() ? `${Verb} to attack it` : 'Click to look';
    return `<div class="sub">${escapeHtml(tribeLabelOf(w, b.tribe))}</div><h4>${escapeHtml(BUILDINGS[b.kind].name)}</h4><div class="act">${act}</div>`;
  }

  private stoneTag(index: number, Verb: string): string {
    const w = this.ctx.world;
    const m = w.monuments[index];
    const s = spellDef(m.spell);
    const blocked = stoneBlocked(w, m);
    const ritual = ritualAt(w, index);
    let html = `<div class="sub">Standing stone · tier ${s.tier}</div><h4>${escapeHtml(stoneName(m))}</h4>` +
      `<div class="spell">${spellIcon(m.spell, 22)}<span>${escapeHtml(stoneTerms(m))}</span></div>` +
      `<p>A ritual of ${fmtSeconds(ritualSeconds(m))}. Damage to the leader breaks it — bring an escort.</p>`;
    if (ritual) html += `<p>${escapeHtml(tribeLabelOf(w, ritual.tribe))} ${ritual.tribe === 'player' ? 'is' : 'are'} communing: ${Math.round(ritual.progress * 100)}%</p>`;
    if (blocked) html += `<div class="why">${escapeHtml(blocked)}</div>`;
    else if (this.leaderSelected()) html += `<div class="act">${Verb} to send your leader to commune</div>`;
    else html += `<div class="act">Select your leader, then ${Verb.toLowerCase()} the stone</div>`;
    return html;
  }
}
