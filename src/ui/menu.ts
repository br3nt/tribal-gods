/**
 * ui/menu.ts — the title screen, skirmish setup, and the in-game menu.
 *
 * The planet keeps turning behind every screen (main.ts slowly orbits the
 * camera while the menu is up), so the menu is a frame around the world,
 * not a wall in front of it.
 *
 * Screens:
 *   title     Campaign · Skirmish · Levels · Editor · Settings · How to play
 *   skirmish  civilisation (config CIVS), difficulty, number of rivals (1–3)
 *   settings  ui/settings-panel.ts
 *   help      ui/help.ts, built from the real hotkey table
 *   pause     the in-game menu: Resume · Settings · How to play · Restart · Main menu
 *   custom    any element another module wants framed (showCustom)
 *
 * The menu owns no game logic. It collects GameSettings and calls hooks
 * that main.ts (and the campaign stream) fill in:
 *
 *   menu.onSkirmish(settings)   start a random skirmish
 *   menu.onCampaign()           open the campaign (null = not available yet)
 *   menu.onLevels()             open the level library
 *   menu.onEditor()             open the editor
 *   menu.onResume / onRestart / onQuit   in-game menu verbs
 */

import { CIVS, CivId, DIFFICULTIES, Difficulty } from '../config';
import { TRIBE_COLORS, TRIBE_IDS } from '../sim/catalog';
import type { GameSettings } from '../sim/world-state';
import { css, h } from './dom';
import { helpHtml } from './help';
import { icon, UiIconName } from './icons';
import { settingsPanel, SettingsHooks } from './settings-panel';

css('menu', `
.menu { position: fixed; inset: 0; z-index: 30; display: flex; color: var(--text); pointer-events: auto;
  background: linear-gradient(90deg, rgba(8,11,18,0.88) 0%, rgba(8,11,18,0.6) 34%, rgba(8,11,18,0.05) 70%); }
.menu.sub { background: rgba(8,11,18,0.62); align-items: center; justify-content: center; }
.menu-title { display: flex; flex-direction: column; justify-content: center; gap: 2.2rem; padding: 0 0 0 clamp(1.5rem, 7vw, 7rem); max-width: 30rem; }
.menu-logo h1 { margin: 0; font: 600 clamp(3rem, 7vw, 5.25rem)/0.95 var(--font-display); letter-spacing: 0.01em; color: #fff4dc;
  text-shadow: 0 0.25rem 2rem rgba(0,0,0,0.5); }
.menu-logo p { margin: 0.9rem 0 0; color: var(--text-2); font-size: var(--t-lg); max-width: 24rem; line-height: 1.45; }
.menu-logo .rule { width: 3.5rem; height: 2px; margin-top: 1.1rem; background: linear-gradient(90deg, var(--gold), transparent); }
.menu-nav { display: flex; flex-direction: column; gap: 0.4rem; width: 17rem; }
.menu-nav .tg-btn:not(.primary) { background: rgba(255,255,255,0.05); }
.menu-nav .tg-btn { justify-content: flex-start; min-height: 2.9rem; padding: 0 1rem; font-size: var(--t-md); font-weight: 600; backdrop-filter: var(--blur); }
.menu-nav .tg-btn svg { color: var(--gold); }
.menu-nav .tg-btn.primary svg { color: inherit; }
.menu-nav .tg-btn .soon { margin-left: auto; font-size: var(--t-xs); color: var(--text-3); font-weight: 500; }
.menu-foot { font-size: var(--t-xs); color: var(--text-3); }
.menu-card { width: min(60rem, calc(100vw - 2rem)); max-height: calc(100vh - 3rem); display: flex; flex-direction: column; }
.menu-card > header { display: flex; align-items: center; gap: 0.75rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--rim); }
.menu-card > header h2 { margin: 0; font: 600 var(--t-xl)/1 var(--font-display); }
.menu-card > header .grow { flex: 1; }
.menu-card > .body { padding: 1.25rem; overflow-y: auto; }
.menu-card > footer { display: flex; justify-content: flex-end; gap: 0.6rem; padding: 0.9rem 1.25rem; border-top: 1px solid var(--rim); }
.menu-card > footer .tg-btn { min-height: 2.6rem; padding: 0 1.4rem; font-size: var(--t-md); }
.pause-card { width: min(22rem, calc(100vw - 2rem)); padding: 1.5rem; display: flex; flex-direction: column; gap: 0.45rem; }
.pause-card h2 { margin: 0 0 0.75rem; text-align: center; font: 600 var(--t-xl)/1 var(--font-display); }
.pause-card .tg-btn { min-height: 2.75rem; justify-content: flex-start; padding: 0 1rem; font-size: var(--t-md); }
.sk h3 { margin: 0 0 0.6rem; font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-3); font-weight: 600; }
.sk section + section { margin-top: 1.4rem; }
.sk-civs { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.6rem; }
.sk-civ { text-align: left; padding: 1rem; border-radius: var(--r3); border: 1px solid var(--rim); background: var(--ink-2); color: var(--text); cursor: pointer; font: inherit;
  display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.8rem; transition: border-color var(--fast), background var(--fast); }
.sk-civ:hover { border-color: var(--rim-strong); background: var(--ink-3); }
.sk-civ.on { border-color: var(--gold); background: var(--gold-soft); box-shadow: 0 0 0 1px var(--gold) inset; }
.sk-civ .crest { grid-row: span 3; width: 3rem; height: 3rem; border-radius: 50%; display: grid; place-items: center; background: rgba(0,0,0,0.3); color: var(--ac); box-shadow: inset 0 0 0 2px var(--ac); }
.sk-civ b { font-size: var(--t-lg); }
.sk-civ .lead { font-size: var(--t-xs); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; }
.sk-civ p { margin: 0.2rem 0 0; font-size: var(--t-sm); color: var(--text-2); line-height: 1.4; }
.sk-opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1.4rem; }
.sk .seg-desc { margin-top: 0.45rem; font-size: var(--t-sm); color: var(--text-2); }
.sk .rivals { display: inline-flex; gap: 0.2rem; margin-left: 0.4rem; }
.sk .rivals i { width: 0.55rem; height: 0.55rem; border-radius: 50%; }
`);

type Screen = 'title' | 'skirmish' | 'settings' | 'help' | 'pause';

export class Menu {
  private readonly overlay: HTMLDivElement;
  private civ: CivId = 'forest';
  private difficulty: Difficulty = 'normal';
  private enemies = 1;
  private screen: Screen = 'title';
  /** Where Back goes from settings/help (title, or the in-game menu). */
  private backTo: Screen = 'title';
  inGame = false;

  /** Hooks, filled by main.ts and the campaign stream. */
  onSkirmish: ((settings: GameSettings) => void) | null = null;
  onCampaign: (() => void) | null = null;
  onLevels: (() => void) | null = null;
  onEditor: (() => void) | null = null;
  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onQuit: (() => void) | null = null;
  settingsHooks: SettingsHooks = { inGame: () => this.inGame, onEdgePan: () => {}, onResetHints: () => {} };

  constructor(onStart?: (settings: GameSettings) => void) {
    if (onStart) this.onSkirmish = onStart;
    this.overlay = h('div.menu');
    document.body.appendChild(this.overlay);
    addEventListener('keydown', (e) => {
      if (!this.visible || this.overlay.classList.contains('custom')) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        if (e.repeat) return e.stopImmediatePropagation();
        e.stopImmediatePropagation(); // the game's own Esc handler must not re-open us
        this.back();
      } else if (e.code === 'F1' && this.screen === 'title') {
        e.preventDefault();
        this.show('help');
      }
    });
    this.render();
  }

  /** The setup the player last chose — levels reuse it when launched. */
  get settings(): GameSettings {
    return { playerCiv: this.civ, difficulty: this.difficulty, enemies: this.enemies };
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none';
  }

  /** Show the title screen (or another screen). */
  show(screen: Screen = 'title'): void {
    if (screen === 'pause') this.inGame = true;
    if (screen === 'title') this.inGame = false;
    this.screen = screen;
    this.overlay.style.display = 'flex';
    this.render();
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }

  /** Open from inside a game: the pause card, or straight to help/settings (Back returns to the pause card). */
  openInGame(screen: 'pause' | 'help' | 'settings' = 'pause'): void {
    this.inGame = true;
    this.backTo = 'pause';
    this.show(screen);
  }

  /** Frame any element as a menu screen (the campaign map, a briefing…). */
  showCustom(title: string, body: HTMLElement, opts: { onBack?: () => void; footer?: HTMLElement[] } = {}): void {
    this.overlay.style.display = 'flex';
    this.overlay.className = 'menu sub custom';
    const card = this.card(title, body, opts.onBack ?? (() => this.show('title')), opts.footer ?? []);
    this.overlay.replaceChildren(card);
    card.querySelector<HTMLElement>('button')?.focus();
  }

  /** Esc / Back. */
  back(): void {
    if (this.screen === 'pause') this.onResume?.();
    else if (this.screen === 'title') return;
    else this.show(this.backTo);
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    this.overlay.className = this.screen === 'title' ? 'menu' : 'menu sub';
    const el =
      this.screen === 'title' ? this.titleScreen()
      : this.screen === 'skirmish' ? this.skirmishScreen()
      : this.screen === 'settings' ? this.card('Settings', settingsPanel(this.settingsHooks), () => this.show(this.backTo))
      : this.screen === 'help' ? this.card('How to play', h('div', { html: helpHtml() }), () => this.show(this.backTo))
      : this.pauseScreen();
    this.overlay.replaceChildren(el);
    el.querySelector<HTMLElement>('.tg-btn.primary, .tg-btn')?.focus({ preventScroll: true });
  }

  private navBtn(label: string, ic: UiIconName, fn: (() => void) | null, primary = false, soon = ''): HTMLButtonElement {
    const b = h('button', { type: 'button', class: `tg-btn${primary ? ' primary' : ''}`, html: `${icon(ic, 18)}<span></span>${soon ? `<span class="soon">${soon}</span>` : ''}` });
    (b.children[1] as HTMLElement).textContent = label;
    if (fn) b.addEventListener('click', fn);
    else b.disabled = true;
    return b;
  }

  private titleScreen(): HTMLElement {
    this.backTo = 'title';
    const nav = h('nav.menu-nav', { 'aria-label': 'Main menu' },
      this.navBtn('Campaign', 'objective', this.onCampaign ? () => { this.hide(); this.onCampaign!(); } : null, !!this.onCampaign, this.onCampaign ? '' : 'coming soon'),
      this.navBtn('Skirmish', 'attack', () => this.show('skirmish'), !this.onCampaign),
      this.navBtn('Levels', 'book', () => { this.hide(); this.onLevels?.(); }),
      this.navBtn('Editor', 'hammer', () => { this.hide(); this.onEditor?.(); }),
      this.navBtn('Settings', 'settings', () => this.show('settings')),
      this.navBtn('How to play', 'info', () => this.show('help')),
    );
    return h('div.menu-title', {},
      h('div.menu-logo', { html: `<h1>Tribal Gods</h1><div class="rule"></div><p>A small round world, a tribe that grows, and a leader who speaks with the sky.</p>` }),
      nav,
      h('div.menu-foot', { text: 'F1 how to play · Esc back' }),
    );
  }

  private card(title: string, body: HTMLElement, onBack: () => void, footer: HTMLElement[] = []): HTMLElement {
    const back = h('button.tg-btn.icon-only', { type: 'button', 'aria-label': 'Back', html: `<span style="display:inline-flex;transform:scaleX(-1)">${icon('arrowRight', 18)}</span>` });
    back.addEventListener('click', onBack);
    const head = h('header', {}, back, h('h2', { text: title }), h('span.grow'));
    const card = h('div.menu-card.tg-panel', {}, head, h('div.body', {}, body));
    if (footer.length) card.appendChild(h('footer', {}, ...footer));
    return card;
  }

  private skirmishScreen(): HTMLElement {
    const body = h('div.sk');
    // Civilisations
    const civs = h('div.sk-civs', { role: 'radiogroup' });
    const paint = () => {
      for (const c of civs.children) c.classList.toggle('on', (c as HTMLElement).dataset.civ === this.civ);
    };
    for (const civ of Object.values(CIVS)) {
      const ac = `#${civ.accent.toString(16).padStart(6, '0')}`;
      const b = h('button.sk-civ', { type: 'button', role: 'radio', style: `--ac:${ac}` },
        h('span.crest', { html: icon('leader', 26) }),
        h('b', { text: civ.name }),
        h('span.lead', { text: `led by ${civ.leaderTitle}` }),
        h('p', { text: civ.blurb }),
      );
      b.dataset.civ = civ.id;
      b.addEventListener('click', () => {
        this.civ = civ.id;
        paint();
      });
      civs.appendChild(b);
    }
    paint();
    body.appendChild(h('section', {}, h('h3', { text: 'Your people' }), civs));

    // Difficulty + rivals
    const diffDesc = h('div.seg-desc');
    const diff = h('div.seg', { role: 'radiogroup' });
    const paintDiff = () => {
      for (const b of diff.children) b.classList.toggle('on', (b as HTMLElement).dataset.v === this.difficulty);
      diffDesc.textContent = DIFFICULTIES[this.difficulty].label;
    };
    for (const id of Object.keys(DIFFICULTIES) as Difficulty[]) {
      const b = h('button.tg-btn', { type: 'button', role: 'radio', text: id[0].toUpperCase() + id.slice(1) });
      b.dataset.v = id;
      b.addEventListener('click', () => {
        this.difficulty = id;
        paintDiff();
      });
      diff.appendChild(b);
    }
    paintDiff();

    const rivalsDesc = h('div.seg-desc');
    const rivals = h('div.seg', { role: 'radiogroup' });
    const paintRivals = () => {
      for (const b of rivals.children) b.classList.toggle('on', Number((b as HTMLElement).dataset.v) === this.enemies);
      rivalsDesc.textContent = this.enemies === 1 ? 'One planet, two gods.' : `One planet, ${this.enemies + 1} gods — they fight each other too.`;
    };
    for (let n = 1; n <= 3; n++) {
      const dots = TRIBE_IDS.slice(1, 1 + n).map((t) => `<i style="background:#${TRIBE_COLORS[t].toString(16).padStart(6, '0')}"></i>`).join('');
      const b = h('button.tg-btn', { type: 'button', role: 'radio', html: `${n} <span class="rivals">${dots}</span>` });
      b.dataset.v = String(n);
      b.addEventListener('click', () => {
        this.enemies = n;
        paintRivals();
      });
      rivals.appendChild(b);
    }
    paintRivals();
    body.appendChild(h('section', {}, h('div.sk-opts', {},
      h('div', {}, h('h3', { text: 'Difficulty' }), diff, diffDesc),
      h('div', {}, h('h3', { text: 'Rival tribes' }), rivals, rivalsDesc),
    )));

    const start = h('button.tg-btn.primary', { type: 'button', html: `${icon('play', 16)}<span>Begin</span>` });
    start.addEventListener('click', () => {
      this.hide();
      this.onSkirmish?.(this.settings);
    });
    const card = this.card('Skirmish', body, () => this.show('title'), [start]);
    queueMicrotask(() => start.focus());
    return card;
  }

  private pauseScreen(): HTMLElement {
    this.backTo = 'pause';
    const card = h('div.pause-card.tg-panel', {}, h('h2', { text: 'Paused' }));
    card.append(
      this.navBtn('Resume', 'play', () => this.onResume?.(), true),
      this.navBtn('Settings', 'settings', () => this.show('settings')),
      this.navBtn('How to play', 'info', () => this.show('help')),
      this.navBtn('Restart', 'arrowRight', () => this.onRestart?.()),
      this.navBtn('Main menu', 'menu', () => this.onQuit?.()),
    );
    return card;
  }
}
