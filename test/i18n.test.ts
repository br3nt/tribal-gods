/**
 * The translation layer (src/i18n): tr() fills placeholders and falls back to
 * English, and the German dictionary stays in step with the code — every
 * entry translates a string the code really passes to tr(), and a
 * translation only uses placeholders its English original has.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LANG, tr } from '../src/i18n';
import { de } from '../src/i18n/de';

/** Keys tr() receives as computed values (tribe colours, hotkey groups, difficulty ids, HUD labels). */
const RUNTIME_KEYS = [
  'Red', 'Gold', 'Violet',
  'Camera', 'Selection', 'Spells', 'Build', 'Game',
  'Easy', 'Normal', 'Hard',
  'wood', 'housed', 'mana', 'praying', 'leader',
];

/** Every string literal passed as the first argument of tr() anywhere in src/. */
function keysInCode(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node) => {
          if (ts.isCallExpression(n) && n.expression.getText(sf) === 'tr') {
            const a = n.arguments[0];
            if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) keys.add(a.text);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
  };
  walk(join(__dirname, '../src'));
  return keys;
}

const placeholders = (s: string) => new Set(s.match(/\{\d+\}/g) ?? []);

describe('tr()', () => {
  it('is English in headless runs (tests and the sim never see a translation)', () => {
    expect(LANG).toBe('en');
    expect(tr('Out of range')).toBe('Out of range');
  });

  it('fills numbered placeholders, leaving unknown ones alone', () => {
    expect(tr('Needs {0} more wood', 3)).toBe('Needs 3 more wood');
    expect(tr('{1} before {0}', 'a', 'b')).toBe('b before a');
    expect(tr('{0} and {2}', 'x')).toBe('x and {2}');
  });
});

describe('German dictionary', () => {
  const code = keysInCode();
  const known = new Set([...code, ...RUNTIME_KEYS]);

  it('translates only strings the code uses', () => {
    const stale = Object.keys(de).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it('covers every string the code passes to tr()', () => {
    const missing = [...known].filter((k) => !(k in de));
    expect(missing).toEqual([]);
  });

  it('uses only placeholders the English text has', () => {
    const bad = Object.entries(de).filter(([en, t]) => [...placeholders(t)].some((p) => !placeholders(en).has(p)));
    expect(bad).toEqual([]);
  });

  it('keeps markup out of the keys (layout stays in the code)', () => {
    const withLayout = Object.keys(de).filter((k) => /<(?!\/?b>)[a-z/]|&lt;/i.test(k));
    expect(withLayout).toEqual([]);
  });
});
