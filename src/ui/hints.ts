/**
 * ui/hints.ts — the first few minutes, one nudge at a time.
 *
 * Instead of a wall of help text, a single small chip near the top of the
 * screen suggests the next thing worth doing. Each hint has a moment it
 * becomes relevant and a condition that means "they've got it" — then it
 * disappears by itself. Dismissed or completed hints are remembered in
 * localStorage, so nobody is taught the same thing twice. Settings can turn
 * them off altogether.
 */

import { BUILD_ORDER } from '../sim/catalog';
import { UiContext } from './context';
import { css, h } from './dom';
import { labelFor } from './hotkeys';
import { icon, UiIconName } from './icons';
import { settings } from './settings';
import { activeSpell } from './tools';

interface Hint {
  id: string;
  icon: UiIconName;
  html: () => string;
  /** Should it show now? */
  when: (c: UiContext, t: number) => boolean;
  /** Has the player done it? */
  done: (c: UiContext) => boolean;
}

const KEY = 'tg.hints.v1';

css('hints', `
.hint-chip { display: flex; align-items: center; gap: 0.6rem;
  max-width: 100%; padding: 0.5rem 0.5rem 0.5rem 0.75rem; font-size: var(--t-sm); line-height: 1.35; color: var(--text);
  animation: hint-in 400ms var(--ease); }
.hint-chip .ic { flex: none; width: 1.9rem; height: 1.9rem; border-radius: 50%; display: grid; place-items: center; background: var(--gold-soft); color: var(--gold); }
.hint-chip .kbd { margin: 0 0.1rem; }
.hint-chip .tg-btn { flex: none; }
@keyframes hint-in { from { opacity: 0; transform: translateY(-0.5rem); } to { opacity: 1; transform: none; } }
`);

const k = (a: Parameters<typeof labelFor>[0]) => `<span class="kbd">${labelFor(a)}</span>`;

export class Hints {
  private readonly seen: Set<string>;
  private readonly hints: Hint[];
  private el: HTMLDivElement | null = null;
  private showing: string | null = null;
  private startCam = { x: 0, z: 0 };
  private armedOnce = false;
  private learnedFrom = 0;
  private sinceStart = 0;

  constructor(private readonly ctx: UiContext, private readonly column: HTMLElement) {
    let saved: string[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    } catch {
      /* fresh */
    }
    this.seen = new Set(saved);
    const moved = () => Math.hypot(ctx.view.target.x - this.startCam.x, ctx.view.target.z - this.startCam.z) > 10;
    const ownHut = () => ctx.world.buildings.some((b) => b.tribe === 'player' && b.kind === 'hut');
    this.hints = [
      {
        id: 'camera', icon: 'eye',
        html: () => `Look around: <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> pan, <span class="kbd">Q</span><span class="kbd">E</span> rotate, the wheel zooms. ${k('centre-leader')} jumps to your leader.`,
        when: (_c, t) => t > 1.5, done: moved,
      },
      {
        id: 'dwelling', icon: 'housed',
        html: () => `Build a Dwelling: pick it in the Build panel ${k(`build:${BUILD_ORDER[0]}`)} and click open ground. Homes breed villagers and feed your spells.`,
        when: (_c, t) => t > 4, done: ownHut,
      },
      {
        id: 'spells', icon: 'book',
        html: () => `Your leader casts spells: pick one in the spell book (${k('spell:blast')} is Blast), then click the world.`,
        when: (_c, t) => t > 30 || ownHut(), done: () => this.armedOnce,
      },
      {
        id: 'stones', icon: 'stone',
        html: () => `Standing stones teach new spells. Select your leader ${k('select-leader')} and right-click a stone to commune.`,
        when: (c, t) => t > 90 && c.world.monuments.some((m) => c.world.monumentAvailable(m)),
        done: (c) => (c.world.tribes.player?.known.size ?? 0) > this.learnedFrom,
      },
      {
        id: 'select', icon: 'move',
        html: () => `Drag a box to select people; right-click to send them. The cursor shows what a right-click will do.`,
        when: (_c, t) => t > 60, done: (c) => c.selection.units.size > 1,
      },
    ];
  }

  /** New game: restart the clock (completed hints stay completed). */
  reset(): void {
    this.sinceStart = 0;
    this.startCam = { x: this.ctx.view.target.x, z: this.ctx.view.target.z };
    this.learnedFrom = this.ctx.world.tribes.player?.known.size ?? 0;
    this.hide();
  }

  private remember(id: string): void {
    this.seen.add(id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.seen]));
    } catch {
      /* storage blocked */
    }
  }

  /** Forget everything (Settings → "Show hints again"). */
  resetSeen(): void {
    this.seen.clear();
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* storage blocked */
    }
  }

  private hide(): void {
    this.el?.remove();
    this.el = null;
    this.showing = null;
  }

  update(dt: number): void {
    this.sinceStart += dt;
    if (activeSpell()) this.armedOnce = true;
    if (!settings.hints) return this.hide();
    // Retire the one showing if it's done.
    for (const hint of this.hints) {
      if (!this.seen.has(hint.id) && hint.done(this.ctx)) {
        this.remember(hint.id);
        if (this.showing === hint.id) this.hide();
      }
    }
    if (this.showing) return;
    const next = this.hints.find((x) => !this.seen.has(x.id) && x.when(this.ctx, this.sinceStart));
    if (!next) return;
    this.showing = next.id;
    const close = h('button.tg-btn.icon-only', { type: 'button', 'aria-label': 'Dismiss hint', html: icon('close', 14) });
    close.addEventListener('click', () => {
      this.remember(next.id);
      this.hide();
    });
    this.el = h('div.hint-chip.tg-panel', { role: 'status' }, h('span.ic', { html: icon(next.icon, 16) }), h('span', { html: next.html() }), close);
    this.column.appendChild(this.el); // below the narrator line (ui/narrator.ts)
  }
}
