/**
 * ui/menu.ts — the skirmish setup screen.
 *
 * Choose a civilization (pure theme: leader + architecture) and a
 * difficulty (pure tempo: how often the red god gets to think), then
 * start. The world keeps simulating behind the dimmed overlay, which
 * doubles as an attract mode — wildmen wandering a planet nobody owns yet.
 *
 * The menu owns no game logic: it collects a GameSettings and hands it to
 * a callback. main.ts decides what "start" means.
 */

import { CIVS, CivId, DIFFICULTIES, Difficulty } from '../config';
import { GameSettings } from '../sim/world-state';

const CARD_CSS = `
  width: 168px; padding: 12px; cursor: pointer; border-radius: 10px;
  border: 2px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.05);
  color: #e8e4d8; font: 12px/1.5 ui-monospace, Menlo, monospace; text-align: center;
`;

export class Menu {
  private readonly overlay: HTMLDivElement;
  private civ: CivId = 'forest';
  private difficulty: Difficulty = 'normal';

  constructor(onStart: (settings: GameSettings) => void) {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 30; display: flex;
      align-items: center; justify-content: center; flex-direction: column;
      gap: 18px; background: rgba(10, 14, 20, 0.78); color: #e8e4d8;
      font: 14px ui-monospace, Menlo, monospace; text-align: center;
    `;

    const title = document.createElement('div');
    title.innerHTML =
      `<div style="font-size: 34px; letter-spacing: 2px;">TRIBAL GODS</div>` +
      `<div style="opacity: 0.7; margin-top: 4px;">one planet · two gods · choose your people</div>`;

    // --- Civilization cards ---
    const civRow = document.createElement('div');
    civRow.style.cssText = 'display: flex; gap: 12px;';
    const civCards = new Map<CivId, HTMLDivElement>();
    for (const civ of Object.values(CIVS)) {
      const card = document.createElement('div');
      card.style.cssText = CARD_CSS;
      const icon = civ.id === 'forest' ? '🌲' : civ.id === 'dynasty' ? '🏜' : '⛰';
      card.innerHTML =
        `<div style="font-size: 30px">${icon}</div>` +
        `<div style="font-size: 14px; margin: 6px 0 2px;">${civ.name}</div>` +
        `<div style="opacity: 0.65">led by ${civ.leaderTitle}</div>` +
        `<div style="opacity: 0.65; margin-top: 6px;">${civ.blurb}</div>`;
      card.addEventListener('click', () => {
        this.civ = civ.id;
        refresh();
      });
      civRow.appendChild(card);
      civCards.set(civ.id, card);
    }

    // --- Difficulty row ---
    const diffRow = document.createElement('div');
    diffRow.style.cssText = 'display: flex; gap: 10px;';
    const diffButtons = new Map<Difficulty, HTMLDivElement>();
    for (const [id, d] of Object.entries(DIFFICULTIES) as Array<[Difficulty, (typeof DIFFICULTIES)['easy']]>) {
      const b = document.createElement('div');
      b.style.cssText = CARD_CSS + 'width: 150px; padding: 8px;';
      b.innerHTML = `<div style="font-size: 13px;">${id.toUpperCase()}</div><div style="opacity: 0.6">${d.label}</div>`;
      b.addEventListener('click', () => {
        this.difficulty = id;
        refresh();
      });
      diffRow.appendChild(b);
      diffButtons.set(id, b);
    }

    // --- Start / Levels / Editor ---
    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display: flex; gap: 12px; align-items: center;';
    const start = document.createElement('button');
    start.textContent = '▶ CLAIM YOUR PLANET';
    start.style.cssText = `
      padding: 12px 36px; font: 16px ui-monospace, Menlo, monospace; cursor: pointer;
      color: #10161e; background: #ffe9a8; border: none; border-radius: 8px; letter-spacing: 1px;
    `;
    start.addEventListener('click', () => {
      this.hide();
      onStart({ playerCiv: this.civ, difficulty: this.difficulty });
    });
    const secondary = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `
        padding: 12px 20px; font: 13px ui-monospace, Menlo, monospace; cursor: pointer;
        color: #e8e4d8; background: rgba(255,255,255,0.08); border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.2);
      `;
      b.addEventListener('click', () => {
        this.hide();
        fn();
      });
      return b;
    };
    buttonRow.append(
      start,
      secondary('📚 LEVELS', () => this.onLevels?.()),
      secondary('🛠 EDITOR', () => this.onEditor?.()),
    );

    const refresh = () => {
      for (const [id, card] of civCards) {
        card.style.borderColor = id === this.civ ? '#ffe9a8' : 'rgba(255,255,255,0.15)';
        card.style.background = id === this.civ ? 'rgba(255,233,168,0.12)' : 'rgba(255,255,255,0.05)';
      }
      for (const [id, b] of diffButtons) {
        b.style.borderColor = id === this.difficulty ? '#ffe9a8' : 'rgba(255,255,255,0.15)';
        b.style.background = id === this.difficulty ? 'rgba(255,233,168,0.12)' : 'rgba(255,255,255,0.05)';
      }
    };
    refresh();

    this.overlay.append(title, civRow, diffRow, buttonRow);
    document.body.appendChild(this.overlay);
  }

  /** Wired by main.ts after construction (keeps the menu logic-free). */
  onLevels: (() => void) | null = null;
  onEditor: (() => void) | null = null;

  /** The setup the player last chose — levels reuse it when launched. */
  get settings(): GameSettings {
    return { playerCiv: this.civ, difficulty: this.difficulty };
  }

  show(): void {
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
  }
}
