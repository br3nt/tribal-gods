/**
 * ui/app-state.ts — which hat the app is wearing, and how fast time runs.
 *
 *   menu   — a setup overlay is up; the world behind it is decoration
 *   game   — a scenario is live: sim ticks, orders and spells accepted
 *   editor — the world is clay: sim frozen, editor tools own the mouse
 *
 * One shared flag, read by every input handler before acting. The same
 * dirt-simple pattern as toolState, for the same reason: when keyboard,
 * mouse and UI buttons all consult one object, they cannot disagree.
 *
 * `paused` and `speed` are read by main.ts's fixed-tick loop: paused skips
 * world.tick entirely (the UI, camera and renderer keep running), speed N
 * runs N sim ticks per loop tick. Determinism is untouched — the sim still
 * only ever sees fixed 1/TICK_HZ steps.
 */

export type AppMode = 'menu' | 'game' | 'editor';

export const SPEEDS = [1, 2, 3] as const;

export const appState = {
  mode: 'menu' as AppMode,
  paused: false,
  /** Sim ticks per loop tick (1×, 2×, 3×). */
  speed: 1 as number,
  /** Debug readout + sculpt-brush keys (F3). */
  debug: false,
};
