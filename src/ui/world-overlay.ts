/**
 * ui/world-overlay.ts — health bars and status marks that float in the world.
 *
 * Above a person: a health bar when they're selected or hurt, plus small
 * badges for Stone Ward / Warsong. Above a building: health when selected,
 * hurt or still under construction (gold = building progress), a training
 * bar while a villager trains inside, a flame while it burns and a count
 * of who is garrisoned.
 *
 * These are pooled DOM elements, not 3D sprites: crisp text and CSS for
 * free, and the position math is the same curved-world projection as
 * everything else (ui/project.ts toScreen). The pool never shrinks — items
 * not needed this frame are just hidden — so nothing is allocated per frame.
 */

import { BUILDINGS, UNITS } from '../sim/catalog';
import { UiContext } from './context';
import { css, h, worldLayer } from './dom';
import { icon } from './icons';
import { tribeCss } from './orders';
import { toScreen } from './project';

css('world-overlay', `
.wo { position: fixed; left: 0; top: 0; z-index: 3; pointer-events: none; display: flex; flex-direction: column; align-items: center; gap: 2px;
  transform: translate(-50%, -100%); will-change: transform; }
.wo .hp { width: 2.6rem; height: 0.3125rem; border-radius: 2px; background: rgba(10,12,18,0.75); box-shadow: 0 0 0 1px rgba(0,0,0,0.45); overflow: hidden; }
.wo.b .hp { width: 4.25rem; height: 0.375rem; }
.wo .hp > i { display: block; height: 100%; width: 100%; background: var(--good); transition: width 120ms linear; }
.wo .hp > i.mid { background: var(--warn); }
.wo .hp > i.low { background: var(--bad); }
.wo .hp > i.build { background: var(--gold); }
.wo .tr { width: 4.25rem; height: 0.25rem; border-radius: 2px; background: rgba(10,12,18,0.75); overflow: hidden; }
.wo .tr > i { display: block; height: 100%; background: var(--mana); }
.wo .marks { display: flex; gap: 2px; }
.wo .mk { display: inline-flex; align-items: center; gap: 1px; height: 1rem; padding: 0 0.2rem; border-radius: var(--r-pill);
  background: rgba(10,12,18,0.8); color: var(--text); font: 700 0.5625rem/1 var(--font); }
.wo .mk.fire { color: #ff9a4a; }
.wo .mk.ward { color: #c9d4e8; }
.wo .mk.song { color: var(--gold); }
.wo .mk.gar { color: var(--mana); }
`);

interface Item {
  el: HTMLDivElement;
  hp: HTMLDivElement;
  hpFill: HTMLElement;
  tr: HTMLDivElement;
  trFill: HTMLElement;
  marks: HTMLDivElement;
  marksSig: string;
}

const MAX_ITEMS = 220;

export class WorldOverlay {
  private readonly pool: Item[] = [];
  private used = 0;

  constructor(private readonly ctx: UiContext) {}

  private item(building: boolean): Item {
    let it = this.pool[this.used];
    if (!it) {
      const hpFill = h('i');
      const trFill = h('i');
      const hp = h('div.hp', {}, hpFill);
      const tr = h('div.tr', {}, trFill);
      const marks = h('div.marks');
      const el = h('div.wo', {}, marks, tr, hp);
      worldLayer().appendChild(el);
      it = { el, hp, hpFill, tr, trFill, marks, marksSig: '' };
      this.pool.push(it);
    }
    this.used++;
    it.el.hidden = false;
    it.el.classList.toggle('b', building);
    return it;
  }

  private place(it: Item, p: { x: number; y: number }): void {
    it.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  private setHp(it: Item, frac: number, construction = false): void {
    it.hp.hidden = false;
    const w = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    if (it.hpFill.style.width !== w) it.hpFill.style.width = w;
    const cls = construction ? 'build' : frac < 0.3 ? 'low' : frac < 0.6 ? 'mid' : '';
    if (it.hpFill.className !== cls) it.hpFill.className = cls;
  }

  private setMarks(it: Item, marks: string[]): void {
    const sig = marks.join('|');
    if (sig === it.marksSig) return;
    it.marksSig = sig;
    it.marks.innerHTML = marks.join('');
  }

  /** Screen rects of the HUD panels: marks that would sit under one are skipped. */
  private blockers: DOMRect[] = [];

  private covered(p: { x: number; y: number }): boolean {
    for (const r of this.blockers) if (p.x >= r.left && p.x <= r.right && p.y >= r.top - 6 && p.y <= r.bottom + 6) return true;
    return false;
  }

  update(): void {
    this.used = 0;
    this.blockers = [...document.querySelectorAll('#ui .tg-panel')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    const { world, view, selection } = this.ctx;
    const camD = view.camera.position.distanceTo(view.target);
    // Zoomed far out, only selected things get bars (otherwise: confetti).
    const showHurt = camD < 120;

    for (const u of world.units) {
      if (this.used >= MAX_ITEMS) break;
      if (u.hidden) continue;
      const sel = selection.units.has(u.id);
      const hurt = u.hp < u.maxHp - 0.01;
      const buffed = u.wardTime > 0 || u.warsongTime > 0;
      if (!sel && !(showHurt && (hurt || (buffed && u.tribe === 'player')))) continue;
      const p = toScreen(view, u.x, u.z, UNITS[u.kind].height + 0.55);
      if (!p || this.covered(p)) continue;
      const it = this.item(false);
      this.place(it, p);
      if (sel || hurt) this.setHp(it, u.hp / u.maxHp);
      else it.hp.hidden = true;
      it.tr.hidden = true;
      const marks: string[] = [];
      if (u.wardTime > 0) marks.push(`<span class="mk ward">${icon('shield', 10)}</span>`);
      if (u.warsongTime > 0) marks.push(`<span class="mk song">${icon('speed', 10)}</span>`);
      this.setMarks(it, marks);
      it.hpFill.style.boxShadow = u.tribe === 'player' ? '' : `inset 0 -1px 0 ${tribeCss(u.tribe)}`;
    }

    for (const b of world.buildings) {
      if (this.used >= MAX_ITEMS) break;
      const sel = selection.building === b.id;
      const hurt = b.hp < b.maxHp - 0.01;
      const building = b.progress < 1;
      const training = b.trainee >= 0 && world.unitById(b.trainee)?.garrison === b.id;
      const garrison = b.garrison.length;
      const burning = b.burning > 0;
      const ours = b.tribe === 'player';
      if (!sel && !burning && !(showHurt && (hurt || (ours && (building || training || garrison > 0))))) continue;
      const p = toScreen(view, b.x, b.z, BUILDINGS[b.kind].height + 0.8);
      if (!p || this.covered(p)) continue;
      const it = this.item(true);
      this.place(it, p);
      if (building) this.setHp(it, b.progress, true);
      else if (sel || hurt) this.setHp(it, b.hp / b.maxHp);
      else it.hp.hidden = true;
      if (training) {
        const total = UNITS[BUILDINGS[b.kind].trains!].trainSeconds;
        it.tr.hidden = false;
        it.trFill.style.width = `${Math.max(0, Math.min(1, 1 - b.trainTime / total)) * 100}%`;
      } else it.tr.hidden = true;
      const marks: string[] = [];
      if (burning) marks.push(`<span class="mk fire">${icon('fire', 11)}</span>`);
      if (garrison > 0) marks.push(`<span class="mk gar">${icon(b.kind === 'shrine' ? 'prayer' : 'garrison', 10)}${garrison}</span>`);
      if (b.queue > 0 && ours) marks.push(`<span class="mk">${icon('plus', 9)}${b.queue}</span>`);
      this.setMarks(it, marks);
      it.hpFill.style.boxShadow = '';
    }

    for (let i = this.used; i < this.pool.length; i++) {
      const it = this.pool[i];
      if (!it.el.hidden) it.el.hidden = true;
    }
  }
}
