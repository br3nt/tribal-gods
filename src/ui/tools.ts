/**
 * ui/tools.ts — which tool the left mouse button currently is.
 *
 * One tiny shared object instead of an event system: selection, the build
 * placer, the spell aimer, the editor and the debug sculpt brush all read
 * `toolState.tool` when the mouse does something, and the spell book,
 * build menu and keyboard all write it. Everyone agrees by construction.
 *
 * Keys are not bound here any more: ui/hotkeys.ts is the table and
 * ui/game-ui.ts the one handler.
 */

import { BUILD_ORDER, BuildingKind, SPELLS, SpellId } from '../sim/catalog';

/** Editor-only placement tools (the level builder's palette). */
export type EditorTool = 'home' | 'monument' | 'tree' | 'wildman' | 'erase';

export type Tool = 'select' | BuildingKind | 'raise' | 'lower' | SpellId | EditorTool;

export const toolState = { tool: 'select' as Tool };

/** Is the current tool a spell? */
export function activeSpell(): SpellId | null {
  return SPELLS.some((s) => s.id === toolState.tool) ? (toolState.tool as SpellId) : null;
}

/** Is the current tool a building placement tool? */
export function activeBuilding(): BuildingKind | null {
  return (BUILD_ORDER as string[]).includes(toolState.tool) ? (toolState.tool as BuildingKind) : null;
}

/** Back to plain selecting (Esc, right-click, a finished cast). */
export function resetTool(): void {
  toolState.tool = 'select';
}
