/**
 * render/highlight.ts — "this one": the hover highlight.
 *
 * The UI decides WHAT is under the cursor; the renderers decide what that
 * LOOKS like. One thing at a time is highlighted:
 *
 *   setHighlight('unit', unitId)          a figure (sim Unit.id)
 *   setHighlight('building', buildingId)  a building (sim Building.id)
 *   setHighlight('monument', index)       a standing stone (index in world.monuments)
 *   setHighlight('tree', index)           a tree (index in world.trees)
 *   setHighlight(null)                    nothing
 *
 * Figures, buildings and stones get a cool rim light and a slight lift
 * (a shared tinted variant of their material — see HIGHLIGHT in look.ts);
 * a tree, being one instance of a shared instanced mesh, is brightened.
 * Renderers read the current target every frame, so calling this as often
 * as the mouse moves is fine (it only stores two values).
 */

export type HighlightKind = 'unit' | 'building' | 'monument' | 'tree';

let kind: HighlightKind | null = null;
let id = -1;

export function setHighlight(k: HighlightKind | null, which: number | null = null): void {
  if (k === null || which === null || which === undefined) {
    kind = null;
    id = -1;
    return;
  }
  kind = k;
  id = which;
}

/** Is (k, which) the highlighted thing? */
export function isHighlighted(k: HighlightKind, which: number): boolean {
  return kind === k && id === which;
}

/** The current target, or null. */
export function getHighlight(): { kind: HighlightKind; id: number } | null {
  return kind === null ? null : { kind, id };
}
