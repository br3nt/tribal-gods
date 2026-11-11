/**
 * ui/world-overlay.ts — bars, marks and stone markers that float in the world.
 *
 * Above a person: a health bar when they're selected, inspected, hurt or
 * under the cursor, plus small badges for Stone Ward / Warsong. Above a
 * building: health when selected, hurt or still under construction (ochre
 * = building progress), a training bar while a villager trains inside, a
 * flame while it burns and a count of who is garrisoned. Above every
 * STANDING STONE: a carved marker showing the spell it holds (rim painted
 * by tier, dimmed while it sleeps or once claimed) and, while someone is
 * communing there, a ritual ring filling in that tribe's colour.
 *
 * These are DOM elements, not 3D sprites: crisp text and CSS for free, and
 * the position math is the same curved-world projection as everything else
 * (ui/project.ts toScreen).
 *
 * Each element belongs to ONE thing for as long as it is on screen (items
 * are keyed by `u<id>` / `b<id>`): a bar never jumps from one building to
 * another as the camera turns, and its fill is `scaleX(value)` from
 * ui/bar-fill.ts with no animation — the fill depends on the value only.
 * Items no longer needed are hidden and kept for reuse, so steady play
 * allocates nothing.
 */

import { BUILDINGS, spellDef, UNITS } from '../sim/catalog';
import { barFill, fillTransform, hpClass } from './bar-fill';
import { UiContext } from './context';
import { css, h, setClass, worldLayer } from './dom';
import { icon, spellIcon } from './icons';
import { tribeCss } from './orders';
import { STONE_HEIGHT } from './picking';
import { toScreen } from './project';
import { ritualAt } from './stones';

css('world-overlay', `
.wo { position: fixed; left: 0; top: 0; z-index: 3; pointer-events: none; display: flex; flex-direction: column; align-items: center; gap: 2px;
  transform: translate(-50%, -100%); will-change: transform; }
.wo .hp, .wo .tr { position: relative; width: 2.6rem; height: 0.375rem; overflow: hidden;
  background: #1c120b; border-radius: 1px 2px 1px 2px;
  box-shadow: 0 0 0 1px #0d0805, 0 1px 0 1px rgba(255,230,190,0.22); }
.wo.b .hp { width: 4.25rem; height: 0.4375rem; }
.wo .tr { width: 4.25rem; height: 0.3125rem; }
.wo .hp > i, .wo .tr > i { position: absolute; inset: 0; transform-origin: 0 50%; transform: scaleX(0);
  background: linear-gradient(180deg, #a9e07a, #5b9a35 70%, #3f6e25); }
.wo .hp > i.mid { background: linear-gradient(180deg, #f2c25a, #c98a22 70%, #8f5f14); }
.wo .hp > i.low { background: linear-gradient(180deg, #ff8a6a, #c8402a 70%, #8a2618); }
.wo .hp > i.build { background: repeating-linear-gradient(-55deg, #e7b25a 0 4px, #c98a2e 4px 7px); }
.wo .tr > i { background: linear-gradient(180deg, #b8f4f6, #4fc3cf 70%, #2a8590); }
.wo .hp > b { position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: var(--tc, transparent); }
.wo .marks { display: flex; gap: 2px; }
.wo .mk { display: inline-flex; align-items: center; gap: 1px; height: 1rem; padding: 0 0.22rem; border-radius: 0.2rem 0.3rem 0.2rem 0.3rem;
  background: #2e1e13; box-shadow: inset 0 0 0 1px rgba(0,0,0,0.6); color: var(--bone); font: 700 0.625rem/1 var(--font); }
.wo .mk.fire { color: #ffae5c; }
.wo .mk.ward { color: #d9dfe8; }
.wo .mk.song { color: var(--ochre-hi); }
.wo .mk.gar { color: var(--spirit); }

.stone-mk { position: fixed; left: 0; top: 0; z-index: 3; pointer-events: none; width: 2.1rem; height: 2.1rem; display: grid; place-items: center;
  transform: translate(-50%, -100%); will-change: transform; }
.stone-mk .disc { position: absolute; inset: 0.2rem; border-radius: 46% 54% 50% 50% / 52% 48% 52% 48%;
  background: radial-gradient(circle at 40% 30%, #8d877c, #5a554d 60%, #3b3833);
  box-shadow: inset 0 0 0 0.16rem var(--tier), inset 0 -0.15rem 0.3rem rgba(0,0,0,0.5), 0 0.15rem 0.35rem rgba(0,0,0,0.55); }
.stone-mk svg { position: relative; color: #f6efdc; filter: drop-shadow(0 0 0.25rem var(--tier)); }
.stone-mk .ritual { position: absolute; inset: -0.05rem; border-radius: 50%;
  background: conic-gradient(var(--rc) calc(var(--p) * 1turn), rgba(0,0,0,0.45) 0);
  -webkit-mask: radial-gradient(circle, transparent 62%, #000 64%); mask: radial-gradient(circle, transparent 62%, #000 64%); }
.stone-mk .ritual.idle { opacity: 0.45; }
.stone-mk .ritual.contested { animation: stone-contested 0.8s ease-in-out infinite alternate; }
@keyframes stone-contested { from { filter: drop-shadow(0 0 0 #ff5a3a); } to { filter: drop-shadow(0 0 0.35rem #ff5a3a); } }
.stone-mk .flag { position: absolute; top: -0.75rem; left: 50%; transform: translateX(-50%); white-space: nowrap; padding: 0.05rem 0.3rem; border-radius: 0.15rem 0.25rem;
  font: 800 0.5625rem/1.2 var(--font); letter-spacing: 0.06em; text-transform: uppercase; background: #6a1b0e; color: #ffe0d6; box-shadow: 0 0 0 1px #1a0904; }
.stone-mk .flag:empty { display: none; }
.stone-mk.dim { opacity: 0.55; filter: grayscale(0.8); }
.stone-mk.dim svg { filter: none; }
.stone-mk::after { content: ''; position: absolute; bottom: -0.35rem; left: 50%; width: 2px; height: 0.4rem; margin-left: -1px; background: linear-gradient(var(--tier), transparent); }
`);

/** Rim colour of a stone marker per spell tier: ochre, woad-turquoise, ember. */
export const TIER_COLORS = ['', '#e2b257', '#5fd0dc', '#ff7a45'];

interface Item {
  el: HTMLDivElement;
  hp: HTMLDivElement;
  hpFill: HTMLElement;
  hpTribe: HTMLElement;
  tr: HTMLDivElement;
  trFill: HTMLElement;
  marks: HTMLDivElement;
  marksSig: string;
  fillSig: string;
  trSig: string;
  key: string;
  seen: number;
}

interface StoneMark {
  el: HTMLDivElement;
  ritual: HTMLDivElement;
  flag: HTMLDivElement;
  spell: string;
}

const MAX_ITEMS = 220;

export class WorldOverlay {
  private readonly byKey = new Map<string, Item>();
  private readonly spare: Item[] = [];
  private frame = 0;
  private count = 0;
  private readonly stones: StoneMark[] = [];

  constructor(private readonly ctx: UiContext) {}

  private make(): Item {
    const hpFill = h('i');
    const hpTribe = h('b');
    const trFill = h('i');
    const hp = h('div.hp', {}, hpFill, hpTribe);
    const tr = h('div.tr', {}, trFill);
    const marks = h('div.marks');
    const el = h('div.wo', {}, marks, tr, hp);
    worldLayer().appendChild(el);
    return { el, hp, hpFill, hpTribe, tr, trFill, marks, marksSig: '', fillSig: '', trSig: '', key: '', seen: -1 };
  }

  /** The item that belongs to `key` (the same element every frame it stays on screen). */
  private item(key: string, building: boolean): Item {
    let it = this.byKey.get(key);
    if (!it) {
      it = this.spare.pop() ?? this.make();
      it.key = key;
      it.marksSig = '\u0000';
      it.fillSig = '';
      it.trSig = '';
      this.byKey.set(key, it);
    }
    it.seen = this.frame;
    this.count++;
    if (it.el.hidden) it.el.hidden = false;
    setClass(it.el, 'b', building);
    return it;
  }

  private place(el: HTMLElement, p: { x: number; y: number }): void {
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  private setHp(it: Item, frac: number, construction = false): void {
    if (it.hp.hidden) it.hp.hidden = false;
    const f = barFill(frac);
    const t = fillTransform(f);
    if (it.fillSig !== t) {
      it.fillSig = t;
      it.hpFill.style.transform = t;
    }
    const cls = construction ? 'build' : hpClass(f);
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

  /** Re-measure the panels (called ~8×/s, not per frame, to avoid forced layouts). */
  refreshBlockers(): void {
    this.blockers = [...document.querySelectorAll('#ui .tg-panel, #ui .al-card')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
  }

  update(): void {
    this.frame++;
    this.count = 0;
    const { world, view, selection, hover } = this.ctx;
    const camD = view.camera.position.distanceTo(view.target);
    // Zoomed far out, only selected things get bars (otherwise: confetti).
    const showHurt = camD < 120;

    for (const u of world.units) {
      if (this.count >= MAX_ITEMS) break;
      if (u.hidden) continue;
      const sel = selection.units.has(u.id) || selection.inspect === u.id || hover.unit === u.id;
      const hurt = u.hp < u.maxHp - 0.01;
      const buffed = u.wardTime > 0 || u.warsongTime > 0;
      if (!sel && !(showHurt && (hurt || (buffed && u.tribe === 'player')))) continue;
      const p = toScreen(view, u.x, u.z, UNITS[u.kind].height + 0.55);
      if (!p || this.covered(p)) continue;
      const it = this.item(`u${u.id}`, false);
      this.place(it.el, p);
      if (sel || hurt) this.setHp(it, u.hp / u.maxHp);
      else it.hp.hidden = true;
      it.tr.hidden = true;
      const marks: string[] = [];
      if (u.wardTime > 0) marks.push(`<span class="mk ward">${icon('shield', 10)}</span>`);
      if (u.warsongTime > 0) marks.push(`<span class="mk song">${icon('speed', 10)}</span>`);
      this.setMarks(it, marks);
      it.hpTribe.style.setProperty('--tc', u.tribe === 'player' ? 'transparent' : tribeCss(u.tribe));
    }

    for (const b of world.buildings) {
      if (this.count >= MAX_ITEMS) break;
      const sel = selection.building === b.id || hover.building === b.id;
      const hurt = b.hp < b.maxHp - 0.01;
      const building = b.progress < 1;
      const training = b.trainee >= 0 && world.unitById(b.trainee)?.garrison === b.id;
      const garrison = b.garrison.length;
      const burning = b.burning > 0;
      const ours = b.tribe === 'player';
      if (!sel && !burning && !(showHurt && (hurt || (ours && (building || training || garrison > 0))))) continue;
      const p = toScreen(view, b.x, b.z, BUILDINGS[b.kind].height + 0.8);
      if (!p || this.covered(p)) continue;
      const it = this.item(`b${b.id}`, true);
      this.place(it.el, p);
      if (building) this.setHp(it, b.progress, true);
      else if (sel || hurt) this.setHp(it, b.hp / b.maxHp);
      else it.hp.hidden = true;
      if (training) {
        const total = UNITS[BUILDINGS[b.kind].trains!].trainSeconds;
        it.tr.hidden = false;
        const t = fillTransform(1 - b.trainTime / total);
        if (it.trSig !== t) {
          it.trSig = t;
          it.trFill.style.transform = t;
        }
      } else it.tr.hidden = true;
      const marks: string[] = [];
      if (burning) marks.push(`<span class="mk fire">${icon('fire', 11)}</span>`);
      if (garrison > 0) marks.push(`<span class="mk gar">${icon(b.kind === 'shrine' ? 'prayer' : 'garrison', 10)}${garrison}</span>`);
      if (b.queue > 0 && ours) marks.push(`<span class="mk">${icon('plus', 9)}${b.queue}</span>`);
      this.setMarks(it, marks);
      it.hpTribe.style.setProperty('--tc', 'transparent');
    }

    // Whatever wasn't needed this frame goes back on the shelf.
    for (const [key, it] of this.byKey) {
      if (it.seen === this.frame) continue;
      it.el.hidden = true;
      this.byKey.delete(key);
      this.spare.push(it);
    }

    this.updateStones();
  }

  /** A marker above every stone: what it holds, and the ritual ring while someone communes. */
  private updateStones(): void {
    const { world, view } = this.ctx;
    while (this.stones.length < world.monuments.length) {
      const ritual = h('div.ritual');
      const flag = h('div.flag');
      const el = h('div.stone-mk', {}, h('div.disc'), ritual, flag);
      worldLayer().appendChild(el);
      this.stones.push({ el, ritual, flag, spell: '' });
    }
    this.stones.forEach((s, i) => {
      const m = world.monuments[i];
      const p = m ? toScreen(view, m.x, m.z, STONE_HEIGHT + 1.4) : null;
      if (!m || !p || this.covered(p)) {
        s.el.hidden = true;
        return;
      }
      s.el.hidden = false;
      if (s.spell !== m.spell) {
        s.spell = m.spell;
        s.el.querySelector('svg')?.remove();
        s.el.insertAdjacentHTML('beforeend', spellIcon(m.spell, 18));
        s.el.style.setProperty('--tier', TIER_COLORS[spellDef(m.spell).tier] ?? '#ccc');
      }
      this.place(s.el, p);
      setClass(s.el, 'dim', !world.monumentAvailable(m));
      const r = ritualAt(world, i);
      s.ritual.hidden = !r;
      if (r) {
        s.ritual.style.setProperty('--p', String(Math.round(r.progress * 200) / 200));
        s.ritual.style.setProperty('--rc', tribeCss(r.tribe));
        setClass(s.ritual, 'idle', !r.communing);
        setClass(s.ritual, 'contested', r.communing && r.contested);
      }
      const flag = r?.communing && r.contested ? 'Contested' : m.guardsAwake ? 'Guardians awake' : '';
      if (s.flag.textContent !== flag) s.flag.textContent = flag;
    });
  }
}
