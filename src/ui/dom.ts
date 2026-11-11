/**
 * ui/dom.ts — the three helpers every panel is built with.
 *
 *   h('div.cls', {attrs}, ...children)  make an element (tiny hyperscript)
 *   css(`...`)                           inject a component's stylesheet once
 *   uiRoot()                             the #ui layer panels mount into
 *
 * No framework: panels build their DOM once, keep references to the nodes
 * that change, and patch only those (text, a width, a class) when the
 * game state they show changes. That is all the "rendering engine" a HUD
 * needs, and it costs nothing per frame when nothing changed.
 */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** `h('button.tg-btn.primary', { onclick }, 'Play')`. The tag comes first and types the result. */
export function h<K extends keyof HTMLElementTagNameMap>(
  sel: K | `${K}.${string}`,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div') as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const injected = new Set<string>();

/** Add a component stylesheet to <head> (once per id). */
export function css(id: string, text: string): void {
  if (injected.has(id)) return;
  injected.add(id);
  const s = document.createElement('style');
  s.dataset.tg = id;
  s.textContent = text;
  document.head.appendChild(s);
}

let root: HTMLDivElement | null = null;

/** The full-screen, click-through layer that game panels live in. */
export function uiRoot(): HTMLDivElement {
  if (!root) {
    root = document.createElement('div');
    root.id = 'ui';
    document.body.appendChild(root);
  }
  return root;
}

let worldLayerEl: HTMLDivElement | null = null;

/**
 * The bottom-most layer of #ui, for things that float IN the world (health
 * bars, order markers, cursor notes): every panel paints above it.
 */
export function worldLayer(): HTMLDivElement {
  if (!worldLayerEl) {
    worldLayerEl = document.createElement('div');
    worldLayerEl.className = 'world-layer';
    // z-index 0 makes it a stacking context: nothing inside (bars at z 3,
    // order marks at z 4) can paint over a HUD panel, which come later in #ui.
    worldLayerEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:0;';
    uiRoot().prepend(worldLayerEl);
  }
  return worldLayerEl;
}

/** Set text only when it changed (avoids layout churn in per-frame updates). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toggle a class only when it changed. */
export function setClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** True while the user is typing into a field (hotkeys must stand aside). */
export function typingInField(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
