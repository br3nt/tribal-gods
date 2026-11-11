/**
 * ui/game-ui.ts — the in-game interface, assembled.
 *
 * Builds every HUD panel, lays them out, implements the shared ACTIONS
 * (ui/context.ts) once, and runs the one keyboard handler that turns
 * ui/hotkeys.ts into those actions. main.ts creates one GameUi and calls
 * update() every render frame and reset() when a new scenario starts.
 *
 * Layout (all panels hug the edges; the middle of the screen is the world):
 *
 *   ┌ resources ───────────────┐                       ┌ clock · speed · menu ┐
 *   │                              narrator line                  objectives │
 *   │                                hint chip                       alerts    │
 *   │                                                              alerts    │
 *   │ minimap        [ selection panel ]          [ build ]  [ spell book ]  │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Cheap panels refresh ~8×/s; the spell book (recharge sweeps), world
 * overlay (bars track moving people) and in-world aiming run every frame.
 */

import * as THREE from 'three';
import type { LoopStats } from '../core/loop';
import { setHighlight } from '../render/highlight';
import { TILE, WORLD_SIZE } from '../config';
import { wrapDelta } from '../core/util';
import { BuildingKind, SpellId, UNITS } from '../sim/catalog';
import type { World } from '../sim/world-state';
import { AlertFeed } from './alerts';
import { appState, SPEEDS } from './app-state';
import { BuildMenu } from './build-menu';
import { BuildPlacer } from './build-placer';
import { UiActions, UiContext } from './context';
import { DebugOverlay } from './debug-overlay';
import { css, h, typingInField, uiRoot } from './dom';
import { GameOverScreen } from './game-over';
import { Hints } from './hints';
import { matchHotkey } from './hotkeys';
import { Minimap } from './minimap';
import { Narrator } from './narrator';
import { ObjectivesPanel } from './objectives-panel';
import { OrderControl } from './orders';
import { lookAtTile, View } from './project';
import { ControlGroups, nextInCycle, Selection } from './selection';
import { SelectionPanel } from './selection-panel';
import { SpellAim } from './spell-aim';
import { SpellBook } from './spell-book';
import { TopBar } from './top-bar';
import { WorldHover } from './world-hover';
import { WorldOverlay } from './world-overlay';
import { activeBuilding, activeSpell, resetTool, toolState } from './tools';
import { hideTip } from './tooltip';

css('game-ui', `
.hud-right { position: absolute; top: calc(var(--edge) + 3.4rem); right: var(--edge); display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-end; }
.hud-dock { position: absolute; left: var(--edge); right: var(--edge); bottom: var(--edge); display: flex; align-items: flex-end; gap: 0.5rem; }
.hud-dock .mid { flex: 1; min-width: 0; display: flex; justify-content: center; }
.hud-dock .mid > .sp { max-width: min(27rem, 100%); }
.hud-rally { position: fixed; z-index: 54; pointer-events: none; }
`);

export interface GameUiHooks {
  openMenu(): void;
  openHelp(): void;
  restart(): void;
  quitToMenu(): void;
  /** True while something modal (the menu) owns the keyboard. */
  isBlocked(): boolean;
}

export class GameUi {
  readonly ctx: UiContext;
  readonly selection = new Selection();
  readonly orders: OrderControl;
  readonly minimap: Minimap;
  readonly spellBook: SpellBook;
  readonly buildMenu: BuildMenu;
  readonly selectionPanel: SelectionPanel;
  readonly alerts: AlertFeed;
  readonly gameOver: GameOverScreen;
  private readonly topBar: TopBar;
  private readonly objectives: ObjectivesPanel;
  private readonly aim: SpellAim;
  private readonly placer: BuildPlacer;
  private readonly hints: Hints;
  readonly narrator = new Narrator();
  private heardMessages = 0;
  private readonly debug: DebugOverlay;
  private readonly overlay: WorldOverlay;
  private readonly worldHover: WorldHover;
  private readonly root: HTMLDivElement;
  private slow = 0;
  private lastIdle: number | null = null;
  private lastRecall: { n: number; t: number } | null = null;
  private shownGameOver = false;

  constructor(
    world: World,
    view: View,
    scene: THREE.Scene,
    canvas: HTMLCanvasElement,
    stats: LoopStats,
    private readonly hooks: GameUiHooks,
    brushRadius: () => number,
  ) {
    this.root = uiRoot();
    const pointer = { x: innerWidth / 2, y: innerHeight / 2, onCanvas: false };
    canvas.addEventListener('pointermove', (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.onCanvas = true;
    });
    canvas.addEventListener('pointerleave', () => (pointer.onCanvas = false));

    const actions = this.makeActions(world, view);
    this.ctx = {
      world, view, scene, canvas, stats, selection: this.selection, groups: new ControlGroups(), pointer, actions,
      hover: { unit: null, building: null, monument: null },
    };

    // --- Panels ---
    this.topBar = new TopBar(this.ctx, this.root);
    const right = h('div.hud-right');
    this.objectives = new ObjectivesPanel(this.ctx);
    this.alerts = new AlertFeed(this.ctx);
    right.append(this.objectives.el, this.alerts.el);
    this.root.appendChild(right);

    const dock = h('div.hud-dock');
    this.minimap = new Minimap(this.ctx);
    this.selectionPanel = new SelectionPanel(this.ctx);
    this.buildMenu = new BuildMenu(this.ctx);
    this.spellBook = new SpellBook(this.ctx);
    dock.append(this.minimap.el, h('div.mid', {}, this.selectionPanel.el), this.buildMenu.el, this.spellBook.el);
    this.root.appendChild(dock);

    // --- World interaction ---
    // Aim + placer register their canvas pointerdown FIRST and stop it when
    // they use the click, so a cast/placement never also starts a box drag.
    this.aim = new SpellAim(this.ctx);
    this.placer = new BuildPlacer(this.ctx);
    this.orders = new OrderControl(this.ctx);
    this.minimap.onOrder = (x, z) => this.orders.orderAt(x, z);
    this.orders.intercept = (x, z) => {
      const id = this.selectionPanel.rallyPick;
      if (id === null) return false;
      world.setRally(id, x, z);
      this.selectionPanel.rallyPick = null;
      return true;
    };
    this.overlay = new WorldOverlay(this.ctx);
    this.worldHover = new WorldHover(this.ctx);
    this.worldHover.preview = this.orders.preview;
    // One calm column at top-centre: the narrator's line, then the hint chip.
    const centre = h('div.hud-centre', {}, this.topBar.pausedBanner, this.narrator.el);
    this.root.appendChild(centre);
    this.hints = new Hints(this.ctx, centre);
    this.debug = new DebugOverlay(stats, world, brushRadius);
    this.gameOver = new GameOverScreen({ onRestart: () => hooks.restart(), onMenu: () => hooks.quitToMenu() });

    addEventListener('keydown', (e) => this.onKey(e));
    // The player taking the camera cancels a narrated drift.
    for (const ev of ['keydown', 'wheel', 'pointerdown'] as const) addEventListener(ev, () => (this.panTo = null), { capture: true, passive: true });
    // A mouse click on a HUD button must not leave it focused (Space would
    // then also "click" it). Keyboard users still Tab to buttons normally.
    this.root.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });
  }

  // ---------------------------------------------------------------------------

  private makeActions(world: World, view: View): UiActions {
    const self = this;
    return {
      centreOn: (x, z) => lookAtTile(view.target, x, z),
      centreOnLeader() {
        const l = world.leaderOf('player');
        const at = l ?? world.tribes.player?.home;
        if (at) lookAtTile(view.target, at.x, at.z);
      },
      centreOnHome() {
        const home = world.tribes.player?.home;
        if (home) lookAtTile(view.target, home.x, home.z);
      },
      nextIdleVillager() {
        const idle = world.units
          .filter((u) => u.tribe === 'player' && u.kind === 'brave' && !u.hidden && u.task === 'none' && u.state === 'idle')
          .map((u) => u.id);
        const id = nextInCycle(idle, self.lastIdle);
        if (id === null) return;
        self.lastIdle = id;
        self.selection.setUnits([id]);
        const u = world.unitById(id)!;
        lookAtTile(view.target, u.x, u.z);
      },
      selectArmy() {
        // Everyone who isn't a villager or the leader: warriors, emberthrowers, wardens, chanters.
        const ids = world.units
          .filter((u) => u.tribe === 'player' && !u.hidden && u.kind !== 'brave' && u.kind !== 'shaman' && UNITS[u.kind].trainedAt)
          .map((u) => u.id);
        self.selection.setUnits(ids);
      },
      selectLeader() {
        const l = world.leaderOf('player');
        if (!l) return;
        self.selection.setUnits([l.id]);
        lookAtTile(view.target, l.x, l.z);
      },
      armSpell(id: SpellId) {
        toolState.tool = id;
        hideTip();
      },
      armBuilding(kind: BuildingKind) {
        toolState.tool = kind;
        hideTip();
      },
      cancelTool() {
        if (self.selectionPanel.rallyPick !== null) {
          self.selectionPanel.rallyPick = null;
          return true;
        }
        if (toolState.tool === 'select') return false;
        resetTool();
        return true;
      },
      togglePause() {
        appState.paused = !appState.paused;
      },
      setSpeed(n: number) {
        appState.speed = n;
        appState.paused = false;
      },
      openMenu: () => this.hooks.openMenu(),
      openHelp: () => this.hooks.openHelp(),
      toggleDebug() {
        appState.debug = !appState.debug;
        if (!appState.debug && (toolState.tool === 'raise' || toolState.tool === 'lower')) resetTool();
      },
      demolishSelected: () => this.selectionPanel.demolishSelected(),
      ping: (x, z, tone) => this.minimap.ping(x, z, tone),
    };
  }

  private onKey(e: KeyboardEvent): void {
    if (appState.mode !== 'game' || typingInField() || this.hooks.isBlocked()) return;
    if (this.gameOver.visible && e.code !== 'F3') return;
    const a = this.ctx.actions;
    // Debug sculpt brush keys (only with the F3 readout open).
    if (appState.debug && (e.code === 'Minus' || e.code === 'Equal') && !e.ctrlKey && !e.metaKey) {
      toolState.tool = e.code === 'Minus' ? 'raise' : 'lower';
      return;
    }
    const hk = matchHotkey(e);
    if (!hk) return;
    const act = hk.action;
    // Holding a key must not flicker toggles (pause, menu, groups); only cycling repeats.
    if (e.repeat && act !== 'idle-villager') {
      e.preventDefault();
      return;
    }
    if (act === 'cancel') {
      if (!a.cancelTool()) {
        if (!this.selection.empty) this.selection.clear();
        else a.openMenu();
      }
    } else if (act.startsWith('spell:')) this.spellBook.arm(act.slice(6) as SpellId);
    else if (act.startsWith('build:')) this.buildMenu.arm(act.slice(6) as BuildingKind);
    else if (act.startsWith('group-set:')) {
      this.ctx.groups.set(Number(act.slice(10)), this.selection.units);
    } else if (act.startsWith('group-recall:')) {
      const n = Number(act.slice(13));
      const ids = this.ctx.groups.get(n, (id) => !!this.ctx.world.unitById(id));
      if (ids.length === 0) return;
      const now = performance.now();
      if (this.lastRecall && this.lastRecall.n === n && now - this.lastRecall.t < 400) {
        const u = this.ctx.world.unitById(ids[0])!;
        a.centreOn(u.x, u.z);
      }
      this.lastRecall = { n, t: now };
      this.selection.setUnits(ids);
    } else {
      switch (act) {
        case 'select-army': a.selectArmy(); break;
        case 'idle-villager': a.nextIdleVillager(); break;
        case 'select-leader': a.selectLeader(); break;
        case 'centre-leader': a.centreOnLeader(); break;
        case 'centre-home': a.centreOnHome(); break;
        case 'pause': a.togglePause(); break;
        case 'speed-down': a.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(appState.speed as 1) - 1)]); break;
        case 'speed-up': a.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(appState.speed as 1) + 1)]); break;
        case 'demolish': a.demolishSelected(); break;
        case 'debug': a.toggleDebug(); break;
        case 'help': a.openHelp(); break;
      }
    }
    e.preventDefault();
  }

  /** Settings → "Show all hints again". */
  resetHints(): void {
    this.hints.resetSeen();
  }

  /** A new scenario began: clear selection, history and screens. */
  reset(): void {
    this.selection.clear();
    resetTool();
    this.alerts.reset();
    this.objectives.reset();
    this.hints.reset();
    this.narrator.reset();
    this.panTo = null;
    this.heardMessages = this.ctx.world.messageSeq;
    this.gameOver.hide();
    this.shownGameOver = false;
    this.lastIdle = null;
    this.lastRecall = null;
    this.ctx.groups.clear(); // unit ids restart at 1 in a new world
    appState.paused = false;
    appState.speed = 1;
  }

  /** Every render frame. */
  update(dt: number): void {
    const inGame = appState.mode === 'game';
    this.root.style.display = inGame ? '' : 'none';
    if (!inGame) {
      if (activeSpell() || activeBuilding()) resetTool();
      setHighlight(null);
      this.orders.hideMarks();
      this.ctx.hover.unit = this.ctx.hover.building = this.ctx.hover.monument = null;
      this.worldHover.update(dt);
      this.aim.update();
      this.placer.update();
      return;
    }
    this.spellBook.update();
    this.aim.update();
    this.placer.update();
    this.orders.update(dt);
    this.worldHover.update(dt);
    this.minimap.update(dt);
    this.debug.update(dt, this.selection.units.size);
    this.hints.update(dt);
    this.alerts.update();
    this.hearScenario();
    this.drift(dt);
    this.narrator.update(dt);

    this.slow -= dt;
    if (this.slow <= 0) {
      this.slow = 0.12;
      this.topBar.update();
      this.buildMenu.update();
      this.objectives.update();
      this.selectionPanel.update();
      this.overlay.refreshBlockers();
    }

    const w = this.ctx.world;
    if (w.gameOver && !this.shownGameOver) {
      this.shownGameOver = true;
      resetTool();
      this.gameOver.show(w.gameOver, w.gameOverReason, {
        seconds: w.elapsed,
        peakPopulation: Math.max(this.alerts.tally.peakPopulation, w.tribePopulation('player')),
        spellsCast: this.alerts.tally.spellsCast,
        buildings: w.buildings.filter((b) => b.tribe === 'player' && b.progress >= 1).length,
      });
    }
    if (!w.gameOver && this.shownGameOver) {
      this.shownGameOver = false;
      this.gameOver.hide();
    }
  }

  /** Scenario lines (scripted events) the sim said since last frame go to the narrator, in order. */
  private hearScenario(): void {
    const w = this.ctx.world;
    if (w.messageSeq < this.heardMessages) this.heardMessages = 0; // a new world
    if (w.messageSeq === this.heardMessages) return;
    const fresh = w.messages.slice(-Math.min(w.messages.length, w.messageSeq - this.heardMessages));
    for (const m of fresh) {
      this.narrator.say(m.text);
      if (m.focus) {
        // The line is about a place: ping it, and drift the camera there unless the player is busy.
        this.minimap.ping(m.focus.x, m.focus.z, 'info');
        this.panTo = { x: m.focus.x, z: m.focus.z };
      }
    }
    this.heardMessages = w.messageSeq;
  }

  /**
   * A gentle camera drift toward a narrated place (world.messages[].focus).
   * Never while aiming, placing or dragging, and any key, click or wheel
   * from the player cancels it — the camera is theirs.
   */
  private panTo: { x: number; z: number } | null = null;
  private drift(dt: number): void {
    if (!this.panTo) return;
    if (activeSpell() || activeBuilding() || this.orders.busy) return; // wait: don't move the ground under the cursor
    const t = this.ctx.view.target;
    const dx = wrapDelta(this.panTo.x * TILE - t.x, WORLD_SIZE * TILE);
    const dz = wrapDelta(this.panTo.z * TILE - t.z, WORLD_SIZE * TILE);
    const d = Math.hypot(dx, dz);
    if (d < 0.5) {
      this.panTo = null;
      return;
    }
    const k = 1 - Math.exp(-dt * 1.6); // ~1.5 s to settle, eases out
    t.x += dx * k;
    t.z += dz * k;
  }

  /** The world overlay runs after the renderers have moved everyone. */
  updateOverlay(): void {
    if (appState.mode === 'game') this.overlay.update();
  }
}
