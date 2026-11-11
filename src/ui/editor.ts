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
 * then the verbs — Save to library, Export share code, Test, Exit.
 *
 *   Stone   places a standing stone: pick its spell (any of the fourteen)
 *           and whether it TEACHES the spell or GIFTS two casts.
 *   Home    moves a tribe's home circle: pick the tribe. Placing the home
 *           of a tribe the level doesn't have adds it as an AI rival (up
 *           to four tribes); Erase on a rival's home circle removes it.
 *
 * What the editor does NOT edit: scenario rules beyond the tribe list
 * (loadouts, objectives, scripted events, alliances, personalities). A
 * level made here plays as "destroy every rival"; campaign chapters keep
 * the rules they were loaded with.
 */

import * as THREE from 'three';
import { CivId, CIVS, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { LevelData, levelToCode } from '../level/level-format';
import { saveLevel } from '../level/store';
import { pickGroundTile } from '../render/ground-picker';
import { walkable } from '../sim/pathfinding';
import { SPELLS, spellDef, SpellId, TribeId } from '../sim/catalog';
import { World } from '../sim/world-state';
import { appState } from './app-state';
import { css } from './dom';
import { icon, spellIcon, UiIconName } from './icons';
import { toolState } from './tools';

const TRIBE_NAMES: Record<TribeId, string> = { player: 'Your tribe', red: 'Red rival', gold: 'Gold rival', violet: 'Violet rival' };

css('editor', `
.ed-bar { position: fixed; top: var(--edge); left: 50%; transform: translateX(-50%); display: none; flex-wrap: wrap; gap: 0.3rem;
  max-width: 94vw; z-index: 15; padding: 0.4rem; align-items: center; font: var(--t-sm) var(--font); }
.ed-bar .tg-btn { min-height: 1.9rem; padding: 0 0.6rem; }
.ed-bar .sep { width: 1px; align-self: stretch; margin: 0.2rem 0.2rem; background: var(--rim); }
.ed-bar input { min-height: 1.9rem; padding: 0 0.55rem; border-radius: var(--r2); border: 1px solid var(--rim); background: var(--ink-2); color: var(--text); font: var(--t-sm) var(--font); }
.ed-status { color: var(--text-3); margin-left: 0.3rem; }
.ed-bar select { min-height: 1.9rem; padding: 0 0.4rem; border-radius: var(--r2); border: 1px solid var(--rim); background: var(--ink-2); color: var(--text); font: var(--t-sm) var(--font); }
`);

export class Editor {
  /** The level currently being edited (id when re-saving an existing one). */
  private editingId: string | undefined;
  private stoneSpell: SpellId = 'lightning';
  private stoneMode: 'teach' | 'gift' = 'teach';
  private homeTribe: TribeId = 'player';
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
    this.monumentBtn = tool('Stone', 'monument', 'Place a standing stone (pick its spell and kind)', 'stone');
    this.select(
      SPELLS.map((s) => [s.id, s.name]),
      () => this.stoneSpell,
      (v) => {
        this.stoneSpell = v as SpellId;
        toolState.tool = 'monument';
        this.refresh();
      },
      'Spell held by the next stone',
    );
    this.select([['teach', 'teaches'], ['gift', 'gifts 2 casts']], () => this.stoneMode, (v) => {
      this.stoneMode = v as 'teach' | 'gift';
      toolState.tool = 'monument';
      this.refresh();
    }, 'Teach: the first leader to commune learns it. Gift: whoever communes gets two casts; the stone then sleeps.');
    tool('Home', 'home', 'Move a tribe’s home circle; a new tribe joins as an AI rival', 'home');
    this.select(
      (Object.keys(TRIBE_NAMES) as TribeId[]).map((t) => [t, TRIBE_NAMES[t]]),
      () => this.homeTribe,
      (v) => {
        this.homeTribe = v as TribeId;
        toolState.tool = 'home';
        this.refresh();
      },
      'Whose home the Home tool moves',
    );
    tool('Erase', 'erase', 'Remove trees / wanderers / stones / a rival’s home', 'close');

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
          w.treesVersion++;
          this.say('tree planted');
        }
        return;
      case 'wildman':
        if (walkable(w.map, x, z)) w.spawnNearWalkable('wildman', 'wild', x, z);
        return;
      case 'monument': {
        if (!walkable(w.map, x, z)) return;
        const spell = this.stoneSpell;
        const gift = this.stoneMode === 'gift';
        w.monuments.push({
          x: w.map.wrap(x), z: w.map.wrap(z), spell, mode: this.stoneMode, claimedBy: null, claimer: null, sleep: 0,
          ...(gift ? { charges: 2, cooldown: 120 } : {}),
        });
        this.say(`Stone placed: ${gift ? 'gifts' : 'teaches'} ${spellDef(spell).name}`);
        return;
      }
      case 'home': {
        if (!walkable(w.map, x, z)) return;
        const added = !w.tribes[this.homeTribe];
        w.setHome(this.homeTribe, x, z);
        this.say(added ? `${TRIBE_NAMES[this.homeTribe]} joins the level` : `${TRIBE_NAMES[this.homeTribe]}: home moved`);
        return;
      }
      case 'erase': {
        // Nearest placeable within 2 tiles dies: trees, wildmen, monuments, then a rival's home.
        // Wrapped distance: the pick and the things on the planet may sit either side of the seam.
        const near = (ax: number, az: number) => Math.hypot(wrapDelta(ax - x, WORLD_SIZE), wrapDelta(az - z, WORLD_SIZE)) < 2;
        const ti = this.world.trees.findIndex((t) => t.alive && near(t.x, t.z));
        if (ti >= 0) {
          this.world.trees.splice(ti, 1);
          this.world.treesVersion++; // the tree renderer re-indexes its per-tree state
          return;
        }
        const mi = this.world.monuments.findIndex((m) => near(m.x, m.z));
        if (mi >= 0) {
          this.world.monuments.splice(mi, 1);
          return;
        }
        const ui = this.world.units.findIndex((u) => u.kind === 'wildman' && near(u.x, u.z));
        if (ui >= 0) {
          this.world.units.splice(ui, 1);
          return;
        }
        const rival = this.world.activeTribes().find((t) => t !== 'player' && near(this.world.tribes[t]!.home.x, this.world.tribes[t]!.home.z));
        if (rival) this.say(this.world.removeTribe(rival) ? `${TRIBE_NAMES[rival]} removed` : 'A level needs at least one rival');
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
    const spell = this.stoneSpell;
    this.monumentBtn.innerHTML = `${spellIcon(spell, 14)}<span></span>`;
    (this.monumentBtn.lastChild as HTMLElement).textContent = 'Stone';
    for (const s of this.selects) s.paint();
  }

  private readonly selects: Array<{ paint(): void }> = [];

  /** A small dropdown on the bar (keys typed into it stay out of the game). */
  private select(options: Array<[string, string]>, current: () => string, pick: (v: string) => void, title: string): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.title = title;
    for (const [v, label] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => pick(sel.value));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    this.bar.appendChild(sel);
    this.selects.push({ paint: () => (sel.value = current()) });
    return sel;
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
