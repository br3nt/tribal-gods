/**
 * ui/hud.ts — resources, debug readout, controls, and the end screen.
 *
 * Plain DOM on top of the canvas. For development UI this beats in-engine
 * text rendering on every axis: free layout, free fonts, zero draw calls.
 *
 * Phase 5 additions: the ledger reads from YOUR tribe's books (resources
 * are per-tribe now), the debug panel shows what the enemy AI is thinking
 * (watching it switch grow → harass → assault teaches you its rhythm),
 * and a victory/defeat overlay ends the show.
 */

import { LoopStats } from '../core/loop';
import { SculptBrush } from './brush';
import { OrderControl } from './orders';
import { toolState } from './tools';
import { World } from '../sim/world-state';

const PANEL_CSS = `
  position: fixed; padding: 8px 12px; color: #e8e4d8;
  background: rgba(16, 22, 30, 0.72); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px; font: 12px/1.6 ui-monospace, Menlo, monospace;
  pointer-events: none; white-space: pre; z-index: 10;
`;

export class Hud {
  private readonly manaFill: HTMLDivElement;
  private readonly gameOver: HTMLDivElement;
  private shownGameOver = false;

  constructor(loopStats: LoopStats, brush: SculptBrush, world: World, orders: OrderControl) {
    // --- Resources panel (top center): mana bar + the village ledger ---
    const resources = document.createElement('div');
    resources.style.cssText = PANEL_CSS + 'top: 12px; left: 50%; transform: translateX(-50%); text-align: center;';
    const ledger = document.createElement('div');
    const manaBar = document.createElement('div');
    manaBar.style.cssText = `
      width: 220px; height: 10px; margin: 6px auto 2px;
      background: rgba(255,255,255,0.12); border-radius: 5px; overflow: hidden;
    `;
    this.manaFill = document.createElement('div');
    this.manaFill.style.cssText = `
      height: 100%; width: 0%; border-radius: 5px;
      background: linear-gradient(90deg, #3fb8d8, #88eaff);
    `;
    manaBar.appendChild(this.manaFill);
    resources.append(ledger, manaBar);
    document.body.appendChild(resources);

    // --- Debug stats (top left) ---
    const stats = document.createElement('div');
    stats.style.cssText = PANEL_CSS + 'top: 12px; left: 12px;';
    document.body.appendChild(stats);

    // --- Controls (bottom left) ---
    const help = document.createElement('div');
    help.style.cssText = PANEL_CSS + 'bottom: 12px; left: 12px;';
    help.textContent = [
      'TOOLS    1 select · 2 hut · T/Y/U war huts+tower · 3-9,0 spells',
      'SELECT   click a follower, or drag a box',
      'MOVE     right-click ground · enemy = attack · stone head = worship',
      'CAST     pick a spell, click the world — your leader does the rest',
      'LEARN    locked spells live in monuments (gold on the minimap)',
      'DEBUG    - / = raw raise/lower brush · [ ] size',
      'CAMERA   WASD pan · Q/E rotate · wheel zoom · minimap click jumps',
      'WORLD    R new world · M setup menu',
    ].join('\n');
    document.body.appendChild(help);

    // --- Victory/defeat overlay (hidden until the war ends) ---
    this.gameOver = document.createElement('div');
    this.gameOver.style.cssText = `
      position: fixed; inset: 0; display: none; z-index: 20;
      align-items: center; justify-content: center; flex-direction: column;
      background: rgba(10, 14, 20, 0.55); color: #e8e4d8; text-align: center;
      font: 16px ui-monospace, Menlo, monospace;
    `;
    document.body.appendChild(this.gameOver);

    setInterval(() => {
      const player = world.tribes.player;
      if (!player) return;
      const huts = world.buildings.filter((b) => b.tribe === 'player' && b.progress >= 1).length;
      const sites = world.buildings.filter((b) => b.tribe === 'player').length - huts;
      const army = world.countUnits(
        (u) => u.tribe === 'player' && (u.kind === 'warrior' || u.kind === 'firewarrior'),
      );
      ledger.textContent =
        `mana +${player.manaRate.toFixed(1)}/s   wood ${player.wood}   ` +
        `pop ${world.tribePopulation('player')} (${world.housedPopulation('player')} housed)   ` +
        `army ${army}   bldgs ${huts}${sites ? ` +${sites}` : ''}`;

      const redAi = world.tribes.red?.ai;
      stats.textContent = [
        `fps    ${loopStats.fps.toFixed(0)}`,
        `tick   ${loopStats.tickCount}`,
        `tool   ${toolState.tool}${['raise', 'lower'].includes(toolState.tool) ? ` (r${brush.radius})` : ''}`,
        `units  ${world.units.length} (${orders.selected.size} selected)`,
        `enemy  ${redAi ? redAi.state : '—'} · pop ${world.tribePopulation('red')}`,
      ].join('\n');

      if (world.gameOver && !this.shownGameOver) {
        this.shownGameOver = true;
        const win = world.gameOver === 'victory';
        this.gameOver.innerHTML =
          `<div style="font-size:42px; margin-bottom: 12px;">${win ? '🌞 VICTORY' : '💀 DEFEAT'}</div>` +
          `<div>${win ? 'The planet worships you alone.' : 'Your tribe has fallen silent.'}</div>` +
          `<div style="margin-top: 10px; opacity: 0.7;">Press R for a new world</div>`;
        this.gameOver.style.display = 'flex';
      }
      if (!world.gameOver && this.shownGameOver) {
        this.shownGameOver = false; // R was pressed — new world, hide the curtain
        this.gameOver.style.display = 'none';
      }
    }, 250);
  }

  /** Fast loop: called every render frame for the smooth mana fill. */
  update(world: World): void {
    // Charge toward the next Blast — a stand-in until the UI stream's spell book lands.
    const blast = world.spellState('player', 'blast');
    this.manaFill.style.width = `${(blast.charges >= blast.max ? 1 : blast.progress) * 100}%`;
  }
}
