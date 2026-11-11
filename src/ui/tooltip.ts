/**
 * ui/tooltip.ts — one tooltip for the whole interface, plus cursor toasts.
 *
 * `tip(el, () => html)` attaches a rich tooltip to any control. The content
 * is a FUNCTION, re-run while the pointer stays on the control, so a spell's
 * tooltip counts its recharge down live instead of freezing at hover time.
 * It also shows on keyboard focus (focus-visible users get the same info).
 *
 * `toast(text, x, y)` floats a short red message by the cursor — the
 * "refused" feedback for a cast or placement that the sim turned down.
 */

import { h, uiRoot } from './dom';

let tipEl: HTMLDivElement | null = null;
let current: { el: HTMLElement; content: () => string } | null = null;
let timer = 0;

function ensure(): HTMLDivElement {
  if (!tipEl) {
    tipEl = h('div.tg-tip', { role: 'tooltip' });
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function place(): void {
  if (!current || !tipEl) return;
  const html = current.content();
  if (tipEl.innerHTML !== html) tipEl.innerHTML = html;
  const r = current.el.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const gap = 10;
  // Prefer above the control (the HUD hugs screen edges, so above/below
  // keeps the tip over the world rather than over other panels).
  let top = r.top - t.height - gap;
  if (top < 8) top = r.bottom + gap;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(innerWidth - t.width - 8, left));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${Math.max(8, Math.min(innerHeight - t.height - 8, top))}px`;
}

function show(el: HTMLElement, content: () => string): void {
  current = { el, content };
  const t = ensure();
  t.classList.add('show');
  place();
  clearInterval(timer);
  timer = window.setInterval(() => {
    if (!current || !document.body.contains(current.el)) hideTip();
    else place();
  }, 200);
}

export function hideTip(): void {
  current = null;
  clearInterval(timer);
  tipEl?.classList.remove('show');
}

/** Attach a live tooltip. */
export function tip(el: HTMLElement, content: () => string): void {
  el.addEventListener('pointerenter', () => show(el, content));
  el.addEventListener('pointerleave', () => current?.el === el && hideTip());
  el.addEventListener('focus', () => el.matches(':focus-visible') && show(el, content));
  el.addEventListener('blur', () => current?.el === el && hideTip());
  el.addEventListener('pointerdown', () => current?.el === el && place());
}

/** A short-lived message at a screen point (cursor), red by default. */
export function toast(text: string, x: number, y: number): void {
  const t = h('div.tg-toast', { text });
  t.style.left = `${x}px`;
  t.style.top = `${y - 34}px`;
  uiRoot().appendChild(t);
  setTimeout(() => t.remove(), 1700);
}
