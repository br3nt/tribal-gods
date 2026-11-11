import { describe, expect, it } from 'vitest';
import { BUILD_ORDER, SPELLS } from '../src/sim/catalog';
import { brushSizeStep, CAMERA_CODES, DEBUG_CODES, codeLabel, HOTKEYS, keyLabel, labelFor, matchHotkey } from '../src/ui/hotkeys';

const ev = (code: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods,
});

describe('hotkey table', () => {
  it('no two actions share a key + modifier combination', () => {
    const seen = new Set<string>();
    for (const hk of HOTKEYS) {
      const k = `${hk.code}|${!!hk.shift}|${!!hk.ctrl}`;
      expect(seen.has(k), `${hk.action} collides on ${k}`).toBe(false);
      seen.add(k);
    }
  });
  it('never binds a camera key or a debug key', () => {
    for (const hk of HOTKEYS) {
      expect(CAMERA_CODES).not.toContain(hk.code);
      expect(DEBUG_CODES).not.toContain(hk.code);
    }
  });
  it('demolish works from the Mac delete key too', () => {
    expect(matchHotkey(ev('Backspace'))?.action).toBe('demolish');
    expect(matchHotkey(ev('Delete'))?.action).toBe('demolish');
  });
  it('every spell and every building has a key', () => {
    for (const s of SPELLS) expect(labelFor(`spell:${s.id}`), s.id).not.toBe('');
    for (const b of BUILD_ORDER) expect(labelFor(`build:${b}`), b).not.toBe('');
  });
  it('spell rows follow tiers: tier I on the R row, II on F, III on V', () => {
    const first = (tier: number) => SPELLS.find((s) => s.tier === tier)!.id;
    expect(labelFor(`spell:${first(1)}`)).toBe('R');
    expect(labelFor(`spell:${first(2)}`)).toBe('F');
    expect(labelFor(`spell:${first(3)}`)).toBe('V');
  });
  it('matches modifiers exactly', () => {
    expect(matchHotkey(ev('Digit1'))?.action).toBe('group-recall:1');
    expect(matchHotkey(ev('Digit1', { ctrlKey: true }))?.action).toBe('group-set:1');
    expect(matchHotkey(ev('Digit1', { shiftKey: true }))?.action).toBe(`build:${BUILD_ORDER[0]}`);
    expect(matchHotkey(ev('KeyR', { metaKey: true }))).toBeNull();
    expect(matchHotkey(ev('KeyW'))).toBeNull();
  });
  it('labels read like keycaps', () => {
    expect(codeLabel('KeyR')).toBe('R');
    expect(codeLabel('Period')).toBe('.');
    expect(keyLabel({ action: 'pause', code: 'Digit2', shift: true, group: 'Build', desc: '' })).toBe('⇧2');
    expect(keyLabel({ action: 'pause', code: 'Digit2', ctrl: true, group: 'Build', desc: '' })).toBe('Ctrl 2');
  });
});

describe('debug brush keys', () => {
  it('in play with F3 on, [ ] are speed only and Shift+[ ] size the brush', () => {
    expect(matchHotkey(ev('BracketLeft'))?.action).toBe('speed-down');
    expect(brushSizeStep(ev('BracketLeft'), 'game', true)).toBe(0);
    expect(brushSizeStep(ev('BracketRight', { shiftKey: true }), 'game', true)).toBe(1);
    expect(matchHotkey(ev('BracketRight', { shiftKey: true }))).toBeNull();
    expect(brushSizeStep(ev('BracketRight', { shiftKey: true }), 'game', false)).toBe(0);
  });
  it('in the editor, plain [ ] size the brush', () => {
    expect(brushSizeStep(ev('BracketLeft'), 'editor', false)).toBe(-1);
    expect(brushSizeStep(ev('BracketRight'), 'editor', false)).toBe(1);
  });
});
