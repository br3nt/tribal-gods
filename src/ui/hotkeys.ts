/**
 * ui/hotkeys.ts — THE hotkey table. Single source of truth.
 *
 * Every control that has a key shows it (spell slots, build tiles, top-bar
 * buttons), the How-to-play page prints this table, and the one keyboard
 * handler (ui/game-ui.ts onKey) dispatches through matchHotkey(). Change a
 * key here and every one of those follows.
 *
 * The layout, and why:
 *   - W A S D / arrows and Q E belong to the camera (render/camera-rig.ts
 *     reads them directly), so nothing else may use them.
 *   - 1–9 recall control groups, Ctrl+1–9 set them (RTS convention).
 *   - Spells sit on three keyboard ROWS, one per tier, so the keyboard
 *     mirrors the spell book: tier I on R T Y U I, tier II on F G H J K,
 *     tier III on V B N M. Muscle memory learns "row = power".
 *   - Buildings are Shift + 1–8 in build-menu order.
 *   - Space jumps to your leader, C to your home circle, period to the next
 *     idle villager, comma selects the whole army.
 *
 * Pure data + pure functions: no DOM, so Vitest can check for collisions.
 */

import { BUILD_ORDER, BUILDINGS, BuildingKind, SPELLS, SpellId } from '../sim/catalog';

export type ActionId =
  | `spell:${SpellId}`
  | `build:${BuildingKind}`
  | `group-set:${number}`
  | `group-recall:${number}`
  | 'select-army'
  | 'idle-villager'
  | 'select-leader'
  | 'centre-leader'
  | 'centre-home'
  | 'pause'
  | 'speed-down'
  | 'speed-up'
  | 'demolish'
  | 'cancel'
  | 'debug'
  | 'help';

export type HotkeyGroup = 'Spells' | 'Build' | 'Selection' | 'Camera' | 'Game';

export interface Hotkey {
  action: ActionId;
  /** KeyboardEvent.code */
  code: string;
  shift?: boolean;
  ctrl?: boolean;
  group: HotkeyGroup;
  /** What the How-to-play table says it does. */
  desc: string;
}

/** Keyboard rows the spell tiers live on (index = tier - 1). */
export const SPELL_ROWS = [
  ['KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI'],
  ['KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'],
  ['KeyV', 'KeyB', 'KeyN', 'KeyM'],
] as const;

/** Debug-only keys (F3 on): - and = arm the sculpt brush. Not bound in play. */
export const DEBUG_CODES = ['Minus', 'Equal'];

/** Keys the camera rig reads directly; nothing else may bind them. */
export const CAMERA_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

function spellHotkeys(): Hotkey[] {
  const out: Hotkey[] = [];
  const used = [0, 0, 0];
  for (const s of SPELLS) {
    const row: readonly string[] = SPELL_ROWS[s.tier - 1];
    const i = used[s.tier - 1]++;
    if (i >= row.length) continue; // a tier longer than its row goes unbound (the slot shows no key)
    out.push({ action: `spell:${s.id}`, code: row[i], group: 'Spells', desc: s.name });
  }
  return out;
}

function buildHotkeys(): Hotkey[] {
  return BUILD_ORDER.slice(0, 9).map((kind, i) => ({
    action: `build:${kind}` as ActionId,
    code: `Digit${i + 1}`,
    shift: true,
    group: 'Build' as const,
    desc: BUILDINGS[kind].name,
  }));
}

function groupHotkeys(): Hotkey[] {
  const out: Hotkey[] = [];
  for (let n = 1; n <= 9; n++) {
    out.push({ action: `group-recall:${n}`, code: `Digit${n}`, group: 'Selection', desc: `Select group ${n} (twice: jump to it)` });
    out.push({ action: `group-set:${n}`, code: `Digit${n}`, ctrl: true, group: 'Selection', desc: `Make the selection group ${n}` });
  }
  return out;
}

export const HOTKEYS: Hotkey[] = [
  ...spellHotkeys(),
  ...buildHotkeys(),
  ...groupHotkeys(),
  { action: 'select-army', code: 'Comma', group: 'Selection', desc: 'Select every fighter' },
  { action: 'idle-villager', code: 'Period', group: 'Selection', desc: 'Next idle villager' },
  { action: 'select-leader', code: 'KeyL', group: 'Selection', desc: 'Select your leader' },
  { action: 'centre-leader', code: 'Space', group: 'Camera', desc: 'Jump to your leader' },
  { action: 'centre-home', code: 'KeyC', group: 'Camera', desc: 'Jump to your home circle' },
  { action: 'pause', code: 'KeyP', group: 'Game', desc: 'Pause / resume' },
  { action: 'speed-down', code: 'BracketLeft', group: 'Game', desc: 'Slower' },
  { action: 'speed-up', code: 'BracketRight', group: 'Game', desc: 'Faster' },
  { action: 'demolish', code: 'Delete', group: 'Selection', desc: 'Demolish the selected building' },
  { action: 'demolish', code: 'Backspace', group: 'Selection', desc: 'Demolish (Mac delete key)' },
  { action: 'cancel', code: 'Escape', group: 'Game', desc: 'Cancel aiming / placing; else open the menu' },
  { action: 'help', code: 'F1', group: 'Game', desc: 'How to play' },
  { action: 'debug', code: 'F3', group: 'Game', desc: 'Debug readout' },
];

/** Camera + mouse controls the table also documents (handled elsewhere). */
export const DESCRIBED_CONTROLS: Array<{ keys: string[]; desc: string; group: HotkeyGroup }> = [
  { keys: ['W', 'A', 'S', 'D'], desc: 'Pan (or arrow keys)', group: 'Camera' },
  { keys: ['Q', 'E'], desc: 'Rotate (or middle-drag)', group: 'Camera' },
  { keys: ['Wheel'], desc: 'Zoom toward the cursor', group: 'Camera' },
  { keys: ['Click'], desc: 'Select a person, building or stone', group: 'Selection' },
  { keys: ['Drag'], desc: 'Box-select your people', group: 'Selection' },
  { keys: ['Double-click'], desc: 'Select all of that kind on screen', group: 'Selection' },
  { keys: ['Shift', 'Click'], desc: 'Add to / remove from the selection', group: 'Selection' },
  { keys: ['Right-click'], desc: 'Order: move, attack, garrison, commune, rally', group: 'Selection' },
];

/** 'KeyR' → 'R', 'Digit1' → '1', 'Space' → 'Space'… */
export function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const named: Record<string, string> = {
    Space: 'Space', Period: '.', Comma: ',', Escape: 'Esc', Backquote: '`', BracketLeft: '[', BracketRight: ']',
    Delete: 'Del', Backspace: 'Bksp', Slash: '/', Minus: '-', Equal: '=',
  };
  return named[code] ?? code;
}

/** Display label for a hotkey, e.g. 'R', '⇧1', 'Ctrl 1'. */
export function keyLabel(hk: Hotkey): string {
  return `${hk.ctrl ? 'Ctrl ' : ''}${hk.shift ? '⇧' : ''}${codeLabel(hk.code)}`;
}

export function hotkeyFor(action: ActionId): Hotkey | undefined {
  return HOTKEYS.find((k) => k.action === action);
}

/** Label for an action's key, or '' if it has none. */
export function labelFor(action: ActionId): string {
  const hk = hotkeyFor(action);
  return hk ? keyLabel(hk) : '';
}

export interface KeyLike {
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** The hotkey a key event means, or null. Modifiers must match exactly. */
export function matchHotkey(e: KeyLike): Hotkey | null {
  if (e.altKey || e.metaKey) return null; // leave browser/OS shortcuts alone
  for (const hk of HOTKEYS) {
    if (hk.code === e.code && !!hk.shift === e.shiftKey && !!hk.ctrl === e.ctrlKey) return hk;
  }
  return null;
}
