/**
 * ui/campaign-screens.ts — the three campaign screens, as plain DOM.
 *
 *   CampaignMapScreen  the journey: ten chapters on a winding trail —
 *                      locked / open / won, best time, optional-objective stars.
 *   BriefingScreen     before play: the story, the tips, the objectives, and
 *                      what you have (spells, buildings, people, boons) and
 *                      what the stones offer — all derived from the rules.
 *   DebriefScreen      after play: result, time, objectives met, a boon
 *                      choice when one is on offer, next / retry / map.
 *
 * Self-contained and logic-free: each screen takes data and callbacks
 * (ui/campaign.ts decides what they mean). Styling is one injected sheet
 * whose colours, fonts and radii read `--tg-…` overrides first, then the
 * shared theme (ui/theme.css: --gold, --ink-1, --font-display …), then a
 * literal fallback — so the screens follow the design system and still
 * render on their own.
 */

import { BOONS, BoonId } from '../campaign/boons';
import { BUILDINGS, FailCondition, ScenarioRules, spellDef, SpellId, TribeId, tribeName, UNITS, UnitKind } from '../sim/catalog';
import { STARTER_SPELLS } from '../sim/rules';
import { START_BRAVES, START_WOOD } from '../config';
import type { LevelData } from '../level/level-format';

const CSS = `
.tgc-overlay {
  position: fixed; inset: 0; z-index: 40; overflow-y: auto;
  background: var(--tg-overlay, radial-gradient(ellipse at 50% 20%, rgba(28,40,58,0.94), rgba(8,11,16,0.97)));
  color: var(--tg-text, var(--text, #ece6d6)); font: 14px/1.5 var(--tg-font, var(--font, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif));
  padding: 32px 16px 64px; box-sizing: border-box;
}
.tgc-overlay * { box-sizing: border-box; }
.tgc-inner { max-width: 920px; margin: 0 auto; }
.tgc-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.tgc-title { font: 600 30px/1.1 var(--tg-display-font, var(--font-display, Georgia, 'Times New Roman', serif)); letter-spacing: 0.5px; flex: 1; margin: 0; }
.tgc-sub { color: var(--tg-muted, var(--text-2, #a59f90)); }
.tgc-btn {
  padding: 9px 16px; border-radius: var(--tg-radius, var(--r2, 8px)); cursor: pointer; font: inherit;
  border: 1px solid var(--tg-border, var(--rim, rgba(255,255,255,0.18))); background: var(--tg-button, var(--ink-2, rgba(255,255,255,0.07))); color: inherit;
}
.tgc-btn:hover { border-color: var(--tg-accent, var(--gold, #f1c96b)); }
.tgc-btn.primary { background: var(--tg-accent, var(--gold, #f1c96b)); color: var(--tg-on-accent, var(--ink-solid, #17120a)); border-color: transparent; font-weight: 600; }
.tgc-btn:disabled { opacity: 0.45; cursor: default; }
.tgc-panel {
  background: var(--tg-panel, var(--ink-1, rgba(255,255,255,0.05))); border: 1px solid var(--tg-border, var(--rim, rgba(255,255,255,0.14)));
  border-radius: var(--tg-radius-lg, var(--r3, 12px)); padding: 16px 18px;
}
.tgc-trail { position: relative; display: grid; gap: 14px; }
.tgc-trail svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.tgc-node.tgc-panel { background: var(--tg-panel-solid, var(--ink-solid, rgba(19,26,36,0.97))); }
.tgc-node { position: relative; display: grid; grid-template-columns: 54px 1fr auto; gap: 14px; align-items: center; width: min(100%, 560px); cursor: pointer; }
.tgc-node.right { margin-left: auto; }
.tgc-node.locked { cursor: default; opacity: 0.5; }
.tgc-node:not(.locked):hover { border-color: var(--tg-accent, var(--gold, #f1c96b)); }
.tgc-node.current { border-color: var(--tg-accent, var(--gold, #f1c96b)); box-shadow: 0 0 0 1px var(--tg-accent, var(--gold, #f1c96b)), 0 0 24px rgba(241,201,107,0.18); }
.tgc-num {
  width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center;
  font: 600 20px var(--tg-display-font, var(--font-display, Georgia, serif)); border: 2px solid var(--tg-border, var(--rim, rgba(255,255,255,0.25)));
  background: var(--tg-bg, var(--ink-solid, #0d131b));
}
.tgc-node.won .tgc-num { border-color: var(--tg-good, var(--good, #7fc98f)); color: var(--tg-good, var(--good, #7fc98f)); }
.tgc-node.current .tgc-num { border-color: var(--tg-accent, var(--gold, #f1c96b)); color: var(--tg-accent, var(--gold, #f1c96b)); }
.tgc-name { font: 600 17px var(--tg-display-font, var(--font-display, Georgia, serif)); }
.tgc-tag { color: var(--tg-muted, var(--text-2, #a59f90)); font-size: 13px; }
.tgc-teach { font-size: 12px; color: var(--tg-accent-2, var(--mana, #8fb8e8)); margin-top: 2px; }
.tgc-meta { text-align: right; font-size: 12px; color: var(--tg-muted, var(--text-2, #a59f90)); white-space: nowrap; }
.tgc-stars { color: var(--tg-accent, var(--gold, #f1c96b)); letter-spacing: 2px; font-size: 14px; }
.tgc-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
@media (max-width: 720px) { .tgc-grid { grid-template-columns: 1fr; } .tgc-node { grid-template-columns: 44px 1fr; } .tgc-meta { grid-column: 2; text-align: left; } }
.tgc-h { font: 600 12px var(--tg-font, var(--font, system-ui)); text-transform: uppercase; letter-spacing: 1.4px; color: var(--tg-muted, var(--text-2, #a59f90)); margin: 14px 0 6px; }
.tgc-h:first-child { margin-top: 0; }
.tgc-body { font-size: 15px; line-height: 1.65; margin: 0; }
.tgc-list { margin: 0; padding-left: 18px; }
.tgc-list li { margin: 3px 0; }
.tgc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.tgc-chip { padding: 3px 9px; border-radius: 999px; font-size: 12px; background: var(--tg-chip, var(--ink-2, rgba(255,255,255,0.08))); border: 1px solid var(--tg-border, var(--rim, rgba(255,255,255,0.12))); }
.tgc-chip.gift { border-color: var(--tg-accent, var(--gold, #f1c96b)); }
.tgc-obj { display: flex; gap: 8px; align-items: baseline; margin: 4px 0; }
.tgc-obj .mark { width: 18px; flex: none; text-align: center; }
.tgc-obj.done .mark { color: var(--tg-good, var(--good, #7fc98f)); }
.tgc-obj.miss .mark { color: var(--tg-bad, var(--bad, #e07a6a)); }
.tgc-obj.optional { color: var(--tg-muted, var(--text-2, #c9c2b0)); }
.tgc-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; justify-content: flex-end; }
.tgc-result { font: 600 44px/1 var(--tg-display-font, var(--font-display, Georgia, serif)); margin: 0 0 6px; }
.tgc-result.victory { color: var(--tg-accent, var(--gold, #f1c96b)); }
.tgc-result.defeat { color: var(--tg-bad, var(--bad, #e07a6a)); }
.tgc-boons { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
.tgc-boon { cursor: pointer; text-align: left; }
.tgc-boon.chosen { border-color: var(--tg-accent, var(--gold, #f1c96b)); box-shadow: 0 0 0 1px var(--tg-accent, var(--gold, #f1c96b)); }
.tgc-boon b { display: block; font-size: 15px; margin-bottom: 2px; }
`;

let injected = false;
function injectCss(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.dataset.tg = 'campaign';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', primary ? 'tgc-btn primary' : 'tgc-btn', label);
  b.addEventListener('click', onClick);
  return b;
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
export const roman = (n: number) => ROMAN[n - 1] ?? String(n);

/** A full-screen overlay that can be shown and hidden. */
class Overlay {
  readonly root: HTMLDivElement;
  protected readonly inner: HTMLDivElement;
  constructor() {
    injectCss();
    this.root = el('div', 'tgc-overlay');
    this.root.style.display = 'none';
    this.inner = el('div', 'tgc-inner');
    this.root.appendChild(this.inner);
    // Keys typed on a campaign screen are not game hotkeys.
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(this.root);
  }
  get visible(): boolean {
    return this.root.style.display !== 'none';
  }
  hide(): void {
    this.root.style.display = 'none';
  }
  protected open(): void {
    this.inner.innerHTML = '';
    this.root.style.display = 'block';
    this.root.scrollTop = 0;
  }
}

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

export interface MapNode {
  id: string;
  chapter: number;
  title: string;
  tagline: string;
  teaches: string;
  state: 'locked' | 'open' | 'won';
  current: boolean;
  bestTime: number | null;
  stars: number;
  /** Optional objectives in the scenario (null while unknown). */
  starsTotal: number | null;
  boon?: string;
}

export class CampaignMapScreen extends Overlay {
  constructor(private readonly hooks: { onPick(id: string): void; onClose(): void }) {
    super();
  }

  show(nodes: MapNode[]): void {
    this.open();
    const head = el('div', 'tgc-head');
    head.append(el('h1', 'tgc-title', 'The Long Tide'), el('span', 'tgc-sub', `${nodes.filter((n) => n.state === 'won').length} of ${nodes.length} chapters`));
    head.appendChild(button('Back', () => this.hooks.onClose()));
    this.inner.appendChild(head);
    const intro = el('p', 'tgc-sub', 'The sea is rising. The Lantern-folk have lost one shore already; this is the road to the last one.');
    intro.style.margin = '0 0 18px';
    this.inner.appendChild(intro);

    const trail = el('div', 'tgc-trail');
    const cards: HTMLElement[] = [];
    nodes.forEach((n, i) => {
      const card = el('div', `tgc-panel tgc-node ${n.state}${n.current ? ' current' : ''}${i % 2 ? ' right' : ''}`);
      card.dataset.id = n.id;
      const num = el('div', 'tgc-num', n.state === 'locked' ? '·' : roman(n.chapter));
      const text = el('div');
      text.append(el('div', 'tgc-name', n.state === 'locked' ? `${roman(n.chapter)}. ${n.title}` : n.title), el('div', 'tgc-tag', n.tagline));
      if (n.state !== 'locked') text.appendChild(el('div', 'tgc-teach', n.teaches));
      const meta = el('div', 'tgc-meta');
      if (n.state === 'won') {
        const total = n.starsTotal ?? 0;
        if (total > 0) meta.appendChild(el('div', 'tgc-stars', '★'.repeat(n.stars) + '☆'.repeat(Math.max(0, total - n.stars))));
        meta.appendChild(el('div', undefined, `best ${formatTime(n.bestTime)}`));
        if (n.boon) meta.appendChild(el('div', undefined, `boon: ${n.boon}`));
      } else if (n.state === 'open') meta.appendChild(el('div', undefined, n.current ? 'next on the road' : 'open'));
      else meta.appendChild(el('div', undefined, 'locked'));
      card.append(num, text, meta);
      if (n.state !== 'locked') card.addEventListener('click', () => this.hooks.onPick(n.id));
      trail.appendChild(card);
      cards.push(card);
    });
    this.inner.appendChild(trail);
    // The road between the chapters, drawn once laid out.
    requestAnimationFrame(() => drawTrail(trail, cards));
  }
}

function drawTrail(trail: HTMLElement, cards: HTMLElement[]): void {
  const box = trail.getBoundingClientRect();
  if (!box.width) return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const pts = cards.map((c) => {
    const r = c.querySelector('.tgc-num')!.getBoundingClientRect();
    return [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
  });
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const my = (y0 + y1) / 2;
    d += ` C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`;
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--tg-trail, rgba(241,201,107,0.35))');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-dasharray', '6 6');
  svg.appendChild(path);
  trail.prepend(svg);
}

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------

/** Player-facing sentence for a fail condition. */
export function failText(f: FailCondition): string | null {
  switch (f.type) {
    case 'tribeDestroyed': return null;
    case 'leaderDies': return 'Your leader must not fall — there is no return this time.';
    case 'timeLimit': return `Finish within ${formatTime(f.seconds)}.`;
    case 'buildingLost': return `Lose every ${BUILDINGS[f.kind].name} and it is over.`;
    case 'monumentTaken': return 'If a rival communes at the stone first, it is over.';
  }
}

export interface BriefingData {
  chapter: number;
  rules: ScenarioRules;
  level: LevelData;
  boons: BoonId[];
  /** A boon won in an earlier chapter but never chosen (debrief skipped): offer it here. */
  pendingBoon?: { chapterTitle: string; offer: BoonId[] };
}

/** What the player starts with, derived from the rules (for the briefing). */
export function describeLoadout(rules: ScenarioRules) {
  const lo = rules.tribes.find((t) => t.id === 'player')?.loadout ?? {};
  const spells = (lo.spells ?? STARTER_SPELLS).map((id) => {
    const extra = lo.extraCharges?.[id] ?? 0;
    const cost = lo.chargeCost?.[id];
    let note = '';
    if (extra) note += ` +${extra} charge`;
    if (cost && cost !== 1) note += cost > 1 ? ` ×${cost} cost` : ` −${Math.round((1 - cost) * 100)}% cost`;
    return spellDef(id).name + note;
  });
  const gifts = Object.entries(lo.gifts ?? {}).map(([id, n]) => `${spellDef(id as SpellId).name} ×${n} (free)`);
  const buildings = lo.buildings === undefined ? 'Every building' : lo.buildings.length === 0 ? 'None — no building at all' : lo.buildings.map((k) => BUILDINGS[k].name).join(', ');
  const units: Partial<Record<UnitKind, number>> = { brave: START_BRAVES, ...(lo.startUnits ?? {}) };
  const people = (Object.entries(units) as Array<[UnitKind, number]>)
    .filter(([k, n]) => n > 0 && k !== 'shaman')
    .map(([k, n]) => `${n} ${UNITS[k].name}${n === 1 ? '' : 's'}`);
  if ((units.shaman ?? 1) > 0) people.unshift('your Leader');
  return { spells: [...spells, ...gifts], buildings, people, wood: lo.startWood ?? START_WOOD, startBuildings: (lo.startBuildings ?? []).map((k) => BUILDINGS[k].name) };
}

export class BriefingScreen extends Overlay {
  constructor(private readonly hooks: { onPlay(): void; onBack(): void; onBoon?(id: BoonId): void }) {
    super();
  }

  show(d: BriefingData): void {
    this.open();
    const b = d.rules.briefing;
    const head = el('div', 'tgc-head');
    head.append(el('span', 'tgc-sub', `Chapter ${roman(d.chapter)}`), el('h1', 'tgc-title', b.title));
    head.style.flexDirection = 'column';
    head.style.alignItems = 'flex-start';
    head.style.gap = '4px';
    this.inner.appendChild(head);

    const grid = el('div', 'tgc-grid');
    const story = el('div', 'tgc-panel');
    story.append(el('p', 'tgc-body', b.body), el('div', 'tgc-h', 'Counsel'));
    const tips = el('ul', 'tgc-list');
    for (const t of b.tips) tips.appendChild(el('li', undefined, t));
    story.appendChild(tips);

    story.appendChild(el('div', 'tgc-h', 'Objectives'));
    for (const o of d.rules.objectives) {
      const row = el('div', `tgc-obj${o.optional ? ' optional' : ''}`);
      row.append(el('span', 'mark', o.optional ? '☆' : '◆'), el('span', undefined, o.text + (o.optional ? ' (optional)' : '')));
      story.appendChild(row);
    }
    const fails = (d.rules.fail ?? []).map((f) => failText(f)).filter((x): x is string => !!x);
    if (fails.length) {
      story.appendChild(el('div', 'tgc-h', 'Beware'));
      for (const f of fails) {
        const row = el('div', 'tgc-obj miss');
        row.append(el('span', 'mark', '✕'), el('span', undefined, f));
        story.appendChild(row);
      }
    }

    const side = el('div', 'tgc-panel');
    const lo = describeLoadout(d.rules);
    const chips = (items: string[], cls = '') => {
      const c = el('div', 'tgc-chips');
      for (const i of items) c.appendChild(el('span', `tgc-chip ${cls}`, i));
      return c;
    };
    side.append(el('div', 'tgc-h', 'Your spells'), chips(lo.spells));
    side.append(el('div', 'tgc-h', 'You may build'), el('div', undefined, lo.buildings));
    side.append(el('div', 'tgc-h', 'You bring'), el('div', undefined, `${lo.people.join(', ')} · ${lo.wood} wood`));
    if (lo.startBuildings.length || d.level.buildings?.some((x) => x.tribe === 'player')) {
      const standing = [...(d.level.buildings ?? []).filter((x) => x.tribe === 'player').map((x) => BUILDINGS[x.kind].name), ...lo.startBuildings];
      side.append(el('div', 'tgc-h', 'Already standing'), el('div', undefined, standing.join(', ')));
    }
    const stones = d.level.monuments.map((m) => {
      const name = spellDef(m.spell).name;
      if (m.mode === 'gift') return `${name} — gift, ${m.charges ?? 2} cast${(m.charges ?? 2) === 1 ? '' : 's'}${m.cooldown ? `, then sleeps ${formatTime(m.cooldown)}` : ''}`;
      return `${name} — teaches${m.opensAt ? `, wakes at ${formatTime(m.opensAt)}` : ''}`;
    });
    side.append(el('div', 'tgc-h', 'The stones offer'), stones.length ? chips(stones, 'gift') : el('div', 'tgc-sub', 'No standing stones here.'));
    const rivals = d.rules.tribes.filter((t) => t.id !== 'player');
    if (rivals.length) {
      const name = (id: TribeId) => tribeName(d.rules, id);
      side.append(el('div', 'tgc-h', 'Others here'), el('div', undefined, rivals.map((t) => name(t.id) + (t.allies?.length ? ` (allied with ${t.allies.map(name).join(', ')})` : '')).join('; ')));
    }
    if (d.boons.length) side.append(el('div', 'tgc-h', 'Boons you carry'), chips(d.boons.map((id) => BOONS[id].name)));
    if (d.pendingBoon && this.hooks.onBoon) {
      side.append(el('div', 'tgc-h', `Unclaimed boon — ${d.pendingBoon.chapterTitle}`));
      const grid = el('div', 'tgc-boons');
      for (const id of d.pendingBoon.offer) {
        const b = el('button', 'tgc-btn tgc-boon');
        b.append(el('b', undefined, BOONS[id].name), el('span', 'tgc-sub', BOONS[id].blurb));
        b.addEventListener('click', () => this.hooks.onBoon!(id));
        grid.appendChild(b);
      }
      side.appendChild(grid);
    }
    grid.append(story, side);
    this.inner.appendChild(grid);

    const actions = el('div', 'tgc-actions');
    actions.append(button('Back to the map', () => this.hooks.onBack()), button('Begin', () => this.hooks.onPlay(), true));
    this.inner.appendChild(actions);
  }
}

// ---------------------------------------------------------------------------
// Debrief
// ---------------------------------------------------------------------------

export interface DebriefData {
  chapter: number;
  title: string;
  result: 'victory' | 'defeat';
  reason: string;
  seconds: number;
  bestTime: number | null;
  objectives: Array<{ text: string; done: boolean; optional: boolean }>;
  /** Boons on offer (victory at an offering chapter), and the one already chosen. */
  boonOffer: BoonId[];
  boonChosen: BoonId | null;
  hasNext: boolean;
}

export class DebriefScreen extends Overlay {
  constructor(
    private readonly hooks: { onNext(): void; onRetry(): void; onMap(): void; onBoon(id: BoonId): void },
  ) {
    super();
  }

  show(d: DebriefData): void {
    this.open();
    const win = d.result === 'victory';
    const head = el('div');
    head.append(el('div', 'tgc-sub', `Chapter ${roman(d.chapter)} · ${d.title}`), el('h1', `tgc-result ${d.result}`, win ? 'Victory' : 'Defeat'), el('p', 'tgc-body', d.reason));
    head.style.marginBottom = '18px';
    this.inner.appendChild(head);

    const panel = el('div', 'tgc-panel');
    panel.appendChild(el('div', 'tgc-h', 'Time'));
    panel.appendChild(el('div', undefined, `${formatTime(d.seconds)}${win && d.bestTime !== null ? ` · best ${formatTime(d.bestTime)}` : ''}`));
    panel.appendChild(el('div', 'tgc-h', 'Objectives'));
    for (const o of d.objectives) {
      const row = el('div', `tgc-obj ${o.done ? 'done' : 'miss'}${o.optional ? ' optional' : ''}`);
      row.append(el('span', 'mark', o.done ? (o.optional ? '★' : '✓') : o.optional ? '☆' : '✕'), el('span', undefined, o.text));
      panel.appendChild(row);
    }
    this.inner.appendChild(panel);

    let next: HTMLButtonElement | null = null;
    if (win && d.boonOffer.length) {
      const boonPanel = el('div', 'tgc-panel');
      boonPanel.style.marginTop = '14px';
      boonPanel.append(el('div', 'tgc-h', 'Choose a boon to carry forward'));
      const grid = el('div', 'tgc-boons');
      let chosen = d.boonChosen;
      const paint = () => {
        for (const c of grid.children) (c as HTMLElement).classList.toggle('chosen', (c as HTMLElement).dataset.boon === chosen);
        if (next) next.disabled = !chosen;
      };
      for (const id of d.boonOffer) {
        const b = el('button', 'tgc-btn tgc-boon');
        b.dataset.boon = id;
        b.append(el('b', undefined, BOONS[id].name), el('span', 'tgc-sub', BOONS[id].blurb));
        b.addEventListener('click', () => {
          chosen = id;
          this.hooks.onBoon(id);
          paint();
        });
        grid.appendChild(b);
      }
      boonPanel.appendChild(grid);
      this.inner.appendChild(boonPanel);
      requestAnimationFrame(paint);
    }

    const actions = el('div', 'tgc-actions');
    actions.append(button('Campaign map', () => this.hooks.onMap()), button(win ? 'Play again' : 'Try again', () => this.hooks.onRetry(), !win));
    if (win && d.hasNext) {
      next = button('Next chapter', () => this.hooks.onNext(), true);
      next.disabled = d.boonOffer.length > 0 && !d.boonChosen;
      actions.appendChild(next);
    }
    this.inner.appendChild(actions);
  }
}
