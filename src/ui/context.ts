/**
 * ui/context.ts — what every in-game panel is handed.
 *
 * Panels don't import each other. They get one UiContext: the world to read,
 * the view to project through, the shared selection, the pointer, and a
 * table of ACTIONS ("centre on leader", "arm Blast", "open the menu") that
 * ui/game-ui.ts implements once. A button and a hotkey that do the same
 * thing call the same action, so they cannot drift apart.
 */

import type * as THREE from 'three';
import type { LoopStats } from '../core/loop';
import type { BuildingKind, SpellId } from '../sim/catalog';
import type { World } from '../sim/world-state';
import type { View } from './project';
import type { ControlGroups, Selection } from './selection';

export interface UiActions {
  centreOnLeader(): void;
  centreOnHome(): void;
  centreOn(x: number, z: number): void;
  nextIdleVillager(): void;
  selectArmy(): void;
  selectLeader(): void;
  armSpell(id: SpellId): void;
  armBuilding(kind: BuildingKind): void;
  /** Esc: leave aiming/placing; returns false if there was nothing to cancel. */
  cancelTool(): boolean;
  togglePause(): void;
  setSpeed(n: number): void;
  openMenu(): void;
  openHelp(): void;
  toggleDebug(): void;
  demolishSelected(): void;
  /** Ping a spot on the minimap (alerts, orders). */
  ping(x: number, z: number, tone: 'bad' | 'good' | 'info'): void;
}

export interface UiContext {
  world: World;
  view: View;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  stats: LoopStats;
  selection: Selection;
  groups: ControlGroups;
  /** Last pointer position in CSS px, and whether it is over the canvas. */
  pointer: { x: number; y: number; onCanvas: boolean };
  /**
   * What is under the cursor (ui/orders.ts keeps it current, ~12×/s): one
   * person, building or standing stone at most. This is THE hover hook —
   * ui/world-hover.ts draws its ring and name tag from it, and a renderer
   * may read it to outline the model.
   */
  hover: { unit: number | null; building: number | null; monument: number | null };
  actions: UiActions;
}
