/**
 * ui/objectives-panel.ts — what you're here to do (top right).
 *
 * Reads world.objectives (catalog ObjectiveState): only the ACTIVE ones
 * (and those done or failed) — objectives chained with `after` appear when
 * they activate, written in with a flourish. The sentence, done (ticked),
 * failed (struck through in red), a progress bar where progress means something (population, survive,
 * hold), and an "optional" tag. When one completes, the time it happened
 * is remembered and shown ("done 4:12"). The header collapses the list to
 * a single line for players who know what they're doing.
 */

import { UiContext } from './context';
import { css, escapeHtml, h, setText } from './dom';
import { fmtClock } from './format';
import { fillTransform } from './bar-fill';
import { icon } from './icons';
import { carve } from './lettering';

css('objectives', `
/* A hide scroll between two rods. */
.ob { position: relative; width: 16.5rem; padding: 0.35rem 0.6rem 0.5rem; box-sizing: border-box; margin: 0.35rem 0; }
.ob::before, .ob::after { content: ''; position: absolute; left: -0.9rem; right: -0.9rem; height: 0.55rem; border-radius: 0.3rem;
  background: radial-gradient(circle at 0.3rem 50%, #e3c792 0 0.18rem, transparent 0.22rem), radial-gradient(circle at calc(100% - 0.3rem) 50%, #e3c792 0 0.18rem, transparent 0.22rem),
    linear-gradient(180deg, #b07a46, #6b4527 55%, #3a2312), var(--tex-wood-light);
  box-shadow: 0 0 0 1px #1a0e06, 0 2px 3px rgba(0,0,0,0.45); pointer-events: none; }
.ob::before { top: calc(-1 * var(--frame) - 0.35rem); }
.ob::after { bottom: calc(-1 * var(--frame) - 0.35rem); }
.ob-head { display: flex; align-items: center; gap: 0.4rem; width: 100%; padding: 0.1rem 0.1rem 0.25rem; background: none; border: 0; color: var(--text-3); cursor: pointer; font: 700 var(--t-xs)/1 var(--font); font-size: 0.8rem; }
.ob-head .count { margin-left: auto; color: var(--text-2); font: 800 var(--t-sm)/1 var(--font); }
.ob-head .chev { width: 0.4rem; height: 0.4rem; margin: 0 0.15rem 0.15rem 0.1rem; border: solid #7a3a10; border-width: 0 2px 2px 0; transform: rotate(45deg); transition: transform var(--fast) var(--ease); }
.ob.collapsed .chev { transform: rotate(-45deg); margin-bottom: 0; }
.ob.collapsed .ob-list { display: none; }
.ob-list { list-style: none; margin: 0.2rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.ob-item { display: grid; grid-template-columns: 1.1rem 1fr; gap: 0.15rem 0.45rem; font-size: var(--t-sm); line-height: 1.3; color: var(--text); font-weight: 600; }
/* A knot on the tally cord: open until done, then filled with ochre. */
.ob-item .mark { width: 0.95rem; height: 0.95rem; margin-top: 0.05rem; border-radius: 50%; box-shadow: inset 0 0 0 2px #6b4527; display: grid; place-items: center; box-sizing: border-box; background: rgba(255,250,235,0.35); }
.ob-item.done .mark { background: radial-gradient(circle at 40% 35%, #a9d77e, #3f7a22); box-shadow: 0 0 0 1px #2a4a12; color: #f4ffe8; }
.ob-item.done .txt { color: var(--text-3); text-decoration: line-through; text-decoration-color: rgba(60,35,15,0.5); }
.ob-item.failed .mark { background: #a3271a; box-shadow: 0 0 0 1px #4a0f06; color: #ffe4da; }
.ob-item.failed .txt { color: var(--text-3); text-decoration: line-through; text-decoration-color: rgba(163,39,26,0.8); text-decoration-thickness: 2px; }
.ob-item.failed .meta { color: var(--bad); }
.ob-item.fresh { animation: ob-fresh 1.4s var(--ease); }
.ob-item.fresh .txt { animation: ob-ink 1.4s var(--ease); }
@keyframes ob-fresh { 0% { opacity: 0; transform: translateX(0.6rem); } 30% { opacity: 1; transform: none; } }
@keyframes ob-ink { 0%, 30% { background: rgba(211,149,55,0.45); } 100% { background: transparent; } }
.ob-item .tag { display: inline-block; margin-left: 0.3rem; padding: 0 0.3rem; border-radius: 0.15rem; font-size: 0.625rem; font-weight: 700; color: var(--text-3); box-shadow: inset 0 0 0 1px var(--rim); vertical-align: 1px; }
.ob-item .meta { grid-column: 2; display: flex; align-items: center; gap: 0.5rem; font-size: var(--t-xs); color: var(--text-3); font-weight: 700; }
.ob-item .meta .bar { flex: 1; height: 0.35rem; }
`);

/** Seconds a finished objective stays on the scroll, ticked, before it is put away. */
const DONE_LINGER = 20;

export class ObjectivesPanel {
  readonly el: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly count: HTMLSpanElement;
  private sig = '';
  private readonly doneAt = new Map<number, number>();
  /** Objectives already written on the scroll (a newly active one arrives with a flourish). */
  private readonly seen = new Set<number>();

  constructor(private readonly ctx: UiContext) {
    this.el = h('div.ob.tg-panel.mat-hide');
    this.count = h('span.count');
    const head = h('button.ob-head', { type: 'button', 'aria-label': 'Objectives', html: `<span class="chev"></span>${carve('Objectives')}` }, this.count);
    head.addEventListener('click', () => this.el.classList.toggle('collapsed'));
    this.list = h('ul.ob-list');
    this.el.append(head, this.list);
  }

  /** Forget completion times (new scenario). */
  reset(): void {
    this.doneAt.clear();
    this.seen.clear();
    this.sig = '';
  }

  update(): void {
    const w = this.ctx.world;
    const obs = w.objectives;
    obs.forEach((o, i) => {
      if (o.done && !this.doneAt.has(i)) this.doneAt.set(i, w.elapsed);
    });
    // Objectives chain (`after`): one waiting on an earlier one stays off the
    // scroll until it activates, then is written in with a flourish.
    // Finished ones stay ticked for DONE_LINGER seconds, then leave the scroll (the count keeps them):
    // a story of eleven steps must not grow a scroll down the whole screen.
    const lingering = (i: number) => w.elapsed - (this.doneAt.get(i) ?? w.elapsed) < DONE_LINGER;
    const all = obs.map((o, i) => ({ o, i }));
    const shown = all.filter(({ o, i }) => (o.active !== false || o.done || o.failed) && (!o.done || lingering(i)));
    this.el.hidden = shown.length === 0;
    const sig = shown.map(({ o, i }) => `${i}|${o.text}|${o.done}|${o.failed}|${o.optional}`).join('/');
    if (sig !== this.sig) {
      const firstPaint = this.sig === '';
      this.sig = sig;
      this.list.innerHTML = shown
        .map(({ o, i }) => {
          const fresh = !firstPaint && !this.seen.has(i);
          const showBar = !o.done && !o.failed && o.progress > 0 && o.progress < 1;
          const cls = `ob-item${o.done ? ' done' : ''}${o.failed ? ' failed' : ''}${fresh ? ' fresh' : ''}`;
          return `<li class="${cls}"><span class="mark">${o.done ? icon('check', 10) : o.failed ? icon('close', 10) : ''}</span>` +
            `<span class="txt">${escapeHtml(o.text)}${o.optional ? '<span class="tag">optional</span>' : ''}</span>` +
            (o.done
              ? `<span class="meta">done ${fmtClock(this.doneAt.get(i) ?? w.elapsed)}</span>`
              : o.failed
                ? `<span class="meta">failed</span>`
                : showBar
                  ? `<span class="meta"><span class="bar gold"><i data-i="${i}"></i></span><span data-p="${i}"></span></span>`
                  : '') +
            `</li>`;
        })
        .join('');
      for (const { i } of shown) this.seen.add(i);
    }
    for (const { o, i } of shown) {
      const bar = this.list.querySelector<HTMLElement>(`[data-i="${i}"]`);
      if (bar) bar.style.transform = fillTransform(o.progress);
      const p = this.list.querySelector(`[data-p="${i}"]`);
      if (p) setText(p, `${Math.round(o.progress * 100)}%`);
    }
    const req = all.filter(({ o }) => !o.optional && (o.active !== false || o.done));
    setText(this.count, `${req.filter(({ o }) => o.done).length}/${req.length}`);
  }
}
