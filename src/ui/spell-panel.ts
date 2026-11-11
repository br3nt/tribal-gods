/**
 * ui/spell-panel.ts — the spell book made clickable.
 *
 * A DOM toolbar (bottom center): select, hut, then the eight spells in
 * casting order. Each button shows its icon, hotkey and mana cost; spells
 * you can't afford are dimmed; the active tool glows. Buttons just write
 * to toolState — the same shared object the number keys write to, so
 * keyboard and mouse stay in perfect agreement by construction.
 *
 * (This is the first piece of "real" game UI. Same DOM-over-canvas
 * approach as the debug HUD — see ui/hud.ts for why that's a fine idea.)
 */

import { BUILDINGS, SPELLS, SpellId } from '../sim/catalog';
import { World } from '../sim/world-state';
import { appState } from './app-state';
import { Tool, toolState } from './tools';

interface Entry {
  tool: Tool;
  el: HTMLButtonElement;
  cost: number;
  /** What the cost is paid in — spells burn mana, buildings burn wood. */
  currency: 'mana' | 'wood' | 'free';
}

export class SpellPanel {
  private readonly entries: Entry[] = [];

  constructor(world: World) {
    const bar = document.createElement('div');
    bar.style.cssText = `
      position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 6px; padding: 8px; z-index: 10;
      background: rgba(16, 22, 30, 0.78); border: 1px solid rgba(255,255,255,0.14);
      border-radius: 10px;
    `;
    document.body.appendChild(bar);

    type Slot = { tool: Tool; icon: string; key: string; name: string; cost: number; currency: Entry['currency'] };
    const slots: Slot[] = [
      { tool: 'select', icon: '👆', key: '1', name: 'Select', cost: 0, currency: 'free' },
      { tool: 'hut', icon: '🛖', key: '2', name: 'Hut', cost: BUILDINGS.hut.wood, currency: 'wood' },
      { tool: 'warriorHut', icon: '🗡', key: 'T', name: 'War Hut', cost: BUILDINGS.warriorHut.wood, currency: 'wood' },
      { tool: 'fireHut', icon: '🔥', key: 'Y', name: 'Fire Hut', cost: BUILDINGS.fireHut.wood, currency: 'wood' },
      { tool: 'tower', icon: '🗼', key: 'U', name: 'Tower', cost: BUILDINGS.tower.wood, currency: 'wood' },
      ...SPELLS.map((s, i): Slot => ({
        tool: s.id as Tool,
        icon: s.name.slice(0, 2),
        key: String((i + 3) % 10), // 3..9 then 0
        name: s.name,
        cost: s.maxCharges,
        currency: 'mana',
      })),
    ];

    for (const slot of slots) {
      const b = document.createElement('button');
      b.title = slot.currency === 'free' ? slot.name : `${slot.name} — ${slot.cost} ${slot.currency}`;
      b.style.cssText = `
        width: 50px; padding: 5px 0 4px; cursor: pointer; border-radius: 7px;
        border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.06);
        color: #e8e4d8; font: 10px ui-monospace, Menlo, monospace; text-align: center;
      `;
      const costColor = slot.currency === 'mana' ? '#88eaff' : '#d8a35e';
      const costMark = slot.currency === 'mana' ? '◆' : '🪵';
      b.innerHTML = `<div style="font-size:17px;line-height:1.2">${slot.icon}</div>` +
        `<div>${slot.key} ${slot.name}</div>` +
        (slot.currency !== 'free' ? `<div style="color:${costColor}">${slot.cost}${costMark}</div>` : `<div>&nbsp;</div>`);
      b.addEventListener('click', () => (toolState.tool = slot.tool));
      bar.appendChild(b);
      this.entries.push({ tool: slot.tool, el: b, cost: slot.cost, currency: slot.currency });
    }

    // Affordability + lock state + active highlight, a few times a second.
    setInterval(() => {
      // The editor has its own toolbar; the game panel steps aside.
      bar.style.display = appState.mode === 'editor' ? 'none' : 'flex';
      const player = world.tribes.player;
      if (!player) return;
      for (const e of this.entries) {
        // Spells the tribe hasn't learned yet show a padlock — worship at
        // a glowing-eyed monument to earn them. Spells charge (catalog.ts):
        // a cast is ready when a charge or a gift is.
        const spell = e.currency === 'mana' ? world.spellState('player', e.tool as SpellId) : null;
        const locked = !!spell && !spell.known && spell.gifted === 0;
        if (spell) {
          const cost = e.el.lastElementChild as HTMLElement;
          cost.textContent = `${spell.charges + spell.gifted}/${spell.max}◆`;
        }
        const affordable =
          !locked &&
          (e.currency === 'free' || (spell ? spell.charges + spell.gifted > 0 : player.wood >= e.cost));
        const active = toolState.tool === e.tool;
        e.el.style.opacity = locked ? '0.22' : affordable ? '1' : '0.35';
        e.el.style.filter = locked ? 'grayscale(1)' : 'none';
        e.el.title = locked ? 'Locked — worship at a monument to learn this' : e.el.title;
        e.el.style.background = active ? 'rgba(136, 234, 255, 0.25)' : 'rgba(255,255,255,0.06)';
        e.el.style.borderColor = active ? '#88eaff' : 'rgba(255,255,255,0.15)';
      }
    }, 150);
  }
}
