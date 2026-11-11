/**
 * ui/editor.ts — the level builder.
 *
 * The deep trick here is that there IS no separate editor world: the
 * editor is the game world with the simulation frozen (main.ts skips
 * World.tick in editor mode) and a different set of mouse tools. Terrain
 * sculpting is the same brush, rendering is the same renderers, monuments
 * are the same monuments. The editor edits THE live World object — which
 * is why Test Play is instant (capture → reload → unfreeze) and why
 * everything you place looks exactly as it will in play, because it is.
 *
 * Toolbar (top center): sculpt tools, placement tools, level metadata,
 * then the verbs — Save to library, Export share code, Test, Exit. The
 * monument tool shows which spell the next stone will hold; click its
 * button again to cycle through the six lockable spells.
 */

import * as THREE from 'three';
import { CivId, CIVS } from '../config';
import { LevelData, levelToCode } from '../level/level-format';
import { saveLevel } from '../level/store';
import { pickGroundTile } from '../render/ground-picker';
import { walkable } from '../sim/pathfinding';
import { SpellId } from '../sim/spells';
import { World } from '../sim/world-state';
import { appState } from './app-state';
import { toolState } from './tools';

const PLACEABLE_SPELLS: SpellId[] = ['lightning', 'swamp', 'landbridge', 'flatten', 'earthquake', 'volcano'];

const BTN = `
  padding: 5px 9px; cursor: pointer; border-radius: 6px; white-space: nowrap;
  border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.07);
  color: #e8e4d8; font: 11px ui-monospace, Menlo, monospace;
`;

export class Editor {
  /** The level currently being edited (id when re-saving an existing one). */
  private editingId: string | undefined;
  private monumentSpell = 0; // index into PLACEABLE_SPELLS, cycled by its button
  private readonly bar: HTMLDivElement;
  private readonly nameInput: HTMLInputElement;
  private readonly authorInput: HTMLInputElement;
  private readonly status: HTMLSpanElement;
  private monumentBtn!: HTMLButtonElement;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly camTarget: THREE.Vector3,
    private readonly world: World,
    canvas: HTMLCanvasElement,
    private readonly hooks: {
      onTest(level: LevelData): void;
      onExit(): void;
    },
  ) {
    this.bar = document.createElement('div');
    this.bar.style.cssText = `
      position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      display: none; flex-wrap: wrap; gap: 5px; max-width: 92vw; z-index: 15;
      padding: 8px; background: rgba(16,22,30,0.85); border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.16); align-items: center;
      font: 11px ui-monospace, Menlo, monospace; color: #e8e4d8;
    `;
    document.body.appendChild(this.bar);

    const tool = (label: string, t: string, title = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = BTN;
      b.dataset.tool = t;
      b.addEventListener('click', () => {
        if (t === 'monument' && toolState.tool === 'monument') {
          // Already selected: clicking again cycles the spell in the stone.
          this.monumentSpell = (this.monumentSpell + 1) % PLACEABLE_SPELLS.length;
        }
        toolState.tool = t as never;
        this.refresh();
      });
      this.bar.appendChild(b);
      return b;
    };

    tool('⛰ raise', 'raise');
    tool('🕳 lower', 'lower');
    tool('▦ flatten', 'flatten', 'In the editor this is a brush, not a spell');
    tool('🌲 tree', 'tree');
    tool('🚶 wildman', 'wildman');
    this.monumentBtn = tool('🗿 monument', 'monument', 'Click again to cycle the spell inside');
    tool('🔵 home P', 'homePlayer', "Move your tribe's start");
    tool('🔴 home R', 'homeRed', "Move the enemy's start");
    tool('✖ erase', 'erase', 'Remove trees / wildmen / monuments');

    const sep = () => {
      const s = document.createElement('span');
      s.textContent = '·';
      s.style.opacity = '0.4';
      this.bar.appendChild(s);
    };
    sep();

    this.nameInput = this.input('level name', 130);
    this.authorInput = this.input('author', 90);
    sep();

    this.action('💾 save', () => void this.save());
    this.action('📋 code', () => void this.exportCode());
    this.action('▶ test', () => void this.test());
    this.action('⏏ exit', () => hooks.onExit());

    this.status = document.createElement('span');
    this.status.style.cssText = 'opacity: 0.75; margin-left: 4px;';
    this.bar.appendChild(this.status);

    // The placement click. pointerdown (not click) to match every other
    // world interaction; gated hard on editor mode.
    canvas.addEventListener('pointerdown', (e) => {
      if (appState.mode !== 'editor' || e.button !== 0) return;
      const hit = pickGroundTile(e.clientX, e.clientY, this.camera, this.world.map, this.camTarget);
      if (hit) this.applyTool(Math.round(hit.x), Math.round(hit.z));
    });
  }

  // -------------------------------------------------------------------------

  /** Open the editor on the current world (optionally an existing saved level). */
  open(existing?: { id?: string; level: LevelData }): void {
    appState.mode = 'editor';
    this.editingId = existing?.id;
    this.nameInput.value = existing?.level.name ?? 'Untitled Planet';
    this.authorInput.value = existing?.level.author ?? 'anonymous god';
    toolState.tool = 'raise';
    this.bar.style.display = 'flex';
    this.refresh();
    this.say('sculpt, place, then save / test');
  }

  close(): void {
    this.bar.style.display = 'none';
  }

  // -------------------------------------------------------------------------

  private applyTool(x: number, z: number): void {
    const w = this.world;
    switch (toolState.tool) {
      case 'tree':
        if (walkable(w.map, x, z)) {
          w.trees.push({ x: w.map.wrap(x), z: w.map.wrap(z), alive: true, regrow: 0, burning: 0 });
          this.say('tree planted (rebuilds on save/test)');
        }
        return;
      case 'wildman':
        if (walkable(w.map, x, z)) w.spawnNearWalkable('wildman', 'wild', x, z);
        return;
      case 'monument': {
        if (!walkable(w.map, x, z)) return;
        const spell = PLACEABLE_SPELLS[this.monumentSpell];
        w.monuments.push({ x: w.map.wrap(x), z: w.map.wrap(z), spell, mode: 'teach', claimedBy: null, claimer: null, sleep: 0 });
        this.say(`monument of ${spell} placed`);
        return;
      }
      case 'homePlayer':
      case 'homeRed': {
        if (!walkable(w.map, x, z)) return;
        const tribe = toolState.tool === 'homePlayer' ? 'player' : 'red';
        const t = w.tribes[tribe];
        if (t) t.home = { x: w.map.wrap(x), z: w.map.wrap(z) };
        this.say(`${tribe} home moved`);
        return;
      }
      case 'erase': {
        // Nearest placeable within 2 tiles dies: trees, wildmen, monuments.
        const near = (ax: number, az: number) => Math.hypot(ax - x, az - z) < 2;
        const ti = this.world.trees.findIndex((t) => t.alive && near(t.x, t.z));
        if (ti >= 0) {
          this.world.trees.splice(ti, 1);
          return;
        }
        const mi = this.world.monuments.findIndex((m) => near(m.x, m.z));
        if (mi >= 0) {
          this.world.monuments.splice(mi, 1);
          return;
        }
        const ui = this.world.units.findIndex((u) => u.kind === 'wildman' && near(u.x, u.z));
        if (ui >= 0) this.world.units.splice(ui, 1);
        return;
      }
      default:
        return; // raise/lower/flatten are handled by the sculpt brush
    }
  }

  private meta() {
    return {
      name: this.nameInput.value.trim() || 'Untitled Planet',
      author: this.authorInput.value.trim() || 'anonymous god',
      desc: '',
    };
  }

  private async save(): Promise<void> {
    const level = await this.world.captureLevel(this.meta());
    this.editingId = saveLevel(level, this.editingId);
    this.say(`saved "${level.name}" to your library ✓`);
  }

  private async exportCode(): Promise<void> {
    const code = await levelToCode(await this.world.captureLevel(this.meta()));
    try {
      await navigator.clipboard.writeText(code);
      this.say(`share code copied (${code.length} chars) ✓`);
    } catch {
      prompt('Copy your level code:', code); // clipboard blocked — show it instead
    }
  }

  private async test(): Promise<void> {
    const level = await this.world.captureLevel(this.meta());
    this.close();
    this.hooks.onTest(level);
  }

  private say(msg: string): void {
    this.status.textContent = msg;
  }

  private refresh(): void {
    for (const b of this.bar.querySelectorAll('button')) {
      if (!b.dataset.tool) continue;
      const active = toolState.tool === b.dataset.tool;
      b.style.borderColor = active ? '#ffe9a8' : 'rgba(255,255,255,0.18)';
      b.style.background = active ? 'rgba(255,233,168,0.15)' : 'rgba(255,255,255,0.07)';
    }
    this.monumentBtn.textContent = `🗿 ${PLACEABLE_SPELLS[this.monumentSpell]}`;
  }

  /** A verb button (save/code/test/exit) — no tool highlighting. */
  private action(label: string, fn: () => void): void {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = BTN;
    b.addEventListener('click', fn);
    this.bar.appendChild(b);
  }

  private input(placeholder: string, width: number): HTMLInputElement {
    const i = document.createElement('input');
    i.placeholder = placeholder;
    i.style.cssText = `
      width: ${width}px; padding: 4px 7px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08);
      color: #e8e4d8; font: 11px ui-monospace, Menlo, monospace;
    `;
    // Keep typing out of the game's hotkey handlers.
    i.addEventListener('keydown', (e) => e.stopPropagation());
    this.bar.appendChild(i);
    return i;
  }

  /** Used by the library's Edit button to choose the enemy civ shown while editing. */
  setRedCiv(civ: CivId | undefined): void {
    const red = this.world.tribes.red;
    if (civ && CIVS[civ] && red) red.civ = civ;
  }
}
