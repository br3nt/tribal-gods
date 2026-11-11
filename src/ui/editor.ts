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
import { spellDef, SpellId } from '../sim/catalog';
import { World } from '../sim/world-state';
import { appState } from './app-state';
import { css } from './dom';
import { icon, spellIcon, UiIconName } from './icons';
import { toolState } from './tools';

const PLACEABLE_SPELLS: SpellId[] = ['lightning', 'swamp', 'landbridge', 'flatten', 'earthquake', 'volcano'];

css('editor', `
.ed-bar { position: fixed; top: var(--edge); left: 50%; transform: translateX(-50%); display: none; flex-wrap: wrap; gap: 0.3rem;
  max-width: 94vw; z-index: 15; padding: 0.4rem; align-items: center; font: var(--t-sm) var(--font); }
.ed-bar .tg-btn { min-height: 1.9rem; padding: 0 0.6rem; }
.ed-bar .sep { width: 1px; align-self: stretch; margin: 0.2rem 0.2rem; background: var(--rim); }
.ed-bar input { min-height: 1.9rem; padding: 0 0.55rem; border-radius: var(--r2); border: 1px solid var(--rim); background: var(--ink-2); color: var(--text); font: var(--t-sm) var(--font); }
.ed-status { color: var(--text-3); margin-left: 0.3rem; }
`);

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
    this.bar.className = 'ed-bar tg-panel';
    document.body.appendChild(this.bar);

    const tool = (label: string, t: string, title = '', ic: UiIconName = 'target') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${icon(ic, 14)}<span></span>`;
      (b.lastChild as HTMLElement).textContent = label;
      b.title = title;
      b.className = 'tg-btn';
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

    tool('Raise', 'raise', '', 'plus');
    tool('Lower', 'lower', '', 'minus');
    tool('Flatten', 'flatten', 'In the editor this is a brush, not a spell', 'hammer');
    tool('Tree', 'tree', '', 'wood');
    tool('Wanderer', 'wildman', '', 'idle');
    this.monumentBtn = tool('Stone', 'monument', 'Click again to cycle the spell inside', 'stone');
    tool('Your home', 'homePlayer', "Move your tribe's start", 'home');
    tool('Rival home', 'homeRed', "Move the enemy's start", 'home');
    tool('Erase', 'erase', 'Remove trees / wanderers / stones', 'close');

    const sep = () => {
      const s = document.createElement('span');
      s.className = 'sep';
      this.bar.appendChild(s);
    };
    sep();

    this.nameInput = this.input('level name', 130);
    this.authorInput = this.input('author', 90);
    sep();

    this.action('Save', () => void this.save(), 'check');
    this.action('Copy code', () => void this.exportCode(), 'book');
    this.action('Test', () => void this.test(), 'play', true);
    this.action('Exit', () => hooks.onExit(), 'close');

    this.status = document.createElement('span');
    this.status.className = 'ed-status';
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
    this.say(`Saved "${level.name}" to your library`);
  }

  private async exportCode(): Promise<void> {
    const code = await levelToCode(await this.world.captureLevel(this.meta()));
    try {
      await navigator.clipboard.writeText(code);
      this.say(`Share code copied (${code.length} characters)`);
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
      b.classList.toggle('on', toolState.tool === b.dataset.tool);
    }
    const spell = PLACEABLE_SPELLS[this.monumentSpell];
    this.monumentBtn.innerHTML = `${spellIcon(spell, 14)}<span></span>`;
    (this.monumentBtn.lastChild as HTMLElement).textContent = `Stone: ${spellDef(spell).name}`;
  }

  /** A verb button (save/code/test/exit) — no tool highlighting. */
  private action(label: string, fn: () => void, ic: UiIconName, primary = false): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${icon(ic, 14)}<span></span>`;
    (b.lastChild as HTMLElement).textContent = label;
    b.className = primary ? 'tg-btn primary' : 'tg-btn';
    b.addEventListener('click', fn);
    this.bar.appendChild(b);
  }

  private input(placeholder: string, width: number): HTMLInputElement {
    const i = document.createElement('input');
    i.placeholder = placeholder;
    i.style.width = `${width}px`;
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
