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

import { BUILD_ORDER, BUILDINGS, SPELLS } from '../sim/catalog';
import { UiContext } from './context';
import { css, h } from './dom';
import { labelFor, orderVerb } from './hotkeys';
import { icon, UiIconName } from './icons';
import { settings } from './settings';
import { ritualOf } from './stones';
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

/** The player's leader's ritual, if one is under way. */
const ritualOfLeader = (c: UiContext) => {
  const l = c.world.leaderOf('player');
  return l ? ritualOf(c.world, l.id) : null;
};

const k = (a: Parameters<typeof labelFor>[0]) => `<span class="kbd">${labelFor(a)}</span>`;

export class Hints {
  private readonly seen: Set<string>;
  private readonly hints: Hint[];
  private el: HTMLDivElement | null = null;
  private textEl: HTMLSpanElement | null = null;
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
    const w = () => ctx.world;
    const ownHut = () => w().buildings.some((b) => b.tribe === 'player' && b.kind === 'hut');
    const verb = () => orderVerb(settings.leftClickOrders);
    const leader = () => w().leaderOf('player');
    /** The spell the spells hint teaches: Blast when the tribe knows it, else the first it knows. */
    const teachSpell = () => {
      const known = SPELLS.filter((s) => w().spellState('player', s.id).known || w().spellState('player', s.id).gifted > 0);
      return known.find((s) => s.id === 'blast') ?? known[0] ?? null;
    };
    const dwelling = BUILD_ORDER[0];
    this.hints = [
      {
        id: 'camera', icon: 'eye',
        html: () => `Look around: <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> pan, <span class="kbd">Q</span><span class="kbd">E</span> rotate, the wheel zooms. ${k('centre-leader')} jumps to your leader.`,
        when: (_c, t) => t > 1.5, done: moved,
      },
      {
        id: 'dwelling', icon: 'housed',
        // Only while a Dwelling is allowed here; while the wood isn't there yet, say so rather than ask for the impossible.
        html: () => {
          const st = w().buildState('player', dwelling);
          const name = BUILDINGS[dwelling].name;
          if (!st.affordable) {
            return `A ${name} costs ${BUILDINGS[dwelling].wood} wood; you have ${w().tribeSummary('player').wood}. Your villagers are felling trees — build one ${k(`build:${dwelling}`)} when the wood is in.`;
          }
          return `Build a ${name}: pick it in the Build panel ${k(`build:${dwelling}`)} and click open ground. Homes breed villagers and feed your spells.`;
        },
        when: (_c, t) => t > 4 && w().buildState('player', dwelling).allowed && w().buildState('player', dwelling).unlocked, done: ownHut,
      },
      {
        id: 'spells', icon: 'book',
        // Never "pick Blast" while Blast has nothing to cast: say what is happening instead.
        html: () => {
          const s = teachSpell()!;
          const st = w().spellState('player', s.id);
          const key = k(`spell:${s.id}`);
          if (!leader()) return `Your leader casts every spell. They are returning to the home circle — spells wait for them.`;
          if (st.charges + st.gifted > 0) return `${s.name} is ready: press ${key} (or click it in the spell book), then click the world. Your leader walks into range and casts.`;
          if (!st.charging) return `${s.name} is not charging. Right-click its stone in the spell book to pour mana into it.`;
          return `${s.name} is gathering power — its stones fill as your people pray${Number.isFinite(st.eta) ? ` (about ${Math.ceil(st.eta)}s)` : ''}. When it glows, press ${key} and click the world.`;
        },
        when: (_c, t) => (t > 30 || ownHut()) && !!teachSpell(), done: () => this.armedOnce,
      },
      {
        id: 'stones', icon: 'stone',
        html: () => `Standing stones teach spells — the marker above each shows which. Select your leader ${k('select-leader')} and ${verb()} a stone to commune. The ritual takes a while and damage breaks it: bring an escort.`,
        when: (c, t) => t > 90 && !!leader() && c.world.monuments.some((m) => c.world.monumentAvailable(m)),
        done: (c) => (c.world.tribes.player?.known.size ?? 0) > this.learnedFrom || c.world.units.some((u) => u.tribe === 'player' && u.task === 'worship'),
      },
      {
        id: 'ritual', icon: 'shield',
        html: () => `Your leader is communing and can't defend themselves. Any hit breaks the ritual — keep warriors beside them until it's done.`,
        when: (c) => !!ritualOfLeader(c), done: (c) => (c.world.tribes.player?.known.size ?? 0) > this.learnedFrom,
      },
      {
        id: 'select', icon: 'move',
        html: () => settings.leftClickOrders
          ? `Drag on the ground to select your people, then click where they should go. The cursor shows what a click will do.`
          : `Drag on the ground to select your people; right-click to send them. The cursor shows what a right-click will do.`,
        when: (c, t) => t > 60 && c.world.units.filter((u) => u.tribe === 'player' && !u.hidden).length > 1, done: (c) => c.selection.units.size > 1,
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
    if (this.showing) {
      const cur = this.hints.find((x) => x.id === this.showing)!;
      // The situation changed under the hint (wood arrived, a charge filled): reword it, or
      // withdraw it if it no longer applies — a hint never asks for something impossible.
      if (!cur.when(this.ctx, this.sinceStart)) return this.hide();
      const html = cur.html();
      if (this.textEl && this.textEl.innerHTML !== html) this.textEl.innerHTML = html;
      return;
    }
    const next = this.hints.find((x) => !this.seen.has(x.id) && x.when(this.ctx, this.sinceStart));
    if (!next) return;
    this.showing = next.id;
    const close = h('button.tg-btn.icon-only', { type: 'button', 'aria-label': 'Dismiss hint', html: icon('close', 14) });
    close.addEventListener('click', () => {
      this.remember(next.id);
      this.hide();
    });
    this.textEl = h('span.txt', { html: next.html() });
    this.el = h('div.hint-chip.tg-panel', { role: 'status' }, h('span.ic', { html: icon(next.icon, 16) }), this.textEl, close);
    this.column.appendChild(this.el); // below the narrator line (ui/narrator.ts)
  }
}
