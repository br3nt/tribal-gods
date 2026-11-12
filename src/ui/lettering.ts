/**
 * ui/lettering.ts — CARVED LETTERS: the title and key headings, as SVG.
 *
 * No font file ships with the game and no system font looks cut by hand,
 * so the display lettering is drawn: an angular capital alphabet where
 * every curve is a few straight knife strokes (the way letters come out
 * when you cut them into wood or knap them into stone), on a 10-unit cap
 * height. Each letter is a list of strokes; `carve()` lays them out and
 * renders three passes, like a real inscription seen in daylight:
 *
 *   1. the CUT — a wide dark stroke, nudged down: the shadow in the groove;
 *   2. the PAINT — the stroke itself, in pigment (ochre by default);
 *   3. the EDGE — a hairline highlight nudged up, where light catches the lip.
 *
 * Every point is moved by a small seeded jitter, so no two letters are
 * machine-identical but the same word always comes out the same.
 *
 * The colours are CSS custom properties (--carve-paint, --carve-cut,
 * --carve-edge), so one heading reads on hide, timber or stone. The text is
 * also in the DOM as visually-hidden text, so screen readers, find-in-page
 * and the automation all still see the words.
 *
 * Unknown characters fall back to a space; lower case is drawn as capitals.
 */

type Stroke = number[]; // x0 y0 x1 y1 … (polyline); a trailing NaN closes it

const Z = Number.NaN;

/** Glyph: advance width and strokes. y = 0 is the cap line, 10 the baseline. */
const G: Record<string, [number, Stroke[]]> = {
  A: [6.2, [[0, 10, 3.1, 0, 6.2, 10], [1.2, 6.4, 5, 6.4]]],
  B: [5.6, [[0, 0, 0, 10, 4.4, 10, 5.6, 8.6, 5.6, 6.5, 4.2, 5, 0, 5], [0, 0, 4, 0, 5.1, 1.2, 5.1, 3.7, 4.2, 5]]],
  C: [5.6, [[5.6, 1.1, 4.5, 0, 1.5, 0, 0, 2, 0, 8, 1.5, 10, 4.5, 10, 5.6, 8.9]]],
  D: [5.8, [[0, 0, 0, 10, 3.6, 10, 5.8, 7.6, 5.8, 2.4, 3.6, 0, Z]]],
  E: [5.2, [[5.2, 0, 0, 0, 0, 10, 5.2, 10], [0, 5, 4, 5]]],
  F: [5, [[5, 0, 0, 0, 0, 10], [0, 5, 4, 5]]],
  G: [5.9, [[5.7, 1.2, 4.5, 0, 1.5, 0, 0, 2, 0, 8, 1.5, 10, 4.5, 10, 5.9, 8.4, 5.9, 5.6, 3.2, 5.6]]],
  H: [5.6, [[0, 0, 0, 10], [5.6, 0, 5.6, 10], [0, 5, 5.6, 5]]],
  I: [1.2, [[0.6, 0, 0.6, 10]]],
  J: [4.4, [[4.4, 0, 4.4, 8, 3, 10, 1.2, 10, 0, 8.4]]],
  K: [5.6, [[0, 0, 0, 10], [5.6, 0, 0.2, 6], [1.9, 4.2, 5.6, 10]]],
  L: [4.9, [[0, 0, 0, 10, 4.9, 10]]],
  M: [7.2, [[0, 10, 0, 0, 3.6, 6.2, 7.2, 0, 7.2, 10]]],
  N: [5.8, [[0, 10, 0, 0, 5.8, 10, 5.8, 0]]],
  O: [6.2, [[1.6, 0, 4.6, 0, 6.2, 2.1, 6.2, 7.9, 4.6, 10, 1.6, 10, 0, 7.9, 0, 2.1, Z]]],
  P: [5.5, [[0, 10, 0, 0, 4.3, 0, 5.5, 1.4, 5.5, 4.1, 4.3, 5.5, 0, 5.5]]],
  Q: [6.4, [[1.6, 0, 4.6, 0, 6.2, 2.1, 6.2, 7.9, 4.6, 10, 1.6, 10, 0, 7.9, 0, 2.1, Z], [3.6, 7.4, 6.4, 11]]],
  R: [5.7, [[0, 10, 0, 0, 4.3, 0, 5.5, 1.4, 5.5, 4.1, 4.3, 5.5, 0, 5.5], [2.8, 5.5, 5.7, 10]]],
  S: [5.5, [[5.4, 1.2, 4.2, 0, 1.3, 0, 0, 1.4, 0, 3.6, 5.5, 6.4, 5.5, 8.6, 4.2, 10, 1.2, 10, 0, 8.8]]],
  T: [6, [[0, 0, 6, 0], [3, 0, 3, 10]]],
  U: [5.7, [[0, 0, 0, 8, 1.5, 10, 4.2, 10, 5.7, 8, 5.7, 0]]],
  V: [6.2, [[0, 0, 3.1, 10, 6.2, 0]]],
  W: [8.4, [[0, 0, 2.1, 10, 4.2, 3.6, 6.3, 10, 8.4, 0]]],
  X: [5.8, [[0, 0, 5.8, 10], [5.8, 0, 0, 10]]],
  Y: [6, [[0, 0, 3, 5.2, 6, 0], [3, 5.2, 3, 10]]],
  Z: [5.6, [[0, 0, 5.6, 0, 0, 10, 5.6, 10]]],
  '0': [5.2, [[1.4, 0, 3.8, 0, 5.2, 2, 5.2, 8, 3.8, 10, 1.4, 10, 0, 8, 0, 2, Z]]],
  '1': [3.6, [[0.4, 2.2, 2.6, 0, 2.6, 10]]],
  '2': [5.2, [[0, 1.6, 1.4, 0, 3.9, 0, 5.2, 1.4, 5.2, 4, 0, 10, 5.2, 10]]],
  '3': [5.2, [[0, 0.9, 1, 0, 4, 0, 5.1, 1.2, 5.1, 3.8, 3.7, 5, 1.6, 5], [3.7, 5, 5.2, 6.3, 5.2, 8.8, 4.1, 10, 1, 10, 0, 9.1]]],
  '4': [5.6, [[4.1, 10, 4.1, 0, 0, 7, 5.6, 7]]],
  '5': [5.2, [[5, 0, 0.6, 0, 0.1, 4.6, 4, 4.6, 5.2, 5.9, 5.2, 8.8, 4, 10, 1, 10, 0, 9]]],
  '6': [5.2, [[4.7, 0, 1.6, 0, 0, 2, 0, 8.6, 1.3, 10, 3.9, 10, 5.2, 8.6, 5.2, 6, 3.9, 4.8, 0, 4.8]]],
  '7': [5.2, [[0, 0, 5.2, 0, 1.9, 10]]],
  '8': [5.2, [[1.3, 0, 3.9, 0, 4.9, 1.2, 4.9, 3.6, 3.7, 4.8, 1.5, 4.8, 0.3, 3.6, 0.3, 1.2, Z], [1.5, 4.8, 0, 6.2, 0, 8.8, 1.3, 10, 3.9, 10, 5.2, 8.8, 5.2, 6.2, 3.7, 4.8]]],
  '9': [5.2, [[5.2, 5.2, 1.3, 5.2, 0, 4, 0, 1.4, 1.3, 0, 3.9, 0, 5.2, 1.4, 5.2, 8, 3.6, 10, 0.6, 10]]],
  '.': [1.6, [[0.8, 9.2, 0.8, 10]]],
  ',': [1.8, [[1.1, 9, 1.1, 10, 0.3, 11.4]]],
  ':': [1.6, [[0.8, 3, 0.8, 3.8], [0.8, 9.2, 0.8, 10]]],
  '·': [1.8, [[0.9, 5, 0.9, 5.8]]],
  '-': [3.6, [[0.2, 5.6, 3.4, 5.6]]],
  '—': [5.6, [[0.2, 5.6, 5.4, 5.6]]],
  "'": [1.4, [[0.7, 0, 0.7, 2.8]]],
  '!': [1.6, [[0.8, 0, 0.8, 7], [0.8, 9.2, 0.8, 10]]],
  '?': [4.8, [[0, 1.4, 1.2, 0, 3.6, 0, 4.8, 1.4, 4.8, 3.6, 2.4, 5.6, 2.4, 7.2], [2.4, 9.2, 2.4, 10]]],
  '&': [6, [[6, 10, 1, 3.6, 1, 1.2, 2, 0, 3.6, 0, 4.4, 1.2, 4.4, 2.6, 0, 6.2, 0, 8.6, 1.4, 10, 3.4, 10, 5.6, 6.6]]],
  '×': [4.4, [[0.4, 4, 4, 8.4], [4, 4, 0.4, 8.4]]],
  ' ': [3.4, []],
};

const SPACING = 1.9;
const WEIGHT = 2.35;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Path data for one line of text, plus its width (cap height 10). */
export function letterPath(text: string): { d: string; width: number } {
  let x = 0;
  let d = '';
  let seed = hash(text) || 1;
  const jitter = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296 - 0.5) * 0.42;
  };
  const r = (n: number) => Math.round(n * 100) / 100;
  for (const ch0 of text.toUpperCase()) {
    const ch = ch0 === '’' ? "'" : ch0;
    const glyph = G[ch] ?? G[' '];
    const [adv, strokes] = glyph;
    for (const s of strokes) {
      for (let i = 0; i + 1 < s.length; i += 2) {
        if (Number.isNaN(s[i])) break;
        d += `${i === 0 ? 'M' : 'L'}${r(x + s[i] + jitter())} ${r(s[i + 1] + jitter())}`;
      }
      if (Number.isNaN(s[s.length - 1])) d += 'Z';
    }
    x += adv + SPACING;
  }
  return { d, width: Math.max(0, x - SPACING) };
}

/**
 * Carved lettering as an HTML string: an inline SVG one em tall (cap height
 * = 1em, so size it with font-size), plus the text for readers.
 */
export function carve(text: string, cls = ''): string {
  const { d, width } = letterPath(text);
  const pad = 1.6;
  const vbW = width + pad * 2;
  const vbH = 10 + pad * 2;
  const esc = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const w = (vbW / vbH).toFixed(3);
  return (
    `<span class="carve${cls ? ` ${cls}` : ''}"><svg aria-hidden="true" focusable="false" viewBox="${-pad} ${-pad} ${vbW.toFixed(2)} ${vbH}" ` +
    `style="width:${w}em;height:1em" fill="none" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="3">` +
    `<path d="${d}" transform="translate(0.45 0.95)" stroke="var(--carve-cut, rgba(20,10,4,0.85))" stroke-width="${WEIGHT + 0.7}"/>` +
    `<path d="${d}" stroke="var(--carve-paint, #e8bd6a)" stroke-width="${WEIGHT}"/>` +
    `<path d="${d}" transform="translate(-0.2 -0.35)" stroke="var(--carve-edge, rgba(255,240,205,0.55))" stroke-width="0.35"/>` +
    `</svg><span class="sr">${esc}</span></span>`
  );
}
