/**
 * ui/tools.ts — which tool the left mouse button currently is.
 *
 * One tiny shared object instead of an event system: the brush, the build
 * placer, the spell caster and the selection controller all just read
 * `toolState.tool` when the mouse does something.
 *
 * Phase 4 reorganized the keyboard around the spell book:
 *
 *   1 select · 2 hut · 3–9,0 the eight spells · - / = the debug sculpt brush
 *
 * The raw raise/lower brush is officially a developer toy now (the
 * in-fiction way to move earth is the spell book), but it stays bound
 * because sculpting planets is half the reason this project exists.
 */

import { SPELLS, SpellId } from '../sim/spells';
import { BuildingKind } from '../sim/world-state';

/** Editor-only placement tools (the level builder's palette). */
export type EditorTool = 'homePlayer' | 'homeRed' | 'monument' | 'tree' | 'wildman' | 'erase';

export type Tool = 'select' | BuildingKind | 'raise' | 'lower' | SpellId | EditorTool;

export const toolState = { tool: 'select' as Tool };

/** Number row: select, hut, then the eight spells in panel order. */
const DIGIT_TOOLS: Tool[] = ['select', 'hut', ...SPELLS.map((s) => s.id)];

addEventListener('keydown', (e) => {
  const digits = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
  const i = digits.indexOf(e.code);
  if (i >= 0 && i < DIGIT_TOOLS.length) toolState.tool = DIGIT_TOOLS[i];
  // War buildings live on letters (the number row is full).
  if (e.code === 'KeyT') toolState.tool = 'warriorHut';
  if (e.code === 'KeyY') toolState.tool = 'fireHut';
  if (e.code === 'KeyU') toolState.tool = 'tower';
  if (e.code === 'Minus') toolState.tool = 'raise';
  if (e.code === 'Equal') toolState.tool = 'lower';
  if (e.code === 'Escape') toolState.tool = 'select';
});

/** Is the current tool a spell? (The caster and panel both ask.) */
export function activeSpell(): SpellId | null {
  return SPELLS.some((s) => s.id === toolState.tool) ? (toolState.tool as SpellId) : null;
}

/** Is the current tool a building placement tool? */
export function activeBuilding(): BuildingKind | null {
  return toolState.tool === 'hut' || toolState.tool === 'warriorHut' || toolState.tool === 'fireHut' || toolState.tool === 'tower'
    ? toolState.tool
    : null;
}
