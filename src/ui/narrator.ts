/**
 * ui/narrator.ts — the one calm voice at the top of the screen.
 *
 * Scenario lines (world.messages: scripted events, the story) and the
 * first-minutes hint chip share a single column at top-centre, so they
 * never stack on top of each other or the alerts (those live on the right).
 *
 * A narrator line is not a toast: it fades in as a sentence under the top
 * bar, stays long enough to read at a calm pace (by word count), and fades
 * out before the next queued line begins. Lines that arrive together wait
 * their turn instead of piling up in one box. A repeat of the line being
 * shown is dropped.
 */

import { css, h } from './dom';

css('narrator', `
.hud-centre { position: absolute; top: calc(var(--edge) + 3.9rem); left: 50%; transform: translateX(-50%); width: min(36rem, calc(100vw - 2rem));
  display: flex; flex-direction: column; align-items: center; gap: 0.5rem; pointer-events: none; }
.narr { max-width: 100%; padding: 0.55rem 1.4rem 0.6rem; text-align: center; color: #f3ead6;
  font: italic 500 var(--t-lg)/1.45 var(--font-display); text-shadow: 0 1px 2px rgba(0,0,0,0.85), 0 0 1.25rem rgba(0,0,0,0.6);
  background: radial-gradient(closest-side, rgba(8,11,18,0.62), rgba(8,11,18,0.38) 70%, transparent);
  opacity: 0; transform: translateY(-0.25rem); transition: opacity 700ms var(--ease), transform 700ms var(--ease); }
.narr.on { opacity: 1; transform: none; }
.narr::before, .narr::after { content: ''; display: block; width: 2.5rem; height: 1px; margin: 0 auto; background: linear-gradient(90deg, transparent, var(--gold), transparent); opacity: 0.7; }
.narr::before { margin-bottom: 0.35rem; }
.narr::after { margin-top: 0.4rem; }
`);

/** Seconds a line stays up: a calm reading pace, never shorter than 4.5 s. */
export function readSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(4.5, Math.min(14, 2.2 + words * 0.32));
}

export class Narrator {
  readonly el: HTMLDivElement;
  private readonly queue: string[] = [];
  private current: string | null = null;
  private left = 0;
  private fading = 0;

  constructor() {
    this.el = h('div.narr', { role: 'status', 'aria-live': 'polite' });
    this.el.hidden = true;
  }

  say(text: string): void {
    const t = text.trim();
    if (!t || t === this.current || this.queue[this.queue.length - 1] === t) return;
    this.queue.push(t);
  }

  /** Lines waiting plus the one showing (for tests and the debug readout). */
  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  reset(): void {
    this.queue.length = 0;
    this.current = null;
    this.left = 0;
    this.fading = 0;
    this.el.classList.remove('on');
    this.el.hidden = true;
  }

  update(dt: number): void {
    if (this.fading > 0) {
      this.fading -= dt;
      if (this.fading <= 0) {
        this.current = null;
        this.el.hidden = true;
      }
      return;
    }
    if (this.current) {
      this.left -= dt;
      if (this.left <= 0) {
        this.el.classList.remove('on');
        this.fading = 0.75; // let the fade finish before the next line
      }
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.left = readSeconds(next);
    this.el.textContent = next;
    this.el.hidden = false;
    void this.el.offsetWidth; // restart the fade-in
    this.el.classList.add('on');
  }
}
