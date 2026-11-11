/**
 * ui/top-bar.ts — the tribe at a glance (top left) and time (top right).
 *
 * LEFT, one timber board: wood · population/cap (housed, idle villagers —
 * click to find one) · mana flowing into spells · villagers praying ·
 * the leader (alive, or back in N seconds — click to look at them).
 *
 * RIGHT: the game clock, pause and 1×/2×/3× speed, and the menu button.
 *
 * Every number comes from world.tribeSummary('player') (catalog.ts
 * TribeSummary). Updated a few times a second; text is only touched when
 * it changes.
 */

import { fmtClock, fmtEta, fmtRate } from './format';
import { appState, SPEEDS } from './app-state';
import { UiContext } from './context';
import { css, h, setClass, setText } from './dom';
import { labelFor } from './hotkeys';
import { icon } from './icons';
import { carve } from './lettering';
import { tip } from './tooltip';

css('top-bar', `
.tb-left { position: absolute; top: var(--edge); left: var(--edge); display: flex; align-items: stretch; padding: 0.1rem 0.15rem; gap: 0; }
.tb-stat { display: flex; align-items: center; gap: 0.45rem; padding: 0.22rem 0.65rem 0.22rem 0.45rem; position: relative; }
/* Dividers: a cord tied round the board. */
.tb-stat + .tb-stat::before { content: ''; position: absolute; left: -1px; top: 12%; bottom: 12%; width: 3px;
  background: repeating-linear-gradient(-35deg, #e1c088 0 2px, #8a6436 2px 4px); box-shadow: 0 0 0 1px rgba(16, 8, 3, 0.85); border-radius: 2px; }
.tb-stat svg { color: var(--bone-2); }
.tb-stat .v { font: 700 var(--t-lg)/1.05 var(--font); letter-spacing: 0; color: var(--bone); text-shadow: 0 1px 0 rgba(0,0,0,0.85); }
.tb-stat .l { font-size: var(--t-xs); color: var(--bone-3); line-height: 1.15; white-space: nowrap; font-weight: 600; }
.tb-stat.wood svg { color: var(--wood); }
.tb-stat.mana svg, .tb-stat.mana .v { color: var(--spirit); }
.tb-stat.pop svg { color: var(--bone); }
.tb-stat.pray svg { color: var(--ochre-hi); }
.tb-stat.leader svg { color: var(--ochre-hi); }
.tb-stat.leader.down svg, .tb-stat.leader.down .v { color: var(--bad); }
.tb-stat.dim > *:not(.l) { opacity: 0.55; }
button.tb-stat { appearance: none; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
button.tb-stat:hover { background: rgba(255, 226, 180, 0.08); }
.tb-idle { display: inline-flex; align-items: center; gap: 0.2rem; margin-left: 0.3rem; padding: 0.1rem 0.4rem 0.1rem 0.25rem; border: 0;
  border-radius: 0.18rem 0.3rem 0.22rem 0.32rem; background: linear-gradient(#efe1c2, #cdb48a); color: #3a2614;
  box-shadow: 0 0 0 1px rgba(20,10,4,0.8); font: 700 var(--t-xs)/1 var(--font); cursor: pointer; vertical-align: 1px; }
.tb-idle:hover { filter: brightness(1.08); }
.tb-idle.has { background: linear-gradient(#ffd27a, #d39537); color: #2a1606; }
.tb-right { position: absolute; top: var(--edge); right: var(--edge); display: flex; align-items: center; gap: 0.35rem; padding: 0.2rem; }
.tb-clock { display: flex; align-items: center; gap: 0.35rem; padding: 0 0.5rem 0 0.35rem; font: 700 var(--t-md)/1 var(--font); min-width: 4rem; color: var(--bone); }
.tb-clock svg { color: var(--ochre-hi); }
.tb-speed { display: flex; gap: 0.2rem; }
.tb-speed .tg-btn { min-height: 1.7rem; padding: 0 0.45rem; font-weight: 700; }
.tb-right > .tg-btn.icon-only { min-height: 1.7rem; min-width: 1.9rem; }
.tb-paused { padding: 0.35rem 1.1rem 0.3rem; font-size: 1.15rem; line-height: 0; }
`);

export class TopBar {
  private readonly v: Record<string, HTMLElement> = {};
  private readonly idleBtn: HTMLButtonElement;
  private readonly leaderStat: HTMLButtonElement;
  private readonly prayStat: HTMLElement;
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly pauseBtn: HTMLButtonElement;
  /** Game-ui moves this into the top-centre column so it stacks with the narrator and hints. */
  readonly pausedBanner: HTMLDivElement;
  private shownPaused = false;

  constructor(private readonly ctx: UiContext, parent: HTMLElement) {
    const left = h('div.tb-left.tg-panel');
    const stat = (cls: string, ic: string, key: string, label: string, tag: 'div' | 'button' = 'div') => {
      const v = h('div.v');
      const l = h('div.l', { text: label });
      const el: HTMLElement = h(tag, { class: `tb-stat ${cls}`, html: icon(ic as never, 22) }, h('div', {}, v, l));
      if (tag === 'button') el.setAttribute('type', 'button');
      this.v[key] = v;
      this.v[key + 'L'] = l;
      left.appendChild(el);
      return el;
    };

    const wood = stat('wood', 'wood', 'wood', 'wood');
    tip(wood, () => `<h4>Wood</h4><p>Villagers fell trees and haul the logs home. Buildings, training and growing dwellings all cost wood.</p>`);

    const pop = stat('pop', 'population', 'pop', 'housed');
    this.idleBtn = h('button.tb-idle.tg-hit', { type: 'button', html: icon('idle', 14) + '<span>0</span>' });
    this.idleBtn.addEventListener('click', () => ctx.actions.nextIdleVillager());
    this.v.popL.textContent = '';
    this.v.housed = h('span');
    this.v.popL.append(this.v.housed, this.idleBtn);
    tip(pop, () => {
      const s = ctx.world.tribeSummary('player');
      return `<h4>Population</h4><p>${s.population} people of a possible ${s.popCap}. ${s.housed} live in dwellings, which breed new villagers and feed your mana.</p>` +
        `<p class="hint">Build more Dwellings to raise the cap.</p>`;
    });
    tip(this.idleBtn, () => `<h4>Idle villagers <span class="kbd">${labelFor('idle-villager')}</span></h4><p>Click to jump to the next villager with nothing to do.</p>`);

    const mana = stat('mana', 'mana', 'mana', 'mana');
    tip(mana, () => {
      const t = ctx.world.tribes.player;
      return `<h4>Mana</h4><p>Your people's faith, flowing into every spell that is charging. More people, more homes and more prayer mean faster charges.</p>` +
        (t && t.manaRate === 0 && t.income > 0 ? `<p class="why">Nothing is charging — mana is going to waste.</p>` : '');
    });

    this.prayStat = stat('pray', 'prayer', 'pray', 'praying');
    tip(this.prayStat, () => `<h4>Praying</h4><p>Villagers inside a Shrine pray instead of working. Each one speeds every charging spell.</p>`);

    this.leaderStat = stat('leader', 'leader', 'leader', 'leader', 'button') as HTMLButtonElement;
    this.leaderStat.classList.add('tg-hit');
    this.leaderStat.addEventListener('click', () => ctx.actions.centreOnLeader());
    tip(this.leaderStat, () => `<h4>Your leader <span class="kbd">${labelFor('centre-leader')}</span></h4><p>Casts every spell. If they fall, they return to the home circle while your tribe lives.</p><p class="hint">Click to look at them.</p>`);
    parent.appendChild(left);

    // --- Right cluster: clock, speed, menu ---
    const right = h('div.tb-right.tg-panel');
    const clock = h('div.tb-clock', { html: icon('clock', 16) });
    this.v.clock = h('span');
    clock.appendChild(this.v.clock);
    tip(clock, () => `<h4>Time</h4><p>How long this scenario has been running.</p>`);
    const speed = h('div.tb-speed');
    this.pauseBtn = h('button.tg-btn', { type: 'button', 'aria-label': 'Pause', html: icon('pause', 16) });
    this.pauseBtn.addEventListener('click', () => ctx.actions.togglePause());
    tip(this.pauseBtn, () => `<h4>${appState.paused ? 'Resume' : 'Pause'} <span class="kbd">${labelFor('pause')}</span></h4><p>Time stops; you can still look around, select and plan.</p>`);
    speed.appendChild(this.pauseBtn);
    for (const n of SPEEDS) {
      const b = h('button.tg-btn', { type: 'button', text: `${n}×`, 'aria-label': `Speed ${n}×` });
      b.addEventListener('click', () => ctx.actions.setSpeed(n));
      tip(b, () => `<h4>Speed ${n}× <span class="kbd">${labelFor('speed-down')}</span><span class="kbd">${labelFor('speed-up')}</span></h4><p>${n === 1 ? 'Normal pace.' : `Time runs ${n} times as fast.`}</p>`);
      speed.appendChild(b);
      this.speedBtns.push(b);
    }
    const menu = h('button.tg-btn.icon-only', { type: 'button', 'aria-label': 'Menu', html: icon('menu', 18) });
    menu.addEventListener('click', () => ctx.actions.openMenu());
    tip(menu, () => `<h4>Menu <span class="kbd">Esc</span></h4><p>Settings, how to play, restart, leave.</p>`);
    right.append(clock, speed, menu);
    parent.appendChild(right);

    this.pausedBanner = h('div.tb-paused.tg-panel.mat-hide.passthrough', { html: carve('Paused') });
    this.pausedBanner.hidden = true;
    parent.appendChild(this.pausedBanner);
  }

  update(): void {
    const w = this.ctx.world;
    const s = w.tribeSummary('player');
    setText(this.v.wood, String(s.wood));
    setText(this.v.pop, `${s.population}/${s.popCap}`);
    setText(this.v.housed, `${s.housed} housed`);
    setText(this.idleBtn.lastElementChild!, String(s.idleVillagers));
    setClass(this.idleBtn, 'has', s.idleVillagers > 0);
    setText(this.v.mana, fmtRate(w.tribes.player?.income ?? s.manaRate));
    setText(this.v.manaL, s.manaRate === 0 && (w.tribes.player?.income ?? 0) > 0 ? 'nothing charging' : 'mana');
    setText(this.v.pray, String(s.praying));
    setClass(this.prayStat, 'dim', s.praying === 0);
    setText(this.v.leader, s.leaderAlive ? 'Alive' : s.leaderRespawn > 0 ? fmtEta(s.leaderRespawn) : 'Lost');
    setText(this.v.leaderL, s.leaderAlive ? 'leader' : s.leaderRespawn > 0 ? 'returning in' : 'leader');
    setClass(this.leaderStat, 'down', !s.leaderAlive);
    setText(this.v.clock, fmtClock(w.elapsed));
    setClass(this.pauseBtn, 'on', appState.paused);
    if (this.shownPaused !== appState.paused) {
      this.shownPaused = appState.paused;
      this.pauseBtn.innerHTML = icon(appState.paused ? 'play' : 'pause', 16);
    }
    this.speedBtns.forEach((b, i) => setClass(b, 'on', !appState.paused && appState.speed === SPEEDS[i]));
    this.pausedBanner.hidden = !appState.paused;
  }
}
