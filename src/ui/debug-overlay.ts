/**
 * ui/debug-overlay.ts — the developer readout, behind F3.
 *
 * Frame rate, sim ticks, unit counts, what each AI god is thinking, the
 * current tool. While it's open, - and = arm the raw raise/lower sculpt
 * brush (Shift+[ and Shift+] size it; plain [ ] stay game speed) — a
 * developer toy, not a game verb, so it lives
 * here and nowhere a player will trip over it.
 */

import type { LoopStats } from '../core/loop';
import type { World } from '../sim/world-state';
import { appState } from './app-state';
import { css, h, uiRoot } from './dom';
import { toolState } from './tools';

css('debug', `
.dbg { position: absolute; left: var(--edge); top: calc(var(--edge) + 4.2rem); padding: 0.5rem 0.75rem; white-space: pre;
  font: 0.6875rem/1.55 ui-monospace, Menlo, monospace; color: var(--text-2); pointer-events: none; }
`);

export class DebugOverlay {
  private readonly el: HTMLDivElement;
  private t = 0;

  constructor(private readonly stats: LoopStats, private readonly world: World, private readonly brushRadius: () => number) {
    this.el = h('div.dbg.tg-panel');
    this.el.hidden = true;
    uiRoot().appendChild(this.el);
  }

  update(dt: number, selected: number): void {
    this.el.hidden = !appState.debug || appState.mode !== 'game';
    if (this.el.hidden) return;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.25;
    const w = this.world;
    const ais = w.activeTribes().filter((id) => w.tribes[id]?.ai).map((id) => {
      const t = w.tribes[id]!;
      return `ai ${id.padEnd(6)} ${t.ai!.state.padEnd(7)} pop ${w.tribePopulation(id)} wood ${t.wood}`;
    });
    this.el.textContent = [
      `fps    ${this.stats.fps.toFixed(0)}`,
      `tick   ${this.stats.tickCount}  ×${appState.speed}${appState.paused ? ' paused' : ''}`,
      `tool   ${toolState.tool}${toolState.tool === 'raise' || toolState.tool === 'lower' ? ` r${this.brushRadius()}` : ''}`,
      `units  ${w.units.length} (${selected} selected)  bldgs ${w.buildings.length}`,
      ...ais,
      `-/= sculpt brush · ⇧[ ⇧] size · [ ] speed`,
    ].join('\n');
  }
}
