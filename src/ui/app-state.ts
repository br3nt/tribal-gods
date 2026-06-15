/**
 * ui/app-state.ts — which hat the app is wearing.
 *
 *   menu   — a setup overlay is up; the world behind it is decoration
 *   game   — a skirmish is live: sim ticks, orders and spells accepted
 *   editor — the world is clay: sim frozen, editor tools own the mouse
 *
 * One shared flag, read by every input handler before acting. The same
 * dirt-simple pattern as toolState, for the same reason: when keyboard,
 * mouse and UI buttons all consult one object, they cannot disagree.
 */

export type AppMode = 'menu' | 'game' | 'editor';

export const appState = { mode: 'menu' as AppMode };
