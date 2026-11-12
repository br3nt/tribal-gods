/**
 * ui/game-over.ts — victory or defeat, how it went, and what next.
 *
 * Shown once when world.gameOver is set: the result, world.gameOverReason,
 * a few numbers (time, peak population, spells cast, buildings standing)
 * and buttons. The defaults are Keep watching / Restart / Main menu.
 *
 * OTHER MODULES ADD BUTTONS here without touching this file — the campaign
 * registers a provider that returns "Next scenario" after a victory:
 *
 *   import { registerGameOverAction } from './game-over';
 *   registerGameOverAction((result) =>
 *     result === 'victory' ? { label: 'Next scenario', primary: true, run: () => … } : null);
 *
 * Providers are asked every time the overlay opens, so they can decide
 * from the current scenario. The returned function unregisters.
 */

import { css, h, uiRoot } from './dom';
import { fmtClock } from './format';
import { icon, UiIconName } from './icons';
import { carve } from './lettering';

export type GameResult = 'victory' | 'defeat';

export interface GameOverAction {
  label: string;
  /** Gold button; the first primary action gets focus. */
  primary?: boolean;
  icon?: UiIconName;
  run(): void;
}

export interface GameOverStats {
  seconds: number;
  peakPopulation: number;
  spellsCast: number;
  buildings: number;
}

type Provider = (result: GameResult) => GameOverAction | GameOverAction[] | null;
const providers: Provider[] = [];

/** Add buttons to the game-over screen (see the header). Returns an unregister function. */
export function registerGameOverAction(provider: Provider): () => void {
  providers.push(provider);
  return () => {
    const i = providers.indexOf(provider);
    if (i >= 0) providers.splice(i, 1);
  };
}

css('game-over', `
.go { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; pointer-events: auto;
  background: radial-gradient(ellipse at center, rgba(22,13,7,0.3), rgba(16,9,4,0.8)); animation: go-in 500ms var(--ease); }
.go-card { width: min(30rem, calc(100vw - 2rem)); padding: 1.6rem 1.8rem 1.4rem; text-align: center; box-sizing: border-box; }
/* The badge: a carved wooden disc nailed to the top of the hide. */
.go-badge { width: 4.5rem; height: 4.5rem; margin: -3.9rem auto 0.6rem; border-radius: 50%; display: grid; place-items: center; color: #2a1708;
  background: radial-gradient(circle at 45% 35%, rgba(255,236,200,0.4), rgba(0,0,0,0.12) 70%), var(--tex-wood-light) 0 0 / 7rem;
  box-shadow: 0 0 0 0.25rem var(--ochre), 0 0 0 0.35rem #1a0e06, 0 0 2rem rgba(242,197,106,0.45); }
.go.defeat .go-badge { box-shadow: 0 0 0 0.25rem var(--red-ochre), 0 0 0 0.35rem #1a0e06, 0 0 2rem rgba(194,70,44,0.4); }
.go h1 { margin: 0; font-size: 3rem; line-height: 1; }
.go.victory h1 { --carve-paint: #9a5a12; }
.go.defeat h1 { --carve-paint: #a3271a; }
.go .why { margin: 0.7rem 0 1.2rem; color: var(--text-2); font: italic 600 var(--t-md)/1.4 var(--font); }
.go-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin-bottom: 1.3rem; }
/* Each number on a little bone tally. */
.go-stat { padding: 0.5rem 0.25rem 0.45rem; border-radius: 0.25rem 0.4rem; background: linear-gradient(#fbf3df, #e2cfa8); box-shadow: 0 0 0 1.5px rgba(70,40,15,0.55), 0 2px 0 rgba(70,40,15,0.35); }
.go-stat b { display: block; font: 800 var(--t-xl)/1.1 var(--font); color: #24160c; }
.go-stat span { font-size: var(--t-xs); color: #5a412b; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
.go-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; }
.go-actions .tg-btn { min-height: 2.5rem; padding: 0 1.1rem; font-size: var(--t-md); }
@keyframes go-in { from { opacity: 0; } to { opacity: 1; } }
`);

export class GameOverScreen {
  private el: HTMLDivElement | null = null;

  constructor(private readonly defaults: { onRestart(): void; onMenu(): void }) {}

  get visible(): boolean {
    return !!this.el;
  }

  show(result: GameResult, reason: string | null, stats: GameOverStats): void {
    this.hide();
    const win = result === 'victory';
    const actions: GameOverAction[] = [];
    for (const p of providers) {
      const r = p(result);
      if (r) actions.push(...(Array.isArray(r) ? r : [r]));
    }
    actions.push(
      { label: 'Keep watching', icon: 'eye', run: () => this.hide() },
      { label: 'Restart', icon: 'arrowRight', primary: !actions.some((a) => a.primary), run: () => { this.hide(); this.defaults.onRestart(); } },
      { label: 'Main menu', icon: 'menu', run: () => { this.hide(); this.defaults.onMenu(); } },
    );
    const stat = (v: string, l: string) => `<div class="go-stat"><b>${v}</b><span>${l}</span></div>`;
    const card = h('div.go-card.tg-panel.mat-hide', {
      html:
        `<div class="go-badge">${icon(win ? 'trophy' : 'skull', 34)}</div>` +
        `<h1>${carve(win ? 'Victory' : 'Defeat')}</h1>` +
        `<p class="why"></p>` +
        `<div class="go-stats">${stat(fmtClock(stats.seconds), 'time')}${stat(String(stats.peakPopulation), 'peak people')}${stat(String(stats.spellsCast), 'spells cast')}${stat(String(stats.buildings), 'buildings')}</div>`,
    });
    (card.querySelector('.why') as HTMLElement).textContent = reason ?? (win ? 'The planet is yours.' : 'Your tribe has fallen silent.');
    const row = h('div.go-actions');
    let focus: HTMLButtonElement | null = null;
    for (const a of actions) {
      const b = h('button', { type: 'button', class: `tg-btn${a.primary ? ' primary' : ''}`, html: `${a.icon ? icon(a.icon, 16) : ''}<span></span>` });
      (b.lastElementChild as HTMLElement).textContent = a.label;
      b.addEventListener('click', () => a.run());
      row.appendChild(b);
      if (a.primary && !focus) focus = b;
    }
    card.appendChild(row);
    this.el = h('div', { class: `go ${result}` }, card);
    uiRoot().appendChild(this.el);
    focus?.focus();
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}
